/**
 * Telegram Mini App `initData` HMAC verifier.
 *
 * Implements Telegram's published algorithm:
 *   secret = HMAC_SHA256(key="WebAppData", data=botToken)
 *   hash   = HMAC_SHA256(key=secret,       data=sortedPairs.join("\n"))
 * where `sortedPairs` is every key=value pair from the URL-encoded payload
 * other than `hash`, sorted alphabetically by key.
 *
 * The verifier rejects:
 *   - missing/malformed structural fields                 → initdata-malformed
 *   - hash mismatch (wrong token or tampered payload)     → initdata-tampered
 *   - `auth_date` more than 60 s in the past              → initdata-expired
 *   - chat.id (or fallback user.id) not on `allowedChatIds` → initdata-disallowed-chat
 *
 * Reference: https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
 */

import { createHmac, timingSafeEqual } from 'crypto';
import {
  TelegramError,
  type TelegramInitData,
  type TelegramInitDataChat,
  type TelegramInitDataUser,
} from './types.js';

const FRESHNESS_WINDOW_SECONDS = 60;

/**
 * Verify a Telegram WebApp `initData` payload.
 *
 * @param initData       The raw query-string supplied as `window.Telegram.WebApp.initData`.
 * @param botToken       The bot token, as issued by BotFather.
 * @param allowedChatIds Numeric chat ids permitted by the user's configuration.
 * @param nowMs          Optional override for the current time, in milliseconds since epoch.
 *                       Defaults to `Date.now()`; supplied by tests for deterministic checks.
 */
export function verifyInitData(
  initData: string,
  botToken: string,
  allowedChatIds: readonly number[],
  nowMs: number = Date.now(),
): TelegramInitData {
  if (typeof initData !== 'string' || initData.length === 0) {
    throw new TelegramError('initdata-malformed', 'empty initData');
  }

  let params: URLSearchParams;
  try {
    params = new URLSearchParams(initData);
  } catch {
    throw new TelegramError('initdata-malformed', 'unparseable URL encoding');
  }

  const hash = params.get('hash');
  if (!hash || !/^[0-9a-f]+$/.test(hash)) {
    throw new TelegramError('initdata-malformed', 'hash field missing or not lowercase hex');
  }

  const authDateRaw = params.get('auth_date');
  if (!authDateRaw) {
    throw new TelegramError('initdata-malformed', 'auth_date field missing');
  }
  const authDate = Number(authDateRaw);
  if (!Number.isFinite(authDate) || authDate <= 0) {
    throw new TelegramError('initdata-malformed', 'auth_date not a positive integer');
  }

  // Build the canonical data-check string: every non-hash pair, sorted by key,
  // joined with `\n` as `key=value` (values left URL-decoded as URLSearchParams yields).
  const raw: Record<string, string> = {};
  for (const [k, v] of params) {
    if (k === 'hash') continue;
    raw[k] = v;
  }
  const joined = Object.keys(raw)
    .sort()
    .map((k) => `${k}=${raw[k]}`)
    .join('\n');

  const secret = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const expectedHash = createHmac('sha256', secret).update(joined).digest('hex');

  const expectedBuf = Buffer.from(expectedHash, 'utf8');
  const providedBuf = Buffer.from(hash, 'utf8');
  if (expectedBuf.length !== providedBuf.length || !timingSafeEqual(expectedBuf, providedBuf)) {
    throw new TelegramError('initdata-tampered', 'hash does not match');
  }

  // Freshness window: reject anything older than 60 s. Future timestamps are
  // accepted (slight desktop clock skew should not lock out a real user).
  const nowSeconds = Math.floor(nowMs / 1000);
  if (nowSeconds - authDate > FRESHNESS_WINDOW_SECONDS) {
    throw new TelegramError(
      'initdata-expired',
      `auth_date ${nowSeconds - authDate}s old (limit ${FRESHNESS_WINDOW_SECONDS}s)`,
    );
  }

  const user = decodeJsonField<TelegramInitDataUser>(raw.user, 'user');
  const chat = decodeJsonField<TelegramInitDataChat>(raw.chat, 'chat');

  const chatId =
    typeof chat?.id === 'number' && Number.isFinite(chat.id)
      ? chat.id
      : typeof user?.id === 'number' && Number.isFinite(user.id)
        ? user.id
        : null;
  if (chatId === null) {
    throw new TelegramError('initdata-malformed', 'no chat.id or user.id available');
  }

  if (!allowedChatIds.includes(chatId)) {
    throw new TelegramError('initdata-disallowed-chat', `chat ${chatId} not on allowed list`);
  }

  return {
    authDate,
    chatId,
    user,
    chat,
    raw,
    hash,
  };
}

function decodeJsonField<T>(value: string | undefined, fieldName: string): T | null {
  if (value === undefined) return null;
  try {
    const parsed = JSON.parse(value) as T;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new TelegramError('initdata-malformed', `${fieldName} is not a JSON object`);
    }
    return parsed;
  } catch (err) {
    if (err instanceof TelegramError) throw err;
    throw new TelegramError('initdata-malformed', `${fieldName} is not valid JSON`);
  }
}
