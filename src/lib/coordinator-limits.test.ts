import { describe, expect, it } from 'vitest';

import {
  clampCoordinatorConcurrentTasks,
  DEFAULT_COORDINATOR_CONCURRENT_TASKS,
} from './coordinator-limits';

describe('clampCoordinatorConcurrentTasks', () => {
  it('keeps values within the coordinator concurrency range', () => {
    expect(clampCoordinatorConcurrentTasks(0)).toBe(1);
    expect(clampCoordinatorConcurrentTasks(3)).toBe(3);
    expect(clampCoordinatorConcurrentTasks(21)).toBe(20);
  });

  it('falls back to the default for invalid values', () => {
    expect(clampCoordinatorConcurrentTasks(Number.NaN)).toBe(DEFAULT_COORDINATOR_CONCURRENT_TASKS);
    expect(clampCoordinatorConcurrentTasks(Number.POSITIVE_INFINITY)).toBe(
      DEFAULT_COORDINATOR_CONCURRENT_TASKS,
    );
  });
});
