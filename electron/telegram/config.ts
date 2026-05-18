/**
 * Main-side cache of the non-secret Telegram configuration.
 *
 * The authoritative copy lives in the renderer's persisted state. The
 * renderer pushes updates via `SetTelegramConfig`; main also reads the JSON
 * blob at startup to bootstrap auto-resume without needing the renderer to
 * be open.
 */

import { loadAppState } from '../ipc/persistence.js';
import {
  DEFAULT_TELEGRAM_CONFIG,
  type TelegramConfig,
  type TelegramPushPolicy,
  type TelegramVoiceRuntime,
} from './types.js';

let current: TelegramConfig = { ...DEFAULT_TELEGRAM_CONFIG };

export function getConfig(): TelegramConfig {
  return current;
}

export function setConfig(patch: Partial<TelegramConfig>): TelegramConfig {
  current = mergeConfig(current, patch);
  return current;
}

function mergeConfig(base: TelegramConfig, patch: Partial<TelegramConfig>): TelegramConfig {
  return {
    ...base,
    ...patch,
    voice: { ...base.voice, ...(patch.voice ?? {}) },
  };
}

/**
 * Read the persisted state.json blob and extract the `telegram` block with
 * strict per-field coercion. Called once on app start before the renderer is
 * ready so auto-resume can decide whether to launch the bot.
 */
export function bootstrapFromPersistedState(): TelegramConfig {
  const raw = loadAppState();
  if (!raw) {
    current = { ...DEFAULT_TELEGRAM_CONFIG };
    return current;
  }
  try {
    const parsed = JSON.parse(raw) as { telegram?: unknown };
    current = coerceTelegramConfig(parsed.telegram);
    return current;
  } catch {
    current = { ...DEFAULT_TELEGRAM_CONFIG };
    return current;
  }
}

function isPushPolicy(v: unknown): v is TelegramPushPolicy {
  return v === 'all' || v === 'questions-only' || v === 'errors-only';
}

function isVoiceRuntime(v: unknown): v is TelegramVoiceRuntime {
  return v === 'none' || v === 'whisper-cpp' || v === 'openai';
}

function coerceStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === 'string');
}

function coerceAllowedChatIds(v: unknown): number[] {
  if (!Array.isArray(v)) return [];
  const seen = new Set<number>();
  const out: number[] = [];
  for (const x of v) {
    if (typeof x !== 'number' || !Number.isInteger(x) || x === 0) continue;
    if (seen.has(x)) continue;
    seen.add(x);
    out.push(x);
  }
  return out;
}

export function coerceTelegramConfig(raw: unknown): TelegramConfig {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ...DEFAULT_TELEGRAM_CONFIG };
  }
  const r = raw as Record<string, unknown>;
  const voiceRaw =
    r.voice && typeof r.voice === 'object' && !Array.isArray(r.voice)
      ? (r.voice as Record<string, unknown>)
      : {};
  return {
    enabled: typeof r.enabled === 'boolean' ? r.enabled : false,
    allowedChatIds: coerceAllowedChatIds(r.allowedChatIds),
    pushPolicy: isPushPolicy(r.pushPolicy) ? r.pushPolicy : 'questions-only',
    redactPatterns: coerceStringArray(r.redactPatterns),
    extraQuestionPatterns: coerceStringArray(r.extraQuestionPatterns),
    publicBaseUrl: typeof r.publicBaseUrl === 'string' ? r.publicBaseUrl : null,
    autoTunnel: typeof r.autoTunnel === 'boolean' ? r.autoTunnel : false,
    cloudflaredPath: typeof r.cloudflaredPath === 'string' ? r.cloudflaredPath : null,
    voice: {
      runtime: isVoiceRuntime(voiceRaw.runtime) ? voiceRaw.runtime : 'none',
      whisperCppPath: typeof voiceRaw.whisperCppPath === 'string' ? voiceRaw.whisperCppPath : null,
    },
  };
}
