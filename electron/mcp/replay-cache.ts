/** Idempotency cache for wait_for_signal_done results.
 *  Key is `${coordinatorTaskId}:${requestId}` to prevent cross-coordinator replay. */
export class ReplayCache<T> {
  private entries = new Map<string, { result: T; expiresAt: number }>();
  private readonly ttlMs: number;

  constructor(ttlMs = 120_000) {
    this.ttlMs = ttlMs;
  }

  get(coordinatorTaskId: string, requestId: string): T | undefined {
    const key = `${coordinatorTaskId}:${requestId}`;
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (Date.now() >= entry.expiresAt) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.result;
  }

  set(coordinatorTaskId: string, requestId: string, result: T): void {
    const now = Date.now();
    // Evict expired entries on each write to bound memory usage.
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(key);
    }
    this.entries.set(`${coordinatorTaskId}:${requestId}`, {
      result,
      expiresAt: now + this.ttlMs,
    });
  }
}
