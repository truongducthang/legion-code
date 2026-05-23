# Spec to Swarm Specification

## ADDED Requirements

### Requirement: Users can dispatch a swarm from a short spec

The app SHALL accept a free-text spec from the user and translate it
into a multi-agent run that produces one branch and one PR per
swarm, without the user creating worktrees or branches by hand.

#### Scenario: Open the dispatch dialog from the keyboard

- **WHEN** the user presses `Ctrl+Shift+S` (or `Cmd+Shift+S` on
  macOS) while a project is selected
- **THEN** the swarm dispatch dialog opens with focus on the spec
  textarea

#### Scenario: Open the dispatch dialog from the sidebar

- **WHEN** the user activates the "Dispatch swarm" entry in the
  sidebar footer of a selected project
- **THEN** the swarm dispatch dialog opens for that project

#### Scenario: Dispatch without a selected project

- **WHEN** the user attempts to open the dispatch dialog and no
  project is selected
- **THEN** the dialog does not open and a tooltip surfaces "Open a
  project first"

### Requirement: A planner decomposes the spec into layered waves

The app SHALL invoke a planner that takes the spec and produces a
`SwarmPlan` of one or more waves, where every task in wave _N_ is
independent of every other task in wave _N_, and tasks in wave _N+1_
may depend on results of tasks in wave _N_.

#### Scenario: Planner emits a multi-wave plan

- **WHEN** the user submits a spec that implies dependent work
  (e.g. an E2E test that depends on a route and a form)
- **THEN** the planner emits a `SwarmPlan` with at least two waves
  and the dependent task in the later wave

#### Scenario: Planner emits a single-task plan when work is not
splittable

- **WHEN** the planner determines the spec cannot be decomposed
- **THEN** it emits a `SwarmPlan` with exactly one task in one wave
  whose title explains why the spec was not split

#### Scenario: Planner output exceeds the hard caps

- **WHEN** the planner returns a plan with more than 5 waves or
  more than 6 tasks in any wave
- **THEN** the plan is rejected before being shown to the user
- **AND** the planner is re-prompted once with the validation error
  as context

#### Scenario: Planner output is malformed JSON

- **WHEN** the planner returns text that does not parse as a valid
  `SwarmPlan`
- **THEN** the system re-prompts the planner once with the parse
  error as context
- **AND** halts the swarm with reason `planner_invalid` if the
  second attempt also fails

#### Scenario: Streaming chunks are surfaced to the renderer

- **WHEN** the planner is producing its response
- **THEN** the renderer receives one or more `SwarmPlanChunk`
  messages carrying partial JSON before the final plan is committed

### Requirement: Users can review and edit the plan before dispatch

The app SHALL render the plan in a review dialog where each task is
editable in place, removable, or addable to any existing or new
wave, and SHALL not begin spawning sub-tasks until the user
approves the plan or the fast-lane skip-review checkbox was set.

#### Scenario: Approve without edits

- **WHEN** the user clicks Approve in the review dialog
- **THEN** the runtime begins spawning Wave 1 sub-tasks

#### Scenario: Edit a task title and prompt

- **WHEN** the user edits any task's title or prompt in place
- **THEN** the dialog reflects the edits and Approve uses the
  edited plan

#### Scenario: Remove a task

- **WHEN** the user removes a task from any wave
- **THEN** the dialog renders the remaining tasks and the runtime
  uses only those after Approve

#### Scenario: Add a task to a wave

- **WHEN** the user adds a task with title and prompt to any
  existing wave or a new appended wave
- **THEN** the dialog includes the new task and the runtime spawns
  it when its wave begins

#### Scenario: Re-plan with feedback

- **WHEN** the user opens the Re-plan textarea, types feedback,
  and submits
- **THEN** the planner is re-invoked with the prior plan and the
  feedback as context
- **AND** the dialog replaces the prior plan with the new one
  when the planner returns

#### Scenario: Fast-lane skips review

- **WHEN** the user checked "Trust planner (skip review)" in the
  dispatch dialog and the planner returns a valid plan
- **THEN** the runtime begins spawning Wave 1 sub-tasks without
  opening the review dialog

### Requirement: The runtime spawns waves serially and tasks within a
wave concurrently

The app SHALL spawn every task within a given wave concurrently and
SHALL NOT spawn any task of wave _N+1_ until every task of wave _N_
has reached terminal status (`succeeded` after at most one retry, or
`failed`).

#### Scenario: All wave tasks succeed → next wave begins

- **WHEN** every task in the current wave reaches `succeeded`
- **THEN** the runtime advances to the next wave

#### Scenario: One task fails after retry → swarm halts

- **WHEN** any task in the current wave reaches `failed` after the
  one allowed retry
- **THEN** the runtime emits `SwarmHalted` with the failed task id
  and the wave index
- **AND** does not spawn any task in the next wave

#### Scenario: No task in a wave is spawned before the prior wave
completes

- **WHEN** wave 2 has not yet started and any wave 1 task is still
  `running`
- **THEN** no wave 2 task is spawned

### Requirement: Sub-task success is detected from git, not from
agent-printed strings

The app SHALL mark a sub-task `succeeded` only when its branch HEAD
has moved beyond the recorded `baseSha` AND the sub-task's PTY has
emitted no new bytes for at least 30 seconds.

#### Scenario: Branch moved + PTY idle → succeeded

- **WHEN** `git rev-parse <branchName>` differs from `baseSha`
  AND the PTY has been silent for ≥ 30 s
- **THEN** the sub-task is marked `succeeded` and its PTY is killed

#### Scenario: Sentinel printed but no commit → user prompt

- **WHEN** the PTY emits `SWARM_TASK_DONE_<taskId>` on its own line
  but `git rev-parse <branchName>` is still equal to `baseSha`
- **THEN** the renderer surfaces a banner with actions
  `[Auto-commit] [Resume agent] [Mark failed]`
- **AND** the sub-task remains `running` until the user picks one

#### Scenario: Auto-commit action

- **WHEN** the user picks `Auto-commit` from the "agent says done
  but no commit" banner
- **THEN** the runtime runs `git add -A && git commit -m "<title>"`
  inside the worktree
- **AND** re-evaluates the success conditions

### Requirement: Sub-task failure is detected from clock, hung-agent,
sentinel, or explicit user action

The app SHALL mark a sub-task `failed` when any of the following
signals fires: wallclock exceeds the configured cap; the hung-agent
detector fires AND no new commit has appeared on the branch for at
least 5 minutes; the PTY emits `SWARM_TASK_FAILED_<taskId>` on its
own line; the user clicks "Mark failed" in the task panel.

#### Scenario: Wallclock exceeded

- **WHEN** a sub-task has been `running` longer than the configured
  per-sub-task wallclock cap
- **THEN** the sub-task is marked `failed` with reason
  `wallclock_exceeded`

#### Scenario: Hung + no progress

- **WHEN** the hung-agent detector fires for a sub-task AND no new
  commit has appeared on its branch for ≥ 5 minutes
- **THEN** the sub-task is marked `failed` with reason `hung_no_progress`

#### Scenario: Explicit failure sentinel

- **WHEN** the PTY emits `SWARM_TASK_FAILED_<taskId>` on its own line
- **THEN** the sub-task is marked `failed` with reason `agent_reported`

#### Scenario: User marks failed

- **WHEN** the user clicks "Mark failed" in the sub-task's task panel
- **THEN** the sub-task is marked `failed` with reason `user_marked`

### Requirement: A failed sub-task is retried once

The app SHALL retry a failed sub-task exactly once, in the same
worktree after a hard reset to `baseSha`, with the previous failure
context appended to the prompt. After the retry, the sub-task is
finalised as `succeeded` or `failed` and the runtime acts
accordingly.

#### Scenario: Retry succeeds

- **WHEN** a sub-task fails once and the retry succeeds
- **THEN** the wave continues as if the sub-task had succeeded on
  the first attempt

#### Scenario: Retry also fails

- **WHEN** a sub-task fails on its retry
- **THEN** it is finalised as `failed` and the swarm halts

#### Scenario: Worktree is reset before retry

- **WHEN** the runtime retries a sub-task
- **THEN** it runs `git reset --hard <baseSha>` inside the worktree
  before re-spawning the agent

#### Scenario: Retry prompt carries previous-attempt context

- **WHEN** the runtime builds the retry prompt
- **THEN** the prompt contains the original prompt, the failure
  reason, a `git diff --stat` summary of the failed attempt, and
  the last 3 KB of PTY output

### Requirement: After the last sub-task wave, an integrator merges
into one branch and opens one PR

The app SHALL run an integrator step after the last sub-task wave
that creates branch `swarm/<slug>/integration` from the base branch,
merges every successful child branch into it, runs `npm test` if a
test script exists, and opens one PR via the existing `gh pr create`
flow.

#### Scenario: Clean merge + tests pass

- **WHEN** every child branch merges without conflict and tests
  pass on the integration branch
- **THEN** the integration branch is pushed and a PR is opened
- **AND** `SwarmDone` is emitted with the PR URL

#### Scenario: Conflict resolved by the integrator agent

- **WHEN** a merge produces a conflict
- **THEN** the integrator agent resolves it using its own tools
- **AND** the resolving commit is recorded as part of the
  integration branch

#### Scenario: Tests fail once → flaky re-run passes

- **WHEN** `npm test` fails after the merges and the flaky-test
  re-run passes
- **THEN** the integrator proceeds to push and open the PR

#### Scenario: Tests fail twice → integrator fix attempt

- **WHEN** `npm test` fails on both the initial run and the
  flaky-test re-run
- **THEN** the integrator agent is re-prompted with the test
  failure output appended and gets one fix attempt

#### Scenario: Tests still fail after the fix → halt

- **WHEN** `npm test` fails on the post-fix re-run
- **THEN** the swarm halts with reason `integrator_fix_failed`

#### Scenario: Project has no test script

- **WHEN** the project's `package.json` has no `test` script
- **THEN** the runtime skips the test step
- **AND** the opened PR's body contains the line "Tests not run —
  no test script"

#### Scenario: `gh pr create` fails

- **WHEN** the integration branch has been pushed but
  `gh pr create` exits non-zero
- **THEN** the swarm halts with reason `pr_open_failed` and the
  banner instructs the user to open the PR manually

### Requirement: Mid-swarm base divergence is detected and halted
only when it overlaps swarm files

The app SHALL fetch the remote of the base branch at the start of
every wave and SHALL halt only when the remote has advanced AND any
of its new commits touch a file listed in any pending or running
sub-task's `filesHint`.

#### Scenario: Base unchanged

- **WHEN** the remote of the base branch matches the recorded
  `baseSha` at the start of a wave
- **THEN** the wave proceeds without notification

#### Scenario: Base advanced into unrelated files

- **WHEN** the remote has advanced but its new commits touch no
  file in any sub-task's `filesHint`
- **THEN** the runtime emits an info notice and proceeds with the
  wave

#### Scenario: Base advanced into swarm files

- **WHEN** the remote has advanced into at least one file present
  in any pending or running task's `filesHint`
- **THEN** the swarm halts with reason
  `base_diverged_into_swarm_files`
- **AND** the banner offers actions
  `[Rebase swarm onto new main] [Continue anyway] [Abort]`

#### Scenario: Rebase action

- **WHEN** the user picks `Rebase swarm onto new main`
- **THEN** the runtime runs `git rebase origin/<baseBranch>` inside
  each existing child branch worktree and the integration branch
  worktree

#### Scenario: Rebase conflict

- **WHEN** any rebase produces a conflict
- **THEN** the swarm halts with reason `rebase_conflict` and the
  user is expected to fix in the conflicting worktree before
  resuming

### Requirement: Halted swarms can be resumed or aborted

The app SHALL surface every halted swarm with a banner offering
`[Resume from here]` and `[Abort swarm]`, and SHALL re-evaluate
sub-task status on resume so that a user who manually committed
inside a sub-task's worktree advances that task to `succeeded`
without spawning a new attempt.

#### Scenario: Resume after user manually committed

- **WHEN** the user committed work inside a failed sub-task's
  worktree and then clicks `Resume from here`
- **THEN** the sub-task is marked `succeeded` on the next status
  re-evaluation
- **AND** the wave continues as if the retry had succeeded

#### Scenario: Resume after no manual progress

- **WHEN** the user clicks `Resume from here` and the failed
  sub-task has no new commits since halt
- **THEN** the sub-task is re-spawned with `attempts` reset to 0
- **AND** the runtime treats subsequent failures as a fresh retry
  budget

#### Scenario: Abort cleans up

- **WHEN** the user clicks `Abort swarm` on any halted swarm
- **THEN** the runtime kills every running sub-task PTY, removes
  every worktree the swarm created, deletes every branch with `-D`,
  and removes the `<userData>/swarms/<swarmId>.json` file

### Requirement: Worktree retention is tiered

The app SHALL remove sub-task worktrees when the next wave begins,
SHALL remove the integration worktree when the PR reaches a terminal
state (merged, closed, or stale > 14 days) as observed via
`pr-checks.ts`, and SHALL retain branches and the persisted
`SwarmPlan` JSON until the user explicitly forgets the swarm.

#### Scenario: Sub-task worktree removed on wave transition

- **WHEN** the runtime begins wave _N+1_ after wave _N_ succeeded
- **THEN** every wave _N_ sub-task worktree is removed
- **AND** the branches remain

#### Scenario: Integration worktree removed on PR close

- **WHEN** `pr-checks.ts` observes the swarm's PR moving to merged
  or closed
- **THEN** the integration worktree is removed
- **AND** the branches and the persisted plan remain

#### Scenario: Forget the swarm

- **WHEN** the user picks "Forget this swarm" in the sidebar group
  menu
- **THEN** all branches the swarm created are deleted with `-D` and
  the persisted plan file is removed

### Requirement: Persistence and crash recovery

The app SHALL persist each `SwarmPlan` atomically to
`<userData>/swarms/<swarmId>.json` and SHALL move every non-terminal
swarm to `halted` with reason `legion_crashed` on Legion startup.

#### Scenario: Atomic write on plan transition

- **WHEN** a swarm's status, any task's status, or any plan field
  changes
- **THEN** the corresponding JSON file is rewritten via write-to-
  temp + rename

#### Scenario: Crash recovery on startup

- **WHEN** Legion starts and any `<userData>/swarms/*.json` file
  has status in `{planning, reviewing, running, integrating}`
- **THEN** that file's status is mutated to `halted` with reason
  `legion_crashed` before the renderer subscribes to swarm IPC
- **AND** a single `SwarmHalted` message is queued for the
  renderer per recovered swarm

#### Scenario: Malformed file does not crash listing

- **WHEN** any `<userData>/swarms/*.json` file is malformed
- **THEN** the listing endpoint returns the parseable entries and
  silently ignores the malformed file
