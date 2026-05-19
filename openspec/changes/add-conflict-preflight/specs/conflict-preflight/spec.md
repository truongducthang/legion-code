# Conflict Pre-Flight Specification

## ADDED Requirements

### Requirement: Watcher lifecycle is driven by the renderer

The app SHALL track conflict pre-flight status for a task only while
the renderer has an active watcher for that task. The renderer is
responsible for starting a watcher when the task is loaded, updating
it when the worktree path changes, and stopping it when the task is
removed.

#### Scenario: Start a watcher

- **WHEN** the renderer sends `StartConflictPreflight` with a
  `taskId`, `worktreePath`, and `projectRoot`
- **THEN** the main process registers the task in its watcher map
- **AND** triggers an immediate refresh for that task

#### Scenario: Restart with a new worktree path

- **WHEN** the renderer sends `StartConflictPreflight` for an
  already-registered `taskId` with a different `worktreePath`
- **THEN** the prior state (status, head SHA, base SHA,
  unknown-streak counter) is discarded
- **AND** the task is treated as a fresh subscription

#### Scenario: Stop a watcher

- **WHEN** the renderer sends `StopConflictPreflight` for a `taskId`
- **THEN** the main process removes the entry from the watcher map
- **AND** a second `StopConflictPreflight` for the same `taskId` is
  a no-op

### Requirement: Status taxonomy

The watcher SHALL classify each task into exactly one of `clean`,
`stale`, `conflict`, or `unknown`, derived from the output of the
existing `checkMergeStatus` helper.

#### Scenario: Base is not ahead

- **WHEN** `checkMergeStatus` returns `main_ahead_count === 0`
- **THEN** the status is `clean`

#### Scenario: Base is ahead but no conflicts

- **WHEN** `main_ahead_count > 0` and `conflicting_files` is empty
- **THEN** the status is `stale`

#### Scenario: Base is ahead and conflicts exist

- **WHEN** `main_ahead_count > 0` and `conflicting_files` is
  non-empty
- **THEN** the status is `conflict`

#### Scenario: The refresh throws

- **WHEN** the refresh for a task throws (worktree missing, git
  error, base branch undetectable)
- **THEN** the status is `unknown`
- **AND** the previously-reported `mainAheadCount` and
  `conflictingFiles` are preserved in the push so the badge does
  not flicker to zero on a transient git lock

### Requirement: Polling cadence

The watcher SHALL refresh tasks on a shared 60 s interval, with
per-task backoff based on the most recent status, plus forced
refreshes on three signals.

#### Scenario: Conflict status refreshes every tick

- **WHEN** a task's most recent status is `conflict`
- **THEN** the poller refreshes it on the next 60 s tick

#### Scenario: Clean and stale refresh every 5 minutes

- **WHEN** a task's most recent status is `clean` or `stale`
- **THEN** the poller refreshes it at most once per 5 minutes

#### Scenario: Unknown backs off after three consecutive results

- **WHEN** a task returns `unknown` three times in a row
- **THEN** subsequent refreshes for that task drop to the 5 min
  cadence until a non-`unknown` result is observed

#### Scenario: Agent exit forces an immediate refresh

- **WHEN** the PTY session associated with the task emits an `exit`
  event
- **THEN** the poller forces an immediate refresh of that task,
  bypassing the schedule

#### Scenario: New HEAD commit forces an immediate refresh

- **WHEN** the cheap `git rev-parse HEAD` poll observes a SHA
  different from the task's stored `head_sha`
- **THEN** the poller forces an immediate refresh for that task

#### Scenario: Base branch movement forces an immediate refresh

- **WHEN** the cheap `git rev-parse <base>` poll observes a SHA
  different from the task's stored `base_sha`
- **THEN** the poller forces an immediate refresh for that task

#### Scenario: Forced refresh is dropped if one is already in flight

- **WHEN** a forced refresh is requested for a task whose
  `isRefreshing` flag is already true
- **THEN** the new request is dropped without queueing

### Requirement: Per-repo serialisation

The poller SHALL run at most one `checkMergeStatus` call at a time
per `projectRoot`, so a many-task user does not fork many `git`
processes against the same `.git/` directory simultaneously.

#### Scenario: Two tasks in the same repo

- **WHEN** two tasks sharing a `projectRoot` are both due for
  refresh on the same tick
- **THEN** the second task waits for the first to complete before
  starting its refresh

#### Scenario: Two tasks in different repos

- **WHEN** two tasks with different `projectRoot` values are due
  for refresh on the same tick
- **THEN** their refreshes run in parallel

### Requirement: Window visibility gates polling

The poller SHALL pause its interval when the main window is hidden
or minimised and resume on show/restore, running an immediate tick
on resume. The poller SHALL NOT pause merely because the window
lost focus.

#### Scenario: Window is hidden or minimised

- **WHEN** the main window emits `hide` or `minimize` and the
  watcher map is non-empty
- **THEN** the interval is cleared
- **AND** no scheduled refresh runs until the window is shown again

#### Scenario: Window is shown or restored

- **WHEN** the main window emits `show` or `restore` and the
  watcher map is non-empty
- **THEN** the poller runs an immediate tick
- **AND** re-establishes the 60 s interval

#### Scenario: Window loses focus without hiding

- **WHEN** the main window emits `blur` while still visible
- **THEN** the interval continues running
- **AND** updates continue to push to the renderer

### Requirement: Live update push to the renderer

The main process SHALL push `ConflictPreflightUpdate` messages to
the renderer whenever a task's refresh produces new information or
when the renderer first registers a watcher and the initial refresh
completes.

#### Scenario: Update payload shape

- **WHEN** the poller completes a refresh for a task
- **THEN** it sends `ConflictPreflightUpdate` on the window's
  webContents with `{ taskId, status, mainAheadCount,
conflictingFiles, baseBranch, checkedAt }`

#### Scenario: No-op refresh skips the push

- **WHEN** a refresh produces identical `status`, `mainAheadCount`,
  `conflictingFiles`, `baseBranch`, and `head_sha` to the previous
  one
- **THEN** no `ConflictPreflightUpdate` is emitted for that task

### Requirement: Task card surface

The renderer SHALL render a compact status badge on any task whose
latest update has `status !== 'unknown'`, and SHALL NOT persist
pre-flight state across restart.

#### Scenario: Badge colour matches status

- **WHEN** a task's latest status is `clean`
- **THEN** the badge renders as a green dot

- **WHEN** a task's latest status is `stale`
- **THEN** the badge renders as an amber dot

- **WHEN** a task's latest status is `conflict`
- **THEN** the badge renders as a red dot accompanied by the
  count of `conflictingFiles`

- **WHEN** a task's latest status is `unknown` or no update has
  arrived yet
- **THEN** no badge is rendered

#### Scenario: Badge tooltip summarises counts

- **WHEN** the badge is rendered
- **THEN** its accessible label reports the status, the base
  branch name, `mainAheadCount`, and the number of conflicting
  files in a single line

#### Scenario: Clicking the badge opens the merge dialog

- **WHEN** the user activates the badge
- **THEN** the existing merge dialog opens for that task
- **AND** the dialog's own conflict listing is the authoritative
  surface for the file names

#### Scenario: State is not persisted across restart

- **WHEN** the app restarts
- **THEN** the persisted store contains no conflict pre-flight
  fields
- **AND** pre-flight state re-populates from
  `ConflictPreflightUpdate` pushes once the renderer re-registers
  watchers
