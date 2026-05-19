/**
 * Refcounted cloudflared tunnel shared by the Telegram bot and the public
 * remote-access feature.
 *
 * Cloudflared is detected at the user-configured `cloudflaredPath` or — when
 * that is null — invoked as a bare `cloudflared` and resolved via the
 * spawning process's PATH. The tunnel publishes the local remote-server port
 * over a `https://<random>.trycloudflare.com` URL, parsed from cloudflared's
 * stdout/stderr.
 *
 * Ownership model: at most one `cloudflared` process runs at a time. Each
 * consumer (`'telegram'` or `'public'`) acquires a hold via `startTunnel`
 * and releases it via `stopTunnel`. The first acquirer spawns the process;
 * the last releaser tears it down. Both consumers observe the same URL.
 */

import { execFile as nodeExecFile, spawn as nodeSpawn, type ChildProcess } from 'child_process';
import { promisify } from 'util';
import { warn as logWarn, info as logInfo } from '../log.js';

const execFileAsync = promisify(nodeExecFile);

export type TunnelOwner = 'telegram' | 'public';

export interface TunnelStatus {
  /** True only when the tunnel is up AND has produced a URL. */
  active: boolean;
  /** The published `https://<random>.trycloudflare.com` URL, or null. */
  url: string | null;
  /** Most recent failure message (binary missing, timeout, unexpected exit). */
  lastError: string | null;
}

export type SpawnFn = (cmd: string, args: readonly string[]) => ChildProcess;

export interface StartTunnelOpts {
  /** Local port to expose. Typically the remote server's port. */
  remotePort: number;
  /** Which consumer is asking. Required so refcounting can attribute holds. */
  owner: TunnelOwner;
  /** User-configured cloudflared path. `null` means "find on PATH". */
  cloudflaredPath?: string | null;
  /** Test seam — defaults to `child_process.spawn`. */
  spawnFn?: SpawnFn;
  /** Milliseconds to wait for stdout/stderr to yield the URL. */
  startTimeoutMs?: number;
}

export interface StopTunnelOpts {
  /** Which consumer is releasing its hold. */
  owner: TunnelOwner;
}

const TRYCLOUDFLARE_RX = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;

let proc: ChildProcess | null = null;
let activeRemotePort: number | null = null;
let lastUrl: string | null = null;
let lastError: string | null = null;
const owners = new Set<TunnelOwner>();
const statusListeners = new Set<(s: TunnelStatus) => void>();

export function getTunnelStatus(): TunnelStatus {
  return {
    active: proc !== null && lastUrl !== null,
    url: lastUrl,
    lastError,
  };
}

/** Returns the set of owners currently holding the tunnel. Test/diagnostic only. */
export function getTunnelOwners(): ReadonlySet<TunnelOwner> {
  return new Set(owners);
}

/**
 * Subscribe to status transitions (URL acquired, error captured, tunnel
 * stopped). The callback is fired with the current status object after each
 * transition. Returns an unsubscribe function.
 */
export function onTunnelStatusChange(cb: (status: TunnelStatus) => void): () => void {
  statusListeners.add(cb);
  return () => statusListeners.delete(cb);
}

function emitStatus(): void {
  const snapshot = getTunnelStatus();
  for (const cb of statusListeners) {
    try {
      cb(snapshot);
    } catch (err) {
      logWarn('telegram.tunnel', 'status listener threw', {
        msg: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

/**
 * Acquire a tunnel hold for `owner`. If no tunnel is running, spawn one and
 * resolve once the public URL is observed in the child's output, or after
 * the start timeout — whichever comes first. If a tunnel is already running
 * on the same `remotePort`, the call is idempotent and returns the current
 * status without spawning a second process. A mismatched `remotePort` is
 * rejected — both consumers always target the same embedded server.
 */
export async function startTunnel(opts: StartTunnelOpts): Promise<TunnelStatus> {
  if (proc) {
    if (opts.remotePort !== activeRemotePort) {
      lastError = `tunnel already running on port ${activeRemotePort}; refused acquire for port ${opts.remotePort}`;
      logWarn('telegram.tunnel', 'port mismatch on acquire', {
        owner: opts.owner,
        requested: opts.remotePort,
        active: activeRemotePort,
      });
      // Do NOT add this owner; the call failed.
      return getTunnelStatus();
    }
    owners.add(opts.owner);
    return getTunnelStatus();
  }

  owners.add(opts.owner);
  const status = await spawnAndWait({
    remotePort: opts.remotePort,
    cloudflaredPath: opts.cloudflaredPath,
    spawnFn: opts.spawnFn,
    startTimeoutMs: opts.startTimeoutMs,
  });
  if (proc === null) {
    // spawn or URL wait failed — release the hold we tentatively added so
    // the next acquire attempt starts from a clean slate.
    owners.delete(opts.owner);
  }
  return status;
}

/**
 * Force a fresh `cloudflared` process even when one is already running, and
 * restore the previous owner set against the new process. Used after the
 * OS resumes from sleep: the existing TCP session to Cloudflare's edge is
 * dead (Cloudflare drops idle tunnels after ~30 s of missed heartbeats), so
 * the still-running `cloudflared` will either reconnect to a NEW session ID
 * (new URL we don't observe) or hang. The cleanest fix is to throw it out
 * and start over.
 */
export async function forceRestartTunnel(opts: {
  cloudflaredPath?: string | null;
  spawnFn?: SpawnFn;
  startTimeoutMs?: number;
}): Promise<TunnelStatus> {
  if (owners.size === 0 || !proc || activeRemotePort === null) {
    return getTunnelStatus();
  }
  const port = activeRemotePort;
  const savedOwners = new Set(owners);

  // Detach the current proc from module state BEFORE killing so its own
  // `once('exit')` handler short-circuits via the `proc === child` guard
  // and does NOT clobber the about-to-be-set new state.
  const old = proc;
  proc = null;
  activeRemotePort = null;
  owners.clear();
  try {
    old.kill('SIGTERM');
  } catch {
    /* already exited */
  }

  const status = await spawnAndWait({
    remotePort: port,
    cloudflaredPath: opts.cloudflaredPath,
    spawnFn: opts.spawnFn,
    startTimeoutMs: opts.startTimeoutMs,
  });
  if (proc !== null) {
    for (const o of savedOwners) owners.add(o);
  }
  // If spawn failed, owners stays empty; the next acquire starts fresh.
  return status;
}

/**
 * Spawn cloudflared, wait for the URL or the start timeout. Mutates `proc`,
 * `activeRemotePort`, `lastUrl`, `lastError` and emits status transitions.
 * Does NOT touch `owners` — callers manage that themselves. Internal helper
 * shared by `startTunnel` and `forceRestartTunnel`.
 */
async function spawnAndWait(opts: {
  remotePort: number;
  cloudflaredPath?: string | null;
  spawnFn?: SpawnFn;
  startTimeoutMs?: number;
}): Promise<TunnelStatus> {
  const cmd = opts.cloudflaredPath ?? 'cloudflared';
  const args = ['tunnel', '--url', `http://localhost:${opts.remotePort}`];
  const spawnFn = opts.spawnFn ?? defaultSpawn;
  const timeoutMs = opts.startTimeoutMs ?? 10_000;

  let child: ChildProcess;
  try {
    child = spawnFn(cmd, args);
  } catch (err) {
    lastError = `Failed to spawn cloudflared: ${err instanceof Error ? err.message : String(err)}`;
    logWarn('telegram.tunnel', 'spawn failed', { msg: lastError });
    emitStatus();
    return getTunnelStatus();
  }

  proc = child;
  activeRemotePort = opts.remotePort;
  lastUrl = null;
  lastError = null;

  const url = await waitForUrl(child, timeoutMs);
  if (url === null) {
    if (proc === child) {
      try {
        proc.kill('SIGTERM');
      } catch {
        /* already exited */
      }
      proc = null;
      activeRemotePort = null;
    }
    if (!lastError) {
      lastError = `cloudflared did not produce a URL within ${timeoutMs}ms`;
    }
    logWarn('telegram.tunnel', 'no URL after timeout', { msg: lastError });
    emitStatus();
    return getTunnelStatus();
  }

  lastUrl = url;
  logInfo('telegram.tunnel', 'tunnel ready', { url });
  emitStatus();

  child.once('exit', (code, signal) => {
    // Guard: only mutate module state if THIS child is still the active
    // proc. `forceRestartTunnel` swaps `proc` BEFORE killing, so this
    // handler becomes a no-op for the old detached child — preventing it
    // from wiping the new tunnel's state.
    if (proc === child) {
      proc = null;
      activeRemotePort = null;
      lastUrl = null;
      owners.clear();
      lastError = `cloudflared exited (code=${code ?? 'null'} signal=${signal ?? 'null'})`;
      logWarn('telegram.tunnel', 'tunnel exited after running', { msg: lastError });
      emitStatus();
    }
  });

  return getTunnelStatus();
}

/**
 * Release `owner`'s hold. When the final hold is released, SIGTERM the
 * running tunnel and resolve when it exits, or after a 2 s force-kill
 * fallback. Safe to call when `owner` has no current hold.
 */
export async function stopTunnel(opts: StopTunnelOpts): Promise<void> {
  if (!owners.has(opts.owner)) return;
  owners.delete(opts.owner);
  if (owners.size > 0) return; // other consumers still hold the tunnel
  if (!proc) return;

  const p = proc;
  proc = null;
  activeRemotePort = null;
  lastUrl = null;

  await new Promise<void>((resolve) => {
    let resolved = false;
    const finish = () => {
      if (resolved) return;
      resolved = true;
      resolve();
    };

    p.once('exit', finish);

    try {
      p.kill('SIGTERM');
    } catch {
      /* already exited */
      finish();
      return;
    }

    setTimeout(() => {
      if (resolved) return;
      try {
        p.kill('SIGKILL');
      } catch {
        /* already exited */
      }
      finish();
    }, 2_000);
  });

  emitStatus();
}

/** Reset all module state. Tests use this to keep one test's state from
 *  leaking into the next. Also force-kills any running child synchronously
 *  so tests don't leak processes. */
export function _resetForTests(): void {
  if (proc) {
    try {
      proc.kill('SIGKILL');
    } catch {
      /* ignore */
    }
  }
  proc = null;
  activeRemotePort = null;
  lastUrl = null;
  lastError = null;
  owners.clear();
  statusListeners.clear();
}

function defaultSpawn(cmd: string, args: readonly string[]): ChildProcess {
  return nodeSpawn(cmd, args as string[], { stdio: ['ignore', 'pipe', 'pipe'] });
}

/**
 * Probe whether `cloudflared` is invokable at the given path (or via PATH).
 * Used by the Settings UI to gate the auto-tunnel toggle's visibility.
 * Returns `{ available: boolean; version?: string; lastError?: string }`.
 */
export async function probeCloudflared(cloudflaredPath?: string | null): Promise<{
  available: boolean;
  version?: string;
  lastError?: string;
}> {
  const cmd = cloudflaredPath?.trim() || 'cloudflared';
  try {
    const { stdout } = await execFileAsync(cmd, ['--version'], { timeout: 5_000 });
    const versionLine = stdout.split(/\r?\n/).find((l) => l.trim().length > 0) ?? '';
    return { available: true, version: versionLine.trim() };
  } catch (err) {
    return {
      available: false,
      lastError: err instanceof Error ? err.message : String(err),
    };
  }
}

function waitForUrl(child: ChildProcess, timeoutMs: number): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    let firstStderrLine: string | null = null;
    let settled = false;

    const settle = (url: string | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(url);
    };

    const onText = (chunk: Buffer): void => {
      const text = chunk.toString('utf8');
      const m = TRYCLOUDFLARE_RX.exec(text);
      if (m) settle(m[0]);
    };

    child.stdout?.on('data', onText);
    child.stderr?.on('data', (chunk: Buffer) => {
      onText(chunk);
      if (firstStderrLine === null) {
        const line = chunk
          .toString('utf8')
          .split(/\r?\n/)
          .find((l) => l.trim().length > 0);
        if (line) firstStderrLine = line.trim();
      }
    });

    child.once('exit', (code, signal) => {
      if (settled) return;
      if (firstStderrLine) lastError = firstStderrLine;
      else if (code !== null) lastError = `cloudflared exited with code ${code}`;
      else if (signal) lastError = `cloudflared killed by ${signal}`;
      else lastError = 'cloudflared exited unexpectedly';
      settle(null);
    });

    child.once('error', (err: NodeJS.ErrnoException) => {
      if (settled) return;
      lastError =
        err.code === 'ENOENT'
          ? `cloudflared binary not found (path: "${err.path ?? 'cloudflared'}")`
          : err.message;
      settle(null);
    });

    const timer = setTimeout(() => settle(null), timeoutMs);
  });
}
