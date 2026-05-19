import { createEffect, onCleanup } from 'solid-js';
import { createStore, produce, unwrap } from 'solid-js/store';
import { store } from './core';
import { getProject } from './projects';
import { fireAndForget } from '../lib/ipc';
import { IPC } from '../../electron/ipc/channels';
import type { ConflictPreflightStatus, ConflictPreflightUpdatePayload } from '../ipc/types';

export interface ConflictPreflightState {
  status: ConflictPreflightStatus;
  mainAheadCount: number;
  conflictingFiles: string[];
  baseBranch: string;
  checkedAt: string;
}

// Per-key reactivity: updating one task's state only re-runs accessors that
// read that task's key, not every badge-aware view.
const [conflictPreflight, setConflictPreflightStore] = createStore<
  Record<string, ConflictPreflightState>
>({});

export function getConflictPreflight(taskId: string): ConflictPreflightState | undefined {
  return conflictPreflight[taskId];
}

function setConflictPreflight(taskId: string, next: ConflictPreflightState): void {
  setConflictPreflightStore(taskId, next);
}

function removeConflictPreflight(taskId: string): void {
  if (!(taskId in unwrap(conflictPreflight))) return;
  setConflictPreflightStore(
    produce((s) => {
      delete s[taskId];
    }),
  );
}

interface ActiveSub {
  worktreePath: string;
  projectRoot: string;
}

export function startConflictPreflightSubscription(): () => void {
  const active = new Map<string, ActiveSub>();

  const offUpdate = window.electron.ipcRenderer.on(IPC.ConflictPreflightUpdate, (data: unknown) => {
    if (!data || typeof data !== 'object') return;
    const msg = data as Partial<ConflictPreflightUpdatePayload>;
    if (typeof msg.taskId !== 'string') return;
    if (!store.tasks[msg.taskId]) return;
    if (typeof msg.status !== 'string') return;
    setConflictPreflight(msg.taskId, {
      status: msg.status as ConflictPreflightStatus,
      mainAheadCount: typeof msg.mainAheadCount === 'number' ? msg.mainAheadCount : 0,
      conflictingFiles: Array.isArray(msg.conflictingFiles)
        ? (msg.conflictingFiles as string[])
        : [],
      baseBranch: typeof msg.baseBranch === 'string' ? msg.baseBranch : '',
      checkedAt: typeof msg.checkedAt === 'string' ? msg.checkedAt : new Date().toISOString(),
    });
  });

  createEffect(() => {
    const seen = new Set<string>();
    const allIds = [...store.taskOrder, ...store.collapsedTaskOrder];
    for (const taskId of allIds) {
      const task = store.tasks[taskId];
      if (!task) continue;
      // Only branches that can be merged back to a base are interesting.
      if (task.gitIsolation === 'none') continue;
      const projectRoot = getProject(task.projectId)?.path;
      if (!projectRoot) continue;
      seen.add(taskId);
      const prev = active.get(taskId);
      if (prev && prev.worktreePath === task.worktreePath && prev.projectRoot === projectRoot) {
        continue;
      }
      active.set(taskId, { worktreePath: task.worktreePath, projectRoot });
      fireAndForget(IPC.StartConflictPreflight, {
        taskId,
        worktreePath: task.worktreePath,
        projectRoot,
      });
    }
    for (const taskId of [...active.keys()]) {
      if (!seen.has(taskId)) {
        active.delete(taskId);
        removeConflictPreflight(taskId);
        fireAndForget(IPC.StopConflictPreflight, { taskId });
      }
    }
  });

  const cleanup = (): void => {
    offUpdate();
    for (const taskId of active.keys()) {
      fireAndForget(IPC.StopConflictPreflight, { taskId });
    }
    active.clear();
  };

  onCleanup(cleanup);
  return cleanup;
}
