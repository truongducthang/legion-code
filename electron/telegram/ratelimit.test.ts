import { describe, it, expect } from 'vitest';
import { RateLimiter } from './ratelimit.js';

describe('RateLimiter — per-chat bucket', () => {
  it('allows 3 immediate sends, blocks the 4th', () => {
    const t0 = 1_000_000;
    const r = new RateLimiter(t0);
    expect(r.acquire(100, t0)).toBe(true);
    expect(r.acquire(100, t0)).toBe(true);
    expect(r.acquire(100, t0)).toBe(true);
    expect(r.acquire(100, t0)).toBe(false);
  });

  it('refills 1 token per second', () => {
    const t0 = 1_000_000;
    const r = new RateLimiter(t0);
    // drain
    r.acquire(100, t0);
    r.acquire(100, t0);
    r.acquire(100, t0);
    expect(r.acquire(100, t0)).toBe(false);
    expect(r.acquire(100, t0 + 1_000)).toBe(true);
    expect(r.acquire(100, t0 + 1_000)).toBe(false);
    expect(r.acquire(100, t0 + 2_000)).toBe(true);
  });

  it('buckets are independent across chats', () => {
    const t0 = 1_000_000;
    const r = new RateLimiter(t0);
    r.acquire(100, t0);
    r.acquire(100, t0);
    r.acquire(100, t0);
    // chat 200 still has full bucket
    expect(r.acquire(200, t0)).toBe(true);
    expect(r.acquire(200, t0)).toBe(true);
    expect(r.acquire(200, t0)).toBe(true);
  });
});

describe('RateLimiter — global bucket', () => {
  it('caps at 25 sends in the same instant across chats', () => {
    const t0 = 1_000_000;
    const r = new RateLimiter(t0);
    let granted = 0;
    for (let c = 0; c < 30; c++) {
      if (r.acquire(c + 1, t0)) granted++;
    }
    expect(granted).toBe(25);
  });

  it('refills globally at 25/sec', () => {
    const t0 = 1_000_000;
    const r = new RateLimiter(t0);
    for (let c = 0; c < 25; c++) r.acquire(c + 1, t0);
    expect(r.acquire(999, t0)).toBe(false);
    expect(r.acquire(999, t0 + 1_000)).toBe(true);
  });
});

describe('RateLimiter — 429 handling', () => {
  it('halves chat capacity on 429', () => {
    const t0 = 1_000_000;
    const r = new RateLimiter(t0);
    r.note429(100, 1, t0);
    expect(r.chatCapacity(100)).toBe(1);
  });

  it('blocks sends to the chat during the retry window', () => {
    const t0 = 1_000_000;
    const r = new RateLimiter(t0);
    r.note429(100, 2, t0);
    expect(r.acquire(100, t0)).toBe(false);
    expect(r.acquire(100, t0 + 1_000)).toBe(false);
    // Window = 2s + 250ms jitter
    expect(r.acquire(100, t0 + 2_300)).toBe(true);
  });

  it('noteSuccess restores capacity', () => {
    const t0 = 1_000_000;
    const r = new RateLimiter(t0);
    r.note429(100, 0, t0);
    expect(r.chatCapacity(100)).toBe(1);
    r.noteSuccess(100);
    expect(r.chatCapacity(100)).toBe(3);
  });
});

describe('RateLimiter — sustained drop tracker', () => {
  it('returns false on first drop, true at 5s', () => {
    const t0 = 1_000_000;
    const r = new RateLimiter(t0);
    expect(r.recordDrop(100, 'agent-a', t0)).toBe(false);
    expect(r.recordDrop(100, 'agent-a', t0 + 4_999)).toBe(false);
    expect(r.recordDrop(100, 'agent-a', t0 + 5_000)).toBe(true);
  });

  it('resetDrop clears the streak', () => {
    const t0 = 1_000_000;
    const r = new RateLimiter(t0);
    r.recordDrop(100, 'agent-a', t0);
    r.resetDrop(100, 'agent-a');
    expect(r.recordDrop(100, 'agent-a', t0 + 5_001)).toBe(false);
  });

  it('streak is independent across (chat, agent) keys', () => {
    const t0 = 1_000_000;
    const r = new RateLimiter(t0);
    r.recordDrop(100, 'agent-a', t0);
    expect(r.recordDrop(100, 'agent-b', t0 + 5_001)).toBe(false);
  });
});

describe('RateLimiter — pending edit replacement', () => {
  it('takePending returns the latest setPending payload', () => {
    const r = new RateLimiter(1_000_000);
    r.setPending(100, 'agent-a', 'first');
    r.setPending(100, 'agent-a', 'second');
    expect(r.takePending<string>(100, 'agent-a')).toBe('second');
    expect(r.takePending<string>(100, 'agent-a')).toBeNull();
  });

  it('pending payloads are keyed by (chat, agent)', () => {
    const r = new RateLimiter(1_000_000);
    r.setPending(100, 'agent-a', 'A');
    r.setPending(100, 'agent-b', 'B');
    expect(r.takePending<string>(100, 'agent-a')).toBe('A');
    expect(r.takePending<string>(100, 'agent-b')).toBe('B');
  });
});

describe('RateLimiter — clearPendingForAgent (opt-out)', () => {
  it('drops pending across every chat for the named agent', () => {
    const r = new RateLimiter(1_000_000);
    r.setPending(100, 'agent-a', 'A');
    r.setPending(200, 'agent-a', 'B');
    r.setPending(100, 'agent-b', 'keep');
    expect(r.clearPendingForAgent('agent-a')).toBe(2);
    expect(r.takePending<string>(100, 'agent-a')).toBeNull();
    expect(r.takePending<string>(200, 'agent-a')).toBeNull();
    expect(r.takePending<string>(100, 'agent-b')).toBe('keep');
  });

  it('also clears in-flight sustained-drop streaks for the agent', () => {
    const t0 = 1_000_000;
    const r = new RateLimiter(t0);
    r.recordDrop(100, 'agent-a', t0); // start streak
    r.clearPendingForAgent('agent-a');
    // Without the clear, t0+5001 would return true; now the streak restarts.
    expect(r.recordDrop(100, 'agent-a', t0 + 5_001)).toBe(false);
  });

  it('returns 0 and is a no-op when the agent has no pending entries', () => {
    const r = new RateLimiter(1_000_000);
    expect(r.clearPendingForAgent('agent-x')).toBe(0);
  });
});
