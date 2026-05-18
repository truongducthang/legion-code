import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { openLiveTail, LiveTailRegistry, type TailIO } from './livetail.js';
import { RateLimiter } from './ratelimit.js';

function makeIO(): TailIO & {
  chunks: Array<(encoded: string) => void>;
  sent: string[];
  edits: Array<{ id: number; text: string }>;
  replyRegister: Array<{ mid: number; agentId: string }>;
} {
  const subs: Array<(encoded: string) => void> = [];
  const sent: string[] = [];
  const edits: Array<{ id: number; text: string }> = [];
  const replyRegister: Array<{ mid: number; agentId: string }> = [];
  let nextId = 1;
  return {
    chunks: subs,
    sent,
    edits,
    replyRegister,
    subscribe(_agentId, cb) {
      subs.push(cb);
      return true;
    },
    unsubscribe(_agentId, cb) {
      const i = subs.indexOf(cb);
      if (i >= 0) subs.splice(i, 1);
    },
    async send(_chatId, text) {
      sent.push(text);
      return nextId++;
    },
    async edit(_chatId, id, text) {
      edits.push({ id, text });
    },
    registerForReplyChain(mid, agentId) {
      replyRegister.push({ mid, agentId });
    },
  };
}

function chunk(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64');
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: false });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('openLiveTail', () => {
  it('returns null when subscription fails', () => {
    const io = makeIO();
    io.subscribe = () => false;
    const h = openLiveTail({
      chatId: 100,
      agentId: 'a',
      io,
      limiter: new RateLimiter(),
    });
    expect(h).toBeNull();
  });

  it('sends a message on first flush after 1s coalesce', async () => {
    const io = makeIO();
    const limiter = new RateLimiter(0);
    const h = openLiveTail({ chatId: 100, agentId: 'a', io, limiter });
    expect(h).not.toBeNull();
    io.chunks[0](chunk('hello'));
    expect(io.sent.length).toBe(0);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(io.sent.length).toBe(1);
    expect(io.sent[0]).toMatch(/hello/);
    expect(io.replyRegister[0]).toEqual({ mid: 1, agentId: 'a' });
  });

  it('coalesces multiple chunks into one edit', async () => {
    const io = makeIO();
    const limiter = new RateLimiter(0);
    const h = openLiveTail({ chatId: 100, agentId: 'a', io, limiter });
    expect(h).not.toBeNull();
    io.chunks[0](chunk('a'));
    io.chunks[0](chunk('b'));
    io.chunks[0](chunk('c'));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(io.sent.length).toBe(1);
    expect(io.sent[0]).toMatch(/abc/);
    // After the first send, subsequent flushes are edits, not new sends.
    io.chunks[0](chunk('d'));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(io.sent.length).toBe(1);
    expect(io.edits.length).toBe(1);
    expect(io.edits[0].text).toMatch(/abcd/);
  });

  it('rotates to a new message at the 3900-char threshold', async () => {
    const io = makeIO();
    const limiter = new RateLimiter(0);
    const h = openLiveTail({ chatId: 100, agentId: 'a', io, limiter });
    expect(h).not.toBeNull();
    // Two big chunks: 3000 + 2000 chars. After both, accumulated > 3900 → rotate.
    io.chunks[0](chunk('x'.repeat(3_000)));
    await vi.advanceTimersByTimeAsync(1_000);
    io.chunks[0](chunk('y'.repeat(2_000)));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(io.sent.length).toBe(2);
    // First message finalised with continued-↓ footer
    expect(io.edits[io.edits.length - 1]?.text ?? '').toMatch(/continued/);
  });

  it('close finalises the latest message with the given reason', async () => {
    const io = makeIO();
    const limiter = new RateLimiter(0);
    const h = openLiveTail({ chatId: 100, agentId: 'a', io, limiter });
    expect(h).not.toBeNull();
    io.chunks[0](chunk('hi'));
    await vi.advanceTimersByTimeAsync(1_000);
    await h?.close('user');
    expect(io.edits[io.edits.length - 1]?.text ?? '').toMatch(/tail closed/);
    expect(io.chunks.length).toBe(0);
  });

  it('strips ANSI and redacts secrets in the live tail content', async () => {
    const io = makeIO();
    const limiter = new RateLimiter(0);
    const h = openLiveTail({ chatId: 100, agentId: 'a', io, limiter });
    expect(h).not.toBeNull();
    io.chunks[0](chunk('\x1b[31mAKIAIOSFODNN7EXAMPLE\x1b[0m token here'));
    await vi.advanceTimersByTimeAsync(1_000);
    // The MD2 escaper backslash-escapes `-`, so the marker name appears as
    // `aws\-akid` inside the code block.
    expect(io.sent[0]).toMatch(/REDACTED:aws\\?-akid/);
    expect(io.sent[0]).not.toMatch(/AKIAIOSFODNN7EXAMPLE/);
    expect(io.sent[0].includes(String.fromCharCode(27))).toBe(false);
  });
});

describe('LiveTailRegistry', () => {
  it('tracks per-chat count and cap', () => {
    const r = new LiveTailRegistry(2);
    expect(r.cap()).toBe(2);
    r.add({
      chatId: 100,
      agentId: 'a',
      async close() {},
    });
    expect(r.count(100)).toBe(1);
    expect(r.has(100, 'a')).toBe(true);
    expect(r.has(100, 'b')).toBe(false);
  });

  it('remove returns the handle and decrements count', () => {
    const r = new LiveTailRegistry();
    const handle = { chatId: 100, agentId: 'a', async close() {} };
    r.add(handle);
    expect(r.remove(100, 'a')).toBe(handle);
    expect(r.count(100)).toBe(0);
  });

  it('closeAgent closes every tail for the agent across chats', async () => {
    const r = new LiveTailRegistry();
    const closes: string[] = [];
    r.add({
      chatId: 100,
      agentId: 'a',
      async close(reason) {
        closes.push(`100:${reason}`);
      },
    });
    r.add({
      chatId: 200,
      agentId: 'a',
      async close(reason) {
        closes.push(`200:${reason}`);
      },
    });
    r.add({
      chatId: 100,
      agentId: 'b',
      async close(reason) {
        closes.push(`b:${reason}`);
      },
    });
    const n = await r.closeAgent('a', 'agent exited');
    expect(n).toBe(2);
    expect(closes).toContain('100:agent exited');
    expect(closes).toContain('200:agent exited');
    expect(closes).not.toContain('b:agent exited');
  });
});
