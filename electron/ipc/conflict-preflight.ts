import { execFile } from 'child_process';
import { promisify } from 'util';
import type { BrowserWindow } from 'electron';
import { IPC } from './channels.js';
import { checkMergeStatus } from './git.js';
import { onPtyEvent, getAgentMeta } from './pty.js';

const exec = promisify(execFile);

const TICK_MS = 60_000;
const SETTLED_REFRESH_MS = 5 * 60_000;
const UNKNOWN_BACKOFF_THRESHOLD = 3;
const REV_PARSE_TIMEOUT_MS = 5_000;

export type ConflictPreflightStatus = 'clean' | 'stale' | 'conflict' | 'unknown';

export interface ConflictPreflightUpdatePayload {
  taskId: string;
  status: ConflictPreflightStatus;
  mainAheadCount: number;
  conflictingFiles: string[];
  baseBranch: string;
  checkedAt: string;
}

interface TaskEntry {
  taskId: string;
  worktreePath: string;
  projectRoot: string;
  status: ConflictPreflightStatus;
  mainAheadCount: number;
  conflictingFiles: string[];
  baseBranch: string;
  headSha: string | null;
  baseSha: string | null;
  /** ms epoch; 0 means never refreshed (initial state). */
  lastCheckedAt: number;
  /** Consecutive `unknown` results. Resets to 0 on any non-unknown result. */
  unknownStreak: number;
  /** True while a heavy `checkMergeStatus` is in flight for this task. */
  isRefreshing: boolean;
}

let win: BrowserWindow | null = null;
let tasks = new Map<string, TaskEntry>();
let tickHandle: ReturnType<typeof setInterval> | null = null;
const repoTail = new Map<string, Promise<unknown>>();
let ptyExitUnsub: (() => void) | null = null;

/** Wire window-lifecycle listeners and the PTY exit signal. Call once from
 *  `registerAllHandlers`. We do NOT pause on `blur` — the user may be in
 *  another app while a long-running agent finishes, and the badge should
 *  still be fresh when they tab back. */
export function initConflictPreflight(mainWindow: BrowserWindow): void {
  win = mainWindow;
  mainWindow.on('show', () => onWindowResume('show'));
  mainWindow.on('restore', () => onWindowResume('restore'));
  mainWindow.on('hide', () => clearTickInterval());
  mainWindow.on('minimize', () => clearTickInterval());
  mainWindow.on('closed', () => {
    win = null;
    clearTickInterval();
    tasks.clear();
    repoTail.clear();
    if (ptyExitUnsub) {
      ptyExitUnsub();
      ptyExitUnsub = null;
    }
  });
  if (!ptyExitUnsub) {
    ptyExitUnsub = onPtyEvent('exit', (agentId) => {
      const meta = getAgentMeta(agentId);
      if (!meta || !tasks.has(meta.taskId)) return;
      void refreshOne(meta.taskId).catch((err) =>
        console.warn('[conflict-preflight] forced refresh on PTY exit failed:', err),
      );
    });
  }
}

function onWindowResume(_event: 'show' | 'restore'): void {
  if (tasks.size === 0) return;
  ensureInterval();
  void runTick().catch((err) => console.warn('[conflict-preflight] resume tick failed:', err));
}

/** Renderer-driven start. Registers (or resets) a task and triggers an
 *  immediate refresh. Re-issuing with the same worktreePath is a no-op so
 *  the renderer can call this idempotently on rerender. */
export function startConflictPreflight(args: {
  taskId: string;
  worktreePath: string;
  projectRoot: string;
}): void {
  const existing = tasks.get(args.taskId);
  if (existing && existing.worktreePath === args.worktreePath) return;

  tasks.set(args.taskId, {
    taskId: args.taskId,
    worktreePath: args.worktreePath,
    projectRoot: args.projectRoot,
    status: 'unknown',
    mainAheadCount: 0,
    conflictingFiles: [],
    baseBranch: '',
    headSha: null,
    baseSha: null,
    lastCheckedAt: 0,
    unknownStreak: 0,
    isRefreshing: false,
  });
  ensureInterval();
  void refreshOne(args.taskId).catch((err) =>
    console.warn('[conflict-preflight] initial refresh failed:', err),
  );
}

export function stopConflictPreflight(taskId: string): void {
  tasks.delete(taskId);
  if (tasks.size === 0) clearTickInterval();
}

function windowIsVisible(): boolean {
  return !!win && !win.isDestroyed() && win.isVisible();
}

function ensureInterval(): void {
  if (tickHandle) return;
  if (!windowIsVisible()) return;
  tickHandle = setInterval(() => {
    runTick().catch((err) => console.warn('[conflict-preflight] tick failed:', err));
  }, TICK_MS);
  tickHandle.unref();
}

function clearTickInterval(): void {
  if (tickHandle) {
    clearInterval(tickHandle);
    tickHandle = null;
  }
}

/** Schedule-based due check. The SHA-change signal is handled separately
 *  during `runTick` so we still notice work landing between scheduled ticks
 *  on settled branches. */
function isDueBySchedule(entry: TaskEntry, now: number): boolean {
  if (entry.lastCheckedAt === 0) return true;
  if (entry.status === 'conflict') return true;
  if (entry.status === 'unknown' && entry.unknownStreak < UNKNOWN_BACKOFF_THRESHOLD) return true;
  return now - entry.lastCheckedAt >= SETTLED_REFRESH_MS;
}

async function runTick(): Promise<void> {
  const now = Date.now();
  const byRepo = new Map<string, TaskEntry[]>();
  for (const entry of tasks.values()) {
    const list = byRepo.get(entry.projectRoot) ?? [];
    list.push(entry);
    byRepo.set(entry.projectRoot, list);
  }

  // Process each repo's tasks sequentially (one heavy `git` process at a
  // time per `.git/`); fan out across repos.
  await Promise.all(
    Array.from(byRepo.values()).map(async (list) => {
      for (const entry of list) {
        if (entry.isRefreshing) continue;
        let trigger: 'schedule' | 'sha-change' | null = null;
        if (isDueBySchedule(entry, now)) {
          trigger = 'schedule';
        } else if (entry.baseBranch) {
          // Cheap SHA poll for settled tasks: head or base may have moved
          // since the last full refresh. We skip the rev-parse altogether
          // for tasks that never finished a successful refresh (no
          // baseBranch yet) — they're handled by the schedule branch.
          const [newHead, newBase] = await Promise.all([
            readSha(entry.worktreePath, 'HEAD'),
            readSha(entry.worktreePath, entry.baseBranch),
          ]);
          const headChanged = newHead !== null && newHead !== entry.headSha;
          const baseChanged = newBase !== null && newBase !== entry.baseSha;
          if (headChanged || baseChanged) trigger = 'sha-change';
        }
        if (!trigger) continue;
        await refreshOne(entry.taskId).catch((err) =>
          console.warn('[conflict-preflight] refresh failed:', err),
        );
      }
    }),
  );
}

async function readSha(repoPath: string, ref: string): Promise<string | null> {
  try {
    const { stdout } = await exec('git', ['rev-parse', ref], {
      cwd: repoPath,
      timeout: REV_PARSE_TIMEOUT_MS,
    });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

async function refreshOne(taskId: string): Promise<void> {
  const entry = tasks.get(taskId);
  if (!entry || entry.isRefreshing) return;
  entry.isRefreshing = true;
  try {
    await withRepoLock(entry.projectRoot, () => doRefresh(taskId));
  } finally {
    const current = tasks.get(taskId);
    if (current) current.isRefreshing = false;
  }
}

/** Serialise refreshes against a single `.git/` so a multi-task user
 *  doesn't fork N git processes against the same repo on a single tick. */
function withRepoLock<T>(projectRoot: string, fn: () => Promise<T>): Promise<T> {
  const prev = repoTail.get(projectRoot) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  repoTail.set(projectRoot, next);
  // Drop the tail entry once it settles so we don't grow forever; only if
  // nothing else has chained onto it.
  next.finally(() => {
    if (repoTail.get(projectRoot) === next) repoTail.delete(projectRoot);
  });
  return next;
}

async function doRefresh(taskId: string): Promise<void> {
  const entry = tasks.get(taskId);
  if (!entry) return;

  let result: Awaited<ReturnType<typeof checkMergeStatus>>;
  try {
    result = await checkMergeStatus(entry.worktreePath);
  } catch (err) {
    handleUnknown(entry);
    console.warn('[conflict-preflight] checkMergeStatus failed:', (err as Error)?.message ?? err);
    return;
  }

  const [newHead, newBase] = await Promise.all([
    readSha(entry.worktreePath, 'HEAD'),
    readSha(entry.worktreePath, result.base_branch),
  ]);

  const status = classifyMergeStatus(result);
  applyResult(entry, status, result, newHead, newBase);
}

/** Pure reducer for the status taxonomy — exported for unit tests. */
export function classifyMergeStatus(result: {
  main_ahead_count: number;
  conflicting_files: string[];
}): ConflictPreflightStatus {
  if (result.main_ahead_count === 0) return 'clean';
  if (result.conflicting_files.length === 0) return 'stale';
  return 'conflict';
}

function applyResult(
  entry: TaskEntry,
  status: ConflictPreflightStatus,
  result: { main_ahead_count: number; conflicting_files: string[]; base_branch: string },
  newHead: string | null,
  newBase: string | null,
): void {
  const firstRefresh = entry.lastCheckedAt === 0;
  const nothingChanged =
    !firstRefresh &&
    entry.status === status &&
    entry.mainAheadCount === result.main_ahead_count &&
    sameStringArray(entry.conflictingFiles, result.conflicting_files) &&
    entry.baseBranch === result.base_branch &&
    entry.headSha === newHead;

  entry.status = status;
  entry.mainAheadCount = result.main_ahead_count;
  entry.conflictingFiles = result.conflicting_files;
  entry.baseBranch = result.base_branch;
  entry.headSha = newHead;
  entry.baseSha = newBase;
  entry.lastCheckedAt = Date.now();
  entry.unknownStreak = 0;

  if (!nothingChanged) sendUpdate(entry);
}

function handleUnknown(entry: TaskEntry): void {
  const firstRefresh = entry.lastCheckedAt === 0;
  const wasUnknown = entry.status === 'unknown';
  // Preserve previously-reported mainAheadCount / conflictingFiles / baseBranch
  // so the badge doesn't flicker to zero on a transient git failure.
  entry.status = 'unknown';
  entry.unknownStreak += 1;
  entry.lastCheckedAt = Date.now();
  if (firstRefresh || !wasUnknown) sendUpdate(entry);
}

function sendUpdate(entry: TaskEntry): void {
  if (!win || win.isDestroyed()) return;
  const payload: ConflictPreflightUpdatePayload = {
    taskId: entry.taskId,
    status: entry.status,
    mainAheadCount: entry.mainAheadCount,
    conflictingFiles: entry.conflictingFiles,
    baseBranch: entry.baseBranch,
    checkedAt: new Date(entry.lastCheckedAt).toISOString(),
  };
  win.webContents.send(IPC.ConflictPreflightUpdate, payload);
}

function sameStringArray(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// --- Test seams ---

/** Reset module state for tests only. */
export function __resetForTests(): void {
  win = null;
  tasks = new Map();
  clearTickInterval();
  repoTail.clear();
  if (ptyExitUnsub) {
    ptyExitUnsub();
    ptyExitUnsub = null;
  }
}

export function __getStateForTests(): {
  taskIds: string[];
  intervalActive: boolean;
  entries: Array<{
    taskId: string;
    status: ConflictPreflightStatus;
    unknownStreak: number;
    headSha: string | null;
    baseSha: string | null;
    lastCheckedAt: number;
    isRefreshing: boolean;
  }>;
} {
  return {
    taskIds: Array.from(tasks.keys()),
    intervalActive: tickHandle !== null,
    entries: Array.from(tasks.values()).map((e) => ({
      taskId: e.taskId,
      status: e.status,
      unknownStreak: e.unknownStreak,
      headSha: e.headSha,
      baseSha: e.baseSha,
      lastCheckedAt: e.lastCheckedAt,
      isRefreshing: e.isRefreshing,
    })),
  };
}

/** Drive a tick from tests (skips the timer). */
export async function __runTickForTests(): Promise<void> {
  await runTick();
}

/** Trigger refresh as if the PTY exited for the agent's task, from tests. */
export async function __refreshForTests(taskId: string): Promise<void> {
  await refreshOne(taskId);
}
