import { describe, expect, it } from 'vitest';
import { shouldHandoffCoordinatorQuestion } from './prompt-control';

describe('shouldHandoffCoordinatorQuestion', () => {
  it('hands off when a coordinator-controlled task is asking a question', () => {
    expect(
      shouldHandoffCoordinatorQuestion({ controlledBy: 'coordinator', questionActive: true }),
    ).toBe(true);
  });

  it('does not hand off when already under human control', () => {
    expect(shouldHandoffCoordinatorQuestion({ controlledBy: 'human', questionActive: true })).toBe(
      false,
    );
  });

  it('does not hand off when no question is active', () => {
    expect(
      shouldHandoffCoordinatorQuestion({ controlledBy: 'coordinator', questionActive: false }),
    ).toBe(false);
  });

  it('does not hand off when controlledBy is undefined even if questionActive is true', () => {
    expect(
      shouldHandoffCoordinatorQuestion({ controlledBy: undefined, questionActive: true }),
    ).toBe(false);
  });
});
