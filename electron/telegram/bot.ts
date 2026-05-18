/**
 * Telegram bot lifecycle: long-poll start/stop, conflict detection,
 * auto-remove on 403, allowed-chat handshake on /start.
 *
 * Public surface lives in `index.ts`; this module is internal.
 */

import { Bot, GrammyError } from 'grammy';
import { info as logInfo, warn as logWarn, error as logError } from '../log.js';
import { registerCommands, handlePromptForReplyChain } from './commands.js';
import { registerInlineCallbacks } from './inline.js';
import { Notifier, setNotifier, getNotifier } from './notifier.js';
import { chatAllowed } from './preamble.js';
import { getConfig, setConfig } from './config.js';
import { record, buildEntry } from './audit.js';
import { TelegramError } from './types.js';

interface RunningBot {
  bot: Bot;
  botUsername: string | null;
  startedAt: number;
  lastError: string | null;
}

let running: RunningBot | null = null;
let onAllowedChatsAutoRemove: ((chatId: number) => void) | null = null;

export function isBotRunning(): boolean {
  return running !== null;
}

export function getRunningBotUsername(): string | null {
  return running?.botUsername ?? null;
}

export function getLastError(): string | null {
  return running?.lastError ?? null;
}

export function setAutoRemoveCallback(cb: ((chatId: number) => void) | null): void {
  onAllowedChatsAutoRemove = cb;
}

function setLastError(msg: string | null): void {
  if (running) running.lastError = msg;
}

function isConflict(err: unknown): boolean {
  return err instanceof GrammyError && err.error_code === 409;
}

function isForbiddenBlocked(err: unknown): boolean {
  return (
    err instanceof GrammyError &&
    err.error_code === 403 &&
    /bot was blocked|bot was kicked/i.test(err.description)
  );
}

function chatIdFromError(err: GrammyError): number | null {
  const payload = err.payload as { chat_id?: number | string } | undefined;
  const raw = payload?.chat_id;
  if (typeof raw === 'number') return raw;
  if (typeof raw === 'string' && /^-?\d+$/.test(raw)) return parseInt(raw, 10);
  return null;
}

function handleBlocked(err: GrammyError): void {
  const chatId = chatIdFromError(err);
  if (chatId === null) return;
  const cfg = getConfig();
  if (!cfg.allowedChatIds.includes(chatId)) return;
  const next = cfg.allowedChatIds.filter((id) => id !== chatId);
  setConfig({ allowedChatIds: next });
  record(
    buildEntry({
      chatId,
      username: null,
      category: 'auto-remove',
      cmd: 'remove-chat',
      agentId: null,
      outcome: 'ok',
      detail: 'bot blocked',
    }),
  );
  logInfo('telegram.bot', 'auto-removed blocked chat', { chatId });
  if (onAllowedChatsAutoRemove) onAllowedChatsAutoRemove(chatId);
}

export async function startBot(token: string): Promise<{ botUsername: string }> {
  if (running) {
    return { botUsername: running.botUsername ?? '' };
  }
  if (!token || !token.trim()) {
    throw new TelegramError('no-token', 'Bot token is empty.');
  }

  const bot = new Bot(token.trim());

  bot.catch((err) => {
    const e = err.error;
    if (isForbiddenBlocked(e)) {
      handleBlocked(e as GrammyError);
      return;
    }
    const msg = e instanceof Error ? e.message : String(e);
    logError('telegram.bot', 'uncaught handler error', { msg });
    setLastError(msg);
    void err.ctx
      .reply('Sorry — something went wrong. The error has been logged.')
      .catch(() => undefined);
  });

  registerCommands(bot);
  registerInlineCallbacks(bot);

  // Reply-chain: a Telegram "reply to" a tagged bot message routes back as a
  // /prompt for the source agent without requiring an explicit `<id>`.
  bot.on('message:text', async (ctx) => {
    if (!chatAllowed(ctx)) return;
    const text = ctx.message.text;
    if (!text || text.startsWith('/')) return; // commands handled elsewhere
    const parent = ctx.message.reply_to_message;
    if (!parent) return;
    const n = getNotifier();
    if (!n) return;
    const agentId = n.replyMap.lookup(parent.message_id);
    if (!agentId) return;
    await handlePromptForReplyChain(ctx, agentId, text);
  });

  let botUsername: string | null = null;
  try {
    const me = await bot.api.getMe();
    botUsername = me.username ?? null;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new TelegramError('invalid-token', `getMe failed: ${msg}`);
  }

  try {
    await bot.api.deleteWebhook({ drop_pending_updates: true });
  } catch (err) {
    logWarn('telegram.bot', 'deleteWebhook failed (continuing)', {
      msg: err instanceof Error ? err.message : String(err),
    });
  }

  running = { bot, botUsername, startedAt: Date.now(), lastError: null };

  const notifier = new Notifier(bot);
  setNotifier(notifier);
  notifier.start();

  // Fire-and-forget. The Promise returned by bot.start only resolves when the
  // bot is stopped — awaiting it here would deadlock the StartTelegramBot IPC.
  void bot
    .start({
      drop_pending_updates: true,
      onStart: () => {
        const cfg = getConfig();
        logInfo('telegram.bot', 'started', {
          botUsername,
          allowedChats: cfg.allowedChatIds.length,
        });
      },
    })
    .catch((err) => {
      if (isConflict(err)) {
        setLastError(
          'Another process is polling this bot token. Stop the other instance or revoke the token.',
        );
        logError('telegram.bot', 'long-poll conflict (409)', {});
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        setLastError(msg);
        logError('telegram.bot', 'long-poll terminated', { msg });
      }
      running = null;
    });

  return { botUsername: botUsername ?? '' };
}

export async function stopBot(): Promise<void> {
  if (!running) return;
  const r = running;
  running = null;
  const n = getNotifier();
  if (n) {
    try {
      n.stop();
    } catch (err) {
      logWarn('telegram.bot', 'notifier stop threw (continuing)', {
        msg: err instanceof Error ? err.message : String(err),
      });
    }
    setNotifier(null);
  }
  try {
    await Promise.race([r.bot.stop(), new Promise<void>((resolve) => setTimeout(resolve, 5_000))]);
  } catch (err) {
    logWarn('telegram.bot', 'stop returned error (ignoring)', {
      msg: err instanceof Error ? err.message : String(err),
    });
  }
  logInfo('telegram.bot', 'stopped', {
    botUsername: r.botUsername,
    runtimeMs: Date.now() - r.startedAt,
  });
}
