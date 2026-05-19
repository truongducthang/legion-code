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
import { getNotifier } from './notifier.js';
import { verifyInitData } from './initdata.js';
import { getTunnelStatus, probeCloudflared, startTunnel, stopTunnel } from './tunnel.js';
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
import {
  DEFAULT_TELEGRAM_CONFIG,
  TelegramError,
  type TelegramConfig,
  type TelegramStatus,
} from './types.js';

let lastBootstrapError: string | null = null;
let remoteServerPort: number | null = null;

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
  await reconcileTunnel();
  return getStatus();
}

export async function stopTelegramBot(): Promise<TelegramStatus> {
  await stopBot();
  await stopTunnel();
  return getStatus();
}

export async function getStatus(): Promise<TelegramStatus> {
  const tunnel = getTunnelStatus();
  const botErr = getLastError();
  return {
    running: isBotRunning(),
    lastError: botErr ?? lastBootstrapError ?? tunnel.lastError,
    connectedChats: getConfig().allowedChatIds.length,
    botUsername: getRunningBotUsername(),
    hasToken: await hasToken(),
    tunnelActive: tunnel.active,
    tunnelUrl: tunnel.url,
  };
}

/** Renderer/IPC informs main of the remote server's bound port whenever the
 *  remote server starts or stops. Null clears the cached port and stops the
 *  tunnel if one is running. */
export async function setRemoteServerPort(port: number | null): Promise<void> {
  remoteServerPort = port;
  if (port === null) {
    await stopTunnel();
    return;
  }
  await reconcileTunnel();
}

/** Start the tunnel when bot is running, autoTunnel is on, and we know the
 *  remote-server port; otherwise stop it. Safe to call whenever any of these
 *  three preconditions might have changed. */
async function reconcileTunnel(): Promise<void> {
  const cfg = getConfig();
  const shouldRun = isBotRunning() && cfg.autoTunnel && remoteServerPort !== null;
  if (shouldRun) {
    try {
      await startTunnel({
        remotePort: remoteServerPort as number,
        cloudflaredPath: cfg.cloudflaredPath,
      });
    } catch (err) {
      logWarn('telegram.index', 'tunnel start failed', {
        msg: err instanceof Error ? err.message : String(err),
      });
    }
  } else {
    await stopTunnel();
  }
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
    await stopTunnel();
  } else if (wasEnabled && after.enabled && update.token && update.token !== '') {
    // Token changed while running — restart.
    if (isBotRunning()) await stopBot();
    await stopTunnel();
    try {
      await startTelegramBot();
    } catch (err) {
      logWarn('telegram.index', 'restart after token change failed', {
        msg: err instanceof Error ? err.message : String(err),
      });
    }
  } else {
    // Config patch may have flipped autoTunnel/cloudflaredPath while the bot
    // is already running: reconcile without restarting the bot.
    await reconcileTunnel();
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
  const diff = setStateBlob(json);
  if (diff.optedOutProjectIds.length > 0) {
    // Honour revoked consent immediately: close live tails and clear pending
    // rate-limiter entries for agents whose project just opted out.
    void getNotifier()
      ?.handleOptedOutProjects(diff.optedOutProjectIds)
      .catch((err) => {
        logWarn('telegram.index', 'opt-out cleanup failed', {
          msg: err instanceof Error ? err.message : String(err),
        });
      });
  }
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
  // Tunnel reconciliation runs after the renderer eventually calls
  // setRemoteServerPort, but if the port is already known (rare on cold
  // boot, normal on renderer reload) we kick it now.
  await reconcileTunnel();
}

/* --- cloudflared availability probe (Settings UI gating) --- */

export async function probeTelegramTunnel(): Promise<{
  available: boolean;
  version?: string;
  lastError?: string;
}> {
  return probeCloudflared(getConfig().cloudflaredPath);
}

/* --- Mini App initData verification for the remote server --- */

/**
 * Verify a Telegram WebApp `initData` payload from the mobile SPA.
 *
 * Returns:
 *   - `true`  on a valid signature whose chat is on the allowed list
 *   - `false` when telegram is disabled or no bot token is configured
 *             (the remote server returns 404 — pretend the route is absent)
 * Throws `TelegramError` on signature / freshness / allowlist failure
 *             (the remote server returns 401).
 */
export async function verifyTelegramInitData(initData: string): Promise<boolean> {
  const cfg = getConfig();
  if (!cfg.enabled) return false;
  const token = await readToken();
  if (!token) return false;
  try {
    verifyInitData(initData, token, cfg.allowedChatIds);
    return true;
  } catch (err) {
    const code = err instanceof TelegramError ? err.code : 'unknown';
    logWarn('telegram.initdata', 'verification failed', { code });
    throw err;
  }
}

/* --- exported defaults for tests / introspection --- */

export { DEFAULT_TELEGRAM_CONFIG };
