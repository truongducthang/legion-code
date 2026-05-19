# Headless Core Specification

## Purpose

Run all parallel-code business logic — PTY management, git worktree
operations, agent orchestration, persistence, the embedded
remote-access server, the Telegram bot, MCP integration — in a
standalone Node process (`core`) that is spawned and supervised by
the Electron main process, and reach it from the renderer through a
WebSocket-based RPC transport that is identical to the one used by
mobile and remote clients.

## ADDED Requirements

### Requirement: Core process lifecycle

The app SHALL run business logic in a child `core` process spawned and
supervised by the Electron main process, with a deterministic startup
handshake and a graceful shutdown path on quit.

#### Scenario: Electron spawns the core on startup

- **WHEN** the Electron main process reaches `app.whenReady`
- **THEN** it spawns the bundled core executable with
  `--port 0`, `--data-dir <userData>`, and `--parent-pid <electronPid>`
- **AND** it reads the first line from the core's stdout
- **AND** that line is JSON of the form
  `{"event":"ready","port":<n>,"token":"<base64url>"}`
- **AND** the parsed `{ port, token }` is stored as the core endpoint

#### Scenario: Core handshake times out

- **WHEN** the core has not written a parseable ready line within
  10 seconds of spawn
- **THEN** Electron main terminates the child process
- **AND** surfaces a fatal startup error to the user
- **AND** the app does not open a BrowserWindow

#### Scenario: Graceful shutdown on user quit

- **WHEN** Electron emits `before-quit`
- **THEN** Electron main sends `SIGTERM` to the core
- **AND** waits up to 3 seconds for the core to exit
- **AND** sends `SIGKILL` if the core has not exited within 3 seconds
- **AND** does not call `app.exit` before the core process has been
  observed to have exited

#### Scenario: Parent disappearance triggers core exit

- **WHEN** the Electron main process disappears while the core is
  running (for example, after `SIGKILL` on the parent PID)
- **THEN** the core observes the loss within 4 seconds of the
  disappearance
- **AND** runs its graceful-shutdown path (flush persistence, close
  WebSocket connections)
- **AND** exits with status 0

### Requirement: Supervised restart on core crash

The Electron main process SHALL restart the core once if it exits
with a non-zero status, surface a fatal dialog on a second crash
within 30 seconds, and notify the renderer of the new endpoint after
a successful restart.

#### Scenario: First core crash is auto-restarted

- **WHEN** the core process exits with a non-zero status
- **AND** Electron did not request the shutdown
- **THEN** Electron main spawns a new core process with the same
  arguments
- **AND** captures the last 200 lines of the previous core's stdout
  to `<dataDir>/logs/core-crash-<timestamp>.log`
- **AND** does **not** surface a dialog to the user

#### Scenario: Second crash within 30 seconds is fatal

- **WHEN** the restarted core also exits with a non-zero status
  within 30 seconds of its spawn
- **THEN** Electron main does not spawn a third core
- **AND** surfaces a dialog that names the crash log path
- **AND** offers the user `Quit` and `Restart manually` choices

#### Scenario: Renderer is notified of a new endpoint after restart

- **WHEN** a restarted core completes its handshake
- **THEN** Electron main sends a `core-restart` event to every
  BrowserWindow with the new `{ url, token }`
- **AND** the renderer's RPC client reconnects to the new endpoint
- **AND** the renderer's live subscriptions are re-issued to the new
  core

### Requirement: Auth handshake between Electron and core

The core SHALL generate a fresh session token at startup, deliver it
to the Electron main process through the stdout handshake, and
require that token on every WebSocket connection.

#### Scenario: Token is session-scoped and not persisted

- **WHEN** the core process starts
- **THEN** the token is generated from the platform's cryptographic
  RNG and base64url-encoded
- **AND** the token is not written to any file
- **AND** restarting the core produces a new token

#### Scenario: Renderer receives the endpoint from preload

- **WHEN** the renderer calls `window.parallelCore.endpoint()`
- **AND** the core has already completed its handshake
- **THEN** the call resolves with `{ url, token }` for the current
  core process

#### Scenario: Endpoint call blocks until the handshake completes

- **WHEN** the renderer calls `window.parallelCore.endpoint()`
- **AND** the core has not yet written its handshake line
- **THEN** the call does not resolve until the handshake completes
  or the 10-second startup timeout elapses
- **AND** the call rejects if the startup timeout elapses

#### Scenario: Loopback bind only on the local core

- **WHEN** the core is spawned by Electron with the default `--bind`
- **THEN** the WebSocket server binds to `127.0.0.1` only
- **AND** connections originating from any non-loopback interface
  are not accepted

### Requirement: RPC over WebSocket

The core SHALL accept request/response RPC messages on the same
WebSocket connection that carries the existing subscribe/output
event protocol, with one request identifier space per connection
and structured error responses for failed calls.

#### Scenario: Successful RPC call

- **WHEN** an authenticated client sends
  `{ "type": "rpc-request", "id": <n>, "method": "<m>", "params": <p> }`
- **AND** `<m>` is a registered method
- **THEN** the server replies with
  `{ "type": "rpc-response", "id": <n>, "result": <r> }`
- **AND** no other message carries that `id`

#### Scenario: Unknown method

- **WHEN** a client sends an `rpc-request` with a `method` that is
  not registered
- **THEN** the server replies with an `rpc-response` carrying
  `error.code` equal to `not_found`
- **AND** the response references the same `id` as the request

#### Scenario: Handler throws an exception

- **WHEN** a registered method handler throws
- **THEN** the server replies with an `rpc-response` whose
  `error.code` is one of `not_found`, `invalid_argument`,
  `permission_denied`, `failed_precondition`, `unavailable`, or
  `internal`
- **AND** the `error.stack` field is present only when the core was
  started outside `NODE_ENV=production`

#### Scenario: Duplicate request id on the same connection

- **WHEN** a client sends a second `rpc-request` with an `id` equal
  to the `id` of a request still in flight on the same connection
- **THEN** the server replies to the second request with
  `error.code` equal to `invalid_argument`
- **AND** the first request continues unaffected

#### Scenario: Inbound payload size cap

- **WHEN** an inbound WebSocket frame exceeds 1 MB
- **THEN** the server rejects the frame and closes the connection

### Requirement: Generalised subscription streams

The core SHALL support multiple concurrent subscription streams over
one WebSocket connection, identified by server-assigned subscription
ids, with deterministic acknowledgement and cleanup.

#### Scenario: Client subscribes to a stream

- **WHEN** an authenticated client sends
  `{ "type": "subscribe", "stream": "<s>", "subId": <id>, "params": <p> }`
- **AND** `<s>` is a registered stream
- **THEN** the server replies with `{ "type": "sub-ack", "subId": <id> }`
- **AND** subsequent chunks for that subscription are sent as
  `{ "type": "chunk", "subId": <id>, "data": <chunk> }`

#### Scenario: Client unsubscribes

- **WHEN** the client sends
  `{ "type": "unsubscribe", "subId": <id> }`
- **THEN** the server stops sending chunks for that `subId`
- **AND** removes the underlying callback

#### Scenario: Subscriptions of a closed connection are cleaned up

- **WHEN** a WebSocket connection closes for any reason
- **THEN** every active subscription on that connection is released
- **AND** no further chunks for those subscriptions are produced

#### Scenario: PTY output stream is delivered through the subscription protocol

- **WHEN** a client subscribes to `pty.output` for an existing PTY
- **THEN** the server sends the PTY's current scrollback as one
  initial chunk
- **AND** streams every subsequent PTY output byte as a chunk
- **AND** chunk payloads are base64-encoded

### Requirement: Single data-dir holder

The core SHALL acquire an OS-level lock on the data directory at
startup and SHALL refuse to start if the lock is held by another
process, so two cores cannot corrupt persistence files
concurrently.

#### Scenario: Lock acquired on a free data directory

- **WHEN** the core starts and `<dataDir>/.lock` is not held
- **THEN** the core takes the lock
- **AND** completes its handshake

#### Scenario: Lock contention exits with code 3

- **WHEN** the core starts and `<dataDir>/.lock` is already held by
  another live process
- **THEN** the core writes an error to stderr that names the holding
  PID
- **AND** exits with status 3
- **AND** does not write the handshake line to stdout

### Requirement: Renderer-side RPC client

The renderer SHALL connect to the core through a single long-lived
WebSocket client that reconnects with exponential backoff and
re-issues live subscriptions, while rejecting pending RPC calls on
disconnect.

#### Scenario: Initial connect uses the preload endpoint

- **WHEN** the renderer starts
- **THEN** the RPC client calls `window.parallelCore.endpoint()`
- **AND** opens a WebSocket to the returned URL
- **AND** sends the auth message with the returned token as the
  first message after the WebSocket opens

#### Scenario: Pending RPC rejects on disconnect

- **WHEN** the WebSocket disconnects for any reason
- **AND** at least one RPC call is awaiting a response
- **THEN** every awaiting call rejects with a `CoreDisconnectedError`
- **AND** the RPC client does not automatically retry the call

#### Scenario: Subscriptions are replayed after reconnect

- **WHEN** the client reconnects and completes authentication
- **AND** one or more subscriptions were active before the
  disconnect
- **THEN** the client sends `subscribe` for each of those streams
- **AND** the renderer's chunk callbacks receive new chunks without
  caller intervention

#### Scenario: Backoff sequence is bounded

- **WHEN** the client attempts to reconnect after a disconnect
- **THEN** the delay sequence is 250 ms, 500 ms, 1 s, 2 s, 4 s, then
  10 s for every subsequent attempt
- **AND** the client retries indefinitely

#### Scenario: Endpoint change is honoured

- **WHEN** the renderer receives a `core-restart` event with a new
  `{ url, token }`
- **THEN** the RPC client tears down the existing WebSocket
- **AND** opens a new WebSocket to the new endpoint
- **AND** authenticates with the new token

## MODIFIED Requirements

### Requirement: On-demand local server

The app SHALL run at most one embedded remote server, started and
stopped explicitly by the user through RPC, and bound to `0.0.0.0`
on the configured port so that other devices on the same network
can reach it.

#### Scenario: User starts the remote server

- **WHEN** the renderer sends the `remote.start` RPC request
- **THEN** the core starts an HTTP server with a WebSocket server
  accepting upgrades on the same listener
- **AND** the server binds to `0.0.0.0` on the configured port
- **AND** the response includes the generated auth token and the
  access URLs for the detected WiFi and Tailscale interfaces

#### Scenario: User stops the remote server

- **WHEN** the renderer sends the `remote.stop` RPC request
- **THEN** the server closes all open WebSocket connections
- **AND** the HTTP listener is closed
- **AND** subsequent `remote.status` RPC requests report the server
  as stopped

#### Scenario: Only one server runs at a time

- **WHEN** `remote.start` is requested while a server is already
  running
- **THEN** the existing server instance is reused and its token and
  URLs are returned
- **AND** no second listener is opened on the port

### Requirement: Live output streaming and scrollback

The server SHALL stream terminal output live to subscribed clients,
back it with a fixed-capacity in-memory ring buffer, and replay the
buffer when a client subscribes so mid-session joiners see recent
history.

#### Scenario: Client subscribes to an agent

- **WHEN** an authenticated client sends `{ "type": "subscribe", "agentId": ... }`
- **THEN** the server registers a per-client subscription callback
- **AND** sends the agent's current ring-buffer contents as a single
  `scrollback` message (base64-encoded `data` and the current `cols`)
- **AND** streams every subsequent chunk of PTY output as an `output` message

#### Scenario: Client unsubscribes

- **WHEN** the client sends `{ "type": "unsubscribe", "agentId": ... }`
- **THEN** the subscription callback is removed
- **AND** no further `output` messages for that agent are sent to the client

#### Scenario: Scrollback capacity is bounded

- **WHEN** total output for a single agent exceeds the 64 KB ring-buffer
  capacity
- **THEN** only the most recent 64 KB is retained
- **AND** earlier bytes are discarded

#### Scenario: Scrollback is not persisted across restarts

- **WHEN** the core process restarts
- **THEN** every ring buffer is empty at the next `remote.start`

### Requirement: Desktop UI integration

The desktop renderer SHALL surface a remote-access control in
settings that shows the server state, the connection URL and QR
code, and the number of connected clients, and SHALL drive
start/stop through RPC.

#### Scenario: User toggles remote access on

- **WHEN** the user flips the remote-access toggle in settings
- **THEN** the renderer sends `remote.start`
- **AND** the returned URL and token are rendered as a QR code plus
  copyable text

#### Scenario: Connected-client counter stays current

- **WHEN** the server's connected-client count changes while the UI
  is visible
- **THEN** the displayed counter updates within a few seconds via
  periodic `remote.status` polling
