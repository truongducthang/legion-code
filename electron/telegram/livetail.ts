/**
 * Live-tail handle: subscribes to an agent's PTY output, edits a single
 * Telegram message in place at most once per second, rotates to a new
 * message when the running content approaches the 4096-char cap, and
 * finalises with a footer when the user sends `/untail` or the agent exits.
 *
 * Dependencies are injected so the module is unit-testable without grammy
 * or the real PTY layer. The bot wiring in `index.ts` supplies real
 * `subscribe`, `send`, and `edit` implementations.
 */

import { stripAnsi, escapeMd2, codeBlock } from './formatter.js';
import { redact } from './redact.js';
import type { RateLimiter } from './ratelimit.js';
import type { LiveTailHandle } from './types.js';

const COALESCE_MS = 1_000;
const ROTATE_AT = 3_900;
const FINALISE_FOOTER = '\n— continued ↓';

export interface TailIO {
  /** Subscribe to base64-encoded PTY chunks for the agent.
   *  Returns false when the agent doesn't exist (already exited). */
  subscribe(agentId: string, cb: (encoded: string) => void): boolean;
  /** Remove a previously registered subscriber. */
  unsubscribe(agentId: string, cb: (encoded: string) => void): void;
  /** Send a new message to the chat. Returns the assigned message id. */
  send(chatId: number, text: string): Promise<number>;
  /** Edit a previously-sent message in the chat. */
  edit(chatId: number, messageId: number, text: string): Promise<void>;
  /** Register the message id in the reply map so user replies route back to
   *  the agent without typing the id. */
  registerForReplyChain(messageId: number, agentId: string): void;
  /** Optional PTY backpressure hooks. When `pauseEnabled` is true the
   *  limiter's sustained-drop signal will pause/resume the producer. */
  pauseAgent?(agentId: string): void;
  resumeAgent?(agentId: string): void;
}

export interface OpenLiveTailOptions {
  chatId: number;
  agentId: string;
  io: TailIO;
  limiter: RateLimiter;
  redactPatterns?: string[];
  /** If true, sustained-drop signals will call io.pauseAgent / resumeAgent. */
  pauseOnBackpressure?: boolean;
}

interface Internal {
  chatId: number;
  agentId: string;
  pauseOnBackpressure: boolean;
  redactPatterns: string[];
  buffer: string;
  currentMessageId: number | null;
  currentContent: string;
  closed: boolean;
  coalesceTimer: ReturnType<typeof setTimeout> | null;
  paused: boolean;
  io: TailIO;
  limiter: RateLimiter;
}

function clearTimer(state: Internal): void {
  if (state.coalesceTimer) {
    clearTimeout(state.coalesceTimer);
    state.coalesceTimer = null;
  }
}

function format(text: string, redactPatterns: string[]): string {
  return escapeMd2(redact(stripAnsi(text), redactPatterns));
}

async function flush(state: Internal): Promise<void> {
  clearTimer(state);
  if (state.closed) return;
  if (state.buffer.length === 0) return;
  if (!state.limiter.acquire(state.chatId)) {
    // Limiter empty — track drop, optionally pause the producer.
    const sustained = state.limiter.recordDrop(state.chatId, state.agentId);
    if (sustained && state.pauseOnBackpressure && !state.paused) {
      try {
        state.io.pauseAgent?.(state.agentId);
        state.paused = true;
      } catch {
        /* ignore — best effort */
      }
    }
    // Re-arm a coalesce timer so the buffered text eventually goes out.
    state.coalesceTimer = setTimeout(() => {
      void flush(state);
    }, COALESCE_MS);
    return;
  }
  state.limiter.resetDrop(state.chatId, state.agentId);
  if (state.paused) {
    try {
      state.io.resumeAgent?.(state.agentId);
    } catch {
      /* ignore */
    }
    state.paused = false;
  }

  const incoming = state.buffer;
  state.buffer = '';
  const next = state.currentContent + incoming;

  try {
    if (next.length > ROTATE_AT) {
      // Finalise current message with the rotation footer, then open a fresh
      // message for the rest of the content.
      if (state.currentMessageId !== null) {
        await state.io.edit(
          state.chatId,
          state.currentMessageId,
          codeBlock(state.currentContent) + escapeMd2(FINALISE_FOOTER),
        );
      }
      state.currentContent = incoming;
      const mid = await state.io.send(state.chatId, codeBlock(state.currentContent));
      state.currentMessageId = mid;
      state.io.registerForReplyChain(mid, state.agentId);
    } else if (state.currentMessageId === null) {
      const mid = await state.io.send(state.chatId, codeBlock(next));
      state.currentContent = next;
      state.currentMessageId = mid;
      state.io.registerForReplyChain(mid, state.agentId);
    } else {
      await state.io.edit(state.chatId, state.currentMessageId, codeBlock(next));
      state.currentContent = next;
    }
    state.limiter.noteSuccess(state.chatId);
  } catch {
    // On send/edit failure, drop the chunk to keep the tail moving — the
    // next chunk will produce a fresh edit. Recoverable Telegram errors
    // (429) are handled by the limiter; non-recoverable errors are logged
    // by the caller's bot.catch.
  }
}

export function openLiveTail(opts: OpenLiveTailOptions): LiveTailHandle | null {
  const state: Internal = {
    chatId: opts.chatId,
    agentId: opts.agentId,
    pauseOnBackpressure: opts.pauseOnBackpressure === true,
    redactPatterns: opts.redactPatterns ?? [],
    buffer: '',
    currentMessageId: null,
    currentContent: '',
    closed: false,
    coalesceTimer: null,
    paused: false,
    io: opts.io,
    limiter: opts.limiter,
  };

  const onChunk = (encoded: string) => {
    if (state.closed) return;
    const decoded = Buffer.from(encoded, 'base64').toString('utf8');
    state.buffer += format(decoded, state.redactPatterns);
    if (state.coalesceTimer) return;
    state.coalesceTimer = setTimeout(() => {
      void flush(state);
    }, COALESCE_MS);
  };

  const subscribed = opts.io.subscribe(opts.agentId, onChunk);
  if (!subscribed) return null;

  const handle: LiveTailHandle = {
    chatId: opts.chatId,
    agentId: opts.agentId,
    async close(reason: string): Promise<void> {
      if (state.closed) return;
      state.closed = true;
      clearTimer(state);
      opts.io.unsubscribe(opts.agentId, onChunk);
      if (state.paused) {
        try {
          opts.io.resumeAgent?.(opts.agentId);
        } catch {
          /* ignore */
        }
        state.paused = false;
      }
      if (state.currentMessageId !== null) {
        const footer = escapeMd2(`\n— tail closed (${reason})`);
        try {
          await opts.io.edit(
            state.chatId,
            state.currentMessageId,
            codeBlock(state.currentContent) + footer,
          );
        } catch {
          /* best-effort finalise */
        }
      }
    },
  };

  return handle;
}

/**
 * Per-chat concurrency cap. The bot's command router uses this map to enforce
 * "at most 3 live tails per chat".
 */
export class LiveTailRegistry {
  private readonly tails = new Map<number, Map<string, LiveTailHandle>>();
  private readonly capPerChat: number;

  constructor(capPerChat: number = 3) {
    this.capPerChat = capPerChat;
  }

  has(chatId: number, agentId: string): boolean {
    return this.tails.get(chatId)?.has(agentId) === true;
  }

  count(chatId: number): number {
    return this.tails.get(chatId)?.size ?? 0;
  }

  cap(): number {
    return this.capPerChat;
  }

  add(handle: LiveTailHandle): void {
    let chatMap = this.tails.get(handle.chatId);
    if (!chatMap) {
      chatMap = new Map();
      this.tails.set(handle.chatId, chatMap);
    }
    chatMap.set(handle.agentId, handle);
  }

  remove(chatId: number, agentId: string): LiveTailHandle | null {
    const chatMap = this.tails.get(chatId);
    if (!chatMap) return null;
    const handle = chatMap.get(agentId);
    if (!handle) return null;
    chatMap.delete(agentId);
    if (chatMap.size === 0) this.tails.delete(chatId);
    return handle;
  }

  /** Close every tail for this agent across every chat. Returns count. */
  async closeAgent(agentId: string, reason: string): Promise<number> {
    let closed = 0;
    const toClose: LiveTailHandle[] = [];
    for (const [, chatMap] of this.tails) {
      const h = chatMap.get(agentId);
      if (h) toClose.push(h);
    }
    for (const h of toClose) {
      this.remove(h.chatId, h.agentId);
      try {
        await h.close(reason);
      } catch {
        /* best effort */
      }
      closed++;
    }
    return closed;
  }

  /** Close every tail for every agent in a project. The caller must supply
   *  the agent-id list; this class doesn't know project structure. */
  async closeAgents(agentIds: string[], reason: string): Promise<number> {
    let total = 0;
    for (const id of agentIds) {
      total += await this.closeAgent(id, reason);
    }
    return total;
  }
}
