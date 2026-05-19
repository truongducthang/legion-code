# Add Public Tunnel Access

## Why

The existing remote-access capability (`openspec/specs/remote-access/spec.md`)
advertises two URLs: a LAN URL and a Tailscale URL. Both require the phone and
the desktop to share a network — same WiFi for the LAN URL, same tailnet for
the Tailscale URL. A user on cellular data, a café hotspot, or a corporate
WiFi that blocks peer-to-peer traffic has no working option.

The Telegram-control change already integrated `cloudflared` to publish the
remote server over `https://<random>.trycloudflare.com`, but the tunnel is
only spun up as a side-effect of starting the Telegram bot. A user who only
wants "phone can reach my desktop over the Internet" has to configure a
Telegram bot they do not need.

The fix is small: expose the same `cloudflared` tunnel that `electron/telegram/
tunnel.ts` already implements as a first-class option inside the "Connect
Phone" modal, sharing one tunnel process with the Telegram bot when both are
active.

## What changes

- New capability `public-tunnel-access` covering tunnel lifecycle (start, stop,
  status, error surfacing), shared ownership with the Telegram bot's tunnel,
  cloudflared installation probe, and integration into the existing
  "Connect Phone" QR modal as a third mode alongside WiFi and Tailscale.
- New IPC channels `StartPublicTunnel`, `StopPublicTunnel`,
  `GetPublicTunnelStatus`. Channel names go in the `IPC` enum in
  `electron/ipc/channels.ts` and in `ALLOWED_CHANNELS` in
  `electron/preload.cjs`.
- New event channel `PublicTunnelStatusChanged` pushed from main to renderer
  whenever the tunnel URL or error state changes, so the UI does not poll.
- Refactor `electron/telegram/tunnel.ts` from a single-owner singleton to a
  refcounted singleton: both the Telegram bot and the new IPC handlers
  acquire/release the same tunnel instance. The first acquirer spawns
  `cloudflared`; the last releaser tears it down. The published URL is
  identical for both consumers.
- `src/store/types.ts` gains a `publicUrl: string \| null` field and a
  `publicTunnelState: 'idle' \| 'starting' \| 'active' \| 'error'` field
  under `remoteAccess`. Neither is persisted across app restarts — the
  tunnel is session-scoped, matching the existing token model.
- `src/components/ConnectPhoneModal.tsx` gains a third "Public" tab next to
  "WiFi" and "Tailscale". When idle, the tab shows a "Start public tunnel"
  button and a cloudflared install hint if the binary is missing. When
  active, it renders the QR for `publicUrl` and a "Stop tunnel" button.
- Stopping the remote server (existing `StopRemoteServer` IPC) SHALL also
  release this consumer's hold on the tunnel, so a user who toggles remote
  access off does not leave a public URL pointing at a closed port.

## Impact

- New capability `public-tunnel-access`.
- No change to the existing `remote-access` capability spec — the tunnel
  publishes the same server on the same port; only the URL advertised to the
  phone changes.
- `electron/telegram/tunnel.ts` API surface changes: `startTunnel` /
  `stopTunnel` gain an opaque `owner` argument (a symbol or string tag) and
  internally refcount by owner. Existing callers in `electron/telegram/
index.ts` update to pass `'telegram'`; the new IPC handlers pass
  `'public'`. The `add-telegram-control` change is the only existing
  consumer; this proposal updates that call site in lockstep.
- Network: outbound HTTPS from `cloudflared` to Cloudflare's edge. No new
  inbound ports beyond what the remote server already binds.
- Security: the published URL is reachable by anyone on the Internet, but
  the existing per-session bearer token (`electron/remote/server.ts:151`)
  still gates every WebSocket and `/api/*` request. The Public tab SHALL
  show a verbatim warning that the URL is Internet-reachable and that the
  token must not be shared.
- Cross-platform: macOS and Linux only (matches `CLAUDE.md`'s
  supported-platform list). No Windows path.
- Dependency: `cloudflared` is **not** bundled. The Public tab probes for
  it via the existing `probeCloudflared` helper in
  `electron/telegram/tunnel.ts:184` and surfaces a verbatim install hint
  (Homebrew / apt / direct download) when missing.
- No persisted state changes. No new persisted secrets.
