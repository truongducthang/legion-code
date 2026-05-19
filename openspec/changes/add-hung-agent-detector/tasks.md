# Tasks — Add Hung-Agent Detector

- [x] Add `lastDataAt: number` to the `PtySession` interface in `electron/ipc/pty.ts`; stamp it on every `onData` event in the same callback that writes the ring-buffer scrollback. Initialise it to `Date.now()` on spawn.

- [x] Add IPC channels `HungAgentUpdate`, `NudgeAgent`, `GetHungAgentSettings`, `SetHungAgentSettings` to `electron/ipc/channels.ts` and to the preload allowlist in `electron/preload.cjs`.

- [x] Add shared payload types to `src/ipc/types.ts`: `HungAgentStatus = 'active' | 'idle' | 'hung'`, `HungAgentUpdatePayload`, `HungAgentSettings`.

- [x] Implement `electron/ipc/hung-agent.ts`: shared interval, classifier, previous-state map, OS notification de-duping, settings re-read on every tick.

- [x] Wire window-visibility gating in `hung-agent.ts` (clear interval on `hide`/`minimize`, resume + immediate tick on `show`/`restore`).

- [x] Clear the per-agent previous-state entry on `onPtyEvent('exit', ...)` so a re-spawn doesn't inherit stale `hung` state.

- [x] Implement the `NudgeAgent` handler as a one-line wrapper around `writeToAgent(agentId, '\r')`. No new write path.

- [x] Implement `GetHungAgentSettings` / `SetHungAgentSettings` over the existing persisted settings store, with validation: both integers ≥ 0; `hungThresholdMs ≥ idleThresholdMs` when `idleThresholdMs > 0`; both capped at 24 h.

- [x] Unit tests in `electron/ipc/hung-agent.test.ts`: classifier taxonomy, transition detection, notification de-duping, threshold edge cases (`idleThresholdMs === 0`, `hungThresholdMs === 0`), shell-session and exited-session filters, window-hidden gating.

- [x] Renderer store `src/store/hung-agent.ts`: subscribe to `HungAgentUpdate`, drop entries on PTY exit, expose per-agent status.

- [x] Agent card UI: show a soft "idle" hint and a loud "looks hung" badge with two actions ("Send a newline" → `NudgeAgent`; "Kill agent" → existing `KillAgent`).

- [x] Settings UI: two numeric fields with sensible defaults and validation messages; copy explains the "set to 0 to disable" behaviour.

- [x] `openspec validate --strict add-hung-agent-detector`, `npm run typecheck`, `npm run lint`, `npm test`.
