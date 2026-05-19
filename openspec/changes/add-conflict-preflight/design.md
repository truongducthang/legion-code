# Design — Add Conflict Pre-Flight

## Reuse `checkMergeStatus`

`electron/ipc/git.ts:1494` already does the costly part: it walks
`rev-list --cherry-pick --right-only HEAD...<base>` to count how far
the base is ahead, then runs `git merge-tree --write-tree HEAD <base>`
and parses the conflict report. The result has exactly the three
fields the badge needs: `main_ahead_count`, `conflicting_files`,
`base_branch`.

The pre-flight feature is a scheduler around that function — not a
new merge implementation. The schedule lives in a new
`electron/ipc/conflict-preflight.ts` module; nothing in `git.ts`
changes.

## Status taxonomy

Per task, one of four states:

- `clean` — `main_ahead_count === 0`. Branch is up to date; merge
  would fast-forward or be empty.
- `stale` — `main_ahead_count > 0` and `conflicting_files.length === 0`.
  Base moved on but the branch would merge clean. The user might still
  want to rebase, but there's no blocking issue.
- `conflict` — `main_ahead_count > 0` and
  `conflicting_files.length > 0`.
- `unknown` — the most recent poll threw (worktree missing, git
  errored, base branch could not be detected). The badge falls back
  to "no badge" rather than showing a misleading colour.

`clean` and `stale` are not the same colour: a user with five tasks
will want to see at a glance which can be merged right now vs. which
need a rebase first.

## Polling topology

One interval, owned by the main process, ticks every 60 s. On each
tick the poller walks its in-memory map of registered tasks:

- `conflict` → refresh every tick. The user might be about to rebase
  away the conflict.
- `clean` and `stale` → refresh every 5 min. Cheap, but reflects new
  pushes to main.
- `unknown` → refresh every tick for up to 3 ticks, then back off to
  every 5 min so a permanently-broken worktree (the user deleted it
  underneath us) doesn't burn CPU.

A pre-flight is also forced on three signals, ignoring the schedule:

1. The task's PTY emits an `exit` event (agent finished — likely a
   new commit).
2. A new commit lands on the worktree HEAD between ticks. Detected
   by storing `head_sha` in the per-task state and comparing on
   each tick.
3. The base branch moves. Detected by storing `base_sha` and
   comparing on each tick.

The `head_sha` and `base_sha` are cheap to read (`git rev-parse`),
so the poll loop reads them first and only runs `checkMergeStatus`
when either changed or the schedule says it's time.

## Throttling

`checkMergeStatus` is concurrent-safe but per-worktree it forks at
least one `git` process and possibly two. The poller serialises
tasks within a single repo root: tasks sharing a `projectRoot`
refresh one-at-a-time so a 10-task user doesn't fork 10 git
processes against the same `.git/` at once. Cross-repo refreshes
proceed in parallel.

Each refresh is guarded by an `isRefreshing` flag per task; a
signal-triggered refresh that lands while a scheduled refresh is
in flight is dropped (not queued) — the in-flight result is fresh
enough.

## Window visibility

Same rule as `add-pr-ci-status`: the interval is cleared on
`hide`/`minimize`, re-established on `show`/`restore`, and runs an
immediate tick on resume. `blur` does not pause: the user might be
in another app while merging, and the badge state should still be
fresh when they tab back.

## IPC contract

- `StartConflictPreflight { taskId, worktreePath, projectRoot }` —
  renderer → main, idempotent. Re-issuing with the same arguments
  is a no-op; re-issuing with a new `worktreePath` discards the
  prior state for that `taskId`.
- `StopConflictPreflight { taskId }` — renderer → main, idempotent.
- `ConflictPreflightUpdate { taskId, status, mainAheadCount,
conflictingFiles, baseBranch, checkedAt }` — main → renderer,
  push.

The renderer subscribes to the push channel at bootstrap and routes
updates into a non-persisted `src/store/conflict-preflight.ts`
slice. The task card reads from that slice and renders nothing for
`status === 'unknown'`.

## Failure modes

- Worktree path no longer exists → one `unknown` push, then drop
  from the watcher map. The renderer's task-card store still has
  the task; on next mount the renderer can re-start the watcher.
- `detectMainBranch` returns null → `unknown` and back-off.
- `checkMergeStatus` throws → status stays as last successful
  value, retry on next tick. The user shouldn't see a working
  green badge flicker to "unknown" because of a transient git lock.
- The window is hidden when an update fires → the push is still
  delivered; renderer-side, the store is non-persisted, so when
  the window is shown again the state is current.

## What this does NOT do

- It does not attempt the rebase. The badge is informational only;
  the existing merge dialog remains the one place that mutates the
  worktree.
- It does not block any UI on the result. Tasks without a recent
  poll just show no badge.
- It does not poll the remote. The base branch is the local ref
  (or the picked merge-base ref) — same as `checkMergeStatus`
  today. If the user wants origin awareness they pull, and the
  next tick picks up the new SHA.
