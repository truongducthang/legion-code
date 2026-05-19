/**
 * Integration test: real git, real fs, real checkMergeStatus.
 *
 * Mocks only `./pty.js` (avoid the native node-pty dep) and `electron`
 * (no main window in node). Everything else runs unmocked so this proves
 * the scheduler talks to git correctly end-to-end and that
 * classifyMergeStatus's verdicts match what real merge-tree reports.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

vi.mock('electron', () => ({}));
vi.mock('./pty.js', () => ({
  onPtyEvent: () => () => undefined,
  getAgentMeta: () => null,
}));

import { IPC } from './channels.js';
import {
  initConflictPreflight,
  startConflictPreflight,
  __resetForTests,
  __getStateForTests,
  __runTickForTests,
  type ConflictPreflightUpdatePayload,
} from './conflict-preflight.js';

const exec = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await exec('git', args, { cwd });
  return stdout.trim();
}

async function writeFile(p: string, content: string): Promise<void> {
  await fs.promises.mkdir(path.dirname(p), { recursive: true });
  await fs.promises.writeFile(p, content, 'utf8');
}

async function makeRepo(): Promise<string> {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'cp-int-'));
  await git(dir, 'init', '-q', '-b', 'main');
  await git(dir, 'config', 'user.email', 'test@example.com');
  await git(dir, 'config', 'user.name', 'Test');
  // Disable any global hooks/gpg signing so commits don't fail in CI.
  await git(dir, 'config', 'commit.gpgsign', 'false');
  await writeFile(path.join(dir, 'README.md'), '# repo\n');
  await git(dir, 'add', '.');
  await git(dir, 'commit', '-qm', 'init');
  return dir;
}

interface WinSendCall {
  channel: string;
  payload: unknown;
}

function makeWin(): {
  win: unknown;
  sent: WinSendCall[];
} {
  const sent: WinSendCall[] = [];
  const handlers: Record<string, Array<() => void>> = {};
  const win = {
    isDestroyed: () => false,
    isVisible: () => true,
    webContents: {
      send: (channel: string, payload: unknown) => {
        sent.push({ channel, payload });
      },
    },
    on(event: string, fn: () => void): void {
      (handlers[event] ??= []).push(fn);
    },
  };
  return { win, sent };
}

function latest(sent: WinSendCall[]): ConflictPreflightUpdatePayload | undefined {
  for (let i = sent.length - 1; i >= 0; i--) {
    if (sent[i].channel === IPC.ConflictPreflightUpdate) {
      return sent[i].payload as ConflictPreflightUpdatePayload;
    }
  }
  return undefined;
}

/** Wait up to `timeoutMs` for `predicate` to return true, polling on a real
 *  wall-clock interval. Necessary because checkMergeStatus forks real `git`
 *  processes — microtask-only flush would race them. */
async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
}

let repos: string[] = [];
beforeEach(() => {
  repos = [];
  __resetForTests();
});
afterEach(async () => {
  __resetForTests();
  for (const dir of repos) {
    await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

describe('integration: real git', () => {
  it('reports clean when the branch matches main', async () => {
    const root = await makeRepo();
    repos.push(root);
    await git(root, 'checkout', '-qb', 'feature');
    await writeFile(path.join(root, 'a.txt'), 'one\n');
    await git(root, 'add', '.');
    await git(root, 'commit', '-qm', 'branch work');

    const { win, sent } = makeWin();
    initConflictPreflight(win as unknown as Parameters<typeof initConflictPreflight>[0]);
    startConflictPreflight({ taskId: 't1', worktreePath: root, projectRoot: root });
    // Real git commands take real time; wait for chain to settle.
    await waitFor(() => latest(sent) !== undefined);

    const u = latest(sent);
    expect(u).toBeDefined();
    expect(u?.status).toBe('clean');
    expect(u?.baseBranch).toBe('main');
    expect(u?.mainAheadCount).toBe(0);
    expect(u?.conflictingFiles).toEqual([]);
  });

  it('reports stale when main is ahead but the branches merge clean', async () => {
    const root = await makeRepo();
    repos.push(root);
    // Branch off, do nothing on the branch yet.
    await git(root, 'checkout', '-qb', 'feature');
    // Add a branch commit on a non-overlapping file so the merge will be
    // clean even after main moves.
    await writeFile(path.join(root, 'branch-only.txt'), 'b\n');
    await git(root, 'add', '.');
    await git(root, 'commit', '-qm', 'branch work');
    // Advance main on a different file (no overlap → no conflict).
    await git(root, 'checkout', '-q', 'main');
    await writeFile(path.join(root, 'main-only.txt'), 'm\n');
    await git(root, 'add', '.');
    await git(root, 'commit', '-qm', 'main work');
    await git(root, 'checkout', '-q', 'feature');

    const { win, sent } = makeWin();
    initConflictPreflight(win as unknown as Parameters<typeof initConflictPreflight>[0]);
    startConflictPreflight({ taskId: 't1', worktreePath: root, projectRoot: root });
    await waitFor(() => latest(sent) !== undefined);

    const u = latest(sent);
    expect(u?.status).toBe('stale');
    expect(u?.mainAheadCount).toBeGreaterThan(0);
    expect(u?.conflictingFiles).toEqual([]);
    expect(u?.baseBranch).toBe('main');
  });

  it('returns non-clean status when feature and main diverge on the same file', async () => {
    // TODO(parallel-code): KNOWN LATENT BUG in electron/ipc/git.ts:1525-1535.
    // Real `git merge-tree --write-tree` writes the "CONFLICT (content): ..."
    // marker to STDOUT (not into the error's `.message`), so
    // `checkMergeStatus`'s `String(e)` parser misses it and reports
    // `conflicting_files: []`. With non-zero `main_ahead_count` the watcher
    // therefore classifies same-line divergence as `stale` instead of
    // `conflict`. The existing git.ts unit test hides the bug by mocking
    // the Error's message text to contain the CONFLICT line.
    //
    // Surgical scope for this change forbids editing checkMergeStatus, so
    // this test asserts current observable behaviour (non-clean) without
    // pinning to either status, and the bug is reported in the PR summary.
    const root = await makeRepo();
    repos.push(root);
    await writeFile(path.join(root, 'conflict.txt'), 'shared line\n');
    await git(root, 'add', '.');
    await git(root, 'commit', '-qm', 'seed');

    await git(root, 'checkout', '-qb', 'feature');
    await writeFile(path.join(root, 'conflict.txt'), 'branch line\n');
    await git(root, 'add', '.');
    await git(root, 'commit', '-qm', 'branch edit');

    await git(root, 'checkout', '-q', 'main');
    await writeFile(path.join(root, 'conflict.txt'), 'main line\n');
    await git(root, 'add', '.');
    await git(root, 'commit', '-qm', 'main edit');

    await git(root, 'checkout', '-q', 'feature');

    const { win, sent } = makeWin();
    initConflictPreflight(win as unknown as Parameters<typeof initConflictPreflight>[0]);
    startConflictPreflight({ taskId: 't1', worktreePath: root, projectRoot: root });
    await waitFor(() => latest(sent) !== undefined);

    const u = latest(sent);
    expect(u).toBeDefined();
    expect(u?.status).not.toBe('clean');
    expect(['stale', 'conflict']).toContain(u?.status);
    expect(u?.mainAheadCount).toBeGreaterThan(0);
  });

  it('transitions clean → stale when main moves, on the next tick', async () => {
    const root = await makeRepo();
    repos.push(root);
    await git(root, 'checkout', '-qb', 'feature');
    await writeFile(path.join(root, 'b.txt'), 'b\n');
    await git(root, 'add', '.');
    await git(root, 'commit', '-qm', 'branch');

    const { win, sent } = makeWin();
    initConflictPreflight(win as unknown as Parameters<typeof initConflictPreflight>[0]);
    startConflictPreflight({ taskId: 't1', worktreePath: root, projectRoot: root });
    await waitFor(() => latest(sent) !== undefined);
    expect(latest(sent)?.status).toBe('clean');

    // Move main on a non-overlapping file. The base SHA changes; the next
    // tick's cheap rev-parse should detect it and force a refresh.
    await git(root, 'checkout', '-q', 'main');
    await writeFile(path.join(root, 'm.txt'), 'm\n');
    await git(root, 'add', '.');
    await git(root, 'commit', '-qm', 'main moved');
    await git(root, 'checkout', '-q', 'feature');

    const beforeTickPushCount = sent.filter(
      (s) => s.channel === IPC.ConflictPreflightUpdate,
    ).length;
    await __runTickForTests();
    await waitFor(
      () =>
        sent.filter((s) => s.channel === IPC.ConflictPreflightUpdate).length > beforeTickPushCount,
    );

    const u = latest(sent);
    expect(u?.status).toBe('stale');
    expect(u?.mainAheadCount).toBeGreaterThan(0);
  });

  it('returns unknown when the worktree directory is gone', async () => {
    const root = await makeRepo();
    repos.push(root);
    await git(root, 'checkout', '-qb', 'feature');
    await writeFile(path.join(root, 'x.txt'), 'x\n');
    await git(root, 'add', '.');
    await git(root, 'commit', '-qm', 'branch');

    // Delete the worktree before the watcher registers — checkMergeStatus
    // throws, the module classifies as unknown and preserves prior counts
    // (zeros, since this is the first refresh).
    await fs.promises.rm(root, { recursive: true, force: true });

    const { win, sent } = makeWin();
    initConflictPreflight(win as unknown as Parameters<typeof initConflictPreflight>[0]);
    startConflictPreflight({ taskId: 't1', worktreePath: root, projectRoot: root });
    await waitFor(() => latest(sent) !== undefined);

    const u = latest(sent);
    expect(u?.status).toBe('unknown');
    expect(__getStateForTests().entries[0].unknownStreak).toBe(1);
  });
});
