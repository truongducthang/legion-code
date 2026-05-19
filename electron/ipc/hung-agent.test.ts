import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { BrowserWindow } from 'electron';

const { mockState, mockWriteToAgent } = vi.hoisted(() => {
  type Snap = { agentId: string; taskId: string; lastDataAt: number };
  const state = {
    snapshot: [] as Snap[],
    exitListeners: new Set<(agentId: string) => void>(),
    notificationSupported: true,
    notifications: [] as { title: string; body: string }[],
  };
  return { mockState: state, mockWriteToAgent: vi.fn() };
});

vi.mock('./pty.js', () => ({
  onPtyEvent: (event: string, listener: (agentId: string) => void) => {
    if (event === 'exit') {
      mockState.exitListeners.add(listener);
      return () => mockState.exitListeners.delete(listener);
    }
    return () => {};
  },
  snapshotRunningAgents: () => [...mockState.snapshot],
  writeToAgent: mockWriteToAgent,
}));

vi.mock('electron', () => ({
  Notification: class {
    static isSupported(): boolean {
      return mockState.notificationSupported;
    }
    constructor(opts: { title: string; body: string }) {
      mockState.notifications.push(opts);
    }
    on(): void {}
    show(): void {}
    close(): void {}
  },
}));

vi.mock('../log.js', () => ({
  warn: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
}));

import {
  classify,
  validateSettings,
  nudgeAgent,
  __resetForTests,
  __initForTests,
  __runTickForTests,
  __getStateForTests,
  __ensureIntervalForTests,
  __clearTickForTests,
  type HungAgentSettings,
  type HungAgentUpdatePayload,
} from './hung-agent.js';

function makeWin(opts?: { visible?: boolean; destroyed?: boolean }): {
  win: BrowserWindow;
  sent: { channel: string; payload: HungAgentUpdatePayload }[];
} {
  const sent: { channel: string; payload: HungAgentUpdatePayload }[] = [];
  const win = {
    isDestroyed: vi.fn(() => opts?.destroyed === true),
    isVisible: vi.fn(() => opts?.visible !== false),
    webContents: {
      send: (channel: string, payload: HungAgentUpdatePayload) => sent.push({ channel, payload }),
    },
  } as unknown as BrowserWindow;
  return { win, sent };
}

function defaults(overrides: Partial<HungAgentSettings> = {}): HungAgentSettings {
  return {
    idleThresholdMs: 5 * 60 * 1000,
    hungThresholdMs: 15 * 60 * 1000,
    ...overrides,
  };
}

beforeEach(() => {
  mockState.snapshot = [];
  mockState.exitListeners = new Set();
  mockState.notificationSupported = true;
  mockState.notifications = [];
  mockWriteToAgent.mockReset();
  __resetForTests();
});

afterEach(() => {
  __resetForTests();
});

describe('classify', () => {
  const s = defaults();

  it('active when silentMs < idle threshold', () => {
    expect(classify(0, s)).toBe('active');
    expect(classify(s.idleThresholdMs - 1, s)).toBe('active');
  });

  it('idle when silentMs in [idle, hung)', () => {
    expect(classify(s.idleThresholdMs, s)).toBe('idle');
    expect(classify(s.hungThresholdMs - 1, s)).toBe('idle');
  });

  it('hung when silentMs >= hung threshold', () => {
    expect(classify(s.hungThresholdMs, s)).toBe('hung');
    expect(classify(s.hungThresholdMs * 10, s)).toBe('hung');
  });

  it('idleThresholdMs=0 skips straight to hung', () => {
    const cfg = defaults({ idleThresholdMs: 0 });
    expect(classify(0, cfg)).toBe('active');
    expect(classify(cfg.hungThresholdMs - 1, cfg)).toBe('active');
    expect(classify(cfg.hungThresholdMs, cfg)).toBe('hung');
  });

  it('hungThresholdMs=0 keeps every agent active (detector disabled)', () => {
    const cfg = defaults({ hungThresholdMs: 0, idleThresholdMs: 1000 });
    expect(classify(0, cfg)).toBe('active');
    expect(classify(1_000_000, cfg)).toBe('active');
  });
});

describe('validateSettings', () => {
  it('accepts integer pair within bounds', () => {
    expect(validateSettings({ idleThresholdMs: 1000, hungThresholdMs: 2000 })).toEqual({
      idleThresholdMs: 1000,
      hungThresholdMs: 2000,
    });
  });

  it('accepts both zero (detector disabled)', () => {
    expect(validateSettings({ idleThresholdMs: 0, hungThresholdMs: 0 })).toEqual({
      idleThresholdMs: 0,
      hungThresholdMs: 0,
    });
  });

  it('accepts idle=0 with hung>0', () => {
    expect(validateSettings({ idleThresholdMs: 0, hungThresholdMs: 60_000 })).toEqual({
      idleThresholdMs: 0,
      hungThresholdMs: 60_000,
    });
  });

  it('rejects non-integers', () => {
    expect(() => validateSettings({ idleThresholdMs: 1.5, hungThresholdMs: 2000 })).toThrow(
      /integer/,
    );
    expect(() => validateSettings({ idleThresholdMs: '1000', hungThresholdMs: 2000 })).toThrow(
      /integer/,
    );
  });

  it('rejects negatives', () => {
    expect(() => validateSettings({ idleThresholdMs: -1, hungThresholdMs: 2000 })).toThrow();
  });

  it('rejects values above 24 h', () => {
    expect(() =>
      validateSettings({ idleThresholdMs: 86_400_001, hungThresholdMs: 2000 }),
    ).toThrow();
  });

  it('rejects hung < idle when idle > 0', () => {
    expect(() => validateSettings({ idleThresholdMs: 5000, hungThresholdMs: 1000 })).toThrow(
      />= idleThresholdMs/,
    );
  });

  it('rejects non-object input', () => {
    expect(() => validateSettings(null)).toThrow();
    expect(() => validateSettings('hi')).toThrow();
  });
});

describe('runTick — taxonomy and transition pushes', () => {
  it('first observation is recorded silently (no push)', () => {
    const { win, sent } = makeWin();
    __initForTests({ win, settings: defaults(), now: () => 1_000_000 });

    mockState.snapshot = [{ agentId: 'a1', taskId: 't1', lastDataAt: 1_000_000 }];
    __runTickForTests();

    expect(sent).toEqual([]);
    expect(__getStateForTests().prevStatus.get('a1')).toBe('active');
  });

  it('pushes update on transition to idle', () => {
    let now = 0;
    const { win, sent } = makeWin();
    __initForTests({ win, settings: defaults(), now: () => now });

    // Tick 1: active, record silently
    now = 1_000_000;
    mockState.snapshot = [{ agentId: 'a1', taskId: 't1', lastDataAt: now }];
    __runTickForTests();
    expect(sent).toEqual([]);

    // Tick 2: 5+ min later, no new output → idle
    now = 1_000_000 + 6 * 60_000;
    __runTickForTests();
    expect(sent.length).toBe(1);
    expect(sent[0].payload.status).toBe('idle');
    expect(sent[0].payload.agentId).toBe('a1');
    expect(sent[0].payload.silentMs).toBe(6 * 60_000);
  });

  it('does not push when status is unchanged across ticks', () => {
    let now = 1_000_000;
    const { win, sent } = makeWin();
    __initForTests({ win, settings: defaults(), now: () => now });

    mockState.snapshot = [{ agentId: 'a1', taskId: 't1', lastDataAt: 1_000_000 }];
    __runTickForTests(); // record active silently
    __runTickForTests(); // still active, no push

    now += 30_000;
    __runTickForTests(); // still active

    expect(sent).toEqual([]);
  });
});

describe('runTick — notification dedupe', () => {
  it('fires one notification on active→hung transition', () => {
    let now = 1_000_000;
    const { win } = makeWin();
    __initForTests({ win, settings: defaults(), now: () => now });

    mockState.snapshot = [{ agentId: 'a1', taskId: 't1', lastDataAt: 1_000_000 }];
    __runTickForTests(); // record active

    now += 20 * 60_000; // >15 min silent → hung
    __runTickForTests();

    expect(mockState.notifications.length).toBe(1);
    expect(mockState.notifications[0].title).toContain('t1');
    expect(mockState.notifications[0].body).toMatch(/Silent for/);
  });

  it('does not re-notify while agent stays hung', () => {
    let now = 1_000_000;
    const { win } = makeWin();
    __initForTests({ win, settings: defaults(), now: () => now });

    mockState.snapshot = [{ agentId: 'a1', taskId: 't1', lastDataAt: 1_000_000 }];
    __runTickForTests(); // active

    now += 20 * 60_000;
    __runTickForTests(); // hung — notify

    now += 30_000;
    __runTickForTests(); // still hung
    now += 30_000;
    __runTickForTests(); // still hung

    expect(mockState.notifications.length).toBe(1);
  });

  it('recovery clears dedupe so next hung onset notifies again', () => {
    let now = 1_000_000;
    const { win } = makeWin();
    __initForTests({ win, settings: defaults(), now: () => now });

    mockState.snapshot = [{ agentId: 'a1', taskId: 't1', lastDataAt: now }];
    __runTickForTests(); // active

    now += 20 * 60_000;
    __runTickForTests(); // hung, notify

    // Recovery: agent emits output → lastDataAt jumps to now
    mockState.snapshot = [{ agentId: 'a1', taskId: 't1', lastDataAt: now }];
    __runTickForTests(); // active again, dedupe cleared

    expect(__getStateForTests().hungNotified.has('a1')).toBe(false);

    // Silent again
    now += 20 * 60_000;
    __runTickForTests(); // hung again — second notification

    expect(mockState.notifications.length).toBe(2);
  });

  it('skips notification but still pushes update when Notification API unavailable', () => {
    mockState.notificationSupported = false;
    let now = 1_000_000;
    const { win, sent } = makeWin();
    __initForTests({ win, settings: defaults(), now: () => now });

    mockState.snapshot = [{ agentId: 'a1', taskId: 't1', lastDataAt: now }];
    __runTickForTests(); // active

    now += 20 * 60_000;
    __runTickForTests(); // hung

    expect(mockState.notifications.length).toBe(0);
    expect(sent.find((s) => s.payload.status === 'hung')).toBeTruthy();
  });
});

describe('runTick — threshold edge cases', () => {
  it('idleThresholdMs=0 — agents skip active→hung directly', () => {
    let now = 1_000_000;
    const { win, sent } = makeWin();
    __initForTests({
      win,
      settings: { idleThresholdMs: 0, hungThresholdMs: 15 * 60_000 },
      now: () => now,
    });

    mockState.snapshot = [{ agentId: 'a1', taskId: 't1', lastDataAt: now }];
    __runTickForTests(); // record active

    // Below hung threshold, still active (never idle)
    now += 5 * 60_000;
    __runTickForTests();
    expect(sent.length).toBe(0);

    // Cross hung threshold
    now += 15 * 60_000;
    __runTickForTests();
    expect(sent.length).toBe(1);
    expect(sent[0].payload.status).toBe('hung');
  });

  it('hungThresholdMs=0 — detector entirely disabled, no idle/hung pushes', () => {
    let now = 1_000_000;
    const { win, sent } = makeWin();
    __initForTests({
      win,
      settings: { idleThresholdMs: 1000, hungThresholdMs: 0 },
      now: () => now,
    });

    mockState.snapshot = [{ agentId: 'a1', taskId: 't1', lastDataAt: now }];
    __runTickForTests();

    now += 24 * 60 * 60 * 1000;
    __runTickForTests();
    __runTickForTests();

    expect(sent.find((s) => s.payload.status !== 'active')).toBeUndefined();
    expect(mockState.notifications.length).toBe(0);
  });
});

describe('runTick — cleanup', () => {
  it('drops bookkeeping when an agent disappears from the snapshot', () => {
    const now = 1_000_000;
    const { win } = makeWin();
    __initForTests({ win, settings: defaults(), now: () => now });

    mockState.snapshot = [{ agentId: 'a1', taskId: 't1', lastDataAt: now }];
    __runTickForTests();
    expect(__getStateForTests().prevStatus.has('a1')).toBe(true);

    mockState.snapshot = [];
    __runTickForTests();
    expect(__getStateForTests().prevStatus.has('a1')).toBe(false);
  });

  it('PTY exit listener clears prevStatus and hungNotified for that agent', () => {
    let now = 1_000_000;
    const { win } = makeWin();
    __initForTests({ win, settings: defaults(), now: () => now });

    mockState.snapshot = [{ agentId: 'a1', taskId: 't1', lastDataAt: now }];
    __runTickForTests();
    now += 20 * 60_000;
    __runTickForTests(); // hung → notified

    expect(__getStateForTests().hungNotified.has('a1')).toBe(true);
    for (const listener of mockState.exitListeners) listener('a1');
    expect(__getStateForTests().prevStatus.has('a1')).toBe(false);
    expect(__getStateForTests().hungNotified.has('a1')).toBe(false);
  });
});

describe('window visibility gating', () => {
  it('ensureInterval is a no-op when the window is not visible', () => {
    const { win } = makeWin({ visible: false });
    __initForTests({ win, settings: defaults() });

    __ensureIntervalForTests();
    expect(__getStateForTests().tickActive).toBe(false);
  });

  it('ensureInterval starts the interval when the window is visible', () => {
    const { win } = makeWin({ visible: true });
    __initForTests({ win, settings: defaults() });

    __ensureIntervalForTests();
    expect(__getStateForTests().tickActive).toBe(true);
    __clearTickForTests();
  });

  it('clearTick stops the active interval', () => {
    const { win } = makeWin({ visible: true });
    __initForTests({ win, settings: defaults() });

    __ensureIntervalForTests();
    __clearTickForTests();
    expect(__getStateForTests().tickActive).toBe(false);
  });
});

describe('nudgeAgent', () => {
  it('writes a single carriage return to the agent', () => {
    nudgeAgent('a1');
    expect(mockWriteToAgent).toHaveBeenCalledWith('a1', '\r');
  });

  it('swallows writeToAgent errors (missing or exited agent)', () => {
    mockWriteToAgent.mockImplementationOnce(() => {
      throw new Error('Agent not found: a1');
    });
    expect(() => nudgeAgent('a1')).not.toThrow();
  });
});
