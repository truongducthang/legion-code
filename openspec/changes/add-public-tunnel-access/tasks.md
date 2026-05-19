# Tasks — Add Public Tunnel Access

## Refactor the existing tunnel module to support multiple owners

- [ ] In `electron/telegram/tunnel.ts`, change the module-singleton state
      from `proc / lastUrl / lastError` to a single instance shared by
      a refcount set of owners. `StartTunnelOpts` gains
      `owner: 'telegram' | 'public'`. The spawn happens on first
      acquire; the kill happens on last release.
- [ ] `stopTunnel(opts: { owner })` removes one entry from the set; the
      existing zero-arg call sites in `electron/telegram/index.ts`
      become `stopTunnel({ owner: 'telegram' })`.
- [ ] `getTunnelStatus()` keeps the same shape (`active`, `url`,
      `lastError`) — both consumers see the same fields.
- [ ] Update `electron/telegram/tunnel.test.ts`: add cases for two-owner
      acquire (spawn count is 1), partial release (process keeps
      running), full release (process is killed). Keep the existing
      single-owner cases passing.

## IPC

- [ ] Add `StartPublicTunnel`, `StopPublicTunnel`, `GetPublicTunnelStatus`
      to the `IPC` enum in `electron/ipc/channels.ts`.
- [ ] Add a renderer-bound event channel constant
      `PublicTunnelStatusChanged` (e.g. `'public-tunnel:status'`) in
      `electron/ipc/channels.ts`.
- [ ] Add all four channel names to the hardcoded `ALLOWED_CHANNELS`
      set in `electron/preload.cjs`. The event channel is listed
      explicitly; do not rely on a prefix match.
- [ ] Implement the three handlers in `electron/ipc/register.ts`: - `StartPublicTunnel`: read the remote server's port from the
      existing server registry; reject if no server is running;
      call `startTunnel({ owner: 'public', remotePort })`. - `StopPublicTunnel`: call `stopTunnel({ owner: 'public' })`. - `GetPublicTunnelStatus`: return the current
      `{ state, url, lastError }`.
- [ ] In the same file, wire a `tunnel`-status broadcaster: whenever
      `tunnel.ts` transitions URL or error state, the main process
      sends `PublicTunnelStatusChanged` to every renderer via
      `webContents.send`. The broadcaster is implemented as a single
      `onTunnelStatusChange(cb)` subscriber surface inside
      `tunnel.ts`, fired from existing transition points
      (`waitForUrl` success, exit handler, `stopTunnel`). Avoid
      polling.
- [ ] Extend the existing `StopRemoteServer` handler to call
      `stopTunnel({ owner: 'public' })` before closing the HTTP server.
      Do **not** release the `'telegram'` owner — that is the Telegram
      bot's concern.

## Renderer store

- [ ] In `src/store/types.ts`, add to `remoteAccess`: - `publicUrl: string | null` - `publicTunnelState: 'idle' | 'starting' | 'active' | 'error'` - `publicTunnelError: string | null`
- [ ] In `src/store/core.ts`, initialise the three fields to `null` /
      `'idle'` / `null`. Do not persist them.
- [ ] In `src/store/remote.ts` (or wherever the existing remote-access
      handlers live), add a listener for `PublicTunnelStatusChanged`
      that updates the three fields. Reuse the existing IPC
      subscription pattern; do not invent a new one.

## Connect Phone modal

- [ ] In `src/components/ConnectPhoneModal.tsx`, extend `NetworkMode`
      to `'wifi' | 'tailscale' | 'public'`.
- [ ] Add a third pill button to the mode row at lines 218–252
      following the same layout as WiFi and Tailscale. Disabled when
      cloudflared is not available; the disabled state shows
      `Not installed` instead of `Not detected`.
- [ ] Add a probe call to `probeCloudflared` on modal open (single
      IPC, debounced) so the disabled state reflects current
      installation.
- [ ] When `mode() === 'public'`: - If `publicTunnelState === 'idle'`: render a "Start public
      tunnel" button that sends `StartPublicTunnel`. - If `publicTunnelState === 'starting'`: render the existing
      QR placeholder with text "Starting tunnel…". - If `publicTunnelState === 'active'`: render the QR for
      `publicUrl` (re-use the existing `generateQr` path at
      `ConnectPhoneModal.tsx:55`). - If `publicTunnelState === 'error'`: render the error
      message and a "Retry" button.
- [ ] Add a "Stop tunnel" button below the URL row when the tunnel
      is active. Confirm not required.
- [ ] Add the verbatim security warning specified in the spec.
- [ ] Closing the modal MUST NOT stop the tunnel.

## Tests

- [ ] Extend `src/components/ConnectPhoneModal.test.ts`: add cases
      covering each `publicTunnelState` rendering, the security
      warning visibility, and that closing the modal does not fire
      `StopPublicTunnel`.
- [ ] Add a unit test for the `StartPublicTunnel` handler: rejection
      path when no server is running. Mock the remote server
      registry.
- [ ] Add a unit test for the refcounted tunnel module covering
      shared-URL semantics across two owners.

## Validation

- [ ] Run `openspec validate add-public-tunnel-access --strict` and
      fix any issues before requesting review.
- [ ] Run `npm run typecheck` and fix any issues.
- [ ] Manual smoke test: install cloudflared locally, run
      `npm run dev`, open Connect Phone, switch to Public, start
      tunnel, scan QR with a phone on cellular data, confirm the
      remote SPA loads.
