# Design — Add Spec to Swarm

## Reuse over rebuild

Every primitive Spec → Swarm needs already exists in Legion:

- Creating a branch, setting up a worktree, symlinking gitignored
  directories, spawning an agent in that worktree, auto-sending an
  initial prompt — owned by the existing task-creation path.
- Detecting that an agent is stuck — `electron/ipc/hung-agent.ts`.
- Watching a PR for state changes — `electron/ipc/pr-checks.ts`.
- A direct LLM call from main with streaming —
  `electron/ipc/ask-code-minimax.ts` (Anthropic SDK path).
- A per-feature opt-in safety model with audit logs —
  `electron/telegram/*` (especially `audit.ts` and the project
  opt-in flag).

The swarm module composes these. It MUST NOT fork the task-creation
path, the worktree creation path, or the PR-watch path. The integrator
is itself a normal Legion task running in a worktree the swarm
created; it has no special privileges.

## Pipeline overview

```
SwarmDispatchDialog
   → planner (direct LLM, streams JSON)
   → PlanReviewDialog (skippable via fast-lane checkbox)
   → SwarmRuntime
         for each wave in plan:
            spawn N sub-tasks in N worktrees (reuse createTask)
            wait until each task succeeds or halts
         spawn integrator task in swarm/<slug>/integration worktree
   → integrator agent merges + tests + pushes
   → SwarmRuntime opens PR via existing gh path
   → SwarmDone broadcast
```

Wave-serial scheduling is intentional. No DAG, no within-wave
dependencies: the planner is told to group concurrently-executable
work into one wave and to push anything that depends on the result of
prior work into a later wave. The most realistic case (an E2E test
that depends on a route and a form) fits naturally as a two-wave plan.

## Planner

A direct LLM call from the main process, not a PTY-spawned agent.
Reasons:

- The planner output is a strict-typed JSON document that drives
  scheduler behavior. Parsing structured output from PTY scrollback
  is unreliable: agents wrap JSON in markdown, prepend prose, or trail
  with explanations. Direct API calls return a known shape.
- The planner is short-lived (one round-trip) so the PTY+xterm
  overhead is wasted setup.
- Streaming chunks into the review dialog gives the user a "plan is
  forming" experience the PTY path can't easily reproduce in a
  dialog.

Default model: `claude-sonnet-4-6`. The model picker in Settings can
override. If no SDK key is configured the planner falls back to
spawning a Claude Code-style PTY task with a structured-output prompt;
this slow-path is documented as suboptimal in the Settings tooltip.

The planner system prompt (in `electron/swarm/prompts/planner.md`)
specifies:

- The output format (JSON, validated against a Zod-equivalent
  TypeScript schema before being shown to the user).
- The decomposition contract: minimize cross-wave dependencies; group
  independent work into the same wave; never put two tasks in the
  same wave that the planner believes will edit the same file.
- The hard caps: at most 5 waves, at most 6 tasks per wave; if the
  spec cannot fit, the planner SHOULD return a single-task plan and
  explain in the task title that the spec was not splittable.
- Repo context to draw on: the file tree (depth ≤ 3), `CLAUDE.md` if
  present, the names of recently changed files for hints, the base
  branch name.

The planner output schema:

```ts
interface SwarmPlan {
  swarmId: string;              // ulid
  specInput: string;
  baseBranch: string;
  integrationBranch: string;    // 'swarm/<slug>/integration'
  slug: string;                 // kebab, ≤ 32 chars, derived from specInput
  waves: SwarmWave[];
  createdAt: number;
  status: 'planning' | 'reviewing' | 'running'
        | 'integrating' | 'done' | 'halted' | 'aborted';
}

interface SwarmWave {
  waveIndex: number;            // 0, 1, 2…
  tasks: SwarmTask[];
}

interface SwarmTask {
  id: string;                   // ulid
  title: string;
  prompt: string;               // sent verbatim to the sub-agent
  filesHint: string[];          // planner's guess; advisory, not enforced
  agentId?: string;             // override the user's default
  status: 'pending' | 'running' | 'succeeded'
        | 'failed' | 'retrying';
  attempts: number;             // 0 or 1; capped at 1 (max 2 tries)
  legionTaskId?: string;        // FK into the existing tasks table
  branchName?: string;          // 'swarm/<slug>/task-<6char>'
  worktreePath?: string;
  failureReason?: string;
}
```

The validator rejects: missing fields, oversized strings (any field
> 16 KB), wave count > 5, task count per wave > 6, slug not matching
`^[a-z0-9-]{1,32}$`. Validation runs before the JSON is shown to the
user; an invalid plan results in one automatic re-prompt of the
planner with the validation error as context, and a halt if the
second attempt also fails.

## Plan review

The `PlanReviewDialog` renders the streamed plan wave-by-wave, with
each task editable in place (title + prompt) and removable. Users may
add a task to any existing wave or to a new appended wave. The
"Re-plan" button opens a small textarea ("What should be different?")
and re-invokes the planner with the prior plan and the user feedback
as context; there is no cap on re-plans (cost self-regulates via the
LLM bill the user sees in their existing model dashboard).

The `Trust planner (skip review)` checkbox at the top of the dispatch
dialog short-circuits the review step: when checked, an approved plan
is sent into the runtime immediately after the planner returns. The
plan is still visible in the sidebar swarm group after dispatch so
the user can see what is running.

## Scheduler

`SwarmRuntime` (`electron/swarm/runtime.ts`) drives the wave loop:

1. Mark plan status `running`. Emit `SwarmStatusUpdate`.
2. For each wave in order:
   - Before spawning the wave, run the base-divergence check
     (Mid-swarm rebase, below). If it halts, stop.
   - Create branches `swarm/<slug>/task-<6char>` for each task from
     `baseBranch`. Create worktrees. Symlink gitignored dirs (reuse
     existing helpers).
   - Call `createTask` + start-agent + initial-prompt-send for each
     task. Record `legionTaskId` on each `SwarmTask`. Emit
     `SwarmTaskUpdate` with `status: 'running'`.
   - Wait until every task in the wave has terminal status
     (`succeeded` or `failed` after at most one retry). If any task
     ends up `failed`, halt the swarm — do not proceed to the next
     wave.
   - On wave success, clean up the worktrees of completed sub-tasks
     in the wave just finished (data is already on the branch).
3. After the final sub-task wave, spawn the integrator (below).
4. On integrator success: push the integration branch, open the PR
   (existing `gh pr create` flow), emit `SwarmDone` with the PR URL.

The runtime is wave-serial: there is never more than one wave's
sub-tasks running concurrently. Within a wave the spawns are fired
without backpressure; rate-limiting at the agent CLI layer is the
agents' responsibility.

## Success detection

A sub-task is `succeeded` when both:

1. `git rev-parse <branchName>` shows a commit not present on
   `baseSha` (the branch HEAD has moved beyond what the runtime
   recorded at branch creation), and
2. the PTY has emitted no new bytes for ≥ 30 s.

The runtime polls condition 1 every 5 s. Condition 2 is observed via
the existing PTY data subscription.

A fast-path: if the PTY emits the line `SWARM_TASK_DONE_<taskId>` on
its own, the runtime checks condition 1 immediately without waiting
for idle. If the line appears but no commit exists, the UI surfaces
`{ banner: 'agent_says_done_no_commit', actions: ['auto_commit',
'resume_agent', 'mark_failed'] }`. `auto_commit` runs
`git add -A && git commit -m '<task title>'` inside the worktree.

Why git, not the sentinel, is the primary signal: LLMs misformat
output. Trusting a magic string as the contract creates false
successes when the agent prints it inside a code block, garbled it,
or never printed it. The branch HEAD is the source of truth for "the
agent produced work."

The sub-task initial-prompt template (in
`electron/swarm/prompts/sub-task-suffix.md`) appends to the planner's
per-task prompt:

```
When you are done:
  1. Run: git add -A && git commit -m "<task title>"
  2. Print on its own line: SWARM_TASK_DONE_<taskId>
```

The sentinel is documented as a hint, not a contract.

## Failure detection

A sub-task is `failed` when any of:

- wallclock exceeds the cap (default 30 min, configurable in
  Settings),
- the hung-agent detector fires AND no new commit has appeared on the
  branch for 5 min,
- the PTY emits `SWARM_TASK_FAILED_<taskId>` on its own line,
- the user clicks "Mark failed" in the task panel.

On failure, the retry logic (next section) is consulted before the
sub-task is finalised as `failed`.

## Retry-once

`retry.shouldRetry(task)` returns true iff `task.attempts < 1`.

When retrying:

1. `tasks.kill(task.legionTaskId)`.
2. `git -C <worktreePath> reset --hard <baseSha>` to clear partial
   work; the partial state is captured in the retry prompt instead.
3. Build the augmented prompt:

   ```
   <original_prompt>
   ...
   </original_prompt>

   <previous_attempt failed="<reason>">
     diff_stat: <git diff --stat output from the failed attempt>
     pty_tail (last 3 KB):
     <ptyTail>
   </previous_attempt>
   ```

4. Spawn a new sub-agent in the same worktree with the augmented
   prompt. Increment `task.attempts` to 1.

If the retry also fails, the task is finalised as `failed`, the
swarm halts, and the failure surfaces in the UI banner.

## Integrator

After the last sub-task wave succeeds, the runtime:

1. Creates branch `swarm/<slug>/integration` from `baseBranch`.
2. Creates the worktree at `<projectRoot>-swarm-<slug>-integration`
   (existing worktree-path scheme).
3. Builds the integrator prompt from
   `electron/swarm/prompts/integrator.md` with the list of child
   branches, the original `specInput`, and the path to the worktree.
4. Spawns the integrator as a normal Legion task: same
   `createTask` + start-agent + prompt-send flow, only the icon in
   the sidebar is a chain link instead of the agent's normal icon.

The integrator agent runs, inside its worktree:

- `git merge swarm/<slug>/task-<id>` for each child branch in plan
  order.
- On conflict, it uses its own Read/Edit/Bash tools to resolve;
  Legion does not auto-resolve text conflicts.
- After all merges, it commits any resolution work and idles.

The runtime watches the integrator branch the same way it watches
sub-task branches (commit + idle). When the integrator branch is
ahead of `baseBranch` AND the integrator PTY is idle, the runtime
takes over the test step. The agent does NOT run tests; the runtime
does, so that exit codes are deterministic and the flaky-test buffer
can be applied without re-prompting the agent for each retry.

The runtime's test step:

1. Inspect `<integrationWorktreePath>/package.json`. If a `test`
   script exists, the test command is `npm test`. Otherwise the
   test step is skipped and the PR body records "Tests not run —
   no test script". Non-Node projects are out of scope for the
   MVP test step; the user can add a `test` script that wraps
   their actual command.
2. Spawn the test command via `child_process.spawn(...)` with
   `cwd: integrationWorktreePath`. Stream output into a status
   pane on the integrator task's panel (not into the integrator
   PTY) so the user can read it.
3. If exit 0 → push + PR.
4. If exit non-zero → re-run once (flaky-test buffer). If exit 0
   on the re-run → push + PR.
5. If exit non-zero twice → re-prompt the integrator with the
   failure output and the test command appended to its existing
   PTY input stream. This is the single fix attempt.
6. After the fix, when the integrator branch advances again AND
   the PTY idles again, the runtime re-runs the test command.
7. If exit 0 → push + PR.
8. If exit non-zero, run the flaky-test buffer once more. Still
   non-zero → halt with reason `integrator_fix_failed`.

## Halt and resume

Halt sources:

- A sub-task failed after retry.
- The integrator's fix attempt failed.
- The mid-swarm rebase check halted the swarm because the base
  diverged onto files in any pending task's `filesHint`.
- The user clicked "Halt" in the swarm overview.
- `gh pr create` failed (no auth) — special: branches are pushed
  if push succeeded but PR open failed; the halt banner tells the
  user to open the PR by hand.
- `git push` rejected — triggers the mid-swarm rebase flow against
  origin.
- The integrator agent itself hung.
- Legion crashed and was restarted (status moved to halted on
  startup).

Halt is observable: `SwarmHalted` is emitted with
`{ swarmId, reason, taskId?, waveIndex }`. The swarm group in the
sidebar shows a red banner with the reason and offers
`[Open task] [Resume from here] [Abort swarm]`. The PTY of any
running sub-task is left attached so the user can interact with it
manually.

`Resume from here` re-enters the runtime loop at the wave the halt
occurred in. The runtime re-evaluates each sub-task's status: if a
sub-task now has a commit on its branch that wasn't there at halt
time (user manually committed in its worktree), it is marked
`succeeded`. Otherwise the failed task is re-spawned with the
attempts counter reset to 0 (the user has clearly intervened, so the
retry budget is replenished).

`Abort swarm` runs the abort path: kill any running PTY, remove all
worktrees the swarm created, delete all branches with `-D`, remove
`<userData>/swarms/<swarmId>.json`, emit
`SwarmStatusUpdate { status: 'aborted' }`.

## Worktree retention

- Sub-task worktrees: removed when the next wave begins (their data
  is already merged into the integration branch's inputs via
  branches). If the wave halts, the worktrees stay for debugging.
- Integration worktree: kept until `pr-checks.ts` observes the PR
  reaching a terminal state (merged, closed, or stale > 14 days).
- Branches: kept until the user runs an explicit "Forget this
  swarm" action in the sidebar.
- `SwarmPlan` JSON: kept until the user forgets the swarm.

The retention can be globally overridden: a Settings flag
`swarm.keepAllWorktrees` retains every worktree until the user
forgets the swarm. This is documented as a debug option, off by
default.

## Mid-swarm rebase

At the start of every wave (and only there), the runtime fetches the
remote of `baseBranch` and compares `origin/<baseBranch>` to the
`baseSha` recorded at swarm creation.

- Equal → continue.
- `origin` is ahead but its new commits do not touch any file listed
  in any pending or running task's `filesHint` → emit an info notice
  and continue without rebasing.
- `origin` is ahead and its new commits touch files in `filesHint` →
  halt the swarm with reason `base_diverged_into_swarm_files`. The
  banner offers `[Rebase swarm onto new main] [Continue anyway]
  [Abort]`.

`Rebase swarm onto new main` runs `git rebase origin/<baseBranch>`
inside each existing child branch worktree and inside the integration
branch worktree. Any rebase conflict halts the swarm again with
`reason: rebase_conflict`; the user is then expected to fix in the
relevant worktree and resume.

The filesHint check is an optimisation, not a correctness guarantee:
if the planner missed a file (filesHint is advisory), the integrator
will surface the conflict at merge time, which is the fallback.

## Persistence

`<userData>/swarms/<swarmId>.json` carries the full `SwarmPlan`. The
store writes atomically (write-to-temp + rename) to match the
existing `electron/ipc/persistence.ts` pattern. Writes happen on:

- Plan approval (transition `reviewing` → `running`).
- Every task status transition.
- Wave transitions.
- Integrator transitions.
- Halt, resume, abort.

On Legion start, the store loads all files, finds any with status
in `{planning, reviewing, running, integrating}`, mutates them to
`halted` with reason `legion_crashed`, and emits one
`SwarmStatusUpdate` per recovered swarm before the renderer attaches.

## IPC contract

All channels added to the existing `IPC` enum in
`electron/ipc/channels.ts` and the preload allowlist in
`electron/preload.cjs`. Conforming to the existing convention
(snake_case strings, PascalCase enum keys, no namespace separator):

| Direction | Channel | Payload |
|---|---|---|
| R→M | `SwarmPlan` (`swarm_plan`) | `{ specInput, baseBranch, agentId?, trustPlanner }` → returns a `swarmId` and starts streaming chunks |
| M→R push | `SwarmPlanChunk` (`swarm_plan_chunk`) | `{ swarmId, partialJson }` |
| R→M | `SwarmReplan` (`swarm_replan`) | `{ swarmId, feedback }` |
| R→M | `SwarmApprove` (`swarm_approve`) | `{ swarmId, editedPlan? }` |
| R→M | `SwarmHalt` (`swarm_halt`) | `{ swarmId }` |
| R→M | `SwarmResume` (`swarm_resume`) | `{ swarmId }` |
| R→M | `SwarmAbort` (`swarm_abort`) | `{ swarmId }` |
| R→M | `SwarmGet` (`swarm_get`) | `{ swarmId }` → `SwarmPlan` |
| R→M | `SwarmList` (`swarm_list`) | `void` → `SwarmPlan[]` |
| M→R push | `SwarmStatusUpdate` (`swarm_status_update`) | `{ swarmId, status, currentWave? }` |
| M→R push | `SwarmTaskUpdate` (`swarm_task_update`) | `{ swarmId, taskId, status, failureReason?, attempts }` |
| M→R push | `SwarmHalted` (`swarm_halted`) | `{ swarmId, reason, taskId?, waveIndex }` |
| M→R push | `SwarmDone` (`swarm_done`) | `{ swarmId, prUrl, summary }` |

## Failure modes (recap)

| Trigger | Detection | Response |
|---|---|---|
| Planner returns invalid JSON | schema validator | One auto-re-prompt with the error; halt on second failure |
| Sub-task fails (any signal) | wallclock OR hung OR sentinel | Retry once; halt if retry also fails |
| Sub-agent commits work then idles | branch HEAD moved + 30 s idle | Marked `succeeded`, PTY killed |
| Sentinel printed, no commit | PTY match + branch HEAD unchanged | UI surfaces `[auto_commit] [resume_agent] [mark_failed]` |
| Two sub-tasks edit same line | integrator's `git merge` exits non-zero | Integrator agent resolves with its own tools |
| Tests red after merge | `npm test` exit code | Flaky re-run; if still red, one fix attempt by integrator; if still red, halt |
| Tests red after fix | as above | Halt with reason `integrator_fix_failed` |
| `git push` rejected | git exit code | Mid-swarm rebase flow against `origin` |
| `gh pr create` failed | gh exit code | Halt with reason `pr_open_failed`; branch is pushed |
| Integrator agent hung | hung-agent detector | Halt; no retry |
| Base diverged into swarm files | startup-of-wave check | Halt with reason `base_diverged_into_swarm_files` |
| Legion crashed | startup recovery | All non-terminal swarms moved to `halted` with reason `legion_crashed` |

## Out of scope

- Cross-swarm scheduling. A user dispatching three swarms in a row
  gets three concurrent runtimes; there is no global concurrency cap
  for the MVP. Settings can add one later if heavy use causes API
  rate-limit issues.
- Cost accounting and budgets. The planner and the agents bill to
  whatever account the user has configured; the swarm module does
  not track or cap tokens. A future "Swarm cost" Settings section
  is anticipated but not in this change.
- Cross-agent comparison ("which agent best handles this swarm").
  The user picks one agent at dispatch time; mixing agents within a
  single swarm is allowed via the planner's per-task `agentId`
  override, but no UX in the dispatch dialog surfaces that.
- Re-using prior swarm plans as templates. A future "Save plan"
  feature is anticipated; the persistence shape already supports
  this without schema changes.
- Public swarm sharing or community plan templates.
