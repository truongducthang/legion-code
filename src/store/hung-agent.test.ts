import { describe, it, expect, vi, beforeEach } from 'vitest';

// Capture listeners registered against window.electron so a test can
// drive the subscription end-to-end without an Electron runtime.
const listeners = new Map<string, (data: unknown) => void>();
const offFns = new Map<string, () => void>();

beforeEach(() => {
  listeners.clear();
  offFns.clear();
  mockAgents = {};
  capturedEffects.length = 0;
});

let mockAgents: Record<string, unknown> = {};
const capturedEffects: (() => void)[] = [];

vi.stubGlobal('window', {
  electron: {
    ipcRenderer: {
      on: (channel: string, listener: (data: unknown) => void) => {
        listeners.set(channel, listener);
        const off = vi.fn();
        offFns.set(channel, off);
        return off;
      },
      invoke: vi.fn(),
      removeAllListeners: vi.fn(),
    },
  },
});

vi.mock('../../electron/ipc/channels', () => ({
  IPC: {
    HungAgentUpdate: 'hung_agent_update',
  },
}));

vi.mock('./core', () => ({
  store: new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === 'agents') return mockAgents;
        return undefined;
      },
    },
  ),
}));

vi.mock('solid-js', () => ({
  createEffect: (fn: () => void) => {
    capturedEffects.push(fn);
    fn();
  },
  onCleanup: vi.fn(),
}));

// solid-js/store is real — we want createStore's reactivity to work
// for assertions against getHungAgentState.

import { startHungAgentSubscription, getHungAgentState } from './hung-agent';

describe('startHungAgentSubscription', () => {
  it('subscribes to HungAgentUpdate and writes valid payloads into the store', () => {
    startHungAgentSubscription();
    const listener = listeners.get('hung_agent_update');
    expect(listener).toBeTruthy();

    listener?.({
      agentId: 'a1',
      status: 'hung',
      lastDataAt: 12345,
      silentMs: 60000,
      checkedAt: '2026-05-19T10:00:00.000Z',
    });

    expect(getHungAgentState('a1')).toEqual({
      status: 'hung',
      lastDataAt: 12345,
      silentMs: 60000,
      checkedAt: '2026-05-19T10:00:00.000Z',
    });
  });

  it('drops malformed payloads (bad shape, unknown status)', () => {
    startHungAgentSubscription();
    const listener = listeners.get('hung_agent_update');
    if (!listener) throw new Error('listener not registered');

    // Various bad shapes
    listener(null);
    listener('hi');
    listener({});
    listener({ agentId: 'a1' });
    listener({ agentId: 'a1', status: 'bogus', lastDataAt: 1, silentMs: 1 });
    listener({ agentId: 'a1', status: 'hung', lastDataAt: 'no', silentMs: 1 });
    listener({ agentId: 'a1', status: 'hung', lastDataAt: 1, silentMs: 'no' });

    expect(getHungAgentState('a1')).toBeUndefined();
  });

  it('sweep effect drops entries whose agentId left store.agents', () => {
    startHungAgentSubscription();
    const listener = listeners.get('hung_agent_update');

    mockAgents = { a1: {}, a2: {} };
    // Re-run the captured effect now that mockAgents has both.
    listener?.({
      agentId: 'a1',
      status: 'hung',
      lastDataAt: 1,
      silentMs: 1,
      checkedAt: 'x',
    });
    listener?.({
      agentId: 'a2',
      status: 'idle',
      lastDataAt: 1,
      silentMs: 1,
      checkedAt: 'x',
    });
    expect(getHungAgentState('a1')).toBeTruthy();
    expect(getHungAgentState('a2')).toBeTruthy();

    // a2 is killed — store.agents no longer has it.
    mockAgents = { a1: {} };
    // Re-trigger the createEffect body to sweep.
    for (const eff of capturedEffects) eff();

    expect(getHungAgentState('a1')).toBeTruthy();
    expect(getHungAgentState('a2')).toBeUndefined();
  });
});
