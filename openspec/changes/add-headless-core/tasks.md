# Tasks — Add Headless Core

## Scaffold the core module

- [ ] Create `core/` at the repo root with `index.ts`, `server.ts`,
      `lifecycle.ts`, `data-dir.ts`, and the subdirectories
      `transport/`, `handlers/`, `telegram/`, `mcp/`.
- [ ] Add a Vite (or esbuild) build target that bundles `core/` to
      `dist/core/index.js` with `node` as the platform and externals
      for native modules (`node-pty`, `better-sqlite3` if present).
- [ ] Add the bundled file to the Electron packager's `extraResources`
      so it ships with the app.
- [ ] Add an `npm` script `core:dev` that runs the bundle in watch
      mode for development.

## Move handlers from electron/ to core/

- [ ] Move every file under `electron/ipc/*.ts` to `core/handlers/`.
      Preserve filenames and contents. Update internal imports.
- [ ] Move `electron/remote/*` to `core/remote/`. Update imports.
- [ ] Move `electron/telegram/*` to `core/telegram/`. Update imports.
- [ ] Move `electron/mcp/*` to `core/mcp/`. Update imports.
- [ ] Move corresponding test files alongside their subjects under
      `core/`. Tests keep their current names and assertions.
- [ ] Delete `electron/ipc/`, `electron/remote/`, `electron/telegram/`,
      `electron/mcp/` after migration.

## Build the RPC transport

- [ ] Implement `core/transport/rpc.ts` with `registerRpc(method, fn)`
      and a dispatcher that handles incoming `rpc-request` messages,
      catches handler errors, and sends `rpc-response` with one of
      the documented error codes.
- [ ] Implement `core/transport/stream.ts` that generalises the
      existing agent-output subscribe path to arbitrary streams.
      Each subscription gets a server-assigned `subId`; chunks
      reference the `subId`. Server cleans up all subs of a closed
      connection.
- [ ] Wire `core/server.ts` to register all handler methods on
      module load. Replace the existing `ipcMain.handle` registrar
      with `registerRpc`. The mapping from old `IPC.*` channel names
      to new `domain.action` method names is mechanical; codify it
      in a single table in `core/handlers/index.ts`.
- [ ] Raise the WebSocket frame size cap from 64 KB to 1 MB via a
      configurable option on the server. Keep the 4096-character
      cap on `input` messages and the 1–500 range on `resize`.

## Core lifecycle

- [ ] In `core/index.ts`, parse `--port`, `--data-dir`, `--bind`, and
      `--parent-pid`. Defaults: random port, `~/.parallel-code/`,
      `127.0.0.1`, no parent.
- [ ] On startup, in this order: acquire data-dir lock, generate
      auth token, bind WebSocket server on the chosen port, write
      `{event:"ready", port, token}` to stdout as one JSON line.
- [ ] If port binding fails: exit code 2. If data-dir lock fails:
      exit code 3 with the holding PID in the error message.
- [ ] If `--parent-pid` is supplied, start a 2-second timer that
      probes the parent with `process.kill(pid, 0)`. On `ESRCH`,
      run the graceful-shutdown path and exit 0.
- [ ] Implement graceful shutdown on `SIGTERM`: stop accepting new
      connections, close existing connections with code 1001, flush
      persistence, release data-dir lock, exit 0. Force-exit on a
      3-second timeout.

## Rewrite electron/main.ts as a thin shell

- [ ] Remove all `ipcMain.handle` registrations and all imports from
      `core/handlers/`. Electron main no longer imports business
      logic.
- [ ] Implement `spawnCore()`: `child_process.spawn` the bundled
      core with `--port 0 --data-dir <userData> --parent-pid <pid>`.
      Pipe stdout; read the first line, parse JSON, store the
      endpoint. Reject startup on non-JSON or 10-second timeout.
- [ ] Pipe subsequent stdout lines to the existing main-process
      logger. Pipe stderr to the same logger at WARN level.
- [ ] Add a single IPC handler `get-core-endpoint` in `electron/
    preload.cjs`'s `ALLOWED_CHANNELS` set and in `electron/main.ts`
      that returns `{ url, token }`. This is the only IPC channel
      that survives Phase 1.
- [ ] Implement the supervisor: on child `exit` with non-zero code,
      restart once, then push `core-restart` with the new endpoint
      to every BrowserWindow. On a second crash within 30 s, show
      a fatal dialog with the crash log path; do not restart.
- [ ] On `before-quit`, send `SIGTERM` to the core, wait up to
      3 seconds for exit, send `SIGKILL` if needed.

## Slim preload.cjs

- [ ] Replace the existing `ALLOWED_CHANNELS` set with one entry:
      `get-core-endpoint`. Remove the per-handler channel
      allowlist.
- [ ] Replace `contextBridge.exposeInMainWorld('electronAPI', …)`
      with `exposeInMainWorld('parallelCore', { endpoint, onCoreRestart })`.
- [ ] Update `electron/preload-allowlist.test.ts` to match the new
      single-channel allowlist.

## Renderer coreClient

- [ ] Create `src/lib/coreClient.ts` implementing `connect`, `call`,
      `subscribe`, `onStatus`. Auth message is sent immediately
      after the WebSocket opens; subsequent messages wait for the
      auth ack.
- [ ] Implement exponential-backoff reconnect with the sequence
      250 ms, 500 ms, 1 s, 2 s, 4 s, 10 s (cap). Infinite retries.
- [ ] On reconnect, re-send `subscribe` for every live
      subscription. Do not auto-retry pending `call`s — reject them
      with `CoreDisconnectedError`.
- [ ] Listen for `core-restart` on `window.parallelCore`; on the
      event, replace the stored endpoint and reset the WebSocket.
- [ ] Add unit tests covering: connect happy path, auth failure,
      pending-RPC rejection on disconnect, subscription replay on
      reconnect, backoff sequence.

## Migrate renderer wrappers

- [ ] For every file under `src/lib/` and `src/store/` that calls
      `ipcRenderer.invoke(IPC.X, …)`, replace the body with
      `coreClient.call('x.y', …)` while preserving the function
      signature. Components above these wrappers do not change.
- [ ] Delete `electron/ipc/channels.ts` and `src/ipc/types.ts`'s
      enum-keyed types. Replace the latter with method-keyed types
      generated from the handler registry, or keep hand-written
      types per call site — whichever lands fewer lines.
- [ ] For every event-style channel (e.g. `PublicTunnelStatusChanged`)
      ported from the IPC enum, replace `ipcRenderer.on(...)` with
      `coreClient.subscribe('events.<name>', …)`. The core side
      emits these via the existing event bus, now routed through
      the RPC stream layer.

## Remote-access wording update

- [ ] In `openspec/specs/remote-access/spec.md`, for every reference
      to the IPC channel names `StartRemoteServer`, `StopRemoteServer`,
      and `GetRemoteStatus`: replace with the corresponding RPC
      method names `remote.start`, `remote.stop`, and `remote.status`.
- [ ] In the same file, replace every occurrence of "IPC request" or
      "through IPC" with "RPC request" or "through RPC", matching
      the MODIFIED requirements in
      `openspec/changes/add-headless-core/specs/headless-core/spec.md`.
- [ ] Confirm the wording update does not change observable behavior
      and matches the MODIFIED sections of the `headless-core` spec
      (this change covers requirements "On-demand local server",
      "Live output streaming and scrollback", and "Desktop UI
      integration" in the remote-access spec).

## Tests

- [ ] Move every existing handler test file to its new location
      under `core/` (1-to-1 with the handler moves). Tests pass
      unchanged.
- [ ] Add `core/transport/rpc.test.ts` covering: correct dispatch,
      handler error → response error code, unknown method →
      `not_found`, duplicate `id` → `invalid_argument`, concurrent
      requests do not interleave results.
- [ ] Add `core/transport/stream.test.ts` covering: subscribe-ack,
      per-`subId` chunk delivery isolation, unsubscribe stops
      delivery, connection close cleans up all subs.
- [ ] Add `core/lifecycle.test.ts` covering: parent disappearance
      triggers exit within 4 s, `SIGTERM` graceful path, data-dir
      lock contention exits with code 3, port bind failure exits
      with code 2.
- [ ] Add `electron/core-child.test.ts` covering: handshake parse,
      handshake timeout (10 s) is fatal, single restart on
      non-zero exit, fatal after two crashes within 30 s, kill on
      `before-quit`.
- [ ] Add `src/lib/coreClient.test.ts` covering the cases listed in
      the coreClient task above. Use a mock WebSocket server, not
      a real core spawn.
- [ ] Add `tests/e2e/phase1-handshake.test.ts`: build the core
      bundle, spawn it, open a WebSocket, auth with the
      handshake-supplied token, call any read-only RPC method,
      send `SIGTERM`, assert exit 0 within 3 s.

## Manual smoke test (gate before merge)

- [ ] `npm run dev` — app boots, opens a project, spawns one task,
      pty output streams to the UI.
- [ ] Run `ps` and confirm an `electron` and a `core` process are
      both alive.
- [ ] `kill -9 <corePid>` — UI shows "Reconnecting…", core
      restarts, task list and pty subscriptions recover.
- [ ] `kill -9 <electronPid>` — `ps` shows the orphan core exit
      within 5 s.
- [ ] Cmd+Q — both processes exit; no orphan in `ps`.
- [ ] `npm run build` — packaged app boots on macOS and on Linux.
      The bundled core is in `Resources/`.

## Validation

- [ ] Run `openspec validate add-headless-core --strict` and fix
      any issues before requesting review.
- [ ] Run `npm run typecheck` and fix any issues.
- [ ] Run the full unit test suite (`npm test` or repo equivalent)
      and confirm zero regressions.
