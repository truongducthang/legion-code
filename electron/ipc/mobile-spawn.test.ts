import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { BrowserWindow } from 'electron';

// Stub Electron's BrowserWindow surface used by runMobileSpawn (it's only
// forwarded to spawnAgent, which we mock).
const fakeWin = {} as BrowserWindow;

const createTaskMock = vi.fn();
const spawnAgentMock = vi.fn();
const writeToAgentMock = vi.fn();
const listAgentsMock = vi.fn();

vi.mock('./tasks.js', () => ({
  createTask: (...args: unknown[]) => createTaskMock(...args),
}));

vi.mock('./pty.js', () => ({
  spawnAgent: (...args: unknown[]) => spawnAgentMock(...args),
  writeToAgent: (...args: unknown[]) => writeToAgentMock(...args),
}));

vi.mock('./agents.js', () => ({
  listAgents: () => listAgentsMock(),
}));

import { runMobileSpawn } from './mobile-spawn.js';
import type { RemoteProject } from '../remote/protocol.js';

function makeMaps(opts: { projects?: RemoteProject[]; branches?: Record<string, string[]> }) {
  const projectsByRoot = new Map<string, RemoteProject>();
  for (const p of opts.projects ?? []) projectsByRoot.set(p.root, p);
  const lastBranchesByRoot = new Map<string, Set<string>>();
  for (const [root, list] of Object.entries(opts.branches ?? {})) {
    lastBranchesByRoot.set(root, new Set(list));
  }
  const taskNames = new Map<string, string>();
  return { projectsByRoot, lastBranchesByRoot, taskNames };
}

const baseReq = {
  requestId: 'r1',
  projectRoot: '/Users/me/repo',
  baseBranch: null as string | null,
  agentId: 'claude-code',
  taskName: 'Fix bug',
  prompt: 'Fix the auth bug',
};

beforeEach(() => {
  createTaskMock.mockReset();
  spawnAgentMock.mockReset();
  writeToAgentMock.mockReset();
  listAgentsMock.mockReset();
  listAgentsMock.mockResolvedValue([
    { id: 'claude-code', name: 'Claude Code', command: 'claude', args: [] },
  ]);
});

describe('runMobileSpawn validation', () => {
  it('rejects unknown projectRoot with invalid_project', async () => {
    const maps = makeMaps({});
    const result = await runMobileSpawn(
      fakeWin,
      baseReq,
      maps.projectsByRoot,
      maps.lastBranchesByRoot,
      maps.taskNames,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('invalid_project');
    expect(createTaskMock).not.toHaveBeenCalled();
    expect(spawnAgentMock).not.toHaveBeenCalled();
  });

  it('rejects baseBranch not in latest branches reply', async () => {
    const maps = makeMaps({
      projects: [{ root: '/Users/me/repo', name: 'r', defaultBaseBranch: 'main' }],
      branches: { '/Users/me/repo': ['main'] },
    });
    const result = await runMobileSpawn(
      fakeWin,
      { ...baseReq, baseBranch: 'feature/x' },
      maps.projectsByRoot,
      maps.lastBranchesByRoot,
      maps.taskNames,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('invalid_branch');
    expect(createTaskMock).not.toHaveBeenCalled();
  });

  it('rejects branch with invalid characters even when listed', async () => {
    // Defense in depth: if the in-memory branch cache somehow contains a
    // garbage name (e.g. crafted directly via WS without a prior list_branches
    // round-trip), the validateBranchName call should still reject it.
    const maps = makeMaps({
      projects: [{ root: '/Users/me/repo', name: 'r', defaultBaseBranch: null }],
      branches: { '/Users/me/repo': ['bad..name'] },
    });
    const result = await runMobileSpawn(
      fakeWin,
      { ...baseReq, baseBranch: 'bad..name' },
      maps.projectsByRoot,
      maps.lastBranchesByRoot,
      maps.taskNames,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('invalid_branch');
  });

  it('rejects empty-after-trim taskName with invalid_name', async () => {
    const maps = makeMaps({
      projects: [{ root: '/Users/me/repo', name: 'r', defaultBaseBranch: null }],
    });
    const result = await runMobileSpawn(
      fakeWin,
      { ...baseReq, taskName: '   \n  ' },
      maps.projectsByRoot,
      maps.lastBranchesByRoot,
      maps.taskNames,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('invalid_name');
  });

  it('rejects empty prompt with invalid_prompt', async () => {
    const maps = makeMaps({
      projects: [{ root: '/Users/me/repo', name: 'r', defaultBaseBranch: null }],
    });
    const result = await runMobileSpawn(
      fakeWin,
      { ...baseReq, prompt: '' },
      maps.projectsByRoot,
      maps.lastBranchesByRoot,
      maps.taskNames,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('invalid_prompt');
  });

  it('rejects non-absolute projectRoot with invalid_project', async () => {
    const maps = makeMaps({
      projects: [{ root: 'relative/path', name: 'r', defaultBaseBranch: null }],
    });
    const result = await runMobileSpawn(
      fakeWin,
      { ...baseReq, projectRoot: 'relative/path' },
      maps.projectsByRoot,
      maps.lastBranchesByRoot,
      maps.taskNames,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('invalid_project');
  });

  it('rejects projectRoot containing .. with invalid_project', async () => {
    const root = '/Users/me/../etc';
    const maps = makeMaps({
      projects: [{ root, name: 'r', defaultBaseBranch: null }],
    });
    const result = await runMobileSpawn(
      fakeWin,
      { ...baseReq, projectRoot: root },
      maps.projectsByRoot,
      maps.lastBranchesByRoot,
      maps.taskNames,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('invalid_project');
  });

  it('rejects unknown agentId with invalid_agent', async () => {
    const maps = makeMaps({
      projects: [{ root: '/Users/me/repo', name: 'r', defaultBaseBranch: null }],
    });
    const result = await runMobileSpawn(
      fakeWin,
      { ...baseReq, agentId: 'no-such' },
      maps.projectsByRoot,
      maps.lastBranchesByRoot,
      maps.taskNames,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('invalid_agent');
    expect(createTaskMock).not.toHaveBeenCalled();
  });
});

describe('runMobileSpawn happy path + failure modes', () => {
  it('returns create_failed when createTask rejects, with no spawn', async () => {
    createTaskMock.mockRejectedValueOnce(new Error('worktree exists'));
    const maps = makeMaps({
      projects: [{ root: '/Users/me/repo', name: 'r', defaultBaseBranch: null }],
    });
    const result = await runMobileSpawn(
      fakeWin,
      baseReq,
      maps.projectsByRoot,
      maps.lastBranchesByRoot,
      maps.taskNames,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('create_failed');
      expect(result.message).toBe('worktree exists');
    }
    expect(spawnAgentMock).not.toHaveBeenCalled();
  });

  it('returns ok:true with empty agentId when spawnAgent throws', async () => {
    createTaskMock.mockResolvedValueOnce({
      id: 'task-1',
      branch_name: 'task/x',
      worktree_path: '/Users/me/.worktrees/x',
    });
    spawnAgentMock.mockImplementationOnce(() => {
      throw new Error('binary not found');
    });
    const maps = makeMaps({
      projects: [{ root: '/Users/me/repo', name: 'r', defaultBaseBranch: null }],
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const result = await runMobileSpawn(
      fakeWin,
      baseReq,
      maps.projectsByRoot,
      maps.lastBranchesByRoot,
      maps.taskNames,
    );
    warnSpy.mockRestore();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.taskId).toBe('task-1');
      expect(result.agentId).toBe('');
    }
    expect(maps.taskNames.get('task-1')).toBe('Fix bug');
  });

  it('happy path: createTask + spawnAgent + ok:true with new agentId', async () => {
    createTaskMock.mockResolvedValueOnce({
      id: 'task-1',
      branch_name: 'task/fix-bug-abc',
      worktree_path: '/Users/me/.worktrees/x',
    });
    spawnAgentMock.mockImplementationOnce(() => undefined);
    const maps = makeMaps({
      projects: [{ root: '/Users/me/repo', name: 'r', defaultBaseBranch: 'main' }],
      branches: { '/Users/me/repo': ['main'] },
    });
    const result = await runMobileSpawn(
      fakeWin,
      { ...baseReq, baseBranch: 'main' },
      maps.projectsByRoot,
      maps.lastBranchesByRoot,
      maps.taskNames,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.taskId).toBe('task-1');
      expect(result.agentId).not.toBe('');
    }
    expect(createTaskMock).toHaveBeenCalledWith('Fix bug', '/Users/me/repo', [], 'task', 'main');
    expect(spawnAgentMock).toHaveBeenCalledTimes(1);
    const spawnArgs = spawnAgentMock.mock.calls[0][1] as Record<string, unknown>;
    expect(spawnArgs.taskId).toBe('task-1');
    expect(spawnArgs.cwd).toBe('/Users/me/.worktrees/x');
    expect(spawnArgs.command).toBe('claude');
    expect(spawnArgs.isShell).toBe(false);
  });

  it('passes baseBranch as undefined when null', async () => {
    createTaskMock.mockResolvedValueOnce({
      id: 'task-2',
      branch_name: 'task/y',
      worktree_path: '/wt',
    });
    spawnAgentMock.mockImplementationOnce(() => undefined);
    const maps = makeMaps({
      projects: [{ root: '/Users/me/repo', name: 'r', defaultBaseBranch: null }],
    });
    await runMobileSpawn(
      fakeWin,
      { ...baseReq, baseBranch: null },
      maps.projectsByRoot,
      maps.lastBranchesByRoot,
      maps.taskNames,
    );
    expect(createTaskMock).toHaveBeenCalledWith('Fix bug', '/Users/me/repo', [], 'task', undefined);
  });

  it('writes prompt after spawn via writeToAgent (bracketed paste + enter)', async () => {
    vi.useFakeTimers();
    createTaskMock.mockResolvedValueOnce({
      id: 'task-3',
      branch_name: 'task/z',
      worktree_path: '/wt',
    });
    spawnAgentMock.mockImplementationOnce(() => undefined);
    const maps = makeMaps({
      projects: [{ root: '/Users/me/repo', name: 'r', defaultBaseBranch: null }],
    });
    const promise = runMobileSpawn(
      fakeWin,
      baseReq,
      maps.projectsByRoot,
      maps.lastBranchesByRoot,
      maps.taskNames,
    );
    const result = await promise;
    expect(result.ok).toBe(true);
    // Fire-and-forget prompt — flush microtasks + advance timers to clear the
    // paste delay sleep.
    await vi.runAllTimersAsync();
    vi.useRealTimers();
    // Three writes typically: bracketed-paste wrapped prompt, then \r.
    // (writeToAgentWhenReady retries on agent-not-found; we don't simulate
    // that here so first write succeeds.)
    expect(writeToAgentMock).toHaveBeenCalled();
    const firstCallArg = writeToAgentMock.mock.calls[0][1] as string;
    expect(firstCallArg.startsWith('\x1b[200~')).toBe(true);
    expect(firstCallArg.endsWith('\x1b[201~')).toBe(true);
    expect(firstCallArg).toContain('Fix the auth bug');
    const enterCall = writeToAgentMock.mock.calls.find((c) => c[1] === '\r');
    expect(enterCall).toBeTruthy();
  });
});
