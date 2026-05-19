import { describe, it, expect, beforeEach, vi } from 'vitest';

// Stub the persistence dependency so importing integration.ts doesn't pull in
// Electron's `app` (which is unavailable in a vitest run).
vi.mock('../ipc/persistence.js', () => ({ loadAppState: () => null }));

import {
  _resetForTests,
  setStateBlob,
  getAllProjects,
  getProjectByAgentMeta,
} from './integration.js';

function blob(projects: Array<{ id: string; name: string; telegramOptIn: boolean }>): string {
  return JSON.stringify({ projects, tasks: {} });
}

describe('setStateBlob — telegramOptIn flip diff', () => {
  beforeEach(() => {
    _resetForTests();
  });

  it('returns an empty diff on first load', () => {
    const d = setStateBlob(blob([{ id: 'p1', name: 'P', telegramOptIn: true }]));
    expect(d.optedOutProjectIds).toEqual([]);
  });

  it('flags a project that flipped true → false', () => {
    setStateBlob(blob([{ id: 'p1', name: 'P', telegramOptIn: true }]));
    const d = setStateBlob(blob([{ id: 'p1', name: 'P', telegramOptIn: false }]));
    expect(d.optedOutProjectIds).toEqual(['p1']);
  });

  it('flags a deleted project as opted out (consent revoked)', () => {
    setStateBlob(blob([{ id: 'p1', name: 'P', telegramOptIn: true }]));
    const d = setStateBlob(blob([]));
    expect(d.optedOutProjectIds).toEqual(['p1']);
  });

  it('does not flag false → false', () => {
    setStateBlob(blob([{ id: 'p1', name: 'P', telegramOptIn: false }]));
    const d = setStateBlob(blob([{ id: 'p1', name: 'P', telegramOptIn: false }]));
    expect(d.optedOutProjectIds).toEqual([]);
  });

  it('does not flag true → true', () => {
    setStateBlob(blob([{ id: 'p1', name: 'P', telegramOptIn: true }]));
    const d = setStateBlob(blob([{ id: 'p1', name: 'P', telegramOptIn: true }]));
    expect(d.optedOutProjectIds).toEqual([]);
  });

  it('reports every flipped project independently', () => {
    setStateBlob(
      blob([
        { id: 'p1', name: 'P1', telegramOptIn: true },
        { id: 'p2', name: 'P2', telegramOptIn: true },
        { id: 'p3', name: 'P3', telegramOptIn: false },
      ]),
    );
    const d = setStateBlob(
      blob([
        { id: 'p1', name: 'P1', telegramOptIn: false }, // flipped
        { id: 'p2', name: 'P2', telegramOptIn: true }, // unchanged
        { id: 'p3', name: 'P3', telegramOptIn: true }, // opted-in (not flagged)
      ]),
    );
    expect(d.optedOutProjectIds).toEqual(['p1']);
  });

  it('leaves caches untouched and returns an empty diff on malformed JSON', () => {
    setStateBlob(blob([{ id: 'p1', name: 'P', telegramOptIn: true }]));
    const d = setStateBlob('not json');
    expect(d.optedOutProjectIds).toEqual([]);
    // Caches untouched.
    expect(getAllProjects()[0]?.telegramOptIn).toBe(true);
  });

  it('exposes the agent → project lookup expected by Notifier', () => {
    setStateBlob(
      JSON.stringify({
        projects: [{ id: 'p1', name: 'P', telegramOptIn: true }],
        tasks: { t1: { id: 't1', name: 'T', projectId: 'p1' } },
      }),
    );
    expect(getProjectByAgentMeta({ taskId: 't1' })?.id).toBe('p1');
  });
});
