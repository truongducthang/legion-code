import { describe, expect, it } from 'vitest';

import { CLOSE_DIALOG_BUTTONS, resolveCloseChoice } from './close-decision';

describe('resolveCloseChoice', () => {
  it('maps button 0 (Kill & Quit) to kill', () => {
    expect(resolveCloseChoice(0)).toBe('kill');
  });

  it('maps button 1 (Keep in Background) to background', () => {
    expect(resolveCloseChoice(1)).toBe('background');
  });

  it('maps button 2 (Cancel) to abort', () => {
    expect(resolveCloseChoice(2)).toBe('abort');
  });

  it('falls back to abort for an out-of-range index', () => {
    expect(resolveCloseChoice(-1)).toBe('abort');
    expect(resolveCloseChoice(99)).toBe('abort');
  });

  it('exposes button labels with Cancel last', () => {
    expect(CLOSE_DIALOG_BUTTONS).toEqual(['Kill & Quit', 'Keep in Background', 'Cancel']);
  });
});
