/**
 * Reply-chain routing: bounded LRU mapping bot-sent `message_id` → `agentId`.
 *
 * Whenever the bot sends a message that names an agent (status replies,
 * prompt acks, question notifications, idle notifications, exit
 * notifications, live tail messages), the message id is registered here so
 * a Telegram "reply to" from the user routes back to the same agent without
 * the user having to type `<id>`.
 *
 * In-memory only. 2000-entry LRU eviction (oldest registration first).
 */

const DEFAULT_CAPACITY = 2_000;

export class ReplyMap {
  private readonly capacity: number;
  // Map preserves insertion order — moving an entry on access makes it LRU.
  private readonly store: Map<number, string>;

  constructor(capacity: number = DEFAULT_CAPACITY) {
    if (capacity <= 0) throw new Error('ReplyMap capacity must be > 0');
    this.capacity = capacity;
    this.store = new Map();
  }

  register(messageId: number, agentId: string): void {
    if (this.store.has(messageId)) {
      // Refresh by removing then re-adding so the entry becomes most-recent.
      this.store.delete(messageId);
    }
    this.store.set(messageId, agentId);
    while (this.store.size > this.capacity) {
      const oldest = this.store.keys().next().value;
      if (oldest === undefined) break;
      this.store.delete(oldest);
    }
  }

  lookup(messageId: number): string | null {
    const agentId = this.store.get(messageId);
    if (agentId === undefined) return null;
    // Touch — bump to most-recent.
    this.store.delete(messageId);
    this.store.set(messageId, agentId);
    return agentId;
  }

  /** Remove every entry pointing at the given agent. Used on agent exit so
   *  stale replies cannot reach a dead agent. */
  forgetAgent(agentId: string): number {
    let removed = 0;
    for (const [mid, aid] of this.store) {
      if (aid === agentId) {
        this.store.delete(mid);
        removed++;
      }
    }
    return removed;
  }

  size(): number {
    return this.store.size;
  }
}
