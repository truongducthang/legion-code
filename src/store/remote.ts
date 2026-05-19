import { setStore, store } from './core';
import { invoke } from '../lib/ipc';
import { IPC } from '../../electron/ipc/channels';

interface ServerResult {
  url: string;
  wifiUrl: string | null;
  tailscaleUrl: string | null;
  token: string;
  port: number;
}

interface PublicTunnelStatus {
  active: boolean;
  url: string | null;
  lastError: string | null;
}

// Generation counter — incremented on stop so in-flight poll responses
// that arrive after stop are discarded instead of overwriting the store.
let stopGeneration = 0;

export async function startRemoteAccess(port?: number): Promise<ServerResult> {
  const result = await invoke<ServerResult>(IPC.StartRemoteServer, port ? { port } : {});
  setStore('remoteAccess', {
    enabled: true,
    token: result.token,
    port: result.port,
    url: result.url,
    wifiUrl: result.wifiUrl,
    tailscaleUrl: result.tailscaleUrl,
    connectedClients: 0,
  });
  return result;
}

export async function stopRemoteAccess(): Promise<void> {
  stopGeneration++;
  await invoke(IPC.StopRemoteServer);
  setStore('remoteAccess', {
    enabled: false,
    token: null,
    port: 7777,
    url: null,
    wifiUrl: null,
    tailscaleUrl: null,
    connectedClients: 0,
    // The main process auto-releases the public-tunnel hold when the
    // server stops; mirror that into the store so the modal returns to
    // an idle state without waiting for the status push.
    publicUrl: null,
    publicTunnelState: 'idle',
    publicTunnelError: null,
  });
}

/**
 * Request that main spawn (or re-share) the cloudflared tunnel. The
 * authoritative state arrives later via `PublicTunnelStatusChanged`; we
 * set `'starting'` here for instant UI feedback.
 */
export async function startPublicTunnel(): Promise<void> {
  setStore('remoteAccess', {
    publicTunnelState: 'starting',
    publicTunnelError: null,
  });
  try {
    const status = await invoke<PublicTunnelStatus>(IPC.StartPublicTunnel);
    applyPublicTunnelStatus(status);
  } catch (err) {
    setStore('remoteAccess', {
      publicTunnelState: 'error',
      publicTunnelError: err instanceof Error ? err.message : String(err),
      publicUrl: null,
    });
  }
}

export async function stopPublicTunnel(): Promise<void> {
  const status = await invoke<PublicTunnelStatus>(IPC.StopPublicTunnel);
  applyPublicTunnelStatus(status);
}

/**
 * Subscribe to `PublicTunnelStatusChanged` pushes from main. Returns the
 * cleanup. Wraps in try/catch the same way the mobile-task sync does, in
 * case preload's ALLOWED_CHANNELS is stale during dev hot-reload.
 */
export function startPublicTunnelStatusSubscription(): () => void {
  try {
    return window.electron.ipcRenderer.on(IPC.PublicTunnelStatusChanged, (data: unknown) => {
      if (!data || typeof data !== 'object') return;
      const status = data as PublicTunnelStatus;
      applyPublicTunnelStatus(status);
    });
  } catch {
    return () => {};
  }
}

export function applyPublicTunnelStatus(status: PublicTunnelStatus): void {
  if (status.active && status.url) {
    // The raw cloudflared URL has no auth — append the same session token
    // the server checks for WiFi/Tailscale URLs. Without this, the mobile
    // SPA loads, then the WebSocket and `/api/*` calls fail with 401.
    const token = store.remoteAccess.token;
    const urlWithToken = token ? `${status.url}?token=${token}` : status.url;
    setStore('remoteAccess', {
      publicTunnelState: 'active',
      publicUrl: urlWithToken,
      publicTunnelError: null,
    });
  } else if (status.lastError) {
    setStore('remoteAccess', {
      publicTunnelState: 'error',
      publicTunnelError: status.lastError,
      publicUrl: null,
    });
  } else {
    setStore('remoteAccess', {
      publicTunnelState: 'idle',
      publicUrl: null,
      publicTunnelError: null,
    });
  }
}

export async function refreshRemoteStatus(): Promise<void> {
  const gen = stopGeneration;
  const result = await invoke<{
    enabled: boolean;
    connectedClients: number;
    url?: string;
    wifiUrl?: string;
    tailscaleUrl?: string;
    token?: string;
    port?: number;
  }>(IPC.GetRemoteStatus);

  // Discard stale response if stopRemoteAccess was called while in-flight
  if (gen !== stopGeneration) return;

  if (result.enabled) {
    setStore('remoteAccess', {
      enabled: true,
      connectedClients: result.connectedClients,
      url: result.url ?? null,
      wifiUrl: result.wifiUrl ?? null,
      tailscaleUrl: result.tailscaleUrl ?? null,
      token: result.token ?? null,
      port: result.port ?? 7777,
    });
  } else {
    setStore('remoteAccess', 'enabled', false);
    setStore('remoteAccess', 'connectedClients', 0);
  }
}
