/**
 * Public entry point for the Telegram control capability. Every other file in
 * this directory is internal — `electron/ipc/register.ts` and
 * `electron/main.ts` only import from here.
 */

import { info as logInfo, warn as logWarn } from '../log.js';
import {
  startBot,
  stopBot,
  isBotRunning,
  getRunningBotUsername,
  getLastError,
  setAutoRemoveCallback,
} from './bot.js';
import {
  bootstrapFromPersistedState,
  coerceTelegramConfig,
  getConfig,
  setConfig,
} from './config.js';
import { bootstrap as bootstrapIntegration, setStateBlob } from './integration.js';
import {
  readToken,
  writeToken,
  clearToken,
  hasToken,
  writeOpenAiKey,
  clearOpenAiKey,
} from './store.js';
import { setFocusedAgent } from './focus.js';
import { record, buildEntry } from './audit.js';
import { DEFAULT_TELEGRAM_CONFIG, type TelegramConfig, type TelegramStatus } from './types.js';

let lastBootstrapError: string | null = null;

export type { TelegramConfig, TelegramStatus } from './types.js';
export { TelegramError } from './types.js';

/* --- lifecycle --- */

export async function startTelegramBot(): Promise<TelegramStatus> {
  if (isBotRunning()) return getStatus();
  const token = await readToken();
  if (!token) {
    lastBootstrapError = 'No bot token configured.';
    return getStatus();
  }
  try {
    await startBot(token);
    lastBootstrapError = null;
  } catch (err) {
    lastBootstrapError = err instanceof Error ? err.message : String(err);
    throw err;
  }
  return getStatus();
}

export async function stopTelegramBot(): Promise<TelegramStatus> {
  await stopBot();
  return getStatus();
}

export async function getStatus(): Promise<TelegramStatus> {
  return {
    running: isBotRunning(),
    lastError: getLastError() ?? lastBootstrapError,
    connectedChats: getConfig().allowedChatIds.length,
    botUsername: getRunningBotUsername(),
    hasToken: await hasToken(),
    tunnelActive: false,
    tunnelUrl: null,
  };
}

/* --- config --- */

export async function applyConfigUpdate(update: {
  config?: Partial<TelegramConfig>;
  token?: string;
  openaiApiKey?: string;
}): Promise<TelegramStatus> {
  const before = getConfig();
  const wasEnabled = before.enabled;

  if (update.token !== undefined) {
    if (update.token === '') {
      await clearToken();
      if (isBotRunning()) await stopBot();
    } else {
      await writeToken(update.token);
    }
    record(
      buildEntry({
        chatId: 0,
        username: null,
        category: 'config',
        cmd: 'set-token',
        agentId: null,
        outcome: 'ok',
        detail: update.token === '' ? 'cleared' : 'set',
      }),
    );
  }

  if (update.openaiApiKey !== undefined) {
    if (update.openaiApiKey === '') {
      await clearOpenAiKey();
    } else {
      await writeOpenAiKey(update.openaiApiKey);
    }
    record(
      buildEntry({
        chatId: 0,
        username: null,
        category: 'config',
        cmd: 'set-openai-key',
        agentId: null,
        outcome: 'ok',
        detail: update.openaiApiKey === '' ? 'cleared' : 'set',
      }),
    );
  }

  if (update.config) {
    setConfig(update.config);
  }

  const after = getConfig();

  if (after.enabled && !isBotRunning() && (await hasToken())) {
    try {
      await startTelegramBot();
    } catch (err) {
      logWarn('telegram.index', 'auto-start after config update failed', {
        msg: err instanceof Error ? err.message : String(err),
      });
    }
  } else if (!after.enabled && isBotRunning()) {
    await stopBot();
  } else if (wasEnabled && after.enabled && update.token && update.token !== '') {
    // Token changed while running — restart.
    if (isBotRunning()) await stopBot();
    try {
      await startTelegramBot();
    } catch (err) {
      logWarn('telegram.index', 'restart after token change failed', {
        msg: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return getStatus();
}

/* --- focus mirror --- */

export function setFocusedAgentId(agentId: string | null): void {
  setFocusedAgent(agentId);
}

/* --- persistence integration --- */

/** Called by the SaveAppState handler whenever the renderer persists state. */
export function onRendererStateSaved(json: string): void {
  setStateBlob(json);
  try {
    const parsed = JSON.parse(json) as { telegram?: unknown };
    if (parsed.telegram) {
      // Reconcile main's cached config with whatever the renderer wrote.
      // The renderer owns the shape; main only mirrors.
      setConfig(coerceTelegramConfig(parsed.telegram));
    }
  } catch {
    /* malformed JSON shouldn't break state sync */
  }
}

/* --- auto-resume --- */

export async function bootstrapTelegram(opts: {
  onAllowedChatsAutoRemove?: (chatId: number) => void;
}): Promise<void> {
  bootstrapIntegration();
  const cfg = bootstrapFromPersistedState();
  if (opts.onAllowedChatsAutoRemove) {
    setAutoRemoveCallback(opts.onAllowedChatsAutoRemove);
  }
  if (!cfg.enabled) return;
  const token = await readToken();
  if (!token) return;
  try {
    await startBot(token);
    logInfo('telegram.index', 'auto-resumed bot');
  } catch (err) {
    lastBootstrapError = err instanceof Error ? err.message : String(err);
    logWarn('telegram.index', 'auto-resume failed', { msg: lastBootstrapError });
  }
}

/* --- exported defaults for tests / introspection --- */

export { DEFAULT_TELEGRAM_CONFIG };
