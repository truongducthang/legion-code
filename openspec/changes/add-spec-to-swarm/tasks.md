# Tasks — Add Spec to Swarm

- [ ] Scaffold `electron/swarm/`:
  - `types.ts` exporting `SwarmPlan`, `SwarmWave`, `SwarmTask`
    interfaces matching `design.md`.
  - `prompts/planner.md`, `prompts/integrator.md`,
    `prompts/sub-task-suffix.md`, `prompts/retry-augment.md`.
  - `index.ts` exposing `registerSwarmIPC(callbacks)` that the main
    process calls from `electron/ipc/register.ts`.
- [ ] Extend `electron/ipc/channels.ts` with the new `Swarm*` enum
      keys listed in `design.md`. Mirror them into the preload
      allowlist in `electron/preload.cjs`.
- [ ] Extend `src/ipc/types.ts` with the payload shapes for the new
      channels.
- [ ] Build the planner (`electron/swarm/planner.ts`):
  - Direct Anthropic-SDK call streamed via the same credential path
    used by `electron/ipc/ask-code-minimax.ts`.
  - Repo-context gather: file tree (depth ≤ 3), `CLAUDE.md` if
    present, recent commit subject lines, base branch name.
  - Schema validator with `slug`, wave-count, task-count caps.
  - Re-prompt-once on schema failure.
  - Emit `SwarmPlanChunk` per partial-JSON delta.
- [ ] Unit tests in `electron/swarm/planner.test.ts`:
  - Streaming JSON assembled from chunks.
  - Markdown-wrapped JSON stripped.
  - Hard caps enforced.
  - Slug derivation handles unicode/whitespace/long input.
  - Second prompt receives the validation error in context.
- [ ] Build the runtime (`electron/swarm/runtime.ts`):
  - Wave-serial scheduler with explicit state machine for plan
    status transitions.
  - Branch + worktree creation per task via existing helpers.
  - `createTask` + start-agent + prompt-send for each task. The
    sub-task prompt is the planner's `prompt` field with the
    `sub-task-suffix.md` template appended.
  - Branch-HEAD poll loop (5 s) for success detection.
  - PTY idle tracker keyed off the existing data subscription.
  - Sentinel matcher for fast-path on `SWARM_TASK_DONE_<id>` and
    failure on `SWARM_TASK_FAILED_<id>`.
  - Per-wave cleanup of completed sub-task worktrees.
  - Mid-swarm rebase check at start of each wave.
- [ ] Unit tests in `electron/swarm/runtime.test.ts`:
  - Wave advances only after all sub-tasks succeed.
  - Halt blocks the next wave from spawning.
  - "agent says done but no commit" surfaces with three actions.
  - filesHint-overlap check classifies divergence correctly.
  - Crash recovery moves running swarms to halted on startup.
- [ ] Build the retry module (`electron/swarm/retry.ts`):
  - `shouldRetry(task)` predicate.
  - Augmented-prompt builder pulling diff stat + 3 KB PTY tail.
  - `git reset --hard <baseSha>` before respawn.
- [ ] Unit tests in `electron/swarm/retry.test.ts`:
  - Attempts increments correctly.
  - Augmented prompt includes all three fields.
  - Reset runs before respawn.
- [ ] Build the integrator (`electron/swarm/integrator.ts`):
  - Branch + worktree creation for `swarm/<slug>/integration`.
  - Spawn integrator task via existing helpers.
  - Watch integrator's branch HEAD + PTY idle the same way
    sub-tasks are watched.
  - Detect "merged_clean" vs "merged_with_fixes" by inspecting the
    commit log.
  - `npm test` heuristic with flaky-test re-run.
  - One fix attempt by re-prompting the integrator with the test
    failure output appended.
  - On success, push integration branch and call `gh pr create`
    with a generated body summarising the spec and child tasks.
- [ ] Unit tests in `electron/swarm/integrator.test.ts`:
  - Merge order matches plan order.
  - Flaky re-run path doesn't double-fix.
  - No `test` script → skipped test step + PR body note.
  - `gh pr create` failure halts with `pr_open_failed` but leaves
    the branch pushed.
- [ ] Build the store (`electron/swarm/store.ts`):
  - Atomic write under `<userData>/swarms/<swarmId>.json`.
  - List + get + delete.
  - Crash-recovery scan on startup.
- [ ] Unit tests in `electron/swarm/store.test.ts`:
  - Atomic write doesn't corrupt on simulated crash mid-write.
  - List ignores malformed files instead of crashing.
  - Recovery scan emits one `SwarmHalted` per non-terminal file.
- [ ] Integration test in `electron/swarm/integration.test.ts`:
  - Mock PTY + temp-dir git repo.
  - Scenario A — two-wave happy path with three sub-tasks → PR open.
  - Scenario B — wave 1 task #2 fails once → retry succeeds → PR.
  - Scenario C — wave 1 task #2 fails twice → halt, no wave 2.
  - Scenario D — two wave-1 tasks edit same line → integrator
    simulated to resolve → PR opens.
  - Scenario E — base advances between wave 1 and wave 2 into a
    file in `filesHint` → halt with rebase offer.
- [ ] Renderer wiring (`src/swarm/` new directory):
  - `SwarmDispatchDialog.tsx` with spec textarea + fast-lane
    checkbox + Plan button.
  - `PlanReviewDialog.tsx` rendering streamed chunks, with inline
    edit and Re-plan textarea.
  - Sidebar swarm group: collapsible header with wave-progress
    counts and chain icon, sub-task chips that drive focus into
    the existing task panel.
  - Halt banner on the swarm group.
  - Smart-default tiling: when a sub-task of an active wave gets
    focus, the tiled layout auto-arranges that wave's tasks.
  - `Ctrl+Shift+S` hotkey wiring.
- [ ] Settings — new "Swarm" section:
  - Planner model picker.
  - Wallclock cap per sub-task.
  - Aggressive-cleanup opt-out.
- [ ] Renderer-side tests:
  - Dispatch dialog disables Plan button until the spec is
    non-empty.
  - Plan review handles partial-JSON streams without flicker.
  - Sidebar group reflects status pushes within one frame.
- [ ] Documentation:
  - Update `README.md` "Features" list with Spec → Swarm one-liner
    and a link to the openspec change.
  - Add a short demo GIF (separately produced) to `screens/` and
    reference it in the README.
- [ ] Validation:
  - `openspec validate --strict add-spec-to-swarm`.
  - `npm run typecheck`.
  - `npm test`.
- [ ] After implementation lands, archive this change into
      `openspec/specs/spec-to-swarm/spec.md` per the OpenSpec
      workflow.
