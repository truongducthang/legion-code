# Public Tunnel Access Specification

## ADDED Requirements

### Requirement: User-initiated tunnel lifecycle

The app SHALL expose explicit start and stop controls for a public tunnel
that publishes the running remote server over the Internet, and SHALL
refuse to start a tunnel while no remote server is running.

#### Scenario: User starts a public tunnel while the remote server is running

- **WHEN** the renderer sends the `StartPublicTunnel` IPC request
- **AND** the embedded remote server is currently running
- **THEN** the main process spawns `cloudflared` against the remote
  server's port
- **AND** the main process pushes `PublicTunnelStatusChanged` with state
  `starting` to every renderer

#### Scenario: User starts a public tunnel while the remote server is stopped

- **WHEN** the renderer sends `StartPublicTunnel` and no remote server is
  running
- **THEN** the request rejects with an error
- **AND** no `cloudflared` process is spawned
- **AND** the renderer's tunnel state remains `idle`

#### Scenario: User stops the public tunnel

- **WHEN** the renderer sends `StopPublicTunnel`
- **THEN** the main process releases this consumer's hold on the tunnel
- **AND** the main process pushes `PublicTunnelStatusChanged` with state
  `idle` to every renderer
- **AND** the tunnel URL is cleared from the renderer's store

#### Scenario: Stopping the remote server releases the public-tunnel hold

- **WHEN** the renderer sends `StopRemoteServer`
- **AND** a public tunnel is currently active
- **THEN** the main process releases the public consumer's hold before
  closing the remote server
- **AND** subsequent `GetPublicTunnelStatus` requests report state `idle`
  unless another consumer (e.g. the Telegram bot) still holds the tunnel

### Requirement: URL discovery and status push

The main process SHALL push tunnel status to the renderer whenever the
URL or error state changes, so the UI never polls for it.

#### Scenario: Tunnel produces a URL

- **WHEN** `cloudflared` writes a `https://<name>.trycloudflare.com` URL
  to its stdout or stderr
- **THEN** the main process pushes `PublicTunnelStatusChanged` with
  state `active` and the parsed URL

#### Scenario: Tunnel fails to produce a URL within the start timeout

- **WHEN** `cloudflared` has not produced a URL within 10 seconds of
  spawn
- **THEN** the main process terminates the child process
- **AND** pushes `PublicTunnelStatusChanged` with state `error` and a
  human-readable message

#### Scenario: Tunnel exits unexpectedly after running

- **WHEN** the `cloudflared` process exits after a URL was already
  produced
- **THEN** the main process pushes `PublicTunnelStatusChanged` with
  state `error` and the exit code or signal
- **AND** the URL is cleared

### Requirement: Shared ownership with the Telegram tunnel

The app SHALL run at most one `cloudflared` process even when both the
Telegram bot and the public-tunnel feature are active, and SHALL
preserve each consumer's intent independently.

#### Scenario: Telegram bot acquires while public tunnel is active

- **WHEN** the Telegram bot calls `startTunnel({ owner: 'telegram' })`
- **AND** the public consumer already holds an active tunnel
- **THEN** no new `cloudflared` process is spawned
- **AND** both consumers observe the same URL

#### Scenario: Public consumer releases while Telegram bot still holds

- **WHEN** the renderer sends `StopPublicTunnel`
- **AND** the Telegram bot still holds the tunnel
- **THEN** the `cloudflared` process keeps running
- **AND** the URL remains advertised to the Telegram bot
- **AND** the renderer's tunnel state becomes `idle`

#### Scenario: Last consumer release tears down the tunnel

- **WHEN** the final consumer releases its hold (regardless of which)
- **THEN** the `cloudflared` process is terminated with `SIGTERM` and a
  2-second `SIGKILL` fallback
- **AND** subsequent `GetPublicTunnelStatus` requests report state
  `idle`

### Requirement: cloudflared availability probe

The app SHALL detect whether `cloudflared` is invokable before the user
attempts to start a tunnel, and SHALL surface a verbatim install hint
when it is not.

#### Scenario: cloudflared is on PATH

- **WHEN** the renderer requests the cloudflared probe
- **AND** `cloudflared --version` exits zero
- **THEN** the response reports `available: true` and the version
  string

#### Scenario: cloudflared is not installed

- **WHEN** the renderer requests the cloudflared probe
- **AND** `cloudflared --version` fails to spawn or returns a non-zero
  exit
- **THEN** the response reports `available: false` and an error
  message
- **AND** the Public tab in the Connect Phone modal renders a
  verbatim install hint with platform-specific commands

#### Scenario: User-configured cloudflared path

- **WHEN** the existing `telegram.cloudflaredPath` persisted field is
  non-null
- **THEN** the probe and the tunnel spawn use that path
- **AND** no new persisted field is introduced for the public-tunnel
  feature

### Requirement: Connect Phone modal Public tab

The Connect Phone modal SHALL surface the public tunnel as a third
selectable mode alongside WiFi and Tailscale, with controls for
starting and stopping the tunnel, the QR for the published URL, and
a security warning.

#### Scenario: User selects the Public tab while the tunnel is idle

- **WHEN** the user selects the Public tab
- **AND** no tunnel URL is currently active
- **THEN** the modal renders a "Start public tunnel" button
- **AND** the modal renders an install hint if cloudflared is not
  available

#### Scenario: User selects the Public tab while the tunnel is active

- **WHEN** the user selects the Public tab
- **AND** a tunnel URL is currently active
- **THEN** the modal renders the QR code for the published URL
- **AND** the modal renders a "Stop tunnel" button
- **AND** the modal renders a verbatim warning that the URL is
  reachable from the public Internet and the token must not be
  shared

#### Scenario: User clicks "Start public tunnel"

- **WHEN** the user clicks "Start public tunnel" in the Public tab
- **THEN** the renderer sends `StartPublicTunnel`
- **AND** the Public tab shows a "Starting…" indicator until the
  next `PublicTunnelStatusChanged` event arrives

#### Scenario: User closes the modal while the tunnel is active

- **WHEN** the user closes the Connect Phone modal
- **AND** a tunnel URL is currently active
- **THEN** the tunnel is **not** stopped
- **AND** the URL stays valid until the user explicitly stops it or
  the remote server is stopped
