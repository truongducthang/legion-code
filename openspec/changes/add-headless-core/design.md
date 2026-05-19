# Design — Add Headless Core

## Why this is big

Roughly 70% of files under `electron/` move into `core/`. Every renderer
wrapper that calls `ipcRenderer.invoke` is rewritten. The IPC enum is
retired. Even though no handler's business logic changes, the surface
area touched is wide. This is a deliberate refactor — Phase 1 of a
multi-phase plan toward remote workspace — and it ships nothing
externally visible to the user. Acceptance is judged by zero
regression on existing flows plus the new lifecycle and transport
behavior described in `specs/headless-core/spec.md`.

## Key decision: Electron spawns core, talks WS even on localhost

Two ways to wire the Electron main process to the extracted module:

| Option                                      | Mechanics                                                                                                                                      | Trade-off                                                                                                                                                               |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A. In-process `require()`                   | Electron main `require()`s the core module. Renderer still uses `ipcRenderer.invoke`. WS server is started inside Electron for mobile clients. | Two transports in the renderer (IPC for local, WS for remote in Phase 3). WS path is untested during local dev — bugs surface only in production. Core crashes kill UI. |
| **B. Spawn core as child process** (chosen) | Electron `spawn`s `core/index.js`. Renderer always speaks WS, even over loopback. Core lifecycle is supervised; crashes are recoverable.       | Adds one process. Loopback round-trip costs ~1–2 ms per call. Need a robust supervisor.                                                                                 |

B is chosen. The deciding factor: option A keeps the WebSocket layer
untested by daily development. Every local dev session and unit test
would run the in-process path; the WS path only exercises under
mobile or remote use. By the time Phase 3 lights up remote workspace,
the WS path has years of accumulated rust. Option B forces every
operation through WebSocket from day one of Phase 1, so the protocol
that Phase 3 depends on is hardened by ordinary use.

Process isolation is a secondary benefit: a handler that throws an
unhandled exception now takes down the core, not the UI, and the
supervisor restarts it.

## Key decision: handshake on stdout, not on a known port

The core picks a random loopback port (49152–65535) and generates a
session token at startup, then writes one JSON line to stdout:

```json
{ "event": "ready", "port": 54321, "token": "abc..." }
```

Electron main reads this line, stores `{ url: "ws://127.0.0.1:54321",
token }`, and exposes it to the renderer via the preload
`get-core-endpoint` channel.

Alternatives considered:

- **Fixed port** — collides with other tools and with two Parallel
  Code instances on the same machine.
- **Unix domain socket** — non-portable to Windows-development hosts
  used by some contributors, even though the shipping target is
  macOS/Linux. Loopback TCP is uniform.
- **Probing a port range from Electron** — both processes have to
  agree without a side channel; stdout is already a side channel.

The handshake line is the first stdout line; further stdout lines
are structured JSON logs that the Electron main pipes to its own
logger. A non-JSON or missing handshake within 10 s is a fatal
startup error.

## Key decision: one RPC protocol, extending the existing WS contract

The remote-access WS protocol today carries event-stream messages:
`agents`, `output`, `subscribe`, `unsubscribe`, `input`, `resize`,
`kill`, `status`, `scrollback`. After Phase 1, the same connection
also carries request/response messages:

```json
// request
{"type":"rpc-request","id":42,"method":"git.diff","params":{"taskId":"t1"}}

// response
{"type":"rpc-response","id":42,"result":{"...":"..."}}
{"type":"rpc-response","id":42,"error":{"code":"not_found","message":"..."}}
```

Two protocols on one connection were considered and rejected — a
single message-tagged protocol keeps routing trivial and lets a
client subscribe and call without managing two sockets. The frame
cap rises from 64 KB to a configurable default of 1 MB to admit
file/diff payloads; the existing 4096-character input cap and 1–500
range for resize stay in place.

RPC method names use the dotted form `domain.action`, replacing the
flat `IPC.*` enum. Existing channels map mechanically:
`IPC.ListTasks` → `tasks.list`, `IPC.PtySpawn` → `pty.spawn`,
`IPC.StartRemoteServer` → `remote.start`, and so on. The mapping is
defined in `tasks.md`.

## Key decision: error codes, not free-form strings

Every RPC error carries a code from a closed enum borrowed from
gRPC's status set, simplified:

| Code                  | When                                                               |
| --------------------- | ------------------------------------------------------------------ |
| `not_found`           | Resource (task, pty, branch, file) does not exist.                 |
| `invalid_argument`    | Param shape or value violates a documented constraint.             |
| `permission_denied`   | Caller is authenticated but not allowed (reserved for future use). |
| `failed_precondition` | State is not ready (e.g. start tunnel while server is stopped).    |
| `unavailable`         | Subsystem is temporarily down (e.g. core is restarting).           |
| `internal`            | Uncaught handler exception. Stack only in non-production builds.   |

Renderer code can branch on `error.code` without parsing message
text. Logs and error toasts read `message`.

## Key decision: supervisor restarts once, then surfaces

A core crash within the same Electron session is auto-restarted
exactly once. A second crash within 30 s of the first stops
restarting and surfaces a dialog with the crash log path. Reasons:

- Restarting indefinitely hides systemic bugs (state file corruption,
  bad config) behind an apparent recovery.
- Restarting zero times turns every transient hiccup into a UX
  failure.
- One restart catches the most common case (a transient handler
  failure with no persisted side effect) without papering over a
  loop.

After a successful restart, Electron main pushes a `core-restart`
event to the renderer carrying the new `{ url, token }`. The
renderer's `coreClient` reconnects to the new endpoint and re-issues
its live subscriptions. Pending RPCs reject with
`CoreDisconnectedError` and let the caller decide whether to retry
(idempotency is not assumed for RPCs that mutate state, e.g.
`pty.spawn`).

## Key decision: parent-PID watch

Core takes `--parent-pid <pid>` and probes the parent every 2 s with
`process.kill(parentPid, 0)`. If the probe fails (`ESRCH`), the core
flushes state and exits 0 within 4 s of the parent disappearing. The
watch defends against `kill -9` of Electron and against a renderer-
side crash that takes the whole desktop process down. Without it, a
crashed Electron leaves an orphan core writing to the data
directory.

## Key decision: data-dir lock

Core acquires an OS-level lock on `<dataDir>/.lock` before opening
persistence files. If the lock is held, core exits with code 3 and
prints the holding PID. Electron interprets code 3 as "another
instance is running" and surfaces the existing
`requestSingleInstanceLock` dialog. The data-dir lock is a second
defense — it catches the case where the Electron-level lock is
bypassed (manual `node core/index.js` for testing, future remote
core process started twice).

## What stays out of scope

- **Remote bootstrap.** Installing core on a remote machine and
  starting it there is Phase 2.
- **Transport-agnostic renderer.** The renderer in Phase 1 always
  connects to `127.0.0.1:<port>` — it does not yet support
  connecting to a remote core. Phase 3.
- **Multi-host UI.** Listing, saving, and switching between hosts is
  Phase 4.
- **Offline / reconnection hardening beyond Phase 1's backoff.**
  Reconnection across cold restart of a remote core, session
  resumption, and key rotation are Phase 5.
- **Migrating the on-disk persistence schema.** The data files keep
  their existing shape. The data directory is opened by a different
  process; the files are byte-identical.
- **Binary distribution of the core.** Phase 1 ships the core as a
  bundled JavaScript file invoked with the Electron-bundled Node.
  Building a standalone `parallel-code-core` binary for headless
  remote installs is Phase 2.
- **Removing the Electron `before-quit` IPC bridge.** A single IPC
  channel (`get-core-endpoint`) survives in `preload.cjs` because it
  has to be available before the WebSocket client can connect.
  Everything else moves to RPC.

## Migration plan

1. Land the new `core/` directory with handlers moved over but still
   unwired. Renderer untouched. Existing tests keep passing because
   Electron still owns IPC.
2. Land the RPC transport (request/response + extended subscribe) on
   the existing WS server, keeping IPC alive in parallel. Renderer
   unchanged.
3. Switch renderer wrappers from IPC to RPC, file by file, behind a
   single feature flag (`USE_CORE_RPC=1`). CI runs both modes.
4. Move the WS server out of Electron and into `core/`. Electron
   starts spawning core and reading the handshake. IPC enum and
   registrations are deleted in the same commit. The flag is
   removed.
5. Burn-in: dogfood for one week; collect crash reports; iterate on
   the supervisor.

The first three steps are reversible without user impact. Step 4 is
the cliff — once IPC is gone the renderer has no fallback. The
manual smoke test in `tasks.md` is the gate.
