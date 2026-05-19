import { execFile } from 'child_process';
import { promisify } from 'util';

const exec = promisify(execFile);

export interface BaseBranchEntry {
  name: string;
  /** true for the branch the project root currently has checked out. */
  current: boolean;
}

/**
 * List branches suitable as a base for a new worktree.
 * Returns local branches plus remote branches with no local counterpart
 * (stripped of the "origin/" prefix), with the desktop's currently
 * checked-out branch flagged. Returns an empty list on any git failure.
 */
export async function listBaseBranches(projectRoot: string): Promise<BaseBranchEntry[]> {
  try {
    const [localOut, remoteOut, currentOut] = await Promise.all([
      exec('git', ['branch', '--list', '--format=%(refname:short)'], { cwd: projectRoot }),
      exec('git', ['branch', '--remotes', '--list', '--format=%(refname:short)'], {
        cwd: projectRoot,
      }).catch(() => ({ stdout: '' })),
      exec('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: projectRoot }).catch(() => ({
        stdout: '',
      })),
    ]);

    const local = localOut.stdout
      .split('\n')
      .map((b) => b.trim())
      .filter(Boolean);

    const localSet = new Set(local);
    const remoteOnly: string[] = [];
    for (const raw of remoteOut.stdout.split('\n')) {
      const ref = raw.trim();
      // Filter HEAD pointers like "origin/HEAD -> origin/main"
      if (!ref || ref.includes(' ')) continue;
      const slash = ref.indexOf('/');
      if (slash < 0) continue;
      const tail = ref.slice(slash + 1);
      if (!tail || tail === 'HEAD' || localSet.has(tail)) continue;
      remoteOnly.push(tail);
    }

    const current = currentOut.stdout.trim();
    const ordered = [...local, ...remoteOnly];
    return ordered.map((name) => ({ name, current: name === current }));
  } catch {
    return [];
  }
}
