import { describe, it, expect } from 'vitest';
import { parseClientMessage, parseSpawnError } from './protocol.js';

function spawnTaskPayload(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: 'spawn_task',
    requestId: 'req-1',
    projectRoot: '/Users/me/repo',
    baseBranch: 'main',
    agentId: 'claude-code',
    taskName: 'Refactor auth',
    prompt: 'Refactor the auth middleware',
    ...overrides,
  });
}

describe('parseClientMessage', () => {
  describe('size caps', () => {
    it('rejects oversized prompt (> 16384)', () => {
      const big = 'x'.repeat(16385);
      expect(parseClientMessage(spawnTaskPayload({ prompt: big }))).toBeNull();
    });

    it('accepts prompt exactly at the 16384 cap', () => {
      const max = 'x'.repeat(16384);
      const parsed = parseClientMessage(spawnTaskPayload({ prompt: max }));
      expect(parsed).not.toBeNull();
      expect(parsed?.type).toBe('spawn_task');
    });

    it('rejects oversized projectRoot (> 1024)', () => {
      const big = '/' + 'a'.repeat(1024);
      expect(parseClientMessage(spawnTaskPayload({ projectRoot: big }))).toBeNull();
    });

    it('rejects oversized taskName (> 200)', () => {
      const big = 'a'.repeat(201);
      expect(parseClientMessage(spawnTaskPayload({ taskName: big }))).toBeNull();
    });

    it('rejects oversized baseBranch (> 200)', () => {
      const big = 'a'.repeat(201);
      expect(parseClientMessage(spawnTaskPayload({ baseBranch: big }))).toBeNull();
    });

    it('rejects oversized agentId preset id (> 100)', () => {
      const big = 'a'.repeat(101);
      expect(parseClientMessage(spawnTaskPayload({ agentId: big }))).toBeNull();
    });

    it('rejects oversized requestId (> 100)', () => {
      const big = 'a'.repeat(101);
      expect(parseClientMessage(spawnTaskPayload({ requestId: big }))).toBeNull();
    });
  });

  describe('shape validation', () => {
    it('rejects missing projectRoot on spawn_task', () => {
      const raw = JSON.stringify({
        type: 'spawn_task',
        requestId: 'r',
        baseBranch: null,
        agentId: 'claude-code',
        taskName: 'x',
        prompt: 'y',
      });
      expect(parseClientMessage(raw)).toBeNull();
    });

    it('rejects unknown message type', () => {
      expect(parseClientMessage(JSON.stringify({ type: 'nope' }))).toBeNull();
    });

    it('rejects non-string baseBranch that is not null', () => {
      expect(parseClientMessage(spawnTaskPayload({ baseBranch: 42 }))).toBeNull();
    });

    it('rejects malformed JSON', () => {
      expect(parseClientMessage('{not json')).toBeNull();
    });

    it('rejects list_branches without projectRoot', () => {
      expect(parseClientMessage(JSON.stringify({ type: 'list_branches' }))).toBeNull();
    });
  });

  describe('valid round-trips', () => {
    it('round-trips a valid spawn_task with explicit baseBranch', () => {
      const parsed = parseClientMessage(spawnTaskPayload());
      expect(parsed).toEqual({
        type: 'spawn_task',
        requestId: 'req-1',
        projectRoot: '/Users/me/repo',
        baseBranch: 'main',
        agentId: 'claude-code',
        taskName: 'Refactor auth',
        prompt: 'Refactor the auth middleware',
      });
    });

    it('round-trips a valid spawn_task with baseBranch null', () => {
      const parsed = parseClientMessage(spawnTaskPayload({ baseBranch: null }));
      expect(parsed?.type).toBe('spawn_task');
      if (parsed?.type === 'spawn_task') {
        expect(parsed.baseBranch).toBeNull();
      }
    });

    it('round-trips list_projects', () => {
      expect(parseClientMessage(JSON.stringify({ type: 'list_projects' }))).toEqual({
        type: 'list_projects',
      });
    });

    it('round-trips list_branches', () => {
      expect(
        parseClientMessage(JSON.stringify({ type: 'list_branches', projectRoot: '/p' })),
      ).toEqual({ type: 'list_branches', projectRoot: '/p' });
    });
  });
});

describe('parseSpawnError', () => {
  it('accepts every documented code', () => {
    for (const code of [
      'invalid_project',
      'invalid_branch',
      'invalid_agent',
      'invalid_name',
      'invalid_prompt',
      'create_failed',
      'spawn_failed',
    ]) {
      expect(parseSpawnError(code)).toBe(code);
    }
  });

  it('rejects unknown strings', () => {
    expect(parseSpawnError('boom')).toBeNull();
  });

  it('rejects non-strings', () => {
    expect(parseSpawnError(42)).toBeNull();
    expect(parseSpawnError(null)).toBeNull();
    expect(parseSpawnError(undefined)).toBeNull();
  });
});
