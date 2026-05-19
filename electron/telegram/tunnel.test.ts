import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import type { ChildProcess } from 'child_process';
import { _resetForTests, getTunnelStatus, startTunnel, stopTunnel } from './tunnel.js';

class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  kill = vi.fn((_signal?: NodeJS.Signals): boolean => {
    queueMicrotask(() => this.emit('exit', 0, null));
    return true;
  });
}

function fakeChild(): FakeChild {
  return new FakeChild();
}

afterEach(async () => {
  await stopTunnel();
  _resetForTests();
});

describe('tunnel.startTunnel', () => {
  it('resolves with the trycloudflare URL when stdout yields one', async () => {
    const child = fakeChild();
    const spawnCall = vi.fn(() => child as unknown as ChildProcess);

    const p = startTunnel({
      remotePort: 7777,
      spawnFn: spawnCall,
      startTimeoutMs: 500,
    });

    queueMicrotask(() => {
      child.stdout.write('your tunnel is ready at https://example-tunnel.trycloudflare.com 🚀\n');
    });

    const status = await p;
    expect(status.active).toBe(true);
    expect(status.url).toBe('https://example-tunnel.trycloudflare.com');
    expect(status.lastError).toBeNull();
    expect(spawnCall).toHaveBeenCalledWith('cloudflared', [
      'tunnel',
      '--url',
      'http://localhost:7777',
    ]);
  });

  it('honors a user-configured cloudflaredPath', async () => {
    const child = fakeChild();
    const spawnCall = vi.fn(() => child as unknown as ChildProcess);

    const p = startTunnel({
      remotePort: 7777,
      cloudflaredPath: '/opt/cloudflared/bin/cloudflared',
      spawnFn: spawnCall,
      startTimeoutMs: 500,
    });
    queueMicrotask(() => {
      child.stderr.write('+ Welcome to Cloudflare Tunnel!\n');
      child.stderr.write('Visit https://abc-def.trycloudflare.com to access\n');
    });
    await p;
    expect(spawnCall).toHaveBeenCalledWith('/opt/cloudflared/bin/cloudflared', [
      'tunnel',
      '--url',
      'http://localhost:7777',
    ]);
  });

  it('picks the URL up from stderr too', async () => {
    const child = fakeChild();
    const p = startTunnel({
      remotePort: 1234,
      spawnFn: () => child as unknown as ChildProcess,
      startTimeoutMs: 500,
    });
    queueMicrotask(() => {
      child.stderr.write('INF Your tunnel is at https://from-stderr.trycloudflare.com\n');
    });
    const status = await p;
    expect(status.url).toBe('https://from-stderr.trycloudflare.com');
  });

  it('captures lastError when the start times out', async () => {
    const child = fakeChild();
    const p = startTunnel({
      remotePort: 1234,
      spawnFn: () => child as unknown as ChildProcess,
      startTimeoutMs: 30, // short
    });

    const status = await p;
    expect(status.active).toBe(false);
    expect(status.url).toBeNull();
    expect(status.lastError).toMatch(/did not produce a URL/);
  });

  it('captures the first stderr line as lastError when cloudflared exits before producing a URL', async () => {
    const child = fakeChild();
    const p = startTunnel({
      remotePort: 1234,
      spawnFn: () => child as unknown as ChildProcess,
      startTimeoutMs: 500,
    });
    queueMicrotask(() => {
      child.stderr.write('ERR cloudflared: failed to authenticate\n');
      child.emit('exit', 1, null);
    });

    const status = await p;
    expect(status.active).toBe(false);
    expect(status.lastError).toBe('ERR cloudflared: failed to authenticate');
  });

  it('captures an ENOENT spawn error and reports cloudflared as not found', async () => {
    const child = fakeChild();
    const p = startTunnel({
      remotePort: 1234,
      spawnFn: () => child as unknown as ChildProcess,
      startTimeoutMs: 500,
    });
    queueMicrotask(() => {
      const err = Object.assign(new Error('spawn cloudflared ENOENT'), {
        code: 'ENOENT',
        path: 'cloudflared',
      });
      child.emit('error', err);
    });
    const status = await p;
    expect(status.active).toBe(false);
    expect(status.lastError).toMatch(/cloudflared binary not found/);
  });

  it('reuses the running tunnel when called again for the same port', async () => {
    const child = fakeChild();
    const spawnCall = vi.fn(() => child as unknown as ChildProcess);
    const p = startTunnel({ remotePort: 9000, spawnFn: spawnCall, startTimeoutMs: 500 });
    queueMicrotask(() => {
      child.stdout.write('open https://reuse.trycloudflare.com\n');
    });
    await p;
    expect(spawnCall).toHaveBeenCalledTimes(1);

    const second = await startTunnel({ remotePort: 9000, spawnFn: spawnCall });
    expect(second.url).toBe('https://reuse.trycloudflare.com');
    expect(spawnCall).toHaveBeenCalledTimes(1); // not re-spawned
  });

  it('stopTunnel SIGTERMs the running tunnel and clears state', async () => {
    const child = fakeChild();
    const p = startTunnel({
      remotePort: 1234,
      spawnFn: () => child as unknown as ChildProcess,
      startTimeoutMs: 500,
    });
    queueMicrotask(() => child.stdout.write('open https://stop-me.trycloudflare.com\n'));
    await p;

    expect(getTunnelStatus().active).toBe(true);

    await stopTunnel();

    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    const after = getTunnelStatus();
    expect(after.active).toBe(false);
    expect(after.url).toBeNull();
  });

  it('stopTunnel is a no-op when no tunnel is running', async () => {
    await expect(stopTunnel()).resolves.toBeUndefined();
    expect(getTunnelStatus().active).toBe(false);
  });
});
