/**
 * Orchestrator for per-agent Telegram notification flows.
 *
 * Owns the shared instances of:
 *   - QuestionDetector (agent-question pattern detection)
 *   - IdleDetector (active → idle transition)
 *   - RateLimiter (per-chat + global token buckets)
 *   - ReplyMap (LRU message_id → agentId for reply-chain routing)
 *   - LiveTailRegistry (per-chat tail subscriptions)
 *
 * Subscribes to per-agent PTY output and exit events. Pushes question,
 * idle, and error notifications through the rate limiter to allowed chats
 * whose `pushPolicy` permits the category.
 *
 * Constructor injects a `bot` instance and config getters; the wiring in
 * `bot.ts` builds the notifier after grammy's `Bot` is constructed.
 */

import type { Bot } from 'grammy';
import { InlineKeyboard } from 'grammy';
import {
  subscribeToAgent,
  unsubscribeFromAgent,
  subscribeToAgentExit,
  unsubscribeFromAgentExit,
  getActiveAgentIds,
  getAgentMeta,
  onPtyEvent,
  type AgentExitInfo,
} from '../ipc/pty.js';
import { getConfig } from './config.js';
import { getProjectByAgentMeta, getWorktreeByAgentMeta } from './integration.js';
import { QuestionDetector } from './detector.js';
import { IdleDetector } from './idle.js';
import { RateLimiter } from './ratelimit.js';
import { ReplyMap } from './reply.js';
import { LiveTailRegistry, openLiveTail, type TailIO } from './livetail.js';
import { redact } from './redact.js';
import { escapeMd2, codeBlock, stripAnsi } from './formatter.js';
import { warn as logWarn } from '../log.js';
import type { LiveTailHandle, NotificationCategory, QuestionMatch } from './types.js';

interface PerAgentSubs {
  outputCb: (encoded: string) => void;
  exitCb: (info: AgentExitInfo) => void;
}

export class Notifier {
  readonly questionDetector = new QuestionDetector();
  readonly idleDetector = new IdleDetector();
  readonly limiter = new RateLimiter();
  readonly replyMap = new ReplyMap();
  readonly tails = new LiveTailRegistry();
  readonly tailIO: TailIO;

  private readonly bot: Bot;
  private readonly agentSubs = new Map<string, PerAgentSubs>();
  private idleTimer: ReturnType<typeof setInterval> | null = null;
  private unsubSpawn: (() => void) | null = null;
  private started = false;

  constructor(bot: Bot) {
    this.bot = bot;
    this.tailIO = this.buildTailIO();
  }

  /* --- lifecycle --- */

  start(): void {
    if (this.started) return;
    this.started = true;
    this.questionDetector.setUserPatterns(getConfig().extraQuestionPatterns);

    // Subscribe to lifecycle events so future spawns get hooks too.
    this.unsubSpawn = onPtyEvent('spawn', (agentId) => this.attachAgent(agentId));

    // Attach to any agents already running.
    for (const id of getActiveAgentIds()) this.attachAgent(id);

    this.idleTimer = setInterval(() => this.runIdleTick(), 1_000);
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    if (this.idleTimer) {
      clearInterval(this.idleTimer);
      this.idleTimer = null;
    }
    this.unsubSpawn?.();
    this.unsubSpawn = null;
    for (const [agentId, subs] of this.agentSubs) {
      unsubscribeFromAgent(agentId, subs.outputCb);
      unsubscribeFromAgentExit(agentId, subs.exitCb);
    }
    this.agentSubs.clear();
    // Close every tail.
    void this.tails.closeAgents([], 'bot stopped');
  }

  /** Refresh detector patterns when the user updates extra-question patterns. */
  reloadConfig(): void {
    this.questionDetector.setUserPatterns(getConfig().extraQuestionPatterns);
  }

  /* --- per-agent attach/detach --- */

  private attachAgent(agentId: string): void {
    if (this.agentSubs.has(agentId)) return;
    const outputCb = (encoded: string) => this.onAgentChunk(agentId, encoded);
    const exitCb = (info: AgentExitInfo) => this.onAgentExit(agentId, info);
    const ok = subscribeToAgent(agentId, outputCb);
    if (!ok) return;
    subscribeToAgentExit(agentId, exitCb);
    this.agentSubs.set(agentId, { outputCb, exitCb });
  }

  private detachAgent(agentId: string): void {
    const subs = this.agentSubs.get(agentId);
    if (!subs) return;
    unsubscribeFromAgent(agentId, subs.outputCb);
    unsubscribeFromAgentExit(agentId, subs.exitCb);
    this.agentSubs.delete(agentId);
  }

  /* --- output chunk handling --- */

  private onAgentChunk(agentId: string, encoded: string): void {
    // Idle detector — feed even if project is opted out so state machine is
    // consistent. Decisions to fire notifications check opt-in.
    const decoded = Buffer.from(encoded, 'base64').toString('utf8');
    const stripped = stripAnsi(decoded);
    const lines = stripped.split('\n').filter((l) => l.trim().length > 0);
    const lastLine = lines.length > 0 ? lines[lines.length - 1] : '';
    this.idleDetector.feed(agentId, lastLine);

    const matches = this.questionDetector.feed(agentId, encoded);
    if (matches.length === 0) return;
    for (const m of matches) {
      void this.pushQuestion(m);
    }
  }

  /* --- exit handling --- */

  private async onAgentExit(agentId: string, info: AgentExitInfo): Promise<void> {
    this.questionDetector.forget(agentId);
    this.idleDetector.forget(agentId);
    this.replyMap.forgetAgent(agentId);
    this.detachAgent(agentId);
    await this.tails.closeAgent(agentId, 'agent exited');

    if (info.exitCode === 0 && info.signal === null) return;
    await this.pushExit(agentId, info);
  }

  private runIdleTick(): void {
    const events = this.idleDetector.tick();
    if (events.length === 0) return;
    for (const ev of events) {
      void this.pushIdle(ev.agentId, ev.lastLine);
    }
  }

  /* --- push helpers (rate limited) --- */

  private chatsAllowing(category: NotificationCategory): number[] {
    const cfg = getConfig();
    const policy = cfg.pushPolicy;
    const ok = (() => {
      if (policy === 'all') return true;
      if (policy === 'questions-only') return category === 'question';
      if (policy === 'errors-only') return category === 'error';
      return false;
    })();
    return ok ? [...cfg.allowedChatIds] : [];
  }

  private projectOptIn(agentId: string): boolean {
    const meta = getAgentMeta(agentId);
    if (!meta) return false;
    const project = getProjectByAgentMeta(meta);
    return project?.telegramOptIn === true;
  }

  private async pushQuestion(m: QuestionMatch): Promise<void> {
    if (!this.projectOptIn(m.agentId)) return;
    const chats = this.chatsAllowing('question');
    const body = this.formatQuestionBody(m);
    const keyboard = new InlineKeyboard()
      .text('✅ Allow', `approve:${m.agentId}`)
      .text('❌ Deny', `deny:${m.agentId}`)
      .text('👁 Open', `open:${m.agentId}`);
    for (const chatId of chats) {
      void this.sendNotification(chatId, body, m.agentId, keyboard);
    }
  }

  private async pushIdle(agentId: string, lastLine: string): Promise<void> {
    if (!this.projectOptIn(agentId)) return;
    const chats = this.chatsAllowing('idle');
    if (chats.length === 0) return;
    const body = [
      `✅ agent\\-\`${escapeMd2(agentId)}\` looks done\\.`,
      lastLine
        ? '> ' + escapeMd2(redact(lastLine, getConfig().redactPatterns))
        : escapeMd2('(no recent output)'),
    ].join('\n');
    const keyboard = new InlineKeyboard().text('👁 Open', `open:${agentId}`);
    for (const chatId of chats) {
      void this.sendNotification(chatId, body, agentId, keyboard);
    }
  }

  private async pushExit(agentId: string, info: AgentExitInfo): Promise<void> {
    if (!this.projectOptIn(agentId)) return;
    const chats = this.chatsAllowing('error');
    if (chats.length === 0) return;
    const cfg = getConfig();
    const codeStr = info.signal !== null ? `signal=${info.signal}` : `code=${info.exitCode}`;
    const tail = info.lastOutput
      .slice(-10)
      .map((l) => '> ' + escapeMd2(redact(l, cfg.redactPatterns)))
      .join('\n');
    const body = [
      `⚠️ agent\\-\`${escapeMd2(agentId)}\` exited \\(${escapeMd2(codeStr)}\\)\\.`,
      tail || escapeMd2('(no captured output)'),
    ].join('\n');
    for (const chatId of chats) {
      void this.sendNotification(chatId, body, agentId, null);
    }
  }

  private formatQuestionBody(m: QuestionMatch): string {
    const cfg = getConfig();
    const redacted = redact(m.tailLine, cfg.redactPatterns);
    return [
      `🤖 agent\\-\`${escapeMd2(m.agentId)}\` is asking:`,
      '> ' + escapeMd2(redacted || '(empty)'),
    ].join('\n');
  }

  private async sendNotification(
    chatId: number,
    text: string,
    agentId: string,
    keyboard: InlineKeyboard | null,
  ): Promise<void> {
    if (!this.limiter.acquire(chatId)) {
      // Drop. Notifications are not edited-in-place like live tail; if the
      // limiter has no token, the user will see future notifications when
      // tokens return. Question detector's 30s suppression prevents storms.
      this.limiter.recordDrop(chatId, agentId);
      return;
    }
    this.limiter.resetDrop(chatId, agentId);
    try {
      const sent = await this.bot.api.sendMessage(chatId, text, {
        parse_mode: 'MarkdownV2',
        reply_markup: keyboard ?? undefined,
      });
      this.limiter.noteSuccess(chatId);
      this.replyMap.register(sent.message_id, agentId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const m = /retry after (\d+)/i.exec(msg);
      if (m) {
        this.limiter.note429(chatId, parseInt(m[1] ?? '1', 10));
      }
      logWarn('telegram.notifier', 'sendMessage failed', { chatId, msg });
    }
  }

  /* --- live tail wiring --- */

  private buildTailIO(): TailIO {
    return {
      subscribe: (agentId, cb) => subscribeToAgent(agentId, cb),
      unsubscribe: (agentId, cb) => unsubscribeFromAgent(agentId, cb),
      send: async (chatId, text) => {
        const sent = await this.bot.api.sendMessage(chatId, text, { parse_mode: 'MarkdownV2' });
        return sent.message_id;
      },
      edit: async (chatId, messageId, text) => {
        await this.bot.api.editMessageText(chatId, messageId, text, {
          parse_mode: 'MarkdownV2',
        });
      },
      registerForReplyChain: (messageId, agentId) => this.replyMap.register(messageId, agentId),
    };
  }

  /** Open a live tail subscription. Caller is responsible for checking the
   *  per-chat cap before calling. */
  openTail(chatId: number, agentId: string, pauseOnBackpressure: boolean): LiveTailHandle | null {
    const handle = openLiveTail({
      chatId,
      agentId,
      io: this.tailIO,
      limiter: this.limiter,
      redactPatterns: getConfig().redactPatterns,
      pauseOnBackpressure,
    });
    if (handle) this.tails.add(handle);
    return handle;
  }

  async closeTail(chatId: number, agentId: string, reason: string): Promise<boolean> {
    const h = this.tails.remove(chatId, agentId);
    if (!h) return false;
    await h.close(reason);
    return true;
  }

  /* --- diff / status helpers used by commands.ts --- */

  formatScrollbackForReply(agentId: string, scrollbackBase64: string, lines: number): string {
    const cfg = getConfig();
    const text = Buffer.from(scrollbackBase64, 'base64').toString('utf8');
    const stripped = stripAnsi(text);
    const tail = stripped
      .split('\n')
      .map((l) => l.replace(/\r$/, ''))
      .filter((l) => l.length > 0)
      .slice(-lines)
      .join('\n');
    const redacted = redact(tail || '(empty)', cfg.redactPatterns);
    return codeBlock(escapeMd2(redacted));
  }

  getWorktreeForAgent(agentId: string): string | null {
    const meta = getAgentMeta(agentId);
    if (!meta) return null;
    return getWorktreeByAgentMeta(meta);
  }
}

let notifierInstance: Notifier | null = null;

export function setNotifier(n: Notifier | null): void {
  notifierInstance = n;
}

export function getNotifier(): Notifier | null {
  return notifierInstance;
}
