/**
 * Telegram send/edit rate limiter.
 *
 * Two token buckets:
 *   - per-chat: capacity 3, refill 1 token per second
 *   - global:   capacity 25, refill 25 tokens per second (Telegram's 30/sec hard
 *               cap minus headroom)
 *
 * `acquire(chatId)` consumes one token from BOTH buckets; if either is empty
 * it returns false without consuming. A 429 response from Telegram halves the
 * chat's capacity until the next successful send.
 *
 * Sustained drops on the same `(chat, agent)` pair are tracked so consumers
 * (live tail) can decide to pause the producer PTY when the project has
 * `telegramPauseOnBackpressure === true`.
 *
 * `setPending(chatId, agentId, payload)` is a "replace-most-recent" buffer for
 * live-tail edits — when the limiter has no tokens, the latest edit overwrites
 * any previous pending payload for the same key so the next send always
 * carries the freshest content.
 */

const PER_CHAT_CAPACITY = 3;
const PER_CHAT_REFILL_PER_SEC = 1;
const GLOBAL_CAPACITY = 25;
const GLOBAL_REFILL_PER_SEC = 25;
const SUSTAINED_DROP_MS = 5_000;

interface Bucket {
  capacity: number;
  tokens: number;
  refillPerMs: number;
  lastRefill: number;
}

function newBucket(capacity: number, refillPerSec: number, now: number): Bucket {
  return {
    capacity,
    tokens: capacity,
    refillPerMs: refillPerSec / 1000,
    lastRefill: now,
  };
}

function refill(b: Bucket, now: number): void {
  if (now <= b.lastRefill) return;
  const delta = (now - b.lastRefill) * b.refillPerMs;
  b.tokens = Math.min(b.capacity, b.tokens + delta);
  b.lastRefill = now;
}

function dropKey(chatId: number, agentId: string): string {
  return `${chatId}:${agentId}`;
}

export interface PendingEntry<T> {
  payload: T;
  setAt: number;
}

export class RateLimiter {
  private readonly global: Bucket;
  private readonly chats = new Map<number, Bucket>();
  private readonly chatCapacityOverride = new Map<number, number>();
  private readonly retryAfterUntil = new Map<number, number>();
  private readonly dropStartedAt = new Map<string, number>();
  private readonly pending = new Map<string, PendingEntry<unknown>>();

  constructor(now: number = Date.now()) {
    this.global = newBucket(GLOBAL_CAPACITY, GLOBAL_REFILL_PER_SEC, now);
  }

  private chatBucket(chatId: number, now: number): Bucket {
    let b = this.chats.get(chatId);
    if (!b) {
      const cap = this.chatCapacityOverride.get(chatId) ?? PER_CHAT_CAPACITY;
      b = newBucket(cap, PER_CHAT_REFILL_PER_SEC, now);
      this.chats.set(chatId, b);
    }
    return b;
  }

  inRetryWindow(chatId: number, now: number = Date.now()): boolean {
    const until = this.retryAfterUntil.get(chatId);
    if (until === undefined) return false;
    if (now >= until) {
      this.retryAfterUntil.delete(chatId);
      return false;
    }
    return true;
  }

  /** Returns true and consumes a token from both buckets, or returns false
   *  without consuming when either bucket is empty / chat in retry window. */
  acquire(chatId: number, now: number = Date.now()): boolean {
    if (this.inRetryWindow(chatId, now)) return false;
    const chat = this.chatBucket(chatId, now);
    // Refill both first so the "either empty" check uses fresh state.
    refill(chat, now);
    refill(this.global, now);
    if (chat.tokens < 1 || this.global.tokens < 1) return false;
    chat.tokens -= 1;
    this.global.tokens -= 1;
    return true;
  }

  /** Telegram returned 429 — sleep `retryAfter` seconds (+ jitter) for this
   *  chat and halve its capacity (minimum 1) until the next successful send. */
  note429(chatId: number, retryAfterSec: number, now: number = Date.now()): void {
    const jitterMs = 250;
    this.retryAfterUntil.set(chatId, now + Math.max(0, retryAfterSec) * 1000 + jitterMs);
    const b = this.chatBucket(chatId, now);
    const halved = Math.max(1, Math.floor(b.capacity / 2));
    b.capacity = halved;
    b.tokens = Math.min(b.tokens, halved);
    this.chatCapacityOverride.set(chatId, halved);
  }

  /** Call after a send succeeds — restore the chat's capacity to the default. */
  noteSuccess(chatId: number): void {
    this.chatCapacityOverride.delete(chatId);
    const b = this.chats.get(chatId);
    if (b) {
      b.capacity = PER_CHAT_CAPACITY;
      // do not refill tokens beyond cap; rely on refill timer
    }
    this.retryAfterUntil.delete(chatId);
    // Drop streak is also cleared — see resetDrop.
  }

  /** Record one dropped send for the (chat, agent) pair. Returns true when
   *  the streak has lasted at least SUSTAINED_DROP_MS (5 seconds). */
  recordDrop(chatId: number, agentId: string, now: number = Date.now()): boolean {
    const key = dropKey(chatId, agentId);
    const start = this.dropStartedAt.get(key);
    if (start === undefined) {
      this.dropStartedAt.set(key, now);
      return false;
    }
    return now - start >= SUSTAINED_DROP_MS;
  }

  resetDrop(chatId: number, agentId: string): void {
    this.dropStartedAt.delete(dropKey(chatId, agentId));
  }

  /** Replace the pending payload for (chat, agent). Older entries are
   *  overwritten; only the most recent is taken on the next send. */
  setPending<T>(chatId: number, agentId: string, payload: T, now: number = Date.now()): void {
    this.pending.set(dropKey(chatId, agentId), { payload, setAt: now });
  }

  takePending<T>(chatId: number, agentId: string): T | null {
    const key = dropKey(chatId, agentId);
    const entry = this.pending.get(key);
    if (!entry) return null;
    this.pending.delete(key);
    return entry.payload as T;
  }

  /** Current chat capacity (visible for tests and debug). */
  chatCapacity(chatId: number): number {
    return this.chats.get(chatId)?.capacity ?? PER_CHAT_CAPACITY;
  }
}
