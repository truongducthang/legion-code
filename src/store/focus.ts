import { batch } from 'solid-js';
import { store, setStore } from './core';
import { setActiveTask } from './navigation';
import { computeSidebarTaskOrder } from './sidebar-order';
import { uncollapseTask } from './tasks';

// Imperative focus registry: components register focus callbacks on mount
const focusRegistry = new Map<string, () => void>();
const actionRegistry = new Map<string, () => void>();

export function registerFocusFn(key: string, fn: () => void): void {
  focusRegistry.set(key, fn);
}

export function unregisterFocusFn(key: string): void {
  focusRegistry.delete(key);
}

export function triggerFocus(key: string): void {
  focusRegistry.get(key)?.();
}

export function registerAction(key: string, fn: () => void): void {
  actionRegistry.set(key, fn);
}

export function unregisterAction(key: string): void {
  actionRegistry.delete(key);
}

export function triggerAction(key: string): void {
  actionRegistry.get(key)?.();
}

// Grid-based spatial navigation. Two task layouts:
//  - vertical stack (default): everything in one column
//  - split (focus mode, panel wide enough): ai-terminal/prompt anchor the left,
//    changed-files/notes/steps/shell anchor the right, and `ai-terminal` is
//    repeated down col 0 so left/right crossings into the right column stay
//    consistent.

/** Cells that belong to the left column in split mode. */
const LEFT_COL_PANELS = new Set(['title', 'ai-terminal', 'prompt', 'terminal']);

function buildGrid(panelId: string): string[][] {
  const task = store.tasks[panelId];
  if (task) {
    const bookmarkCount =
      store.projects.find((p) => p.id === task.projectId)?.terminalBookmarks?.length ?? 0;
    const toolbarCols = Array.from({ length: 1 + bookmarkCount }, (_, i) => `shell-toolbar:${i}`);

    if (store.taskSplitMode[panelId]) {
      const grid: string[][] = [['title']];
      grid.push(['ai-terminal', 'changed-files']);
      grid.push(['ai-terminal', 'notes']);
      if (task.stepsEnabled && task.stepsContent?.length) {
        grid.push(['ai-terminal', 'steps']);
      }

      // Pair the bottom-left (prompt or ai-terminal if prompt hidden) with
      // whatever's at the bottom-right, so → from prompt jumps into the shell
      // section instead of falling off to the next task.
      const hasShells = task.shellAgentIds.length > 0;
      const leftBottom = store.showPromptInput ? 'prompt' : 'ai-terminal';
      if (hasShells) {
        grid.push(['ai-terminal', ...toolbarCols]);
        grid.push([leftBottom, ...task.shellAgentIds.map((_, i) => `shell:${i}`)]);
      } else {
        grid.push([leftBottom, ...toolbarCols]);
      }
      return grid;
    }

    const grid: string[][] = [['title']];
    grid.push(['notes', 'changed-files']);
    grid.push(toolbarCols);
    if (task.shellAgentIds.length > 0) {
      grid.push(task.shellAgentIds.map((_, i) => `shell:${i}`));
    }
    grid.push(['ai-terminal']);
    if (task.stepsEnabled && task.stepsContent?.length) {
      grid.push(['steps']);
    }
    if (store.showPromptInput) {
      grid.push(['prompt']);
    }
    return grid;
  }

  // Terminal panel: just title + terminal
  return [['title'], ['terminal']];
}

/** In split mode, find the first focusable panel in the right column. */
function pickTopRightColumnTarget(grid: string[][]): string | null {
  for (const row of grid) {
    for (let c = 1; c < row.length; c++) {
      const cell = row[c];
      if (!LEFT_COL_PANELS.has(cell)) return cell;
    }
  }
  return null;
}

/** The panel to focus when navigating into a task or terminal. */
function defaultPanelFor(panelId: string): string {
  return store.tasks[panelId] ? 'ai-terminal' : 'terminal';
}

interface GridPos {
  row: number;
  col: number;
}

function findInGrid(grid: string[][], cell: string): GridPos | null {
  for (let row = 0; row < grid.length; row++) {
    const col = grid[row].indexOf(cell);
    if (col !== -1) return { row, col };
  }
  return null;
}

export function getTaskFocusedPanel(taskId: string): string {
  return store.focusedPanel[taskId] ?? defaultPanelFor(taskId);
}

/**
 * Whether a panel within a task should render its focus border. Returns false
 * when focus has moved to the sidebar/placeholder, even though the previously
 * focused panel is still recorded in `focusedPanel[taskId]`.
 */
export function isPanelFocused(taskId: string, panel: string): boolean {
  if (store.sidebarFocused || store.placeholderFocused) return false;
  if (store.activeTaskId !== taskId) return false;
  return store.focusedPanel[taskId] === panel;
}

export function isPanelFocusedPrefix(taskId: string, prefix: string): boolean {
  if (store.sidebarFocused || store.placeholderFocused) return false;
  if (store.activeTaskId !== taskId) return false;
  return store.focusedPanel[taskId]?.startsWith(prefix) ?? false;
}

export function setTaskFocusedPanel(taskId: string, panel: string): void {
  setStore('focusedPanel', taskId, panel);
  setStore('sidebarFocused', false);
  setStore('placeholderFocused', false);
  triggerFocus(`${taskId}:${panel}`);
  scrollTaskIntoView(taskId);
}

function scrollTaskIntoView(taskId: string): void {
  requestAnimationFrame(() => {
    const el = document.querySelector<HTMLElement>(`[data-task-id="${CSS.escape(taskId)}"]`);
    el?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
  });
}

export function focusSidebar(): void {
  setStore('sidebarFocused', true);
  setStore('placeholderFocused', false);
  setStore('sidebarFocusedTaskId', store.activeTaskId);
  setStore('sidebarFocusedProjectId', null);
  triggerFocus('sidebar');
}

export function unfocusSidebar(): void {
  setStore('sidebarFocused', false);
  setStore('sidebarFocusedProjectId', null);
  setStore('sidebarFocusedTaskId', null);
}

export function focusPlaceholder(button?: 'add-task' | 'add-terminal'): void {
  setStore('placeholderFocused', true);
  setStore('sidebarFocused', false);
  if (button) setStore('placeholderFocusedButton', button);
  const target = button ?? store.placeholderFocusedButton;
  triggerFocus(`placeholder:${target}`);
}

export function unfocusPlaceholder(): void {
  setStore('placeholderFocused', false);
}

export function setSidebarFocusedProjectId(id: string | null): void {
  setStore('sidebarFocusedProjectId', id);
}

function focusTaskPanel(taskId: string, panel: string): void {
  batch(() => {
    setStore('focusedPanel', taskId, panel);
    setStore('sidebarFocused', false);
    setStore('placeholderFocused', false);
    setActiveTask(taskId);
  });
  triggerFocus(`${taskId}:${panel}`);
}

export function navigateRow(direction: 'up' | 'down'): void {
  if (store.showNewTaskDialog || store.showHelpDialog || store.showSettingsDialog) return;

  if (store.placeholderFocused) {
    const btn = direction === 'up' ? 'add-task' : 'add-terminal';
    setStore('placeholderFocusedButton', btn);
    triggerFocus(`placeholder:${btn}`);
    return;
  }

  if (store.sidebarFocused) {
    const { projects, sidebarFocusedProjectId, sidebarFocusedTaskId } = store;
    const allTasks = computeSidebarTaskOrder();

    if (sidebarFocusedProjectId !== null) {
      // Project mode: navigate within projects
      const projectIdx = projects.findIndex((p) => p.id === sidebarFocusedProjectId);
      if (direction === 'up') {
        if (projectIdx > 0) {
          setStore('sidebarFocusedProjectId', projects[projectIdx - 1].id);
        }
        // At first project: stay put
      } else {
        if (projectIdx < projects.length - 1) {
          setStore('sidebarFocusedProjectId', projects[projectIdx + 1].id);
        } else if (allTasks.length > 0) {
          // Past last project: enter task mode
          setStore('sidebarFocusedProjectId', null);
          setStore('sidebarFocusedTaskId', allTasks[0]);
        }
      }
      return;
    }

    // Task mode: navigate within tasks (highlight only, don't activate)
    if (allTasks.length === 0 && projects.length === 0) return;
    const currentIdx = sidebarFocusedTaskId ? allTasks.indexOf(sidebarFocusedTaskId) : -1;
    if (direction === 'up') {
      if (currentIdx <= 0 && projects.length > 0) {
        // At first task (or no task): enter project mode at last project
        setStore('sidebarFocusedTaskId', null);
        setStore('sidebarFocusedProjectId', projects[projects.length - 1].id);
      } else if (currentIdx > 0) {
        setStore('sidebarFocusedTaskId', allTasks[currentIdx - 1]);
      }
    } else {
      if (allTasks.length === 0) return;
      const nextIdx = Math.min(allTasks.length - 1, currentIdx + 1);
      setStore('sidebarFocusedTaskId', allTasks[nextIdx]);
    }
    return;
  }

  const taskId = store.activeTaskId;
  if (!taskId) return;

  const grid = buildGrid(taskId);
  const current = getTaskFocusedPanel(taskId);
  let pos = findInGrid(grid, current);
  // The previously focused cell can vanish (task.stepsEnabled off, shells killed,
  // width crossing threshold). Recover by falling back to the default instead of
  // leaving arrow keys silently broken until the user clicks.
  if (!pos) {
    const fallback = defaultPanelFor(taskId);
    pos = findInGrid(grid, fallback);
    if (!pos) return;
    setTaskFocusedPanel(taskId, fallback);
  }

  const step = direction === 'up' ? -1 : 1;
  let nextRow = pos.row + step;
  // Skip rows whose clamped target equals the current cell — in split mode,
  // ai-terminal spans many rows on col 0, so ↓ from it has to walk past itself
  // to reach prompt (or the right column, below).
  while (nextRow >= 0 && nextRow < grid.length) {
    const col = Math.min(pos.col, grid[nextRow].length - 1);
    const target = grid[nextRow][col];
    if (target !== current) {
      setTaskFocusedPanel(taskId, target);
      return;
    }
    nextRow += step;
  }

  // Dead-end: in split mode, ↓ from ai-terminal when no prompt/shells anchor
  // the left column's bottom would otherwise stop — enter the top-right panel.
  if (
    direction === 'down' &&
    store.taskSplitMode[taskId] &&
    pos.col === 0 &&
    current === 'ai-terminal'
  ) {
    const target = pickTopRightColumnTarget(grid);
    if (target) setTaskFocusedPanel(taskId, target);
  }
}

export function navigateColumn(direction: 'left' | 'right'): void {
  if (store.showNewTaskDialog || store.showHelpDialog || store.showSettingsDialog) return;

  const taskId = store.activeTaskId;

  // From placeholder
  if (store.placeholderFocused) {
    if (direction === 'left') {
      unfocusPlaceholder();
      const lastTaskId = store.taskOrder[store.taskOrder.length - 1];
      if (lastTaskId) {
        setActiveTask(lastTaskId);
        setTaskFocusedPanel(lastTaskId, getTaskFocusedPanel(lastTaskId));
      } else if (store.sidebarVisible) {
        focusSidebar();
      }
    }
    return;
  }

  // From sidebar — always enter at the leftmost task panel, regardless of which
  // task is highlighted in the sidebar. The sidebar list is its own axis; → is
  // for crossing into the panel area, not for activating the highlighted item.
  if (store.sidebarFocused) {
    if (direction === 'right') {
      const targetTaskId = store.taskOrder[0] ?? store.sidebarFocusedTaskId ?? taskId;
      if (targetTaskId) {
        if (store.tasks[targetTaskId]?.collapsed) {
          uncollapseTask(targetTaskId);
          return;
        }
        if (targetTaskId !== store.activeTaskId) setActiveTask(targetTaskId);
        unfocusSidebar();
        setTaskFocusedPanel(targetTaskId, getTaskFocusedPanel(targetTaskId));
      }
    }
    return;
  }

  if (!taskId) return;

  const grid = buildGrid(taskId);
  const current = getTaskFocusedPanel(taskId);
  let pos = findInGrid(grid, current);
  if (!pos) {
    const fallback = defaultPanelFor(taskId);
    pos = findInGrid(grid, fallback);
    if (!pos) return;
    setTaskFocusedPanel(taskId, fallback);
  }

  if (
    direction === 'right' &&
    pos.col === 0 &&
    current === 'ai-terminal' &&
    store.taskSplitMode[taskId]
  ) {
    const target = pickTopRightColumnTarget(grid);
    if (target) {
      setTaskFocusedPanel(taskId, target);
      return;
    }
  }

  const row = grid[pos.row];
  const nextCol = direction === 'left' ? pos.col - 1 : pos.col + 1;
  if (nextCol >= 0 && nextCol < row.length) {
    setTaskFocusedPanel(taskId, row[nextCol]);
    return;
  }

  // Cross task boundary
  const { taskOrder } = store;
  const taskIdx = taskOrder.indexOf(taskId);
  const isCurrentTerminal = !store.tasks[taskId];

  const focusAdjacentTask = (targetId: string, entryEdge: 'left' | 'right') => {
    if (isCurrentTerminal && store.tasks[targetId]) {
      focusTaskPanel(targetId, getTaskFocusedPanel(targetId));
    } else if (!store.tasks[targetId]) {
      focusTaskPanel(targetId, defaultPanelFor(targetId));
    } else {
      const targetGrid = buildGrid(targetId);
      const targetPos = findInGrid(targetGrid, current);
      const targetRow = targetPos ? targetPos.row : pos.row;
      const safeRow = Math.min(targetRow, targetGrid.length - 1);
      const col = entryEdge === 'right' ? 0 : targetGrid[safeRow].length - 1;
      focusTaskPanel(targetId, targetGrid[safeRow][col]);
    }
  };

  if (direction === 'left') {
    if (taskIdx === 0) {
      if (store.sidebarVisible) focusSidebar();
      return;
    }
    const prevTaskId = taskOrder[taskIdx - 1];
    if (prevTaskId) focusAdjacentTask(prevTaskId, 'left');
  } else {
    const nextTaskId = taskOrder[taskIdx + 1];
    if (nextTaskId) {
      focusAdjacentTask(nextTaskId, 'right');
    } else {
      focusPlaceholder('add-task');
    }
  }
}

export function setPendingAction(
  action: { type: 'close' | 'merge' | 'push'; taskId: string } | null,
): void {
  setStore('pendingAction', action);
}

export function clearPendingAction(): void {
  setStore('pendingAction', null);
}

export function toggleHelpDialog(show?: boolean): void {
  setStore('showHelpDialog', show ?? !store.showHelpDialog);
}

export function toggleSettingsDialog(show?: boolean): void {
  setStore('showSettingsDialog', show ?? !store.showSettingsDialog);
}

export function sendActivePrompt(): void {
  const taskId = store.activeTaskId;
  if (!taskId) return;
  triggerAction(`${taskId}:send-prompt`);
}
