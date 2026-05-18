/**
 * Idle-after-activity detector.
 *
 * State machine per agent: `idle → active → idle`. The detector watches the
 * agent's chunk arrival rate; when an agent has been "active" (≥2 chunks/sec
 * sustained for ≥5 minutes) and then emits no chunk for 60 consecutive
 * seconds, it fires one `idle` event. The event does not re-fire until the
 * agent re-enters the active state.
 *
 * This module is pure state — the bot wiring in `index.ts` calls `tick()`
 * on a 1-second interval, calls `feed()` from the PTY subscriber, and
 * pushes notifications through the rate limiter when `tick()` returns
 * events.
 */

const ACTIVE_RATE_PER_SEC = 2;
const ACTIVE_REQUIRED_MS = 5 * 60 * 1000; // 5 minutes sustained
const IDLE_QUIET_MS = 60 * 1000; // 60 seconds without a chunk
const RATE_WINDOW_MS = 1_000;

type State = 'idle' | 'active';

interface AgentRuntime {
  state: State;
  chunkTimestamps: number[]; // recent chunk timestamps (last RATE_WINDOW_MS)
  activeSince: number | null;
  lastChunkAt: number;
  idleFired: boolean;
  lastLine: string;
}

export interface IdleEvent {
  agentId: string;
  firedAt: number;
  lastLine: string;
}

export class IdleDetector {
  private readonly agents = new Map<string, AgentRuntime>();

  feed(agentId: string, lastLine: string, now: number = Date.now()): void {
    let s = this.agents.get(agentId);
    if (!s) {
      s = {
        state: 'idle',
        chunkTimestamps: [],
        activeSince: null,
        lastChunkAt: now,
        idleFired: false,
        lastLine: '',
      };
      this.agents.set(agentId, s);
    }
    s.lastChunkAt = now;
    if (lastLine.length > 0) s.lastLine = lastLine;
    s.chunkTimestamps.push(now);
    // Trim to recent window.
    const cutoff = now - RATE_WINDOW_MS;
    while (s.chunkTimestamps.length > 0 && s.chunkTimestamps[0] < cutoff) {
      s.chunkTimestamps.shift();
    }
    // Active rate evaluation.
    if (s.chunkTimestamps.length >= ACTIVE_RATE_PER_SEC) {
      if (s.activeSince === null) {
        s.activeSince = now;
      }
      if (s.activeSince !== null && now - s.activeSince >= ACTIVE_REQUIRED_MS) {
        if (s.state !== 'active') {
          s.state = 'active';
          s.idleFired = false;
        }
      }
    } else if (s.state === 'active' && now - s.lastChunkAt > IDLE_QUIET_MS) {
      // Not used here — tick() handles the transition. Stale rate buckets
      // shouldn't flip state; only sustained silence does.
    }
  }

  /** Call on a 1-second interval. Returns idle events that fired since the
   *  previous tick. */
  tick(now: number = Date.now()): IdleEvent[] {
    const events: IdleEvent[] = [];
    for (const [agentId, s] of this.agents) {
      if (s.state !== 'active') continue;
      if (s.idleFired) continue;
      if (now - s.lastChunkAt < IDLE_QUIET_MS) continue;
      events.push({ agentId, firedAt: now, lastLine: s.lastLine });
      s.idleFired = true;
      s.state = 'idle';
      s.activeSince = null;
    }
    return events;
  }

  forget(agentId: string): void {
    this.agents.delete(agentId);
  }

  /** Visible for tests. */
  stateFor(agentId: string): State | null {
    return this.agents.get(agentId)?.state ?? null;
  }
}
