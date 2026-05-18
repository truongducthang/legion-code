/**
 * Optional cloudflared auto-tunnel for the Mini App's public URL.
 *
 * Cloudflared is detected at the user-configured `cloudflaredPath` or — when
 * that is null — invoked as a bare `cloudflared` and resolved via the
 * spawning process's PATH. The tunnel publishes the local remote-server port
 * over a `https://<random>.trycloudflare.com` URL, parsed from cloudflared's
 * stdout/stderr.
 *
 * The tunnel is best-effort: any failure (binary not found, no URL in 10 s,
 * unexpected exit) is captured in `lastError` and the bot continues running
 * without a public URL.
 */

import { execFile as nodeExecFile, spawn as nodeSpawn, type ChildProcess } from 'child_process';
import { promisify } from 'util';
import { warn as logWarn, info as logInfo } from '../log.js';

const execFileAsync = promisify(nodeExecFile);

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
  /** User-configured cloudflared path. `null` means "find on PATH". */
  cloudflaredPath?: string | null;
  /** Test seam — defaults to `child_process.spawn`. */
  spawnFn?: SpawnFn;
  /** Milliseconds to wait for stdout/stderr to yield the URL. */
  startTimeoutMs?: number;
}

const TRYCLOUDFLARE_RX = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;

let proc: ChildProcess | null = null;
let activeRemotePort: number | null = null;
let lastUrl: string | null = null;
let lastError: string | null = null;

export function getTunnelStatus(): TunnelStatus {
  return {
    active: proc !== null && lastUrl !== null,
    url: lastUrl,
    lastError,
  };
}

/**
 * Spawn cloudflared and resolve once the public URL is observed in the
 * child's output, or after the start timeout — whichever comes first.
 * Idempotent for the same `remotePort`; re-spawns on a port change.
 */
export async function startTunnel(opts: StartTunnelOpts): Promise<TunnelStatus> {
  if (proc) {
    if (opts.remotePort === activeRemotePort) return getTunnelStatus();
    await stopTunnel();
  }

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
    return getTunnelStatus();
  }

  proc = child;
  activeRemotePort = opts.remotePort;
  lastUrl = null;
  lastError = null;

  const url = await waitForUrl(child, timeoutMs);
  if (url === null) {
    // Either the start timeout elapsed or cloudflared exited early.
    if (proc) {
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
    return getTunnelStatus();
  }

  lastUrl = url;
  logInfo('telegram.tunnel', 'tunnel ready', { url });

  // Keep watching for unexpected exit after the URL is up so we surface a
  // clear `lastError` if cloudflared drops the connection.
  child.once('exit', (code, signal) => {
    if (proc === child) {
      proc = null;
      activeRemotePort = null;
      lastUrl = null;
      lastError = `cloudflared exited (code=${code ?? 'null'} signal=${signal ?? 'null'})`;
      logWarn('telegram.tunnel', 'tunnel exited after running', { msg: lastError });
    }
  });

  return getTunnelStatus();
}

/**
 * SIGTERM the running tunnel and resolve when it exits, or after a 2 s
 * force-kill fallback. Safe to call when no tunnel is running.
 */
export async function stopTunnel(): Promise<void> {
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
}

/** Reset all module state. Tests use this to keep one test's state from
 *  leaking into the next. */
export function _resetForTests(): void {
  proc = null;
  activeRemotePort = null;
  lastUrl = null;
  lastError = null;
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
