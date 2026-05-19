import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock execFile from node:child_process so listBaseBranches can be exercised
// without a real git repo.
const execFileMock = vi.fn();
vi.mock('child_process', () => ({
  execFile: (
    _cmd: string,
    _args: string[],
    _opts: unknown,
    cb: (err: Error | null, out: { stdout: string; stderr: string }) => void,
  ) => execFileMock(_cmd, _args, _opts, cb),
}));

import { listBaseBranches } from './git-branches.js';

interface Routes {
  /** `git branch --list ...` stdout. */
  local?: string;
  /** `git branch --remotes ...` stdout. */
  remote?: string;
  /** `git rev-parse --abbrev-ref HEAD` stdout. */
  current?: string;
  /** When set, the matching command rejects. */
  fail?: 'local' | 'remote' | 'current';
}

function setupGit(routes: Routes): void {
  execFileMock.mockImplementation(
    (
      _cmd: string,
      args: string[],
      _opts: unknown,
      cb: (err: Error | null, out: { stdout: string; stderr: string }) => void,
    ) => {
      if (args[0] === 'rev-parse') {
        if (routes.fail === 'current') return cb(new Error('detached'), { stdout: '', stderr: '' });
        return cb(null, { stdout: (routes.current ?? '') + '\n', stderr: '' });
      }
      if (args[0] === 'branch' && args.includes('--remotes')) {
        if (routes.fail === 'remote') return cb(new Error('boom'), { stdout: '', stderr: '' });
        return cb(null, { stdout: routes.remote ?? '', stderr: '' });
      }
      if (args[0] === 'branch') {
        if (routes.fail === 'local') return cb(new Error('boom'), { stdout: '', stderr: '' });
        return cb(null, { stdout: routes.local ?? '', stderr: '' });
      }
      return cb(new Error(`unexpected: ${args.join(' ')}`), { stdout: '', stderr: '' });
    },
  );
}

beforeEach(() => {
  execFileMock.mockReset();
});

describe('listBaseBranches', () => {
  it('returns local branches with current flagged', async () => {
    setupGit({
      local: 'main\nfeature/x\nfeature/y\n',
      remote: '',
      current: 'feature/x',
    });
    const list = await listBaseBranches('/repo');
    expect(list).toEqual([
      { name: 'main', current: false },
      { name: 'feature/x', current: true },
      { name: 'feature/y', current: false },
    ]);
  });

  it('includes remote-only branches stripped of origin/ prefix', async () => {
    setupGit({
      local: 'main\n',
      remote: 'origin/main\norigin/release\norigin/feature\n',
      current: 'main',
    });
    const list = await listBaseBranches('/repo');
    expect(list.map((b) => b.name)).toEqual(['main', 'release', 'feature']);
  });

  it('skips the origin/HEAD pointer line', async () => {
    setupGit({
      local: 'main\n',
      remote: 'origin/HEAD -> origin/main\norigin/main\norigin/dev\n',
      current: 'main',
    });
    const list = await listBaseBranches('/repo');
    expect(list.map((b) => b.name)).toEqual(['main', 'dev']);
  });

  it('does not duplicate a remote branch that already exists locally', async () => {
    setupGit({
      local: 'main\nfeature/x\n',
      remote: 'origin/main\norigin/feature/x\n',
      current: 'main',
    });
    const list = await listBaseBranches('/repo');
    expect(list.map((b) => b.name)).toEqual(['main', 'feature/x']);
  });

  it('returns [] when local branch enumeration fails', async () => {
    setupGit({ fail: 'local' });
    const list = await listBaseBranches('/repo');
    expect(list).toEqual([]);
  });

  it('still returns local list when remote enumeration fails', async () => {
    setupGit({ local: 'main\n', fail: 'remote', current: 'main' });
    const list = await listBaseBranches('/repo');
    expect(list).toEqual([{ name: 'main', current: true }]);
  });

  it('still returns local list when current-branch detection fails (no flag)', async () => {
    setupGit({ local: 'main\nfeature/x\n', fail: 'current' });
    const list = await listBaseBranches('/repo');
    expect(list).toEqual([
      { name: 'main', current: false },
      { name: 'feature/x', current: false },
    ]);
  });

  it('handles empty repo (no branches yet)', async () => {
    setupGit({ local: '', remote: '', current: 'main' });
    expect(await listBaseBranches('/repo')).toEqual([]);
  });
});
