/**
 * Integration tests for the remote server.
 *
 * Two independent suites live here:
 *   1. POST /api/telegram-auth  — HTTP route that mints the session token.
 *   2. WebSocket spec / spawn_task scenarios.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createServer } from 'net';
import { WebSocket } from 'ws';

// pty.js pulls in node-pty (native module). Stub the surface the server uses
// so tests don't spawn real PTYs.
vi.mock('../ipc/pty.js', () => ({
  writeToAgent: vi.fn(),
  resizeAgent: vi.fn(),
  killAgent: vi.fn(),
  subscribeToAgent: vi.fn(() => false),
  unsubscribeFromAgent: vi.fn(),
  getAgentScrollback: vi.fn(() => null),
  getActiveAgentIds: vi.fn(() => [] as string[]),
  getAgentMeta: vi.fn(() => null),
  getAgentCols: vi.fn(() => 80),
  onPtyEvent: vi.fn(() => () => undefined),
}));

import { startRemoteServer, type TelegramAuthHook, type SpawnTaskRequest } from './server.js';
import { TelegramError } from '../telegram/types.js';
import type { RemoteProject, RemoteBranch, ServerMessage, SpawnResultMessage } from './protocol.js';

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

let staticDir: string;
let server: Awaited<ReturnType<typeof startRemoteServer>> | null = null;
let port: number;

/** Ask the OS for a free port, then close immediately so we can rebind. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.unref();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const addr = s.address();
      if (addr && typeof addr === 'object') {
        const p = addr.port;
        s.close(() => resolve(p));
      } else {
        reject(new Error('no address'));
      }
    });
  });
}

/** Convenience used by the telegram-auth suite — binds to an ephemeral port. */
function startServer(telegramAuth?: TelegramAuthHook): ReturnType<typeof startRemoteServer> {
  return startRemoteServer({
    port: 0,
    staticDir,
    getTaskName: (taskId) => taskId,
    getAgentStatus: () => ({ status: 'exited', exitCode: null, lastLine: '' }),
    telegramAuth,
    getCoordinator: () => null,
  });
}

async function listening(s: Awaited<ReturnType<typeof startRemoteServer>>): Promise<number> {
  // Poll until the underlying http server reports a bound port.
  for (let attempt = 0; attempt < 50; attempt++) {
    const info = s.addressInfo();
    if (info && info.port > 0) return info.port;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('server failed to bind');
}

interface Conn {
  ws: WebSocket;
  /** Messages received, oldest first. Drained by `waitForMessage`. */
  inbox: ServerMessage[];
  /** Wakes up pending `waitForMessage` callers. */
  notify: () => void;
}

function openConn(useToken: boolean): Promise<Conn> {
  if (!server) throw new Error('openConn called before server was started');
  const token = server.token;
  return new Promise((resolve, reject) => {
    const url = useToken ? `ws://127.0.0.1:${port}?token=${token}` : `ws://127.0.0.1:${port}`;
    const ws = new WebSocket(url);
    const inbox: ServerMessage[] = [];
    let resolveNotify: (() => void) | null = null;
    const notify = () => {
      if (resolveNotify) {
        const r = resolveNotify;
        resolveNotify = null;
        r();
      }
    };
    // Attach the message listener BEFORE 'open' fires so the initial
    // `agents` push from the server isn't lost in the gap.
    ws.on('message', (data: WebSocket.RawData) => {
      inbox.push(JSON.parse(data.toString()) as ServerMessage);
      notify();
    });
    ws.once('open', () => {
      resolve({
        ws,
        inbox,
        notify: () => {
          if (resolveNotify) {
            const r = resolveNotify;
            resolveNotify = null;
            r();
          }
        },
      });
    });
    ws.once('error', reject);
    // Expose setter so waitForMessage can park on the next push.
    (ws as unknown as { __waitFor: (cb: () => void) => void }).__waitFor = (cb) => {
      resolveNotify = cb;
    };
  });
}

function send(ws: WebSocket, msg: unknown): void {
  ws.send(JSON.stringify(msg));
}

async function waitForMessage<T extends ServerMessage>(
  conn: Conn,
  pred: (m: ServerMessage) => m is T,
  timeoutMs = 2_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  // First drain the buffer.
  for (let i = 0; i < conn.inbox.length; i++) {
    const m = conn.inbox[i];
    if (pred(m)) {
      conn.inbox.splice(i, 1);
      return m;
    }
  }
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, remaining);
      (conn.ws as unknown as { __waitFor: (cb: () => void) => void }).__waitFor(() => {
        clearTimeout(t);
        resolve();
      });
    });
    for (let i = 0; i < conn.inbox.length; i++) {
      const m = conn.inbox[i];
      if (pred(m)) {
        conn.inbox.splice(i, 1);
        return m;
      }
    }
  }
  throw new Error('timeout waiting for message');
}

function nextClose(ws: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise((resolve) => {
    ws.once('close', (code, reason) => {
      resolve({ code, reason: reason.toString() });
    });
  });
}

function spawnResultWith(requestId: string) {
  return (m: ServerMessage): m is SpawnResultMessage =>
    m.type === 'spawn_result' && (m as SpawnResultMessage).requestId === requestId;
}

beforeEach(async () => {
  staticDir = mkdtempSync(join(tmpdir(), 'remote-server-test-'));
  writeFileSync(join(staticDir, 'index.html'), '<!doctype html><title>stub</title>');
  port = await freePort();
});

afterEach(async () => {
  if (server) {
    await server.stop();
    server = null;
  }
  rmSync(staticDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Suite 1 — POST /api/telegram-auth
// ---------------------------------------------------------------------------

describe('POST /api/telegram-auth', () => {
  it('returns 200 with the session token when verify resolves to true', async () => {
    server = await startServer({ verify: async () => true });
    const p = await listening(server);
    const res = await fetch(`http://127.0.0.1:${p}/api/telegram-auth`, {
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
    server = await startServer({
      verify: async () => {
        throw new TelegramError('initdata-tampered', 'hash mismatch');
      },
    });
    const p = await listening(server);
    const res = await fetch(`http://127.0.0.1:${p}/api/telegram-auth`, {
      method: 'POST',
      body: 'auth_date=123&hash=abc',
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('unauthorized');
  });

  it('returns 404 when verify resolves to false (bot disabled / no token)', async () => {
    server = await startServer({ verify: async () => false });
    const p = await listening(server);
    const res = await fetch(`http://127.0.0.1:${p}/api/telegram-auth`, {
      method: 'POST',
      body: 'auth_date=123&hash=abc',
    });
    expect(res.status).toBe(404);
  });

  it('returns 404 when telegramAuth hook is not supplied at all', async () => {
    server = await startServer(); // no telegramAuth
    const p = await listening(server);
    const res = await fetch(`http://127.0.0.1:${p}/api/telegram-auth`, {
      method: 'POST',
      body: 'auth_date=123&hash=abc',
    });
    expect(res.status).toBe(404);
  });

  it('rejects payloads larger than the 4 KB cap with 413', async () => {
    server = await startServer({ verify: async () => true });
    const p = await listening(server);
    const oversized = 'a'.repeat(5000);
    const res = await fetch(`http://127.0.0.1:${p}/api/telegram-auth`, {
      method: 'POST',
      body: oversized,
    });
    expect(res.status).toBe(413);
  });

  it('does not gate /api/telegram-auth on the server bearer token', async () => {
    // The /api/telegram-auth route exists to MINT the session token, so it
    // must work without one. Regression guard: ensure it is not intercepted
    // by the generic /api/ auth check.
    server = await startServer({ verify: async () => true });
    const p = await listening(server);
    const res = await fetch(`http://127.0.0.1:${p}/api/telegram-auth`, {
      method: 'POST',
      body: 'auth_date=123&hash=abc',
      // NO Authorization header, NO token query param
    });
    expect(res.status).toBe(200);
  });

  it('passes the raw initData body through to the verify hook unchanged', async () => {
    let received: string | null = null;
    server = await startServer({
      verify: async (initData) => {
        received = initData;
        return true;
      },
    });
    const p = await listening(server);
    const payload = 'query_id=AAA&user=%7B%22id%22%3A1%7D&auth_date=123&hash=deadbeef';
    await fetch(`http://127.0.0.1:${p}/api/telegram-auth`, {
      method: 'POST',
      body: payload,
    });
    expect(received).toBe(payload);
  });
});

// ---------------------------------------------------------------------------
// Suite 2 — WebSocket spec scenarios
// ---------------------------------------------------------------------------

describe('remote server spec scenarios', () => {
  it('closes unauthenticated client with 4001 on list_projects (spec)', async () => {
    server = await startRemoteServer({
      port,
      staticDir,
      getTaskName: () => '',
      getAgentStatus: () => ({ status: 'exited', exitCode: null, lastLine: '' }),
      listProjects: async () => [{ root: '/p', name: 'p', defaultBaseBranch: null }],
      getCoordinator: () => null,
    });
    const conn = await openConn(false);
    send(conn.ws, { type: 'list_projects' });
    const closed = await nextClose(conn.ws);
    expect(closed.code).toBe(4001);
    // Server must NOT emit the projects payload to an unauth client.
    expect(conn.inbox.some((m) => m.type === 'projects')).toBe(false);
  });

  it('replies with empty projects list when desktop has no open projects (spec)', async () => {
    server = await startRemoteServer({
      port,
      staticDir,
      getTaskName: () => '',
      getAgentStatus: () => ({ status: 'exited', exitCode: null, lastLine: '' }),
      listProjects: async () => [],
      getCoordinator: () => null,
    });
    const conn = await openConn(true);
    send(conn.ws, { type: 'list_projects' });
    const reply = await waitForMessage(
      conn,
      (m): m is Extract<ServerMessage, { type: 'projects' }> => m.type === 'projects',
    );
    expect(reply.list).toEqual([]);
    conn.ws.close();
  });

  it('replies with empty branches list when the callback rejects (spec: git failure)', async () => {
    server = await startRemoteServer({
      port,
      staticDir,
      getTaskName: () => '',
      getAgentStatus: () => ({ status: 'exited', exitCode: null, lastLine: '' }),
      listProjects: async () => [{ root: '/p', name: 'p', defaultBaseBranch: null }],
      listBranches: async () => {
        throw new Error('git boom');
      },
      getCoordinator: () => null,
    });
    const conn = await openConn(true);
    send(conn.ws, { type: 'list_branches', projectRoot: '/p' });
    const reply = await waitForMessage(
      conn,
      (m): m is Extract<ServerMessage, { type: 'branches' }> => m.type === 'branches',
    );
    expect(reply.projectRoot).toBe('/p');
    expect(reply.list).toEqual([]);
    conn.ws.close();
  });

  it('parser drops oversized prompt and the server emits no spawn_result (spec)', async () => {
    server = await startRemoteServer({
      port,
      staticDir,
      getTaskName: () => '',
      getAgentStatus: () => ({ status: 'exited', exitCode: null, lastLine: '' }),
      listProjects: async () => [{ root: '/p', name: 'p', defaultBaseBranch: null }],
      spawnTask: vi.fn(async (req: SpawnTaskRequest) => ({
        type: 'spawn_result' as const,
        requestId: req.requestId,
        ok: true as const,
        taskId: 't',
        agentId: 'a',
      })),
      getCoordinator: () => null,
    });
    const conn = await openConn(true);
    // Send an oversized prompt directly via the raw socket — parseClientMessage
    // must drop it before the handler runs.
    send(conn.ws, {
      type: 'spawn_task',
      requestId: 'rOver',
      projectRoot: '/p',
      baseBranch: null,
      agentId: 'claude-code',
      taskName: 'x',
      prompt: 'x'.repeat(16385),
    });
    // Follow it with a known-valid request so we have something to wait on
    // that proves the socket stayed open.
    send(conn.ws, {
      type: 'spawn_task',
      requestId: 'rOK',
      projectRoot: '/p',
      baseBranch: null,
      agentId: 'claude-code',
      taskName: 'x',
      prompt: 'short prompt',
    });
    const reply = await waitForMessage(conn, spawnResultWith('rOK'));
    expect(reply.ok).toBe(true);
    // The oversized request must not have produced a spawn_result.
    expect(conn.inbox.some((m) => m.type === 'spawn_result')).toBe(false);
    conn.ws.close();
  });
});

// ---------------------------------------------------------------------------
// Suite 3 — WebSocket spawn_task
// ---------------------------------------------------------------------------

describe('remote server spawn_task', () => {
  it('closes unauthenticated clients with 4001 on spawn_task', async () => {
    server = await startRemoteServer({
      port,
      staticDir,
      getTaskName: () => '',
      getAgentStatus: () => ({ status: 'exited', exitCode: null, lastLine: '' }),
      getCoordinator: () => null,
    });
    const conn = await openConn(false);
    send(conn.ws, {
      type: 'spawn_task',
      requestId: 'r1',
      projectRoot: '/p',
      baseBranch: null,
      agentId: 'claude-code',
      taskName: 'x',
      prompt: 'y',
    });
    const closed = await nextClose(conn.ws);
    expect(closed.code).toBe(4001);
  });

  it('returns invalid_project for unknown projectRoot', async () => {
    server = await startRemoteServer({
      port,
      staticDir,
      getTaskName: () => '',
      getAgentStatus: () => ({ status: 'exited', exitCode: null, lastLine: '' }),
      listProjects: async () => [],
      spawnTask: async (req: SpawnTaskRequest) => ({
        type: 'spawn_result',
        requestId: req.requestId,
        ok: false,
        error: 'invalid_project',
        message: 'project not in current project list',
      }),
      getCoordinator: () => null,
    });
    const conn = await openConn(true);
    send(conn.ws, {
      type: 'spawn_task',
      requestId: 'r1',
      projectRoot: '/elsewhere',
      baseBranch: null,
      agentId: 'claude-code',
      taskName: 'x',
      prompt: 'y',
    });
    const reply = await waitForMessage(conn, spawnResultWith('r1'));
    expect(reply.ok).toBe(false);
    if (!reply.ok) expect(reply.error).toBe('invalid_project');
    conn.ws.close();
  });

  it('routes invalid_branch and invalid_agent through the callback', async () => {
    const projects: RemoteProject[] = [{ root: '/p', name: 'p', defaultBaseBranch: 'main' }];
    const branches: RemoteBranch[] = [{ name: 'main', current: true }];
    const spawnTask = vi.fn(async (req: SpawnTaskRequest): Promise<SpawnResultMessage> => {
      if (req.baseBranch && !branches.some((b) => b.name === req.baseBranch)) {
        return {
          type: 'spawn_result',
          requestId: req.requestId,
          ok: false,
          error: 'invalid_branch',
          message: 'no',
        };
      }
      if (req.agentId !== 'claude-code') {
        return {
          type: 'spawn_result',
          requestId: req.requestId,
          ok: false,
          error: 'invalid_agent',
          message: 'no',
        };
      }
      return {
        type: 'spawn_result',
        requestId: req.requestId,
        ok: true,
        taskId: 't',
        agentId: 'a',
      };
    });
    server = await startRemoteServer({
      port,
      staticDir,
      getTaskName: () => '',
      getAgentStatus: () => ({ status: 'exited', exitCode: null, lastLine: '' }),
      listProjects: async () => projects,
      listBranches: async () => branches,
      spawnTask,
      getCoordinator: () => null,
    });
    const conn = await openConn(true);

    send(conn.ws, {
      type: 'spawn_task',
      requestId: 'r-branch',
      projectRoot: '/p',
      baseBranch: 'not-real',
      agentId: 'claude-code',
      taskName: 'x',
      prompt: 'y',
    });
    const branchReply = await waitForMessage(conn, spawnResultWith('r-branch'));
    expect(branchReply.ok).toBe(false);
    if (!branchReply.ok) expect(branchReply.error).toBe('invalid_branch');

    // Failed spawns don't update the 2s floor, so a second one is allowed.
    send(conn.ws, {
      type: 'spawn_task',
      requestId: 'r-agent',
      projectRoot: '/p',
      baseBranch: 'main',
      agentId: 'no-such-agent',
      taskName: 'x',
      prompt: 'y',
    });
    const agentReply = await waitForMessage(conn, spawnResultWith('r-agent'));
    expect(agentReply.ok).toBe(false);
    if (!agentReply.ok) expect(agentReply.error).toBe('invalid_agent');
    conn.ws.close();
  });

  it('rate-limits a successful spawn followed by a same-second retry', async () => {
    const spawnTask = vi.fn(
      async (req: SpawnTaskRequest): Promise<SpawnResultMessage> => ({
        type: 'spawn_result',
        requestId: req.requestId,
        ok: true,
        taskId: 't',
        agentId: 'a',
      }),
    );
    server = await startRemoteServer({
      port,
      staticDir,
      getTaskName: () => '',
      getAgentStatus: () => ({ status: 'exited', exitCode: null, lastLine: '' }),
      listProjects: async () => [{ root: '/p', name: 'p', defaultBaseBranch: 'main' }],
      listBranches: async () => [{ name: 'main', current: true }],
      spawnTask,
      getCoordinator: () => null,
    });
    const conn = await openConn(true);
    const base = {
      type: 'spawn_task' as const,
      projectRoot: '/p',
      baseBranch: 'main',
      agentId: 'claude-code',
      taskName: 'x',
      prompt: 'y',
    };
    send(conn.ws, { ...base, requestId: 'first' });
    const first = await waitForMessage(conn, spawnResultWith('first'));
    expect(first.ok).toBe(true);

    send(conn.ws, { ...base, requestId: 'second' });
    const second = await waitForMessage(conn, spawnResultWith('second'));
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.error).toBe('spawn_failed');
      expect(second.message).toBe('rate_limited');
    }
    expect(spawnTask).toHaveBeenCalledTimes(1);
    conn.ws.close();
  });

  it('rejects an overlapping in-flight spawn with busy', async () => {
    let release: ((r: SpawnResultMessage) => void) | undefined;
    const spawnTask = vi.fn(
      (req: SpawnTaskRequest): Promise<SpawnResultMessage> =>
        new Promise((resolve) => {
          release = (msg) =>
            resolve(
              msg ?? {
                type: 'spawn_result',
                requestId: req.requestId,
                ok: true,
                taskId: 't',
                agentId: 'a',
              },
            );
        }),
    );
    server = await startRemoteServer({
      port,
      staticDir,
      getTaskName: () => '',
      getAgentStatus: () => ({ status: 'exited', exitCode: null, lastLine: '' }),
      listProjects: async () => [{ root: '/p', name: 'p', defaultBaseBranch: 'main' }],
      listBranches: async () => [{ name: 'main', current: true }],
      spawnTask,
      getCoordinator: () => null,
    });
    const conn = await openConn(true);
    const base = {
      type: 'spawn_task' as const,
      projectRoot: '/p',
      baseBranch: 'main',
      agentId: 'claude-code',
      taskName: 'x',
      prompt: 'y',
    };
    send(conn.ws, { ...base, requestId: 'a' });
    // Give the server a tick to enter the in-flight state before the racer.
    await new Promise((r) => setTimeout(r, 10));
    send(conn.ws, { ...base, requestId: 'b' });
    const busy = await waitForMessage(conn, spawnResultWith('b'));
    expect(busy.ok).toBe(false);
    if (!busy.ok) {
      expect(busy.error).toBe('spawn_failed');
      expect(busy.message).toBe('busy');
    }
    release?.({
      type: 'spawn_result',
      requestId: 'a',
      ok: true,
      taskId: 't',
      agentId: 'a',
    });
    await waitForMessage(conn, spawnResultWith('a'));
    conn.ws.close();
  });
});
