import { afterEach, describe, expect, it, vi } from 'vitest';

import { IPC } from '../../electron/ipc/channels';
import { choice } from './dialog';

const invoke = vi.fn();

(globalThis as unknown as { window: unknown }).window = {
  electron: { ipcRenderer: { invoke } },
};

afterEach(() => {
  invoke.mockReset();
});

describe('choice', () => {
  it('invokes the DialogChoice channel with message and options', async () => {
    invoke.mockResolvedValue(2);

    const result = await choice('Pick one', {
      title: 'Closing',
      kind: 'warning',
      buttons: ['Kill & Quit', 'Keep in Background', 'Cancel'],
      defaultId: 2,
      cancelId: 2,
    });

    expect(invoke).toHaveBeenCalledWith(IPC.DialogChoice, {
      message: 'Pick one',
      title: 'Closing',
      kind: 'warning',
      buttons: ['Kill & Quit', 'Keep in Background', 'Cancel'],
      defaultId: 2,
      cancelId: 2,
    });
    expect(result).toBe(2);
  });

  it('returns the selected button index from the main process', async () => {
    invoke.mockResolvedValue(0);
    expect(await choice('msg', { buttons: ['A', 'B'] })).toBe(0);
  });
});
