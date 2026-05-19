import { describe, it, expect, vi, beforeEach } from 'vitest';
import { promisify } from 'util';

// --- Mocks ---

vi.mock('child_process', () => {
  const mockExecFile = vi.fn();
  (mockExecFile as unknown as Record<symbol, unknown>)[promisify.custom] = (
    file: unknown,
    args: unknown,
    opts: unknown,
  ): Promise<{ stdout: string; stderr: string }> =>
    new Promise((resolve, reject) => {
      mockExecFile(file, args, opts, (err: Error | null, stdout: string, stderr: string) => {
        if (err) reject(err);
        else resolve({ stdout, stderr });
      });
    });
  return { execFile: mockExecFile };
});

const mockCheckMergeStatus = vi.fn();
vi.mock('./git.js', () => ({
  checkMergeStatus: (worktreePath: string, baseBranch?: string) =>
    mockCheckMergeStatus(worktreePath, baseBranch),
}));

type PtyExitListener = (agentId: string, data?: unknown) => void;
let ptyExitListeners: PtyExitListener[] = [];
const mockGetAgentMeta = vi.fn();
vi.mock('./pty.js', () => ({
  onPtyEvent: (event: string, listener: PtyExitListener) => {
    if (event === 'exit') ptyExitListeners.push(listener);
    return () => {
      ptyExitListeners = ptyExitListeners.filter((l) => l !== listener);
    };
  },
  getAgentMeta: (agentId: string) => mockGetAgentMeta(agentId),
}));

// Minimal BrowserWindow stand-in. We let the test toggle `_visible` to drive
// show/hide and capture `webContents.send` payloads so we can assert update
// pushes.
interface WinHandle {
  win: {
    isDestroyed(): boolean;
    isVisible(): boolean;
    webContents: { send: ReturnType<typeof vi.fn> };
    on(event: string, fn: () => void): void;
    emit(event: string): void;
  };
  setVisible(v: boolean): void;
  emit(event: string): void;
}
function makeWin(): WinHandle {
  let visible = true;
  const handlers: Record<string, Array<() => void>> = {};
  const send = vi.fn();
  return {
    win: {
      isDestroyed: () => false,
      isVisible: () => visible,
      webContents: { send },
      on(event: string, fn: () => void) {
        (handlers[event] ??= []).push(fn);
      },
      emit(event: string) {
        for (const fn of handlers[event] ?? []) fn();
      },
    },
    setVisible(v: boolean) {
      visible = v;
    },
    emit(event: string) {
      this.win.emit(event);
    },
  };
}

vi.mock('electron', () => ({}));

import { execFile } from 'child_process';
import { IPC } from './channels.js';
import {
  classifyMergeStatus,
  initConflictPreflight,
  startConflictPreflight,
  stopConflictPreflight,
  __resetForTests,
  __getStateForTests,
  __runTickForTests,
  type ConflictPreflightUpdatePayload,
} from './conflict-preflight.js';

type ExecCb = (err: Error | null, stdout: string, stderr: string) => void;
type ExecHandler = (cmd: string, args: string[], cb: ExecCb) => void;

function stubExec(handler: ExecHandler): string[][] {
  const calls: string[][] = [];
  const impl = (cmd: string, args: string[], _opts: unknown, cb: ExecCb) => {
    calls.push([cmd, ...args]);
    handler(cmd, args, cb);
  };
  vi.mocked(execFile).mockImplementation(impl as unknown as typeof execFile);
  return calls;
}

function shaResponder(map: Record<string, string>): ExecHandler {
  return (cmd, args, cb) => {
    if (cmd === 'git' && args[0] === 'rev-parse') {
      const ref = args[1];
      const sha = map[ref];
      if (sha) cb(null, sha + '\n', '');
      else cb(new Error('unknown ref'), '', '');
      return;
    }
    cb(new Error(`unexpected exec: ${cmd} ${args.join(' ')}`), '', '');
  };
}

/** Drain microtasks so fire-and-forget refreshOne calls land. */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
}

function latestUpdate(handle: WinHandle): ConflictPreflightUpdatePayload | undefined {
  const calls = handle.win.webContents.send.mock.calls;
  for (let i = calls.length - 1; i >= 0; i--) {
    const [channel, payload] = calls[i];
    if (channel === IPC.ConflictPreflightUpdate) return payload as ConflictPreflightUpdatePayload;
  }
  return undefined;
}

function updateCount(handle: WinHandle): number {
  return handle.win.webContents.send.mock.calls.filter((c) => c[0] === IPC.ConflictPreflightUpdate)
    .length;
}

beforeEach(() => {
  vi.clearAllMocks();
  ptyExitListeners = [];
  __resetForTests();
});

describe('classifyMergeStatus', () => {
  it('main_ahead_count === 0 is clean', () => {
    expect(classifyMergeStatus({ main_ahead_count: 0, conflicting_files: [] })).toBe('clean');
    // Even if a file slipped in, ahead===0 means nothing to merge from main.
    expect(classifyMergeStatus({ main_ahead_count: 0, conflicting_files: ['a.ts'] })).toBe('clean');
  });
  it('ahead > 0 without conflicts is stale', () => {
    expect(classifyMergeStatus({ main_ahead_count: 3, conflicting_files: [] })).toBe('stale');
  });
  it('ahead > 0 with conflicts is conflict', () => {
    expect(classifyMergeStatus({ main_ahead_count: 2, conflicting_files: ['a.ts'] })).toBe(
      'conflict',
    );
  });
});

describe('startConflictPreflight — initial refresh + push', () => {
  it('registers the task and pushes one update after the first refresh', async () => {
    const handle = makeWin();
    initConflictPreflight(handle.win as unknown as Parameters<typeof initConflictPreflight>[0]);
    stubExec(shaResponder({ HEAD: 'head1', main: 'base1' }));
    mockCheckMergeStatus.mockResolvedValueOnce({
      main_ahead_count: 0,
      conflicting_files: [],
      base_branch: 'main',
    });

    startConflictPreflight({ taskId: 't1', worktreePath: '/r/wt1', projectRoot: '/r' });
    await flush();

    expect(__getStateForTests().taskIds).toEqual(['t1']);
    const u = latestUpdate(handle);
    expect(u).toBeDefined();
    expect(u?.status).toBe('clean');
    expect(u?.baseBranch).toBe('main');
  });

  it('re-issuing startConflictPreflight with the same worktreePath is a no-op', async () => {
    const handle = makeWin();
    initConflictPreflight(handle.win as unknown as Parameters<typeof initConflictPreflight>[0]);
    stubExec(shaResponder({ HEAD: 'head1', main: 'base1' }));
    mockCheckMergeStatus.mockResolvedValue({
      main_ahead_count: 0,
      conflicting_files: [],
      base_branch: 'main',
    });

    startConflictPreflight({ taskId: 't1', worktreePath: '/r/wt1', projectRoot: '/r' });
    await flush();
    const beforeCount = mockCheckMergeStatus.mock.calls.length;

    startConflictPreflight({ taskId: 't1', worktreePath: '/r/wt1', projectRoot: '/r' });
    await flush();

    expect(mockCheckMergeStatus.mock.calls.length).toBe(beforeCount);
  });

  it('re-issuing with a different worktreePath discards prior state and refreshes', async () => {
    const handle = makeWin();
    initConflictPreflight(handle.win as unknown as Parameters<typeof initConflictPreflight>[0]);
    stubExec(shaResponder({ HEAD: 'head1', main: 'base1' }));
    mockCheckMergeStatus
      .mockResolvedValueOnce({
        main_ahead_count: 2,
        conflicting_files: ['a.ts'],
        base_branch: 'main',
      })
      .mockResolvedValueOnce({
        main_ahead_count: 0,
        conflicting_files: [],
        base_branch: 'main',
      });

    startConflictPreflight({ taskId: 't1', worktreePath: '/r/wt1', projectRoot: '/r' });
    await flush();
    expect(__getStateForTests().entries[0].status).toBe('conflict');

    startConflictPreflight({ taskId: 't1', worktreePath: '/r/wt2', projectRoot: '/r' });
    await flush();
    expect(__getStateForTests().entries[0].status).toBe('clean');
    expect(__getStateForTests().entries[0].unknownStreak).toBe(0);
  });
});

describe('stopConflictPreflight', () => {
  it('removes the task and is idempotent on a second call', async () => {
    const handle = makeWin();
    initConflictPreflight(handle.win as unknown as Parameters<typeof initConflictPreflight>[0]);
    stubExec(shaResponder({ HEAD: 'h', main: 'b' }));
    mockCheckMergeStatus.mockResolvedValue({
      main_ahead_count: 0,
      conflicting_files: [],
      base_branch: 'main',
    });
    startConflictPreflight({ taskId: 't1', worktreePath: '/r/wt1', projectRoot: '/r' });
    await flush();
    stopConflictPreflight('t1');
    expect(__getStateForTests().taskIds).toEqual([]);
    stopConflictPreflight('t1');
    expect(__getStateForTests().taskIds).toEqual([]);
  });
});

describe('refresh cadence', () => {
  it('refreshes on every tick when status is conflict', async () => {
    const handle = makeWin();
    initConflictPreflight(handle.win as unknown as Parameters<typeof initConflictPreflight>[0]);
    stubExec(shaResponder({ HEAD: 'h1', main: 'b1' }));
    mockCheckMergeStatus.mockResolvedValue({
      main_ahead_count: 2,
      conflicting_files: ['a.ts'],
      base_branch: 'main',
    });

    startConflictPreflight({ taskId: 't1', worktreePath: '/r/wt', projectRoot: '/r' });
    await flush();
    expect(mockCheckMergeStatus.mock.calls.length).toBe(1);

    await __runTickForTests();
    expect(mockCheckMergeStatus.mock.calls.length).toBe(2);

    await __runTickForTests();
    expect(mockCheckMergeStatus.mock.calls.length).toBe(3);
  });

  it('does not re-run checkMergeStatus on the next tick for a settled clean task whose SHAs are unchanged', async () => {
    const handle = makeWin();
    initConflictPreflight(handle.win as unknown as Parameters<typeof initConflictPreflight>[0]);
    stubExec(shaResponder({ HEAD: 'h1', main: 'b1' }));
    mockCheckMergeStatus.mockResolvedValue({
      main_ahead_count: 0,
      conflicting_files: [],
      base_branch: 'main',
    });

    startConflictPreflight({ taskId: 't1', worktreePath: '/r/wt', projectRoot: '/r' });
    await flush();
    expect(mockCheckMergeStatus.mock.calls.length).toBe(1);

    await __runTickForTests();
    expect(mockCheckMergeStatus.mock.calls.length).toBe(1);
  });

  it('forces a refresh when HEAD SHA moves between ticks', async () => {
    const handle = makeWin();
    initConflictPreflight(handle.win as unknown as Parameters<typeof initConflictPreflight>[0]);
    let head = 'h1';
    stubExec((cmd, args, cb) => {
      if (cmd === 'git' && args[0] === 'rev-parse') {
        if (args[1] === 'HEAD') return cb(null, head + '\n', '');
        if (args[1] === 'main') return cb(null, 'b1\n', '');
      }
      cb(new Error('unexpected'), '', '');
    });
    mockCheckMergeStatus.mockResolvedValue({
      main_ahead_count: 0,
      conflicting_files: [],
      base_branch: 'main',
    });

    startConflictPreflight({ taskId: 't1', worktreePath: '/r/wt', projectRoot: '/r' });
    await flush();
    expect(mockCheckMergeStatus.mock.calls.length).toBe(1);

    head = 'h2';
    await __runTickForTests();
    expect(mockCheckMergeStatus.mock.calls.length).toBe(2);
  });

  it('forces a refresh when base branch SHA moves between ticks', async () => {
    const handle = makeWin();
    initConflictPreflight(handle.win as unknown as Parameters<typeof initConflictPreflight>[0]);
    let base = 'b1';
    stubExec((cmd, args, cb) => {
      if (cmd === 'git' && args[0] === 'rev-parse') {
        if (args[1] === 'HEAD') return cb(null, 'h1\n', '');
        if (args[1] === 'main') return cb(null, base + '\n', '');
      }
      cb(new Error('unexpected'), '', '');
    });
    mockCheckMergeStatus.mockResolvedValue({
      main_ahead_count: 0,
      conflicting_files: [],
      base_branch: 'main',
    });

    startConflictPreflight({ taskId: 't1', worktreePath: '/r/wt', projectRoot: '/r' });
    await flush();
    base = 'b2';
    await __runTickForTests();
    expect(mockCheckMergeStatus.mock.calls.length).toBe(2);
  });
});

describe('unknown back-off', () => {
  it('refreshes every tick for the first 3 unknown results, then backs off', async () => {
    const handle = makeWin();
    initConflictPreflight(handle.win as unknown as Parameters<typeof initConflictPreflight>[0]);
    stubExec(shaResponder({ HEAD: 'h', main: 'b' }));
    mockCheckMergeStatus.mockRejectedValue(new Error('worktree missing'));

    startConflictPreflight({ taskId: 't1', worktreePath: '/r/wt', projectRoot: '/r' });
    await flush();
    expect(__getStateForTests().entries[0].unknownStreak).toBe(1);

    await __runTickForTests();
    expect(mockCheckMergeStatus.mock.calls.length).toBe(2);
    expect(__getStateForTests().entries[0].unknownStreak).toBe(2);

    await __runTickForTests();
    expect(mockCheckMergeStatus.mock.calls.length).toBe(3);
    expect(__getStateForTests().entries[0].unknownStreak).toBe(3);

    // After 3 consecutive unknowns, schedule drops to 5-min cadence: a tick
    // shortly after should NOT issue another checkMergeStatus call.
    await __runTickForTests();
    expect(mockCheckMergeStatus.mock.calls.length).toBe(3);
  });

  it('resets streak after a successful non-unknown result', async () => {
    const handle = makeWin();
    initConflictPreflight(handle.win as unknown as Parameters<typeof initConflictPreflight>[0]);
    stubExec(shaResponder({ HEAD: 'h', main: 'b' }));
    mockCheckMergeStatus.mockRejectedValueOnce(new Error('flaky')).mockResolvedValueOnce({
      main_ahead_count: 0,
      conflicting_files: [],
      base_branch: 'main',
    });

    startConflictPreflight({ taskId: 't1', worktreePath: '/r/wt', projectRoot: '/r' });
    await flush();
    expect(__getStateForTests().entries[0].unknownStreak).toBe(1);

    await __runTickForTests();
    expect(__getStateForTests().entries[0].unknownStreak).toBe(0);
    expect(__getStateForTests().entries[0].status).toBe('clean');
  });

  it('preserves prior mainAheadCount/conflictingFiles on transient unknown', async () => {
    const handle = makeWin();
    initConflictPreflight(handle.win as unknown as Parameters<typeof initConflictPreflight>[0]);
    stubExec(shaResponder({ HEAD: 'h', main: 'b' }));
    mockCheckMergeStatus
      .mockResolvedValueOnce({
        main_ahead_count: 4,
        conflicting_files: ['a.ts', 'b.ts'],
        base_branch: 'main',
      })
      .mockRejectedValueOnce(new Error('git lock'));

    startConflictPreflight({ taskId: 't1', worktreePath: '/r/wt', projectRoot: '/r' });
    await flush();
    await __runTickForTests();

    const u = latestUpdate(handle);
    expect(u?.status).toBe('unknown');
    expect(u?.mainAheadCount).toBe(4);
    expect(u?.conflictingFiles).toEqual(['a.ts', 'b.ts']);
  });
});

describe('per-repo serialisation', () => {
  it('serialises two tasks in the same repo within a single tick', async () => {
    const handle = makeWin();
    initConflictPreflight(handle.win as unknown as Parameters<typeof initConflictPreflight>[0]);
    stubExec(shaResponder({ HEAD: 'h', main: 'b' }));

    let inFlight = 0;
    let maxConcurrent = 0;
    let release1 = (): void => undefined;
    let release2 = (): void => undefined;
    const gate1 = new Promise<void>((r) => {
      release1 = r;
    });
    const gate2 = new Promise<void>((r) => {
      release2 = r;
    });
    let callIdx = 0;
    mockCheckMergeStatus.mockImplementation(async () => {
      inFlight++;
      maxConcurrent = Math.max(maxConcurrent, inFlight);
      const gate = callIdx === 0 ? gate1 : gate2;
      callIdx++;
      await gate;
      inFlight--;
      return { main_ahead_count: 1, conflicting_files: ['x'], base_branch: 'main' };
    });

    startConflictPreflight({ taskId: 't1', worktreePath: '/r/a', projectRoot: '/r' });
    startConflictPreflight({ taskId: 't2', worktreePath: '/r/b', projectRoot: '/r' });
    await flush();
    expect(maxConcurrent).toBe(1);
    release1();
    await flush();
    release2();
    await flush();
    expect(mockCheckMergeStatus.mock.calls.length).toBe(2);
    expect(maxConcurrent).toBe(1);
  });

  it('runs refreshes in parallel for tasks in different repos', async () => {
    const handle = makeWin();
    initConflictPreflight(handle.win as unknown as Parameters<typeof initConflictPreflight>[0]);
    stubExec(shaResponder({ HEAD: 'h', main: 'b' }));

    let inFlight = 0;
    let maxConcurrent = 0;
    let release = (): void => undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    mockCheckMergeStatus.mockImplementation(async () => {
      inFlight++;
      maxConcurrent = Math.max(maxConcurrent, inFlight);
      await gate;
      inFlight--;
      return { main_ahead_count: 0, conflicting_files: [], base_branch: 'main' };
    });

    startConflictPreflight({ taskId: 't1', worktreePath: '/r1/wt', projectRoot: '/r1' });
    startConflictPreflight({ taskId: 't2', worktreePath: '/r2/wt', projectRoot: '/r2' });
    await flush();
    expect(maxConcurrent).toBe(2);
    release();
    await flush();
  });
});

describe('signal: PTY exit', () => {
  it('forces an immediate refresh when the task agent exits', async () => {
    const handle = makeWin();
    initConflictPreflight(handle.win as unknown as Parameters<typeof initConflictPreflight>[0]);
    stubExec(shaResponder({ HEAD: 'h', main: 'b' }));
    mockCheckMergeStatus.mockResolvedValue({
      main_ahead_count: 0,
      conflicting_files: [],
      base_branch: 'main',
    });
    mockGetAgentMeta.mockReturnValue({ taskId: 't1', agentId: 'a1', isShell: false });

    startConflictPreflight({ taskId: 't1', worktreePath: '/r/wt', projectRoot: '/r' });
    await flush();
    const before = mockCheckMergeStatus.mock.calls.length;

    for (const fn of ptyExitListeners) fn('a1');
    await flush();
    expect(mockCheckMergeStatus.mock.calls.length).toBe(before + 1);
  });

  it('ignores exit events for agents whose task is not registered', async () => {
    const handle = makeWin();
    initConflictPreflight(handle.win as unknown as Parameters<typeof initConflictPreflight>[0]);
    stubExec(shaResponder({ HEAD: 'h', main: 'b' }));
    mockGetAgentMeta.mockReturnValue({ taskId: 'other', agentId: 'a1', isShell: false });

    for (const fn of ptyExitListeners) fn('a1');
    await flush();
    expect(mockCheckMergeStatus).not.toHaveBeenCalled();
  });
});

describe('forced refresh dedupe', () => {
  it('drops a forced refresh when one is already in flight for the same task', async () => {
    const handle = makeWin();
    initConflictPreflight(handle.win as unknown as Parameters<typeof initConflictPreflight>[0]);
    stubExec(shaResponder({ HEAD: 'h', main: 'b' }));
    mockGetAgentMeta.mockReturnValue({ taskId: 't1', agentId: 'a1', isShell: false });
    let release = (): void => undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    mockCheckMergeStatus.mockImplementation(async () => {
      await gate;
      return { main_ahead_count: 0, conflicting_files: [], base_branch: 'main' };
    });

    startConflictPreflight({ taskId: 't1', worktreePath: '/r/wt', projectRoot: '/r' });
    // The initial refresh is now in flight (gate not released).
    await flush();
    expect(mockCheckMergeStatus.mock.calls.length).toBe(1);
    expect(__getStateForTests().entries[0].isRefreshing).toBe(true);

    // Forced refresh requests while the in-flight one holds isRefreshing
    // must be dropped, not queued.
    for (const fn of ptyExitListeners) fn('a1');
    for (const fn of ptyExitListeners) fn('a1');
    await flush();
    expect(mockCheckMergeStatus.mock.calls.length).toBe(1);

    release();
    await flush();
    expect(__getStateForTests().entries[0].isRefreshing).toBe(false);
  });
});

describe('window visibility gating', () => {
  it('does not pause polling on blur (window still visible)', async () => {
    const handle = makeWin();
    initConflictPreflight(handle.win as unknown as Parameters<typeof initConflictPreflight>[0]);
    stubExec(shaResponder({ HEAD: 'h', main: 'b' }));
    mockCheckMergeStatus.mockResolvedValue({
      main_ahead_count: 2,
      conflicting_files: ['a.ts'],
      base_branch: 'main',
    });
    startConflictPreflight({ taskId: 't1', worktreePath: '/r/wt', projectRoot: '/r' });
    await flush();
    // Blur is not subscribed by the module — emitting it should be a no-op
    // and the interval must remain armed.
    handle.emit('blur');
    expect(__getStateForTests().intervalActive).toBe(true);
  });

  it('clears the interval on hide and re-establishes + ticks on show', async () => {
    const handle = makeWin();
    initConflictPreflight(handle.win as unknown as Parameters<typeof initConflictPreflight>[0]);
    stubExec(shaResponder({ HEAD: 'h', main: 'b' }));
    mockCheckMergeStatus.mockResolvedValue({
      main_ahead_count: 2,
      conflicting_files: ['a.ts'],
      base_branch: 'main',
    });

    startConflictPreflight({ taskId: 't1', worktreePath: '/r/wt', projectRoot: '/r' });
    await flush();
    expect(__getStateForTests().intervalActive).toBe(true);

    handle.setVisible(false);
    handle.emit('hide');
    expect(__getStateForTests().intervalActive).toBe(false);

    handle.setVisible(true);
    handle.emit('show');
    await flush();
    expect(__getStateForTests().intervalActive).toBe(true);
    // Immediate tick on show ran an additional refresh.
    expect(mockCheckMergeStatus.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('clears interval on minimize and resumes on restore', async () => {
    const handle = makeWin();
    initConflictPreflight(handle.win as unknown as Parameters<typeof initConflictPreflight>[0]);
    stubExec(shaResponder({ HEAD: 'h', main: 'b' }));
    mockCheckMergeStatus.mockResolvedValue({
      main_ahead_count: 0,
      conflicting_files: [],
      base_branch: 'main',
    });
    startConflictPreflight({ taskId: 't1', worktreePath: '/r/wt', projectRoot: '/r' });
    await flush();
    handle.emit('minimize');
    expect(__getStateForTests().intervalActive).toBe(false);
    handle.emit('restore');
    await flush();
    expect(__getStateForTests().intervalActive).toBe(true);
  });
});

describe('update payload shape', () => {
  it('emits every spec-defined field on the push channel', async () => {
    const handle = makeWin();
    initConflictPreflight(handle.win as unknown as Parameters<typeof initConflictPreflight>[0]);
    stubExec(shaResponder({ HEAD: 'h1', main: 'b1' }));
    mockCheckMergeStatus.mockResolvedValueOnce({
      main_ahead_count: 3,
      conflicting_files: ['a.ts', 'b.ts'],
      base_branch: 'main',
    });

    startConflictPreflight({ taskId: 't1', worktreePath: '/r/wt', projectRoot: '/r' });
    await flush();

    const u = latestUpdate(handle);
    expect(u).toBeDefined();
    expect(u?.taskId).toBe('t1');
    expect(u?.status).toBe('conflict');
    expect(u?.mainAheadCount).toBe(3);
    expect(u?.conflictingFiles).toEqual(['a.ts', 'b.ts']);
    expect(u?.baseBranch).toBe('main');
    expect(typeof u?.checkedAt).toBe('string');
    // checkedAt should be a valid ISO timestamp.
    const checkedAt = u?.checkedAt ?? '';
    expect(() => new Date(checkedAt).toISOString()).not.toThrow();
  });
});

describe('no-op dedupe', () => {
  it('does not push an update when nothing changed between refreshes', async () => {
    const handle = makeWin();
    initConflictPreflight(handle.win as unknown as Parameters<typeof initConflictPreflight>[0]);
    stubExec(shaResponder({ HEAD: 'h1', main: 'b1' }));
    mockCheckMergeStatus.mockResolvedValue({
      main_ahead_count: 2,
      conflicting_files: ['a.ts'],
      base_branch: 'main',
    });

    startConflictPreflight({ taskId: 't1', worktreePath: '/r/wt', projectRoot: '/r' });
    await flush();
    const initial = updateCount(handle);
    expect(initial).toBe(1);

    await __runTickForTests();
    expect(updateCount(handle)).toBe(initial); // no new push
  });
});
