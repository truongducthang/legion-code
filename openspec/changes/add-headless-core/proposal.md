# Add Headless Core

## Why

Parallel Code's business logic — pty management, git worktree operations,
agent orchestration, persistence, the embedded remote-access server, the
Telegram bot, MCP — currently lives inside the Electron main process and
is reached by the renderer through `ipcRenderer.invoke` over Electron's
private IPC channels. Three forces are pulling this apart:

1. Users want to run the same workload on a stronger machine than their
   laptop ("remote workspace"). Mobile-spawn-task and public-tunnel-
   access have already proven the value of accessing this backend from
   outside the desktop process, but the backend itself is still
   chained to Electron.
2. Two transports are accumulating: the renderer's Electron IPC for
   local use, and the WebSocket protocol in `electron/remote/server.ts`
   for mobile and Telegram clients. Every new capability has to be
   wired twice. The two paths drift; bugs in the WS path only surface
   in production.
3. Electron's main process owns lifecycle, window management, and
   business logic in one binary. Crashes in business logic kill the
   UI; restarting requires the user to reopen all windows.

The fix is to extract the business logic into a standalone Node
module (`core/`) that runs as a separate OS process and serves all
clients — local desktop UI, mobile SPA, Telegram bot, future remote
workspace — through a single WebSocket-based RPC transport. Electron
becomes a thin shell that spawns and supervises the core, then renders
UI on top of the same RPC client every other client uses. This is
Phase 1 of a five-phase plan toward remote workspace; the remaining
phases (remote bootstrap, transport-agnostic renderer, multi-host UI,
reconnection hardening) build on the boundary established here.

## What changes

- New capability `headless-core` covering the core process lifecycle,
  the parent-supervised child process model, the RPC-over-WebSocket
  transport (request/response and subscription streams), the auth
  handshake between Electron main and core, and the renderer's
  `coreClient` reconnect/resubscribe semantics.
- New top-level `core/` directory holding the headless module. The
  existing `electron/ipc/*` handlers, `electron/remote/*` server,
  `electron/telegram/*` bot, and `electron/mcp/*` integration move
  into `core/handlers/`, `core/server.ts`, `core/telegram/`, and
  `core/mcp/` respectively. Handler code is unchanged; only
  registration switches from `ipcMain.handle` to a new `registerRpc`
  surface.
- `electron/main.ts` is rewritten as a thin shell that spawns
  `core/index.ts` as a child process, reads its handshake from
  stdout (`{event:"ready", port, token}`), creates the BrowserWindow,
  and supervises the child (restart once on crash, kill on quit).
  Electron main no longer registers any IPC handler beyond
  `get-core-endpoint`.
- `electron/preload.cjs` is reduced to exposing the core endpoint
  (`{ url, token }`) and a `core-restart` event. All other
  `contextBridge.exposeInMainWorld` surfaces are removed.
- New `src/lib/coreClient.ts` implements the renderer-side RPC
  client: connect, auth, `call(method, params)`, `subscribe(stream,
params, onChunk)`, exponential-backoff reconnect, and automatic
  re-subscribe after reconnect.
- Existing renderer wrappers under `src/lib/*.ts` and `src/store/*.ts`
  keep their public function signatures but switch their internals
  from `ipcRenderer.invoke(IPC.X, …)` to `coreClient.call('x.y', …)`.
  SolidJS components above the wrappers do not change.
- The `IPC` enum in `electron/ipc/channels.ts` is retired. RPC method
  names use the dotted form `domain.action` (e.g. `pty.spawn`,
  `git.diff`, `remote.start`).
- The existing `remote-access` capability spec is updated to reflect
  that the renderer reaches the embedded remote server through the
  same RPC transport as every other operation, rather than through
  Electron IPC.

## Impact

- New capability `headless-core`.
- Modified capability `remote-access` — wording change only: requests
  that say "IPC request" become "RPC request"; observable behavior is
  preserved.
- `electron/ipc/*`, `electron/remote/*`, `electron/telegram/*`,
  `electron/mcp/*` move under `core/`. Imports throughout the repo
  shift accordingly.
- The renderer gains one steady dependency: a long-lived loopback
  WebSocket connection to the local core. Tear-down on app quit is
  driven by the Electron `before-quit` event.
- New runtime artifact: a bundled `core.js` file shipped alongside
  the Electron app. Build pipeline gains a `core` bundle target.
- Backward compatibility: none preserved inside the renderer. After
  Phase 1, the renderer cannot fall back to direct IPC. Mobile SPA,
  Telegram bot, and public tunnel continue to work because they
  already use the WebSocket transport; this change only widens that
  transport's API surface.
- Cross-platform: macOS and Linux only (matches `CLAUDE.md`). The
  child-process model relies on POSIX signal semantics for parent
  death detection (signal 0 probe of parent PID). No Windows path.
- Security: the loopback core binds `127.0.0.1` only. The auth token
  is generated per session, passed through the Electron-main → core
  stdout handshake, and never written to disk. Token comparison in
  core continues to use the timing-safe path already in place for
  the WebSocket server.
- Persisted state: no new persisted fields. The `~/.parallel-code/`
  data directory continues to hold the same files; it is now opened
  by the core process instead of the Electron main process. Electron
  passes its `app.getPath('userData')` value to the core via
  `--data-dir`, so the on-disk location is unchanged.
- Performance: the renderer-to-handler round trip adds one loopback
  WebSocket hop (~1–2 ms). PTY output streaming uses the existing
  64 KB ring buffer and base64 framing; no encoding change.
