/**
 * End-to-end integration test for the mobile-spawn-task flow.
 *
 * Wires together everything register.ts wires in production:
 *   - real startRemoteServer with the three new callbacks
 *   - real runMobileSpawn calling real createTask which creates a real
 *     git worktree on disk
 *   - real listBaseBranches running real git commands
 *   - real WebSocket client talking to the real server
 *
 * Only the pty layer is stubbed (we don't want to spawn an actual `claude`
 * binary, and node-pty is a native module).
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { execFileSync } from 'child_process';
import { createServer } from 'net';
import { WebSocket } from 'ws';

// Stub the pty module BEFORE importing anything that pulls it in.
const spawnAgentMock = vi.fn();
const writeToAgentMock = vi.fn();

vi.mock('../ipc/pty.js', () => ({
  writeToAgent: (...a: unknown[]) => writeToAgentMock(...a),
  resizeAgent: vi.fn(),
  killAgent: vi.fn(),
  subscribeToAgent: vi.fn(() => false),
  unsubscribeFromAgent: vi.fn(),
  getAgentScrollback: vi.fn(() => null),
  getActiveAgentIds: vi.fn(() => [] as string[]),
  getAgentMeta: vi.fn(() => null),
  getAgentCols: vi.fn(() => 80),
  onPtyEvent: vi.fn(() => () => undefined),
  spawnAgent: (...a: unknown[]) => spawnAgentMock(...a),
  notifyAgentListChanged: vi.fn(),
}));

// listAgents is async + cached; deterministic stub keeps the test hermetic.
vi.mock('../ipc/agents.js', () => ({
  listAgents: async () => [
    { id: 'claude-code', name: 'Claude Code', command: 'echo', args: ['hello'] },
  ],
}));

import { startRemoteServer, type SpawnTaskRequest } from './server.js';
import type { RemoteProject, RemoteBranch, ServerMessage, SpawnResultMessage } from './protocol.js';
import { listBaseBranches } from '../ipc/git-branches.js';
import { runMobileSpawn } from '../ipc/mobile-spawn.js';

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
        reject(new Error('no addr'));
      }
    });
  });
}

let workdir: string;
let repoRoot: string;
let staticDir: string;
let port: number;
let server: Awaited<ReturnType<typeof startRemoteServer>>;
let projectsByRoot: Map<string, RemoteProject>;
let lastBranchesByRoot: Map<string, Set<string>>;
let taskNames: Map<string, string>;

function git(...args: string[]): string {
  return execFileSync('git', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
}

beforeAll(() => {
  workdir = mkdtempSync(join(tmpdir(), 'mobile-spawn-int-'));
  repoRoot = join(workdir, 'repo');
  mkdirSync(repoRoot);
  // Set up a small real git repo so createTask / listBaseBranches have
  // something concrete to inspect.
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoRoot });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repoRoot });
  execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: repoRoot });
  writeFileSync(join(repoRoot, 'README.md'), '# test\n');
  git('add', 'README.md');
  git('commit', '-q', '-m', 'init');
  git('branch', 'feature/x');
});

afterAll(() => {
  rmSync(workdir, { recursive: true, force: true });
});

beforeEach(async () => {
  staticDir = mkdtempSync(join(tmpdir(), 'mobile-spawn-int-static-'));
  port = await freePort();
  spawnAgentMock.mockReset();
  writeToAgentMock.mockReset();
  projectsByRoot = new Map<string, RemoteProject>();
  lastBranchesByRoot = new Map<string, Set<string>>();
  taskNames = new Map<string, string>();
  projectsByRoot.set(repoRoot, {
    root: repoRoot,
    name: 'test-repo',
    defaultBaseBranch: 'main',
  });

  server = await startRemoteServer({
    port,
    staticDir,
    getTaskName: (taskId: string) => taskNames.get(taskId) ?? taskId,
    getAgentStatus: () => ({ status: 'exited', exitCode: null, lastLine: '' }),
    listProjects: async () => Array.from(projectsByRoot.values()),
    listBranches: async (projectRoot: string): Promise<RemoteBranch[]> => {
      if (!projectsByRoot.has(projectRoot)) return [];
      const list = await listBaseBranches(projectRoot);
      lastBranchesByRoot.set(projectRoot, new Set(list.map((b) => b.name)));
      return list;
    },
    spawnTask: async (req: SpawnTaskRequest) =>
      runMobileSpawn({} as never, req, projectsByRoot, lastBranchesByRoot, taskNames),
    getCoordinator: () => null,
  });
});

afterEach(async () => {
  if (server) await server.stop();
  rmSync(staticDir, { recursive: true, force: true });
  // Best-effort cleanup of worktrees created by the test.
  try {
    execFileSync('git', ['worktree', 'prune'], { cwd: repoRoot, stdio: 'ignore' });
  } catch {
    /* repo may not exist anymore */
  }
  const worktreeDir = join(repoRoot, '.worktrees');
  rmSync(worktreeDir, { recursive: true, force: true });
});

// --- Test harness ---------------------------------------------------------

interface Conn {
  ws: WebSocket;
  inbox: ServerMessage[];
}

function openConn(useToken: boolean): Promise<Conn> {
  return new Promise((resolve, reject) => {
    const url = useToken
      ? `ws://127.0.0.1:${port}?token=${server.token}`
      : `ws://127.0.0.1:${port}`;
    const ws = new WebSocket(url);
    const inbox: ServerMessage[] = [];
    ws.on('message', (data: WebSocket.RawData) => {
      inbox.push(JSON.parse(data.toString()) as ServerMessage);
    });
    ws.once('open', () => resolve({ ws, inbox }));
    ws.once('error', reject);
  });
}

function send(ws: WebSocket, msg: unknown): void {
  ws.send(JSON.stringify(msg));
}

async function waitForMessage<T extends ServerMessage>(
  conn: Conn,
  pred: (m: ServerMessage) => m is T,
  timeoutMs = 5_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (let i = 0; i < conn.inbox.length; i++) {
      if (pred(conn.inbox[i])) {
        const m = conn.inbox[i] as T;
        conn.inbox.splice(i, 1);
        return m;
      }
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('timeout waiting for message');
}

function isProjects(m: ServerMessage): m is Extract<ServerMessage, { type: 'projects' }> {
  return m.type === 'projects';
}
function isBranches(m: ServerMessage): m is Extract<ServerMessage, { type: 'branches' }> {
  return m.type === 'branches';
}
function spawnResultWith(requestId: string) {
  return (m: ServerMessage): m is SpawnResultMessage =>
    m.type === 'spawn_result' && (m as SpawnResultMessage).requestId === requestId;
}

// --- Tests ----------------------------------------------------------------

afterEach(() => {});

describe('mobile-spawn-task integration (real git, mocked pty)', () => {
  it('round-trips list_projects with the configured project', async () => {
    const conn = await openConn(true);
    send(conn.ws, { type: 'list_projects' });
    const reply = await waitForMessage(conn, isProjects);
    expect(reply.list).toEqual([{ root: repoRoot, name: 'test-repo', defaultBaseBranch: 'main' }]);
    conn.ws.close();
  });

  it('list_branches returns the real git branch set with current flagged', async () => {
    const conn = await openConn(true);
    send(conn.ws, { type: 'list_branches', projectRoot: repoRoot });
    const reply = await waitForMessage(conn, isBranches);
    expect(reply.projectRoot).toBe(repoRoot);
    const names = reply.list.map((b) => b.name).sort();
    expect(names).toEqual(['feature/x', 'main']);
    const current = reply.list.find((b) => b.current);
    expect(current?.name).toBe('main');
    // Cache is now populated for the spawn validator.
    expect(lastBranchesByRoot.get(repoRoot)?.has('feature/x')).toBe(true);
    conn.ws.close();
  });

  it('list_branches for an unknown root returns an empty list and does NOT invoke git', async () => {
    const conn = await openConn(true);
    // Project not in projectsByRoot — server short-circuits.
    send(conn.ws, { type: 'list_branches', projectRoot: '/not/a/real/path' });
    const reply = await waitForMessage(conn, isBranches);
    expect(reply.list).toEqual([]);
    conn.ws.close();
  });

  it('valid spawn creates a real worktree on disk and invokes spawnAgent', async () => {
    const conn = await openConn(true);
    // First populate the branches cache.
    send(conn.ws, { type: 'list_branches', projectRoot: repoRoot });
    await waitForMessage(conn, isBranches);

    send(conn.ws, {
      type: 'spawn_task',
      requestId: 'rid-1',
      projectRoot: repoRoot,
      baseBranch: 'main',
      agentId: 'claude-code',
      taskName: 'mobile e2e task',
      prompt: 'do the thing',
    });
    const reply = await waitForMessage(conn, spawnResultWith('rid-1'), 10_000);
    expect(reply.ok).toBe(true);
    if (reply.ok) {
      expect(reply.taskId).toMatch(/^[0-9a-f-]{36}$/);
      expect(reply.agentId).not.toBe('');
    }

    // Verify a worktree actually showed up on disk.
    const worktreeListing = execFileSync('git', ['worktree', 'list'], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    expect(worktreeListing).toContain('task/mobile-e2e-task-');

    // spawnAgent was called with the worktree as cwd.
    expect(spawnAgentMock).toHaveBeenCalledTimes(1);
    const spawnArgs = spawnAgentMock.mock.calls[0][1] as Record<string, unknown>;
    expect(String(spawnArgs.cwd)).toContain(join(repoRoot, '.worktrees', 'task/mobile-e2e-task-'));
    expect(spawnArgs.command).toBe('echo');

    // taskNames was updated so the agent list pushes a labelled entry.
    if (reply.ok) {
      expect(taskNames.get(reply.taskId)).toBe('mobile e2e task');
    }

    conn.ws.close();
  });

  it('rejects baseBranch the client never saw in a list_branches reply', async () => {
    const conn = await openConn(true);
    // Note: no list_branches call this time, so lastBranchesByRoot is empty.
    send(conn.ws, {
      type: 'spawn_task',
      requestId: 'rid-2',
      projectRoot: repoRoot,
      baseBranch: 'main',
      agentId: 'claude-code',
      taskName: 'never-runs',
      prompt: 'should reject',
    });
    const reply = await waitForMessage(conn, spawnResultWith('rid-2'));
    expect(reply.ok).toBe(false);
    if (!reply.ok) {
      expect(reply.error).toBe('invalid_branch');
    }
    expect(spawnAgentMock).not.toHaveBeenCalled();
    conn.ws.close();
  });

  it('spawn_task with baseBranch:null still works without a prior list_branches', async () => {
    const conn = await openConn(true);
    send(conn.ws, {
      type: 'spawn_task',
      requestId: 'rid-3',
      projectRoot: repoRoot,
      baseBranch: null,
      agentId: 'claude-code',
      taskName: 'default base',
      prompt: 'do it',
    });
    const reply = await waitForMessage(conn, spawnResultWith('rid-3'), 10_000);
    expect(reply.ok).toBe(true);
    if (reply.ok) {
      expect(reply.agentId).not.toBe('');
    }
    conn.ws.close();
  });

  it('returns create_failed when the real createTask rejects (duplicate worktree path)', async () => {
    const conn = await openConn(true);
    send(conn.ws, { type: 'list_branches', projectRoot: repoRoot });
    await waitForMessage(conn, isBranches);

    // Pre-create a directory at the worktree path so git refuses to make it.
    // The path is deterministic for the given (name, taskId-prefix); we use
    // a colliding name pattern by creating .worktrees/task/<slug>-<6hex>
    // would require knowing the uuid prefix. Easier route: rmdir-protect by
    // making `.worktrees/task` a file so git can't create the subdir tree.
    const blocker = join(repoRoot, '.worktrees');
    writeFileSync(blocker, 'block');

    try {
      send(conn.ws, {
        type: 'spawn_task',
        requestId: 'rid-4',
        projectRoot: repoRoot,
        baseBranch: 'main',
        agentId: 'claude-code',
        taskName: 'will fail to create',
        prompt: 'p',
      });
      const reply = await waitForMessage(conn, spawnResultWith('rid-4'), 10_000);
      expect(reply.ok).toBe(false);
      if (!reply.ok) {
        expect(reply.error).toBe('create_failed');
        expect(reply.message.length).toBeGreaterThan(0);
      }
      expect(spawnAgentMock).not.toHaveBeenCalled();
    } finally {
      rmSync(blocker, { force: true });
    }
    conn.ws.close();
  });
});
