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

interface ProjectInfo {
  id: string;
  name: string;
  telegramOptIn: boolean;
  telegramPauseOnBackpressure: boolean;
}

interface TaskInfo {
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

export function setStateBlob(json: string): void {
  try {
    const parsed = JSON.parse(json) as { projects?: unknown; tasks?: unknown };
    projects = coerceProjects(parsed.projects);
    tasks = coerceTasks(parsed.tasks);
  } catch {
    /* leave caches untouched on parse failure */
  }
}

export function bootstrap(): void {
  const raw = loadAppState();
  if (raw) setStateBlob(raw);
}

export function getTaskForAgent(taskId: string): TaskInfo | null {
  return tasks.get(taskId) ?? null;
}

export function getProjectForTask(projectId: string): ProjectInfo | null {
  return projects.get(projectId) ?? null;
}
