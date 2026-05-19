# Tasks — Add Conflict Pre-Flight

- [x] Add IPC channels `StartConflictPreflight`, `StopConflictPreflight`, `ConflictPreflightUpdate` to `electron/ipc/channels.ts` and to the preload allowlist in `electron/preload.cjs`.

- [x] Add shared payload types to `src/ipc/types.ts`: `ConflictPreflightStatus = 'clean' | 'stale' | 'conflict' | 'unknown'`, `ConflictPreflightUpdatePayload`.

- [x] Implement `electron/ipc/conflict-preflight.ts`: shared interval, per-task state map (`status`, `head_sha`, `base_sha`, `lastCheckedAt`, `unknownStreak`, `isRefreshing`), per-repo serialisation, signal-triggered refreshes on PTY `exit`, head SHA change, and base SHA change.

- [x] Wire window-visibility gating in `conflict-preflight.ts` (clear interval on `hide`/`minimize`, resume + immediate tick on `show`/`restore`).

- [x] Unit tests in `electron/ipc/conflict-preflight.test.ts` mirroring `electron/ipc/pr-checks.test.ts` mock style: status taxonomy reducer, schedule cadence, per-repo serialisation, signal-triggered refreshes, back-off after repeated `unknown`, window-hidden gating.

- [x] Wire `StartConflictPreflight` / `StopConflictPreflight` into `registerAllHandlers` in `electron/ipc/register.ts`.

- [x] New renderer store `src/store/conflict-preflight.ts`: subscribe to `ConflictPreflightUpdate` at bootstrap; call Start/Stop when a task is created, opened, or removed.

- [x] Add status badge to the task card (the same component that hosts the existing branch info bar) — green dot for `clean`, amber dot for `stale`, red dot with count for `conflict`, nothing for `unknown`.

- [x] `openspec validate --strict add-conflict-preflight`, `npm run typecheck`, `npm run lint`, `npm test`.
