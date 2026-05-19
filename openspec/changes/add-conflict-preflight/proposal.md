# Add Conflict Pre-Flight

## Why

A user dispatches several agents in parallel; each one builds a branch
worth merging back to main. Today the only place that checks whether
those branches would actually merge cleanly is the merge dialog, which
runs `checkMergeStatus` on demand the moment the user clicks "Merge".
For a task that's been sitting for hours while main moved on, that's
the first time the conflict surface is visible — and the user has
already context-switched into "I'm about to merge this" mode.

The ask is for the task card itself to know whether the branch would
merge cleanly against the latest main, so the user can:

- decide which of N parallel agents to merge first based on conflict
  cost, not by remembering when each was started, and
- spot a branch that has gone out of date and queue a rebase before
  the merge dialog forces the choice.

The expensive part is already implemented: `checkMergeStatus` in
`electron/ipc/git.ts` runs `git merge-tree --write-tree` and parses
the conflict report, all in-memory. What's missing is a polling
schedule, a renderer-side store, and a compact task-card indicator.

## What changes

- Each task that has at least one commit on its branch gains a
  conflict pre-flight status: `clean`, `conflict`, `stale`, or
  `unknown`.
- The status is computed by the main process from a periodic poll
  against the current `main` (or task's `base_branch`), reusing
  `checkMergeStatus`.
- The polling is gated on window visibility, throttled per task, and
  invalidated when main moves or when the task's worktree gets new
  commits.
- The task card grows a small badge next to the existing branch info:
  green dot for `clean`, amber for `stale` (no conflicts but main is
  ahead), red for `conflict` with a count of conflicting files.
- The user can click the badge to open the existing merge dialog,
  which already shows the conflict file list.

## Impact

- New capability `conflict-preflight`.
- New IPC channels `StartConflictPreflight`, `StopConflictPreflight`,
  `ConflictPreflightUpdate`.
- New shared payload types in `src/ipc/types.ts`.
- New main-process module `electron/ipc/conflict-preflight.ts`.
- One new badge component in the existing task card; one new
  non-persisted renderer store slice.
- No changes to merge behaviour itself, and no changes to the diff
  base detection used by the diff viewer.
