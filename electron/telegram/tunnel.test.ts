import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import type { ChildProcess } from 'child_process';
import {
  _resetForTests,
  forceRestartTunnel,
  getTunnelOwners,
  getTunnelStatus,
  onTunnelStatusChange,
  startTunnel,
  stopTunnel,
  type TunnelStatus,
} from './tunnel.js';

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
  // Release any leftover owners so each test starts clean. `_resetForTests`
  // force-kills the child too.
  await stopTunnel({ owner: 'telegram' }).catch(() => undefined);
  await stopTunnel({ owner: 'public' }).catch(() => undefined);
  _resetForTests();
});

describe('tunnel.startTunnel', () => {
  it('resolves with the trycloudflare URL when stdout yields one', async () => {
    const child = fakeChild();
    const spawnCall = vi.fn(() => child as unknown as ChildProcess);

    const p = startTunnel({
      owner: 'telegram',
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
      owner: 'telegram',
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
      owner: 'telegram',
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
      owner: 'telegram',
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
      owner: 'telegram',
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
      owner: 'telegram',
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
    const p = startTunnel({
      owner: 'telegram',
      remotePort: 9000,
      spawnFn: spawnCall,
      startTimeoutMs: 500,
    });
    queueMicrotask(() => {
      child.stdout.write('open https://reuse.trycloudflare.com\n');
    });
    await p;
    expect(spawnCall).toHaveBeenCalledTimes(1);

    const second = await startTunnel({ owner: 'telegram', remotePort: 9000, spawnFn: spawnCall });
    expect(second.url).toBe('https://reuse.trycloudflare.com');
    expect(spawnCall).toHaveBeenCalledTimes(1); // not re-spawned
  });

  it('stopTunnel SIGTERMs the running tunnel and clears state', async () => {
    const child = fakeChild();
    const p = startTunnel({
      owner: 'telegram',
      remotePort: 1234,
      spawnFn: () => child as unknown as ChildProcess,
      startTimeoutMs: 500,
    });
    queueMicrotask(() => child.stdout.write('open https://stop-me.trycloudflare.com\n'));
    await p;

    expect(getTunnelStatus().active).toBe(true);

    await stopTunnel({ owner: 'telegram' });

    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    const after = getTunnelStatus();
    expect(after.active).toBe(false);
    expect(after.url).toBeNull();
  });

  it('stopTunnel is a no-op when no tunnel is running', async () => {
    await expect(stopTunnel({ owner: 'telegram' })).resolves.toBeUndefined();
    expect(getTunnelStatus().active).toBe(false);
  });
});

describe('tunnel.refcount — shared between telegram and public consumers', () => {
  it('does not respawn when a second owner acquires the same port', async () => {
    const child = fakeChild();
    const spawnCall = vi.fn(() => child as unknown as ChildProcess);

    const first = startTunnel({
      owner: 'telegram',
      remotePort: 7777,
      spawnFn: spawnCall,
      startTimeoutMs: 500,
    });
    queueMicrotask(() => {
      child.stdout.write('https://shared.trycloudflare.com\n');
    });
    await first;
    expect(spawnCall).toHaveBeenCalledTimes(1);

    // Second consumer acquires — must reuse the same process.
    const second = await startTunnel({
      owner: 'public',
      remotePort: 7777,
      spawnFn: spawnCall,
      startTimeoutMs: 500,
    });
    expect(spawnCall).toHaveBeenCalledTimes(1);
    expect(second.url).toBe('https://shared.trycloudflare.com');
    expect(getTunnelOwners().has('telegram')).toBe(true);
    expect(getTunnelOwners().has('public')).toBe(true);
  });

  it('keeps the process running until the last owner releases', async () => {
    const child = fakeChild();
    const spawnCall = vi.fn(() => child as unknown as ChildProcess);

    const first = startTunnel({
      owner: 'telegram',
      remotePort: 7777,
      spawnFn: spawnCall,
      startTimeoutMs: 500,
    });
    queueMicrotask(() => {
      child.stdout.write('https://shared.trycloudflare.com\n');
    });
    await first;
    await startTunnel({
      owner: 'public',
      remotePort: 7777,
      spawnFn: spawnCall,
      startTimeoutMs: 500,
    });

    // First release — process must NOT be killed because the other owner
    // still holds it. This is the whole point of the refactor.
    await stopTunnel({ owner: 'telegram' });
    expect(child.kill).not.toHaveBeenCalled();
    expect(getTunnelStatus().active).toBe(true);

    // Last release — process is killed.
    await stopTunnel({ owner: 'public' });
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(getTunnelStatus().active).toBe(false);
  });

  it('refuses an acquire on a mismatched port instead of spawning a second tunnel', async () => {
    const child = fakeChild();
    const spawnCall = vi.fn(() => child as unknown as ChildProcess);

    const first = startTunnel({
      owner: 'telegram',
      remotePort: 7777,
      spawnFn: spawnCall,
      startTimeoutMs: 500,
    });
    queueMicrotask(() => {
      child.stdout.write('https://port-7777.trycloudflare.com\n');
    });
    await first;

    // Reason: both consumers always point at the same embedded server. A
    // mismatched port means a caller bug, not a legitimate use case;
    // silently spawning a second tunnel would double the cloudflared cost.
    const second = await startTunnel({
      owner: 'public',
      remotePort: 8888,
      spawnFn: spawnCall,
      startTimeoutMs: 500,
    });
    expect(spawnCall).toHaveBeenCalledTimes(1); // no second spawn
    expect(second.lastError).toMatch(/port mismatch|already running/i);
    expect(getTunnelOwners().has('public')).toBe(false);
  });
});

describe('tunnel.forceRestartTunnel', () => {
  it('spawns a new process, restores owners, and emits the new URL', async () => {
    const oldChild = fakeChild();
    const newChild = fakeChild();
    const spawnCall = vi.fn(() => oldChild as unknown as ChildProcess);

    // Two owners hold the tunnel before the simulated OS resume.
    const first = startTunnel({
      owner: 'telegram',
      remotePort: 7777,
      spawnFn: spawnCall,
      startTimeoutMs: 500,
    });
    queueMicrotask(() => oldChild.stdout.write('https://before-sleep.trycloudflare.com\n'));
    await first;
    await startTunnel({
      owner: 'public',
      remotePort: 7777,
      spawnFn: spawnCall,
      startTimeoutMs: 500,
    });
    expect(spawnCall).toHaveBeenCalledTimes(1);

    // Now simulate resume. Swap the spawn factory to return the new child.
    const events: TunnelStatus[] = [];
    const off = onTunnelStatusChange((s) => events.push(s));

    const restartSpawn = vi.fn(() => newChild as unknown as ChildProcess);
    const restartP = forceRestartTunnel({
      spawnFn: restartSpawn,
      startTimeoutMs: 500,
    });
    queueMicrotask(() => newChild.stdout.write('https://after-resume.trycloudflare.com\n'));
    const status = await restartP;

    expect(restartSpawn).toHaveBeenCalledTimes(1);
    // Old child must have been SIGTERMed by forceRestartTunnel.
    expect(oldChild.kill).toHaveBeenCalledWith('SIGTERM');
    // The post-restart status carries the new URL, NOT the cached old one.
    expect(status.url).toBe('https://after-resume.trycloudflare.com');
    // Both previous owners are restored — otherwise stopRemoteServer's
    // public-owner release would no-op and never tear the tunnel down.
    expect(getTunnelOwners().has('telegram')).toBe(true);
    expect(getTunnelOwners().has('public')).toBe(true);
    // The renderer-bound status listener must receive the new URL so the QR
    // regenerates without polling.
    expect(events[events.length - 1].url).toBe('https://after-resume.trycloudflare.com');

    off();
  });

  it('is a no-op when no tunnel is currently held', async () => {
    const spawnCall = vi.fn();
    // Calling restart with nothing to restart must not spawn anything; the
    // power-resume handler in main.ts relies on this so it can fire on every
    // resume without checking ownership itself.
    await forceRestartTunnel({ spawnFn: spawnCall as unknown as () => ChildProcess });
    expect(spawnCall).not.toHaveBeenCalled();
    expect(getTunnelStatus().active).toBe(false);
  });

  it("the old child's exit handler does not wipe the new tunnel's state", async () => {
    const oldChild = fakeChild();
    const newChild = fakeChild();

    const first = startTunnel({
      owner: 'public',
      remotePort: 7777,
      spawnFn: () => oldChild as unknown as ChildProcess,
      startTimeoutMs: 500,
    });
    queueMicrotask(() => oldChild.stdout.write('https://old.trycloudflare.com\n'));
    await first;

    const restartP = forceRestartTunnel({
      spawnFn: () => newChild as unknown as ChildProcess,
      startTimeoutMs: 500,
    });
    queueMicrotask(() => newChild.stdout.write('https://new.trycloudflare.com\n'));
    await restartP;

    // The SIGTERM on oldChild fires its 'exit' event AFTER the swap. The
    // `proc === child` guard inside spawnAndWait must make that handler a
    // no-op — otherwise it would clear owners and null the URL right after
    // we just set them.
    await new Promise((r) => setTimeout(r, 10));
    expect(getTunnelStatus().url).toBe('https://new.trycloudflare.com');
    expect(getTunnelOwners().has('public')).toBe(true);
  });
});

describe('tunnel.onTunnelStatusChange', () => {
  it('fires when the URL is acquired and when the tunnel is torn down', async () => {
    const child = fakeChild();
    const events: TunnelStatus[] = [];
    const off = onTunnelStatusChange((s) => events.push(s));

    const p = startTunnel({
      owner: 'telegram',
      remotePort: 7777,
      spawnFn: () => child as unknown as ChildProcess,
      startTimeoutMs: 500,
    });
    queueMicrotask(() => child.stdout.write('https://emit.trycloudflare.com\n'));
    await p;

    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events[events.length - 1].url).toBe('https://emit.trycloudflare.com');

    await stopTunnel({ owner: 'telegram' });
    expect(events[events.length - 1].active).toBe(false);

    off();
  });
});
