/**
 * Main-side cache of the renderer's project/task records so the bot can
 * resolve `agentId → task → project → telegramOptIn` without going through
 * IPC.
 *
 * The renderer is the authoritative owner of the project/task list. Main
 * receives the latest snapshot through two paths:
 *   - On startup, `bootstrapFromPersistedState()` reads `state.json`.
 *   - On every renderer `SaveAppState`, the IPC handler in `register.ts`
 *     forwards the new JSON blob to `setStateBlob()`.
 */

import { loadAppState } from '../ipc/persistence.js';

interface PersistedProject {
  id: string;
  name: string;
  path?: string;
  coverageReportPath?: string;
  terminalBookmarks?: Array<{ id?: unknown; command?: unknown }>;
  telegramOptIn?: boolean;
  telegramPauseOnBackpressure?: boolean;
}

interface PersistedTask {
  id: string;
  name: string;
  projectId: string;
  agentIds?: string[];
  worktreePath?: string;
}

export interface TerminalBookmarkInfo {
  id: string;
  command: string;
}

export interface ProjectInfo {
  id: string;
  name: string;
  path: string | null;
  coverageReportPath: string | null;
  terminalBookmarks: TerminalBookmarkInfo[];
  telegramOptIn: boolean;
  telegramPauseOnBackpressure: boolean;
}

export interface TaskInfo {
  id: string;
  name: string;
  projectId: string;
  worktreePath: string | null;
}

let projects: Map<string, ProjectInfo> = new Map();
let tasks: Map<string, TaskInfo> = new Map();

function coerceBool(v: unknown): boolean {
  return v === true;
}

function coerceBookmarks(raw: unknown): TerminalBookmarkInfo[] {
  if (!Array.isArray(raw)) return [];
  const out: TerminalBookmarkInfo[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as { id?: unknown; command?: unknown };
    if (typeof e.id !== 'string' || typeof e.command !== 'string') continue;
    out.push({ id: e.id, command: e.command });
  }
  return out;
}

function coerceProjects(raw: unknown): Map<string, ProjectInfo> {
  const out = new Map<string, ProjectInfo>();
  if (!Array.isArray(raw)) return out;
  for (const p of raw) {
    if (!p || typeof p !== 'object') continue;
    const pp = p as PersistedProject;
    if (typeof pp.id !== 'string' || typeof pp.name !== 'string') continue;
    out.set(pp.id, {
      id: pp.id,
      name: pp.name,
      path: typeof pp.path === 'string' ? pp.path : null,
      coverageReportPath: typeof pp.coverageReportPath === 'string' ? pp.coverageReportPath : null,
      terminalBookmarks: coerceBookmarks(pp.terminalBookmarks),
      telegramOptIn: coerceBool(pp.telegramOptIn),
      telegramPauseOnBackpressure: coerceBool(pp.telegramPauseOnBackpressure),
    });
  }
  return out;
}

function coerceTasks(raw: unknown): Map<string, TaskInfo> {
  const out = new Map<string, TaskInfo>();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [id, value] of Object.entries(raw)) {
    if (!value || typeof value !== 'object') continue;
    const t = value as PersistedTask;
    if (typeof t.id !== 'string' || typeof t.projectId !== 'string') continue;
    out.set(id, {
      id: t.id,
      name: typeof t.name === 'string' ? t.name : id,
      projectId: t.projectId,
      worktreePath: typeof t.worktreePath === 'string' ? t.worktreePath : null,
    });
  }
  return out;
}

export interface StateDiff {
  /** Project ids whose `telegramOptIn` flipped from `true` to `false` since
   *  the previous snapshot. Callers use this to close in-flight tails and
   *  clear pending rate-limiter entries for the project's agents. */
  optedOutProjectIds: string[];
}

export function setStateBlob(json: string): StateDiff {
  const prev = projects;
  try {
    const parsed = JSON.parse(json) as { projects?: unknown; tasks?: unknown };
    projects = coerceProjects(parsed.projects);
    tasks = coerceTasks(parsed.tasks);
  } catch {
    /* leave caches untouched on parse failure */
    return { optedOutProjectIds: [] };
  }
  const optedOutProjectIds: string[] = [];
  for (const [id, before] of prev) {
    if (!before.telegramOptIn) continue;
    const after = projects.get(id);
    if (!after || !after.telegramOptIn) optedOutProjectIds.push(id);
  }
  return { optedOutProjectIds };
}

export function bootstrap(): void {
  const raw = loadAppState();
  if (raw) setStateBlob(raw);
}

/** Visible for tests: clear the in-memory caches. */
export function _resetForTests(): void {
  projects = new Map();
  tasks = new Map();
}

export function getTaskForAgent(taskId: string): TaskInfo | null {
  return tasks.get(taskId) ?? null;
}

export function getProjectForTask(projectId: string): ProjectInfo | null {
  return projects.get(projectId) ?? null;
}

/** Convenience: resolve `agentId → project` via the agent's task. Requires
 *  pty's `getAgentMeta` to know about the agent. */
export function getProjectByAgentMeta(meta: { taskId: string }): ProjectInfo | null {
  const task = tasks.get(meta.taskId);
  if (!task) return null;
  return projects.get(task.projectId) ?? null;
}

export function getWorktreeByAgentMeta(meta: { taskId: string }): string | null {
  return tasks.get(meta.taskId)?.worktreePath ?? null;
}

export function getAllProjects(): ProjectInfo[] {
  return Array.from(projects.values());
}
