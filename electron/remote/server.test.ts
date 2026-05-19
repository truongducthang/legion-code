/**
 * Integration tests for the POST /api/telegram-auth route on the remote
 * server. Verifies the four documented outcomes:
 *   - valid initData            → 200 + session token JSON
 *   - tampered / expired / etc. → 401
 *   - hook returns false        → 404 (bot disabled or no token)
 *   - hook not supplied         → 404
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { startRemoteServer, type TelegramAuthHook } from './server.js';
import { TelegramError } from '../telegram/types.js';

let staticDir: string;
let server: ReturnType<typeof startRemoteServer> | null = null;

function startServer(telegramAuth?: TelegramAuthHook): ReturnType<typeof startRemoteServer> {
  return startRemoteServer({
    port: 0,
    staticDir,
    getTaskName: (taskId) => taskId,
    getAgentStatus: () => ({ status: 'exited', exitCode: null, lastLine: '' }),
    telegramAuth,
  });
}

async function listening(s: ReturnType<typeof startRemoteServer>): Promise<number> {
  // Poll until the underlying http server reports a bound port.
  for (let attempt = 0; attempt < 50; attempt++) {
    const info = s.addressInfo();
    if (info && info.port > 0) return info.port;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('server failed to bind');
}

beforeEach(() => {
  staticDir = mkdtempSync(join(tmpdir(), 'remote-server-test-'));
  writeFileSync(join(staticDir, 'index.html'), '<!doctype html><title>stub</title>');
});

afterEach(async () => {
  if (server) {
    await server.stop();
    server = null;
  }
  rmSync(staticDir, { recursive: true, force: true });
});

describe('POST /api/telegram-auth', () => {
  it('returns 200 with the session token when verify resolves to true', async () => {
    server = startServer({ verify: async () => true });
    const port = await listening(server);
    const res = await fetch(`http://127.0.0.1:${port}/api/telegram-auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: 'auth_date=123&hash=abc',
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token: string };
    expect(typeof body.token).toBe('string');
    expect(body.token).toBe(server.token);
    expect(body.token.length).toBeGreaterThan(10);
  });

  it('returns 401 when verify throws (signature / freshness / allowlist failure)', async () => {
    server = startServer({
      verify: async () => {
        throw new TelegramError('initdata-tampered', 'hash mismatch');
      },
    });
    const port = await listening(server);
    const res = await fetch(`http://127.0.0.1:${port}/api/telegram-auth`, {
      method: 'POST',
      body: 'auth_date=123&hash=abc',
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('unauthorized');
  });

  it('returns 404 when verify resolves to false (bot disabled / no token)', async () => {
    server = startServer({ verify: async () => false });
    const port = await listening(server);
    const res = await fetch(`http://127.0.0.1:${port}/api/telegram-auth`, {
      method: 'POST',
      body: 'auth_date=123&hash=abc',
    });
    expect(res.status).toBe(404);
  });

  it('returns 404 when telegramAuth hook is not supplied at all', async () => {
    server = startServer(); // no telegramAuth
    const port = await listening(server);
    const res = await fetch(`http://127.0.0.1:${port}/api/telegram-auth`, {
      method: 'POST',
      body: 'auth_date=123&hash=abc',
    });
    expect(res.status).toBe(404);
  });

  it('rejects payloads larger than the 4 KB cap with 413', async () => {
    server = startServer({ verify: async () => true });
    const port = await listening(server);
    const oversized = 'a'.repeat(5000);
    const res = await fetch(`http://127.0.0.1:${port}/api/telegram-auth`, {
      method: 'POST',
      body: oversized,
    });
    expect(res.status).toBe(413);
  });

  it('does not gate /api/telegram-auth on the server bearer token', async () => {
    // The /api/telegram-auth route exists to MINT the session token, so it
    // must work without one. Regression guard: ensure it is not intercepted
    // by the generic /api/ auth check.
    server = startServer({ verify: async () => true });
    const port = await listening(server);
    const res = await fetch(`http://127.0.0.1:${port}/api/telegram-auth`, {
      method: 'POST',
      body: 'auth_date=123&hash=abc',
      // NO Authorization header, NO token query param
    });
    expect(res.status).toBe(200);
  });

  it('passes the raw initData body through to the verify hook unchanged', async () => {
    let received: string | null = null;
    server = startServer({
      verify: async (initData) => {
        received = initData;
        return true;
      },
    });
    const port = await listening(server);
    const payload = 'query_id=AAA&user=%7B%22id%22%3A1%7D&auth_date=123&hash=deadbeef';
    await fetch(`http://127.0.0.1:${port}/api/telegram-auth`, {
      method: 'POST',
      body: payload,
    });
    expect(received).toBe(payload);
  });
});
