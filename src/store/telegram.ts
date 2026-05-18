import { invoke } from '../lib/ipc';
import { IPC } from '../../electron/ipc/channels';
import { setStore, store } from './core';
import type { PersistedTelegramConfig } from './types';

export interface TelegramStatusResponse {
  running: boolean;
  lastError: string | null;
  connectedChats: number;
  botUsername: string | null;
  hasToken: boolean;
  tunnelActive: boolean;
  tunnelUrl: string | null;
}

let stopGen = 0;

export async function refreshTelegramStatus(): Promise<TelegramStatusResponse | null> {
  const gen = stopGen;
  try {
    const result = await invoke<TelegramStatusResponse>(IPC.GetTelegramStatus);
    if (gen !== stopGen) return null;
    setStore('telegramHasToken', result.hasToken);
    return result;
  } catch (err) {
    console.warn('Failed to refresh telegram status:', err);
    return null;
  }
}

export async function startTelegramBot(): Promise<TelegramStatusResponse | null> {
  try {
    return await invoke<TelegramStatusResponse>(IPC.StartTelegramBot);
  } catch (err) {
    console.warn('startTelegramBot failed:', err);
    return null;
  }
}

export async function stopTelegramBot(): Promise<TelegramStatusResponse | null> {
  stopGen++;
  try {
    return await invoke<TelegramStatusResponse>(IPC.StopTelegramBot);
  } catch (err) {
    console.warn('stopTelegramBot failed:', err);
    return null;
  }
}

/** Apply a non-secret config patch and optionally write a new token /
 *  OpenAI key to encrypted storage in main. The token + key are dropped
 *  from the renderer's reactive state immediately after the IPC reply so
 *  they never persist in `state.json`. */
export async function applyTelegramConfig(args: {
  config?: Partial<PersistedTelegramConfig>;
  token?: string;
  openaiApiKey?: string;
}): Promise<TelegramStatusResponse | null> {
  try {
    const result = await invoke<TelegramStatusResponse>(IPC.SetTelegramConfig, args);
    if (args.config) {
      setStore('telegram', { ...store.telegram, ...args.config });
    }
    setStore('telegramHasToken', result.hasToken);
    return result;
  } catch (err) {
    console.warn('applyTelegramConfig failed:', err);
    throw err;
  }
}

export function setTelegramField<K extends keyof PersistedTelegramConfig>(
  key: K,
  value: PersistedTelegramConfig[K],
): void {
  setStore('telegram', key, value as never);
}

/** Add or remove a chat id locally. Triggers a config sync. */
export async function addAllowedChat(chatId: number): Promise<void> {
  if (!Number.isInteger(chatId) || chatId === 0) return;
  if (store.telegram.allowedChatIds.includes(chatId)) return;
  const next = [...store.telegram.allowedChatIds, chatId];
  await applyTelegramConfig({ config: { allowedChatIds: next } });
}

export async function removeAllowedChat(chatId: number): Promise<void> {
  const next = store.telegram.allowedChatIds.filter((id) => id !== chatId);
  await applyTelegramConfig({ config: { allowedChatIds: next } });
}

export async function setTelegramEnabled(enabled: boolean): Promise<void> {
  await applyTelegramConfig({ config: { enabled } });
}

export async function setTelegramPushPolicy(
  policy: PersistedTelegramConfig['pushPolicy'],
): Promise<void> {
  await applyTelegramConfig({ config: { pushPolicy: policy } });
}

export async function setTelegramToken(token: string): Promise<void> {
  await applyTelegramConfig({ token });
}

export async function setTelegramRedactPatterns(patterns: string[]): Promise<void> {
  await applyTelegramConfig({ config: { redactPatterns: patterns } });
}

export async function setTelegramExtraQuestionPatterns(patterns: string[]): Promise<void> {
  await applyTelegramConfig({ config: { extraQuestionPatterns: patterns } });
}

/** Push the renderer's `activeAgentId` to main so voice / reply-chain
 *  routing can fall back to the focused agent when no `<id>` is provided. */
export async function pushFocusedAgent(agentId: string | null): Promise<void> {
  try {
    await invoke(IPC.SetFocusedAgent, { agentId });
  } catch (err) {
    console.warn('pushFocusedAgent failed:', err);
  }
}
