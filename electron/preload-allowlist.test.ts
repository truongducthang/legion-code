import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { IPC } from './ipc/channels.js';

// Regression guard: every IPC channel the renderer can invoke must be in
// preload.cjs ALLOWED_CHANNELS, or `invoke` throws "Blocked IPC channel" at
// runtime. main.ts only console.warns about drift in dev, so without this
// test the mismatch ships silently (see commit 08969d3, same bug class).
describe('preload ALLOWED_CHANNELS', () => {
  const preloadSrc = readFileSync(join(__dirname, 'preload.cjs'), 'utf8');
  const hasChannel = (channel: string) =>
    preloadSrc.includes(`'${channel}'`) || preloadSrc.includes(`"${channel}"`);

  it('lists every channel in the IPC enum', () => {
    const channels: string[] = Object.values(IPC);
    const missing = channels.filter((channel) => !hasChannel(channel));
    expect(missing).toEqual([]);
  });
});
