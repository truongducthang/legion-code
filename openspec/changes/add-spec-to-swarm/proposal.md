# Add Spec to Swarm

## Why

Legion already runs multiple AI coding agents in parallel, each in its
own git worktree, but the dispatch model is one-task-at-a-time: the
user writes a prompt, picks a base branch, and a single agent works on
it. Multi-feature work ("add Stripe checkout with E2E tests and docs")
today becomes either one long-running agent doing five things in
series, or five separate task creations the user wires together by
hand and merges one PR at a time.

Legion's worktree infra is the missing piece nobody else has built on
top of. Cursor's background agents, Devin, Copilot CLI, and GitHub
Spark dispatch agents but do not isolate each unit of work in its own
git worktree, so parallel-with-clean-merge is genuinely natural here
in a way it is not in those products.

Spec → Swarm turns one short spec into a planner-driven multi-agent
run: a planner decomposes the spec into layered waves of parallel
sub-tasks, the user reviews the plan (or skips review via a fast-lane
checkbox), the sub-tasks run wave-by-wave with retry-once on failure,
and an integrator agent merges everything into a single PR. The user
goes from one spec input to one PR without managing branches or merges
by hand.

## What changes

- New keyboard shortcut `Ctrl+Shift+S` and sidebar footer entry point
  open a `SwarmDispatchDialog` for spec input.
- New planner that issues a direct LLM call (default
  `claude-sonnet-4-6`) to decompose the spec into layered waves of
  parallel sub-tasks, streaming JSON into a `PlanReviewDialog` the
  user can edit before approving.
- New `electron/swarm/` module containing the planner, the
  `SwarmRuntime` scheduler, the integrator wrapper, retry-once logic,
  and persistence. Sub-task spawns reuse the existing
  `createTask` + start-agent + initial-prompt-send path; no parallel
  task-creation code is introduced.
- New integrator step runs as a normal Legion task in a dedicated
  `swarm/<slug>/integration` worktree, merges each child branch with
  its own tools, runs the project's `npm test` script if present, and
  opens a single PR via the existing `gh pr create` pattern.
- Sidebar nests sub-tasks under a collapsible "Swarm: …" group with
  per-wave progress counts; sub-task panels are otherwise identical
  to ordinary task panels.
- Per-wave-completion cleanup of completed sub-task worktrees;
  integration worktree retained until the PR closes (detected via the
  existing `pr-checks.ts` watcher). Branches and the `SwarmPlan` JSON
  are retained until the user explicitly deletes the swarm.
- Crash recovery: on Legion startup, any swarm whose persisted status
  is non-terminal is moved to `halted` with reason
  `"legion_crashed"`; the user can `Resume` or `Abort` from the
  sidebar.

## Impact

- New capability `spec-to-swarm`.
- New module `electron/swarm/` parallel to `electron/telegram/` and
  `electron/remote/`. Split into `planner.ts`, `runtime.ts`,
  `integrator.ts`, `retry.ts`, `store.ts`, `prompts/` and `types.ts`.
- New IPC channels in `electron/ipc/channels.ts`: `SwarmPlan`,
  `SwarmPlanChunk`, `SwarmReplan`, `SwarmApprove`, `SwarmHalt`,
  `SwarmResume`, `SwarmAbort`, `SwarmGet`, `SwarmList`,
  `SwarmStatusUpdate`, `SwarmTaskUpdate`, `SwarmHalted`, `SwarmDone`.
- New persistence: per-swarm `SwarmPlan` JSON under
  `<userData>/swarms/<swarmId>.json`. No new files written inside the
  repo the user is dispatching against, beyond ordinary git branches
  and agent-authored commits.
- New Settings section "Swarm": planner model picker, wallclock cap
  per sub-task (default 30 min), integrator fix-attempt cap (default
  1), an opt-out for aggressive worktree cleanup.
- Reuses: `createTask` + agent-start + prompt-send path,
  `pr-checks.ts` for PR-close detection, `hung-agent.ts` for failure
  signals, `ask-code-minimax.ts`-style direct-LLM credential pattern.
