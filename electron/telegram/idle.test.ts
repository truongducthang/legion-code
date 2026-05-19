import { describe, it, expect } from 'vitest';
import { IdleDetector } from './idle.js';

function pumpActive(d: IdleDetector, agentId: string, startMs: number, durationMs: number): number {
  // Feed 2 chunks/sec for `durationMs` ms starting at `startMs`.
  // Returns the timestamp of the last fed chunk.
  let now = startMs;
  while (now <= startMs + durationMs) {
    d.feed(agentId, `line@${now}`, now);
    d.feed(agentId, `line@${now}`, now + 500);
    now += 1_000;
  }
  return now;
}

describe('IdleDetector', () => {
  it('does not fire idle before active span reaches 5 minutes', () => {
    const d = new IdleDetector();
    const last = pumpActive(d, 'a', 0, 60_000); // 1 minute
    const events = d.tick(last + 60_000);
    expect(events.length).toBe(0);
  });

  it('fires idle once after 5 minutes of activity followed by 60s silence', () => {
    const d = new IdleDetector();
    const last = pumpActive(d, 'a', 0, 5 * 60_000); // 5 min active
    expect(d.stateFor('a')).toBe('active');
    const events = d.tick(last + 60_001);
    expect(events.length).toBe(1);
    expect(events[0].agentId).toBe('a');
  });

  it('does not re-fire idle without an intervening active span', () => {
    const d = new IdleDetector();
    const last = pumpActive(d, 'a', 0, 5 * 60_000);
    d.tick(last + 60_001); // first fire
    // Even 10 minutes of further silence does not produce another idle event.
    const events = d.tick(last + 60_001 + 10 * 60_000);
    expect(events.length).toBe(0);
  });

  it('forget resets state on agent exit', () => {
    const d = new IdleDetector();
    pumpActive(d, 'a', 0, 5 * 60_000);
    d.forget('a');
    expect(d.stateFor('a')).toBeNull();
  });

  it('captures the most recent non-empty line as the notification body', () => {
    const d = new IdleDetector();
    const start = 0;
    // Feed at rate, then a known last line.
    pumpActive(d, 'a', start, 5 * 60_000);
    d.feed('a', 'final-line', 5 * 60_000 + 1);
    const events = d.tick(5 * 60_000 + 1 + 60_001);
    expect(events[0].lastLine).toBe('final-line');
  });
});
