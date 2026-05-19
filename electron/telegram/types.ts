/**
 * Public types for the Telegram control capability.
 *
 * The bot module lives entirely in the Electron main process. The renderer
 * only ever sees the types in this file via the IPC handler shapes.
 */

export type TelegramErrorCode =
  | 'not-implemented'
  | 'encryption-unavailable'
  | 'no-token'
  | 'invalid-token'
  | 'conflict'
  | 'bot-not-running'
  | 'bot-already-running'
  | 'agent-not-found'
  | 'agent-not-opted-in'
  | 'agent-project-missing'
  | 'initdata-malformed'
  | 'initdata-tampered'
  | 'initdata-expired'
  | 'initdata-disallowed-chat'
  | 'unknown';

export class TelegramError extends Error {
  readonly code: TelegramErrorCode;
  constructor(code: TelegramErrorCode, message?: string) {
    super(message ?? code);
    this.code = code;
    this.name = 'TelegramError';
  }
}

export type TelegramPushPolicy = 'all' | 'questions-only' | 'errors-only';

export type TelegramVoiceRuntime = 'none' | 'whisper-cpp' | 'openai';

/** Non-secret persisted configuration. The bot token and OpenAI key are NOT
 *  in this shape — they are owned by `store.ts` via `safeStorage`. */
export interface TelegramConfig {
  enabled: boolean;
  allowedChatIds: number[];
  pushPolicy: TelegramPushPolicy;
  redactPatterns: string[];
  extraQuestionPatterns: string[];
  publicBaseUrl: string | null;
  autoTunnel: boolean;
  cloudflaredPath: string | null;
  voice: {
    runtime: TelegramVoiceRuntime;
    whisperCppPath: string | null;
  };
}

export interface TelegramStatus {
  running: boolean;
  lastError: string | null;
  connectedChats: number;
  botUsername: string | null;
  hasToken: boolean;
  tunnelActive: boolean;
  tunnelUrl: string | null;
}

export interface TelegramConfigUpdate {
  /** Non-secret config patch. Any field missing keeps its current value. */
  config?: Partial<TelegramConfig>;
  /** Empty string clears the stored token. Undefined leaves it unchanged. */
  token?: string;
  /** Empty string clears the stored OpenAI key. Undefined leaves it unchanged. */
  openaiApiKey?: string;
}

export interface AuditEntry {
  ts: number;
  chatId: number;
  username: string | null;
  category: 'cmd' | 'inline' | 'voice' | 'upload' | 'config' | 'auto-remove';
  cmd: string;
  agentId: string | null;
  outcome: 'ok' | 'denied' | 'error';
  detail: string | null;
}

/** Notification categories the rate limiter routes through pushPolicy. */
export type NotificationCategory = 'question' | 'idle' | 'error' | 'tail';

/** A detected question match keyed by agent id and pattern id. */
export interface QuestionMatch {
  agentId: string;
  patternId: string;
  tailLine: string;
  matchedAt: number;
}

/** Per-agent exit payload mirrored from electron/ipc/pty.ts. */
export interface ExitInfo {
  exitCode: number;
  signal: string | null;
  lastOutput: string[];
}

/** A handle returned by openLiveTail for a (chat, agent) tail subscription. */
export interface LiveTailHandle {
  chatId: number;
  agentId: string;
  close(reason: string): Promise<void>;
}

/** Decoded Telegram WebApp `initData` payload after signature verification. */
export interface TelegramInitData {
  /** Unix seconds; verified to be within the freshness window. */
  authDate: number;
  /** chat.id when present, else user.id (DM payloads omit `chat`). */
  chatId: number;
  /** Decoded `user` JSON object, if `initData` carried one. */
  user: TelegramInitDataUser | null;
  /** Decoded `chat` JSON object, if `initData` carried one. */
  chat: TelegramInitDataChat | null;
  /** Raw key→value pairs (URL-decoded), minus the `hash` field. */
  raw: Record<string, string>;
  /** The verified `hash` field, lowercase hex. */
  hash: string;
}

export interface TelegramInitDataUser {
  id: number;
  first_name?: string;
  last_name?: string;
  username?: string;
  language_code?: string;
  is_premium?: boolean;
  [key: string]: unknown;
}

export interface TelegramInitDataChat {
  id: number;
  type?: string;
  title?: string;
  username?: string;
  [key: string]: unknown;
}

export const DEFAULT_TELEGRAM_CONFIG: TelegramConfig = {
  enabled: false,
  allowedChatIds: [],
  pushPolicy: 'questions-only',
  redactPatterns: [],
  extraQuestionPatterns: [],
  publicBaseUrl: null,
  autoTunnel: false,
  cloudflaredPath: null,
  voice: {
    runtime: 'none',
    whisperCppPath: null,
  },
};
