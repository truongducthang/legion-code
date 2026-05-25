/**
 * Unit tests for the renderer-side ws.ts request correlation helpers.
 *
 * ws.ts is browser-flavoured: it talks to the global `WebSocket`, reads
 * `window.location`, and pulls the auth token from localStorage. Tests install
 * the minimum globals needed before importing the module so listProjects,
 * listBranches, and spawnTask can be exercised in plain node.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

interface FakeWS extends EventTarget {
  readyState: number;
  sent: string[];
  send(data: string): void;
  close(): void;
  /** Helper for tests: push a server-to-client message. */
  __emit(data: unknown): void;
}

const OPEN = 1;

function makeFakeWebSocket(): {
  ctor: new (url: string) => FakeWS;
  instances: FakeWS[];
} {
  const instances: FakeWS[] = [];
  class Fake extends EventTarget implements FakeWS {
    readyState = OPEN;
    sent: string[] = [];
    onopen: ((ev: Event) => void) | null = null;
    onmessage: ((ev: MessageEvent) => void) | null = null;
    onclose: ((ev: CloseEvent) => void) | null = null;
    onerror: ((ev: Event) => void) | null = null;
    constructor(_url: string) {
      super();
      instances.push(this);
      // Fire onopen on the next microtask so subscribers attach first.
      queueMicrotask(() => {
        this.onopen?.(new Event('open'));
      });
    }
    send(data: string): void {
      this.sent.push(data);
    }
    close(): void {
      this.readyState = 3; // CLOSED
      this.onclose?.(new CloseEvent('close', { code: 1000 }));
    }
    __emit(data: unknown): void {
      this.onmessage?.(new MessageEvent('message', { data: JSON.stringify(data) }));
    }
  }
  return { ctor: Fake as unknown as new (url: string) => FakeWS, instances };
}

let instances: FakeWS[];

beforeEach(async () => {
  vi.resetModules();
  // Globals ws.ts + auth.ts touch.
  const stubStorage = (() => {
    const store = new Map<string, string>();
    return {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => store.set(k, v),
      removeItem: (k: string) => store.delete(k),
    };
  })();
  (globalThis as unknown as { localStorage: unknown }).localStorage = stubStorage;
  (globalThis as unknown as { window: unknown }).window = {
    location: { protocol: 'http:', host: '127.0.0.1', search: '', href: 'http://127.0.0.1/' },
    history: { replaceState: () => undefined },
  };
  stubStorage.setItem('legion-code-token', 'tok-1');

  const fake = makeFakeWebSocket();
  instances = fake.instances;
  (globalThis as unknown as { WebSocket: unknown }).WebSocket = Object.assign(fake.ctor, {
    OPEN,
    CONNECTING: 0,
    CLOSING: 2,
    CLOSED: 3,
  });
});

afterEach(() => {
  delete (globalThis as unknown as { localStorage?: unknown }).localStorage;
  delete (globalThis as unknown as { window?: unknown }).window;
  delete (globalThis as unknown as { WebSocket?: unknown }).WebSocket;
});

async function connectAndDrainAuth(): Promise<{
  ws: FakeWS;
  mod: typeof import('./ws');
}> {
  const mod = await import('./ws');
  mod.connect();
  // Wait for the queued onopen → first 'auth' send.
  await new Promise((r) => queueMicrotask(() => r(undefined)));
  const ws = instances[0];
  // Clear auth payload so tests can assert on subsequent sends only.
  ws.sent.length = 0;
  return { ws, mod };
}

describe('ws.ts request correlation', () => {
  it('listProjects resolves with the next projects message', async () => {
    const { ws, mod } = await connectAndDrainAuth();
    const promise = mod.listProjects();
    // The send went out.
    expect(ws.sent).toHaveLength(1);
    expect(JSON.parse(ws.sent[0])).toEqual({ type: 'list_projects' });
    ws.__emit({
      type: 'projects',
      list: [{ root: '/r', name: 'r', defaultBaseBranch: 'main' }],
    });
    const list = await promise;
    expect(list).toEqual([{ root: '/r', name: 'r', defaultBaseBranch: 'main' }]);
  });

  it('listBranches matches on projectRoot, ignoring replies for other roots', async () => {
    const { ws, mod } = await connectAndDrainAuth();
    const promise = mod.listBranches('/wanted');
    expect(JSON.parse(ws.sent[0])).toEqual({ type: 'list_branches', projectRoot: '/wanted' });
    // A stray reply for a different root must not resolve our pending promise.
    ws.__emit({ type: 'branches', projectRoot: '/other', list: [{ name: 'x', current: true }] });
    let resolved = false;
    promise.then(() => {
      resolved = true;
    });
    await new Promise((r) => setTimeout(r, 5));
    expect(resolved).toBe(false);
    ws.__emit({
      type: 'branches',
      projectRoot: '/wanted',
      list: [{ name: 'main', current: true }],
    });
    expect(await promise).toEqual([{ name: 'main', current: true }]);
  });

  it('spawnTask resolves on matching requestId only', async () => {
    const { ws, mod } = await connectAndDrainAuth();
    const promise = mod.spawnTask({
      requestId: 'r-1',
      projectRoot: '/p',
      baseBranch: 'main',
      agentId: 'claude-code',
      taskName: 'x',
      prompt: 'y',
    });
    expect(JSON.parse(ws.sent[0])).toMatchObject({
      type: 'spawn_task',
      requestId: 'r-1',
    });
    // Wrong requestId must not resolve.
    ws.__emit({
      type: 'spawn_result',
      requestId: 'r-other',
      ok: true,
      taskId: 't',
      agentId: 'a',
    });
    let resolved = false;
    promise.then(() => {
      resolved = true;
    });
    await new Promise((r) => setTimeout(r, 5));
    expect(resolved).toBe(false);
    ws.__emit({
      type: 'spawn_result',
      requestId: 'r-1',
      ok: true,
      taskId: 't',
      agentId: 'a-1',
    });
    const result = await promise;
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.agentId).toBe('a-1');
  });

  it('spawnTask resolves with timed_out error on no reply', async () => {
    vi.useFakeTimers();
    const { mod } = await connectAndDrainAuth();
    const promise = mod.spawnTask({
      requestId: 'r-1',
      projectRoot: '/p',
      baseBranch: null,
      agentId: 'claude-code',
      taskName: 'x',
      prompt: 'y',
    });
    // Advance past the 10 s correlation timeout in ws.ts.
    await vi.advanceTimersByTimeAsync(10_001);
    vi.useRealTimers();
    const result = await promise;
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('spawn_failed');
      expect(result.message).toBe('timed_out');
    }
  });
});
