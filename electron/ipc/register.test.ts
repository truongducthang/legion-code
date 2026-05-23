import { describe, expect, it } from 'vitest';
import { selectMcpJsonDir } from './register.js';

describe('selectMcpJsonDir', () => {
  it('returns worktreePath when defined', () => {
    expect(selectMcpJsonDir('/worktrees/my-task', '/project')).toBe('/worktrees/my-task');
  });

  it('returns projectRoot when worktreePath is undefined', () => {
    expect(selectMcpJsonDir(undefined, '/project')).toBe('/project');
  });

  it('returns empty string when worktreePath is empty string (nullish coalescing only catches null/undefined)', () => {
    expect(selectMcpJsonDir('', '/project')).toBe('');
  });
});
