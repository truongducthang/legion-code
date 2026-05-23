# Add Time-Travel Agent Debugger

> **Status: parked exploration.** The detailed design lives in
> `design.md`. A `tasks.md` and capability spec under
> `specs/time-travel-debugger/spec.md` will be added when this change
> is activated for implementation.

## Why

When an AI coding agent goes the wrong direction, the user today has
two bad options: (1) kill and restart, losing 10+ minutes of correct
early context — file reads, exploration, the half of the plan that
was right; (2) try to talk the agent back, sinking another N minutes
while the agent thrashes.

Legion already records steps to `.claude/steps.json` and buffers PTY
scrollback. The infrastructure to capture an agent's behavior is
half-built; it's not surfaced as a debugger. What's missing is a
**scrubbable timeline** of everything that happened during a task
(PTY output, tool calls, file edits) and a one-click **fork**
("rewind to this point, restore the worktree as it was, and try a
different prompt") that produces a new task branched from any moment
in the parent task's history.

This is a feature no other AI coding tool has built. LangSmith and
similar observability products are read-only log viewers; nobody has
made the agent timeline _interactive_.

## What changes

- A new always-on capture layer per task that emits a single canonical
  event stream (PTY bytes, tool calls when available, file writes,
  agent spawn/exit, fork markers) into per-task storage under
  `<userData>/timetravel/<projectId>/<taskId>/`.
- A new scrubbable timeline panel inside each task panel, with a
  bucketed SVG track coloured by event kind, debounced seek that
  returns a "state-at-T" frame (terminal replay, diff list, last tool
  call, last step), and a clickable "Fork from here" button.
- A new fork action that creates a new worktree + branch from a
  recorded snapshot, types the (optionally edited) prompt into the
  new agent's PTY, and records a `fork_marker` event in the parent
  timeline cross-linking the two.
- A capture kill-switch in Settings, ON by default, off for shell
  sessions.
- Three capture channels at decreasing fidelity, working for all
  supported agents at the floor level (PTY bytes + filesystem watch)
  and using Claude Code's `PreToolUse`/`PostToolUse`/`Stop` hooks when
  available for richer semantics.

## Impact

- New capability `time-travel-debugger`.
- New module tree `electron/ipc/timetravel/`.
- New IPC channels: `StartTimelineRecording`, `StopTimelineRecording`,
  `TimelineSummary`, `TimelineSeek`, `TimelineForkFrom`, plus push
  channels `TimelineEvent`, `TimelineEvictionNotice`.
- New storage path `<userData>/timetravel/<projectId>/<taskId>/`
  containing an NDJSON event log, zstd-framed PTY binary files, a
  per-task content-addressed store for file snapshots, and periodic
  tree manifests.
- New scrubbable timeline section inside `TaskPanel.tsx`, collapsible
  like the existing steps and changed-files sections.
- New Settings entry for the capture kill switch and the per-task
  storage cap.
- Reuses: the existing PTY subscriber bus in `electron/ipc/pty.ts`,
  the steps timestamp pattern in `electron/ipc/steps.ts`, the atomic
  persistence pattern in `electron/ipc/persistence.ts`, the existing
  worktree-creation flow for forks.
