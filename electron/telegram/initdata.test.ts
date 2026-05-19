import { describe, it, expect } from 'vitest';
import { createHmac } from 'crypto';
import { verifyInitData } from './initdata.js';
import { TelegramError } from './types.js';

const BOT_TOKEN = '111111:AAAA-BBBB-CCCC-DDDD-EEEE-FFFF-GGGG-HHHH';
const NOW_MS = 1_700_000_000_000; // fixed reference instant
const FRESH_AUTH_DATE = Math.floor(NOW_MS / 1000) - 5; // 5 s ago

function signInitData(payload: Record<string, string>, botToken: string): string {
  const keys = Object.keys(payload).sort();
  const joined = keys.map((k) => `${k}=${payload[k]}`).join('\n');
  const secretKey = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const hash = createHmac('sha256', secretKey).update(joined).digest('hex');
  const params = new URLSearchParams();
  for (const k of keys) params.set(k, payload[k]);
  params.set('hash', hash);
  return params.toString();
}

describe('verifyInitData', () => {
  it('accepts a known-good payload signed by the bot token', () => {
    const initData = signInitData(
      {
        query_id: 'AAEAAQABAg',
        user: JSON.stringify({ id: 1001, first_name: 'Pat', username: 'pat' }),
        auth_date: String(FRESH_AUTH_DATE),
      },
      BOT_TOKEN,
    );

    const result = verifyInitData(initData, BOT_TOKEN, [1001], NOW_MS);

    expect(result.authDate).toBe(FRESH_AUTH_DATE);
    expect(result.chatId).toBe(1001);
    expect(result.user?.id).toBe(1001);
    expect(result.chat).toBeNull();
    expect(result.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('uses chat.id when the payload carries a chat object', () => {
    const initData = signInitData(
      {
        chat: JSON.stringify({ id: -200300, type: 'supergroup' }),
        user: JSON.stringify({ id: 1001 }),
        auth_date: String(FRESH_AUTH_DATE),
      },
      BOT_TOKEN,
    );

    const result = verifyInitData(initData, BOT_TOKEN, [-200300], NOW_MS);
    expect(result.chatId).toBe(-200300);
    expect(result.chat?.id).toBe(-200300);
    expect(result.user?.id).toBe(1001);
  });

  it('rejects a tampered hash with TelegramError("initdata-tampered")', () => {
    const initData = signInitData(
      { auth_date: String(FRESH_AUTH_DATE), user: JSON.stringify({ id: 1001 }) },
      BOT_TOKEN,
    );
    // Flip one hex char of the trailing hash
    const tampered = initData.replace(/hash=([0-9a-f]+)/, (_, h: string) => {
      const flipped = h[0] === '0' ? '1' + h.slice(1) : '0' + h.slice(1);
      return `hash=${flipped}`;
    });

    expect(() => verifyInitData(tampered, BOT_TOKEN, [1001], NOW_MS)).toThrow(TelegramError);
    try {
      verifyInitData(tampered, BOT_TOKEN, [1001], NOW_MS);
    } catch (err) {
      expect((err as TelegramError).code).toBe('initdata-tampered');
    }
  });

  it('rejects a hash signed with a different bot token', () => {
    const initData = signInitData(
      { auth_date: String(FRESH_AUTH_DATE), user: JSON.stringify({ id: 1001 }) },
      'wrong-bot-token',
    );
    try {
      verifyInitData(initData, BOT_TOKEN, [1001], NOW_MS);
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(TelegramError);
      expect((err as TelegramError).code).toBe('initdata-tampered');
    }
  });

  it('rejects an expired payload (auth_date > 60 s in the past)', () => {
    const stale = Math.floor(NOW_MS / 1000) - 61;
    const initData = signInitData(
      { auth_date: String(stale), user: JSON.stringify({ id: 1001 }) },
      BOT_TOKEN,
    );

    try {
      verifyInitData(initData, BOT_TOKEN, [1001], NOW_MS);
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(TelegramError);
      expect((err as TelegramError).code).toBe('initdata-expired');
    }
  });

  it('accepts a payload exactly at the 60 s boundary', () => {
    const onTheLine = Math.floor(NOW_MS / 1000) - 60;
    const initData = signInitData(
      { auth_date: String(onTheLine), user: JSON.stringify({ id: 1001 }) },
      BOT_TOKEN,
    );

    expect(() => verifyInitData(initData, BOT_TOKEN, [1001], NOW_MS)).not.toThrow();
  });

  it('rejects a payload whose chat.id is not on the allowed list', () => {
    const initData = signInitData(
      {
        auth_date: String(FRESH_AUTH_DATE),
        user: JSON.stringify({ id: 999 }),
      },
      BOT_TOKEN,
    );
    try {
      verifyInitData(initData, BOT_TOKEN, [1001, 1002], NOW_MS);
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(TelegramError);
      expect((err as TelegramError).code).toBe('initdata-disallowed-chat');
    }
  });

  it('rejects a payload missing the hash field', () => {
    const params = new URLSearchParams();
    params.set('auth_date', String(FRESH_AUTH_DATE));
    params.set('user', JSON.stringify({ id: 1001 }));
    // no hash field
    try {
      verifyInitData(params.toString(), BOT_TOKEN, [1001], NOW_MS);
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(TelegramError);
      expect((err as TelegramError).code).toBe('initdata-malformed');
    }
  });

  it('rejects a payload missing auth_date', () => {
    const initData = signInitData({ user: JSON.stringify({ id: 1001 }) }, BOT_TOKEN);
    try {
      verifyInitData(initData, BOT_TOKEN, [1001], NOW_MS);
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(TelegramError);
      expect((err as TelegramError).code).toBe('initdata-malformed');
    }
  });

  it('rejects a payload with no chat.id and no user.id', () => {
    const initData = signInitData({ auth_date: String(FRESH_AUTH_DATE) }, BOT_TOKEN);
    try {
      verifyInitData(initData, BOT_TOKEN, [1001], NOW_MS);
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(TelegramError);
      expect((err as TelegramError).code).toBe('initdata-malformed');
    }
  });

  it('rejects a payload with non-JSON user blob', () => {
    const initData = signInitData(
      { auth_date: String(FRESH_AUTH_DATE), user: 'not-json' },
      BOT_TOKEN,
    );
    try {
      verifyInitData(initData, BOT_TOKEN, [1001], NOW_MS);
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(TelegramError);
      expect((err as TelegramError).code).toBe('initdata-malformed');
    }
  });

  it('rejects an uppercase-hex hash as malformed (Telegram emits lowercase)', () => {
    const initData = signInitData(
      { auth_date: String(FRESH_AUTH_DATE), user: JSON.stringify({ id: 1001 }) },
      BOT_TOKEN,
    );
    const upper = initData.replace(/hash=([0-9a-f]+)/, (_, h: string) => `hash=${h.toUpperCase()}`);
    try {
      verifyInitData(upper, BOT_TOKEN, [1001], NOW_MS);
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(TelegramError);
      expect((err as TelegramError).code).toBe('initdata-malformed');
    }
  });
});
