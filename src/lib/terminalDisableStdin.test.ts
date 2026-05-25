import { describe, expect, it } from 'vitest';
import { computeDisableStdin } from './terminalDisableStdin';

describe('computeDisableStdin', () => {
  it('disables stdin when task is coordinator-controlled', () => {
    expect(computeDisableStdin('coordinator')).toBe(true);
  });

  it('enables stdin when task is human-controlled', () => {
    expect(computeDisableStdin('human')).toBe(false);
  });

  it('enables stdin when controlledBy is undefined', () => {
    expect(computeDisableStdin(undefined)).toBe(false);
  });
});
