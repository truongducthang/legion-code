// src/components/ConnectPhoneModal.tsx

import { Show, createSignal, createEffect, onCleanup, createMemo, untrack } from 'solid-js';
import { Dialog } from './Dialog';
import { store } from '../store/core';
import {
  startRemoteAccess,
  stopRemoteAccess,
  refreshRemoteStatus,
  startPublicTunnel,
  stopPublicTunnel,
} from '../store/remote';
import { invoke } from '../lib/ipc';
import { IPC } from '../../electron/ipc/channels';
import { theme } from '../lib/theme';
import type { RemoteAccess } from '../store/types';

type NetworkMode = 'wifi' | 'tailscale' | 'public';
type RemoteAccessUrls = Pick<
  RemoteAccess,
  'enabled' | 'url' | 'wifiUrl' | 'tailscaleUrl' | 'publicUrl'
>;

interface ConnectPhoneModalProps {
  open: boolean;
  onClose: () => void;
}

export function connectionUrlForMode(
  remoteAccess: RemoteAccessUrls,
  networkMode: NetworkMode,
): string | null {
  if (!remoteAccess.enabled) return null;
  if (networkMode === 'public') return remoteAccess.publicUrl;
  const modeUrl = networkMode === 'tailscale' ? remoteAccess.tailscaleUrl : remoteAccess.wifiUrl;
  return modeUrl ?? remoteAccess.url;
}

/** Pick a default mode when the current one is no longer reachable. Never
 *  auto-promotes to `'public'` — exposing the desktop on the Internet must
 *  be a deliberate user action. */
export function availableNetworkModeFor(
  remoteAccess: RemoteAccessUrls,
  currentMode: NetworkMode,
): NetworkMode {
  if (currentMode === 'public') return 'public';
  if (currentMode === 'wifi' && remoteAccess.wifiUrl) return 'wifi';
  if (currentMode === 'tailscale' && remoteAccess.tailscaleUrl) return 'tailscale';
  if (remoteAccess.wifiUrl) return 'wifi';
  if (remoteAccess.tailscaleUrl) return 'tailscale';
  return currentMode;
}

export function ConnectPhoneModal(props: ConnectPhoneModalProps) {
  const [qrDataUrl, setQrDataUrl] = createSignal<string | null>(null);
  const [qrError, setQrError] = createSignal<string | null>(null);
  const [starting, setStarting] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [copied, setCopied] = createSignal(false);
  const [mode, setMode] = createSignal<NetworkMode>('wifi');
  const [cloudflaredAvailable, setCloudflaredAvailable] = createSignal<boolean | null>(null);
  let stopPolling: (() => void) | undefined;
  let copiedTimer: ReturnType<typeof setTimeout> | undefined;
  let qrRequestId = 0;
  onCleanup(() => {
    if (copiedTimer !== undefined) clearTimeout(copiedTimer);
    qrRequestId++;
  });

  const activeUrl = createMemo(() => connectionUrlForMode(store.remoteAccess, mode()));

  async function generateQr(url: string, requestId: number) {
    try {
      const mod = await import('qrcode');
      // qrcode is CJS — Vite dev wraps it as .default only, prod adds named re-exports
      const QRCode = mod.default ?? mod;
      const dataUrl = await QRCode.toDataURL(url, {
        width: 256,
        margin: 2,
        color: { dark: '#000000', light: '#ffffff' },
      });
      if (requestId !== qrRequestId) return;
      setQrDataUrl(dataUrl);
      setQrError(null);
    } catch (err) {
      if (requestId !== qrRequestId) return;
      console.error('[ConnectPhoneModal] QR generation failed:', err);
      setQrDataUrl(null);
      setQrError('QR code unavailable');
    }
  }

  // Regenerate QR when the shown connection URL changes.
  createEffect(() => {
    const url = activeUrl();
    if (!props.open || !url) {
      qrRequestId++;
      setQrDataUrl(null);
      setQrError(null);
      return;
    }
    const requestId = ++qrRequestId;
    setQrDataUrl(null);
    setQrError(null);
    generateQr(url, requestId);
  });

  // Focus the dialog panel when it opens (Dialog doesn't auto-focus)
  createEffect(() => {
    if (!props.open) return;
    requestAnimationFrame(() => {
      const panel = document.querySelector<HTMLElement>('.dialog-panel');
      panel?.focus();
    });
  });

  // Probe cloudflared once per modal open to gate the Public tab.
  createEffect(() => {
    if (!props.open) return;
    setCloudflaredAvailable(null);
    invoke<{ available: boolean }>(IPC.ProbeCloudflared)
      .then((r) => setCloudflaredAvailable(r.available))
      .catch(() => setCloudflaredAvailable(false));
  });

  // Start server when modal opens
  createEffect(() => {
    if (!props.open) return;

    if (!store.remoteAccess.enabled && !untrack(starting)) {
      setStarting(true);
      setError(null);
      startRemoteAccess()
        .then((result) => {
          setStarting(false);
          setMode(
            availableNetworkModeFor(
              {
                enabled: true,
                url: result.url,
                wifiUrl: result.wifiUrl,
                tailscaleUrl: result.tailscaleUrl,
                publicUrl: null,
              },
              untrack(mode),
            ),
          );
        })
        .catch((err: unknown) => {
          setStarting(false);
          setError(err instanceof Error ? err.message : 'Failed to start server');
        });
    } else {
      // Re-derive mode if network changed since last open
      setMode(availableNetworkModeFor(store.remoteAccess, mode()));
    }

    // Poll connected clients count while modal is open
    let pollActive = true;
    const interval = setInterval(() => {
      if (pollActive) refreshRemoteStatus();
    }, 3000);
    stopPolling = () => {
      pollActive = false;
      clearInterval(interval);
    };
    onCleanup(() => stopPolling?.());
  });

  async function handleDisconnect() {
    stopPolling?.();
    const result = await stopRemoteAccess();
    if (!result.stopped) {
      if (result.reason === 'coordinator_active') {
        setError('Cannot disconnect while a coordinator is active. Stop the coordinator first.');
      } else {
        setError('Failed to disconnect. Please try again.');
      }
      return;
    }
    setQrDataUrl(null);
    props.onClose();
  }

  async function handleCopyUrl() {
    const url = activeUrl();
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      if (copiedTimer !== undefined) clearTimeout(copiedTimer);
      copiedTimer = setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard not available */
    }
  }

  const pillStyle = (active: boolean) => ({
    padding: '6px 14px',
    'border-radius': '6px',
    border: 'none',
    'font-size': '13px',
    cursor: 'pointer',
    background: active ? theme.accent : 'transparent',
    color: active ? theme.accentText : theme.fgMuted,
    'font-weight': active ? '600' : '400',
  });

  const cloudflaredMissing = () => cloudflaredAvailable() === false;
  function recheckCloudflared(): void {
    setCloudflaredAvailable(null);
    invoke<{ available: boolean }>(IPC.ProbeCloudflared)
      .then((r) => setCloudflaredAvailable(r.available))
      .catch(() => setCloudflaredAvailable(false));
  }

  return (
    <Dialog
      open={props.open}
      onClose={props.onClose}
      width="380px"
      panelStyle={{ 'align-items': 'center', gap: '20px' }}
    >
      <div style={{ 'text-align': 'center' }}>
        <h2 style={{ margin: '0', 'font-size': '17px', color: theme.fg, 'font-weight': '600' }}>
          Connect Phone
        </h2>
        <span style={{ 'font-size': '12px', color: theme.fgSubtle }}>Experimental</span>
      </div>

      <Show when={starting()}>
        <div style={{ color: theme.fgMuted, 'font-size': '14px' }}>Starting server...</div>
      </Show>

      <Show when={error()}>
        <div style={{ color: theme.error, 'font-size': '14px', 'text-align': 'center' }}>
          {error()}
        </div>
      </Show>

      <Show when={!starting() && store.remoteAccess.enabled}>
        {/* Network mode toggle */}
        <div
          style={{
            display: 'flex',
            gap: '4px',
            background: theme.bgInput,
            'border-radius': '8px',
            padding: '3px',
          }}
        >
          <div
            style={{
              display: 'flex',
              'flex-direction': 'column',
              'align-items': 'center',
              gap: '2px',
            }}
          >
            <button
              onClick={() => setMode('wifi')}
              disabled={!store.remoteAccess.wifiUrl}
              style={{
                ...pillStyle(mode() === 'wifi' && !!store.remoteAccess.wifiUrl),
                ...(!store.remoteAccess.wifiUrl ? { opacity: '0.35', cursor: 'default' } : {}),
              }}
            >
              WiFi
            </button>
            <Show when={!store.remoteAccess.wifiUrl}>
              <span style={{ 'font-size': '10px', color: theme.fgSubtle }}>Not detected</span>
            </Show>
          </div>
          <div
            style={{
              display: 'flex',
              'flex-direction': 'column',
              'align-items': 'center',
              gap: '2px',
            }}
          >
            <button
              onClick={() => setMode('tailscale')}
              disabled={!store.remoteAccess.tailscaleUrl}
              style={{
                ...pillStyle(mode() === 'tailscale' && !!store.remoteAccess.tailscaleUrl),
                ...(!store.remoteAccess.tailscaleUrl ? { opacity: '0.35', cursor: 'default' } : {}),
              }}
            >
              Tailscale
            </button>
            <Show when={!store.remoteAccess.tailscaleUrl}>
              <span style={{ 'font-size': '10px', color: theme.fgSubtle }}>Not detected</span>
            </Show>
          </div>
          <div
            style={{
              display: 'flex',
              'flex-direction': 'column',
              'align-items': 'center',
              gap: '2px',
            }}
          >
            <button onClick={() => setMode('public')} style={pillStyle(mode() === 'public')}>
              Public
            </button>
            <Show when={cloudflaredMissing()}>
              <span style={{ 'font-size': '10px', color: theme.fgSubtle }}>Needs cloudflared</span>
            </Show>
          </div>
        </div>

        <Show
          when={mode() === 'public'}
          fallback={
            <>
              {/* QR Code (LAN/Tailscale modes) */}
              <div
                style={{
                  width: '200px',
                  height: '200px',
                  'border-radius': '8px',
                  background: '#ffffff',
                  display: 'flex',
                  'align-items': 'center',
                  'justify-content': 'center',
                  overflow: 'hidden',
                }}
              >
                <Show
                  when={qrDataUrl()}
                  fallback={
                    <span
                      aria-live="polite"
                      style={{
                        color: '#3f3f46',
                        'font-size': '12px',
                        'text-align': 'center',
                        padding: '16px',
                      }}
                    >
                      {qrError() ?? 'Generating QR code...'}
                    </span>
                  }
                >
                  {(url) => (
                    <img
                      src={url()}
                      alt="Connection QR code"
                      style={{ width: '200px', height: '200px' }}
                    />
                  )}
                </Show>
              </div>

              {/* URL */}
              <div
                style={{
                  width: '100%',
                  background: theme.bgInput,
                  border: `1px solid ${theme.border}`,
                  'border-radius': '8px',
                  padding: '10px 12px',
                  'font-size': '13px',
                  'font-family': "'JetBrains Mono', monospace",
                  color: theme.fg,
                  'word-break': 'break-all',
                  'text-align': 'center',
                  cursor: 'pointer',
                }}
                onClick={handleCopyUrl}
                title="Click to copy"
              >
                {activeUrl()}
              </div>

              <Show when={copied()}>
                <span style={{ 'font-size': '13px', color: theme.success }}>Copied!</span>
              </Show>

              <p
                style={{
                  'font-size': '13px',
                  color: theme.fgMuted,
                  'text-align': 'center',
                  margin: '0',
                  'line-height': '1.5',
                }}
              >
                Scan the QR code or copy the URL to monitor and interact with your agent terminals
                from your phone.
                <Show
                  when={mode() === 'tailscale'}
                  fallback={<> Your phone and this computer must be on the same WiFi network.</>}
                >
                  <> Your phone and this computer must be on the same Tailscale network.</>
                </Show>
              </p>
            </>
          }
        >
          <PublicTunnelPanel
            onCopyUrl={handleCopyUrl}
            qrDataUrl={qrDataUrl}
            qrError={qrError}
            cloudflaredMissing={cloudflaredMissing}
            onRecheck={recheckCloudflared}
          />
        </Show>

        {/* Connected clients */}
        <Show
          when={store.remoteAccess.connectedClients > 0}
          fallback={
            <div
              style={{
                'font-size': '13px',
                color: theme.fgSubtle,
                display: 'flex',
                'align-items': 'center',
                gap: '6px',
              }}
            >
              <div
                style={{
                  width: '8px',
                  height: '8px',
                  'border-radius': '50%',
                  background: theme.fgSubtle,
                }}
              />
              Waiting for connection...
            </div>
          }
        >
          <div
            style={{
              display: 'flex',
              'flex-direction': 'column',
              'align-items': 'center',
              gap: '8px',
            }}
          >
            <svg
              width="48"
              height="48"
              viewBox="0 0 24 24"
              fill="none"
              stroke={theme.success}
              stroke-width="2.5"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <path d="M20 6L9 17l-5-5" />
            </svg>
            <span style={{ 'font-size': '15px', color: theme.success, 'font-weight': '500' }}>
              {store.remoteAccess.connectedClients} client(s) connected
            </span>
          </div>
        </Show>

        {/* Disconnect — always available when server is running */}
        <button
          onClick={handleDisconnect}
          style={{
            padding: '7px 16px',
            background: 'transparent',
            border: 'none',
            'border-radius': '8px',
            color: theme.fgSubtle,
            cursor: 'pointer',
            'font-size': '13px',
            'font-weight': '400',
          }}
        >
          Disconnect
        </button>
      </Show>
    </Dialog>
  );
}

interface PublicTunnelPanelProps {
  onCopyUrl: () => void;
  qrDataUrl: () => string | null;
  qrError: () => string | null;
  cloudflaredMissing: () => boolean;
  onRecheck: () => void;
}

function PublicTunnelPanel(props: PublicTunnelPanelProps) {
  const state = () => store.remoteAccess.publicTunnelState;
  const url = () => store.remoteAccess.publicUrl;
  const err = () => store.remoteAccess.publicTunnelError;

  return (
    <div
      style={{
        display: 'flex',
        'flex-direction': 'column',
        'align-items': 'center',
        gap: '14px',
        width: '100%',
      }}
    >
      <Show
        when={!props.cloudflaredMissing()}
        fallback={<InstallCloudflaredHint onRecheck={props.onRecheck} />}
      >
        <Show
          when={state() === 'active' && url()}
          fallback={
            <div
              style={{
                width: '200px',
                height: '200px',
                'border-radius': '8px',
                background: theme.bgInput,
                border: `1px dashed ${theme.border}`,
                display: 'flex',
                'flex-direction': 'column',
                'align-items': 'center',
                'justify-content': 'center',
                gap: '10px',
                padding: '16px',
                'text-align': 'center',
              }}
            >
              <Show when={state() === 'idle'}>
                <span style={{ color: theme.fgMuted, 'font-size': '13px' }}>No public URL yet</span>
                <button
                  onClick={() => {
                    void startPublicTunnel();
                  }}
                  style={{
                    padding: '8px 14px',
                    background: theme.accent,
                    color: theme.accentText,
                    border: 'none',
                    'border-radius': '6px',
                    'font-size': '13px',
                    'font-weight': '600',
                    cursor: 'pointer',
                  }}
                >
                  Start public tunnel
                </button>
              </Show>
              <Show when={state() === 'starting'}>
                <span style={{ color: theme.fgMuted, 'font-size': '13px' }}>Starting tunnel…</span>
              </Show>
              <Show when={state() === 'error'}>
                <span style={{ color: theme.error, 'font-size': '12px' }}>
                  {err() ?? 'Tunnel failed'}
                </span>
                <button
                  onClick={() => {
                    void startPublicTunnel();
                  }}
                  style={{
                    padding: '6px 12px',
                    background: 'transparent',
                    color: theme.fg,
                    border: `1px solid ${theme.border}`,
                    'border-radius': '6px',
                    'font-size': '12px',
                    cursor: 'pointer',
                  }}
                >
                  Retry
                </button>
              </Show>
            </div>
          }
        >
          <div
            style={{
              width: '200px',
              height: '200px',
              'border-radius': '8px',
              background: '#ffffff',
              display: 'flex',
              'align-items': 'center',
              'justify-content': 'center',
              overflow: 'hidden',
            }}
          >
            <Show
              when={props.qrDataUrl()}
              fallback={
                <span
                  aria-live="polite"
                  style={{
                    color: '#3f3f46',
                    'font-size': '12px',
                    'text-align': 'center',
                    padding: '16px',
                  }}
                >
                  {props.qrError() ?? 'Generating QR code...'}
                </span>
              }
            >
              {(qr) => (
                <img
                  src={qr()}
                  alt="Public connection QR code"
                  style={{ width: '200px', height: '200px' }}
                />
              )}
            </Show>
          </div>

          <div
            style={{
              width: '100%',
              background: theme.bgInput,
              border: `1px solid ${theme.border}`,
              'border-radius': '8px',
              padding: '10px 12px',
              'font-size': '13px',
              'font-family': "'JetBrains Mono', monospace",
              color: theme.fg,
              'word-break': 'break-all',
              'text-align': 'center',
              cursor: 'pointer',
            }}
            onClick={() => props.onCopyUrl()}
            title="Click to copy"
          >
            {url()}
          </div>

          <p
            style={{
              'font-size': '12px',
              color: theme.fgMuted,
              'text-align': 'center',
              margin: '0',
              'line-height': '1.5',
            }}
          >
            Anyone with this URL and token can connect over the public Internet. Stop the tunnel
            when you are done.
          </p>

          <button
            onClick={() => {
              void stopPublicTunnel();
            }}
            style={{
              padding: '6px 14px',
              background: 'transparent',
              color: theme.fg,
              border: `1px solid ${theme.border}`,
              'border-radius': '6px',
              'font-size': '12px',
              cursor: 'pointer',
            }}
          >
            Stop tunnel
          </button>
        </Show>
      </Show>
    </div>
  );
}

function InstallCloudflaredHint(props: { onRecheck: () => void }) {
  const platform = navigator.platform.toLowerCase();
  const isMac = platform.includes('mac');
  const isWin = platform.includes('win');

  return (
    <div
      style={{
        width: '100%',
        background: theme.bgInput,
        border: `1px solid ${theme.border}`,
        'border-radius': '8px',
        padding: '14px',
        display: 'flex',
        'flex-direction': 'column',
        gap: '10px',
      }}
    >
      <div style={{ 'font-size': '13px', color: theme.fg, 'font-weight': '600' }}>
        cloudflared is not installed
      </div>
      <div style={{ 'font-size': '12px', color: theme.fgMuted, 'line-height': '1.5' }}>
        Install it once on this computer, then come back and tap Recheck. iPhone needs nothing — it
        just opens Safari.
      </div>
      <Show when={isMac}>
        <CodeLine cmd="brew install cloudflared" />
      </Show>
      <Show when={isWin}>
        <CodeLine cmd="winget install --id Cloudflare.cloudflared" />
      </Show>
      <Show when={!isMac && !isWin}>
        <div style={{ 'font-size': '12px', color: theme.fgMuted }}>Download from:</div>
        <CodeLine cmd="https://github.com/cloudflare/cloudflared/releases/latest" />
      </Show>
      <button
        onClick={() => props.onRecheck()}
        style={{
          'align-self': 'flex-start',
          padding: '6px 12px',
          background: theme.accent,
          color: theme.accentText,
          border: 'none',
          'border-radius': '6px',
          'font-size': '12px',
          'font-weight': '600',
          cursor: 'pointer',
        }}
      >
        Recheck
      </button>
    </div>
  );
}

function CodeLine(props: { cmd: string }) {
  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(props.cmd);
    } catch {
      /* clipboard unavailable */
    }
  }
  return (
    <div
      onClick={() => void copy()}
      title="Click to copy"
      style={{
        background: theme.bg,
        border: `1px solid ${theme.border}`,
        'border-radius': '6px',
        padding: '8px 10px',
        'font-size': '12px',
        'font-family': "'JetBrains Mono', monospace",
        color: theme.fg,
        'word-break': 'break-all',
        cursor: 'pointer',
      }}
    >
      {props.cmd}
    </div>
  );
}
