# Add Background Daemon (Self-hosted Devin)

> **Status: parked exploration.** The detailed design lives in
> `design.md`. A `tasks.md` and capability spec under
> `specs/background-daemon/spec.md` will be added when this change is
> activated for implementation.

## Why

Legion already dispatches agents in parallel worktrees, but every
task today starts from a human keystroke in the GUI or a Telegram
`/prompt`. There is no path for unattended work — labelled issues
sitting on GitHub do not become Legion tasks until someone is at the
desktop to dispatch them.

The "self-hosted Devin" pitch is: a labelled GitHub issue on an
opted-in repo becomes a Legion task automatically — branch,
worktree, agent, push, draft PR, Telegram ping — without the desktop
UI being open. Same outcome as the paid background-coding products
(Devin, Cursor Background Agents), but on the user's own machine,
with the user's own API keys, free.

Legion is already close: the worktree creation path, the agent spawn,
the PR push, the hung-agent detector, the Telegram notifier, the
secret redactor, the audit log, the per-project opt-in safety model —
all the primitives the daemon needs already exist. What's missing is
the loop that watches a remote signal, the safety model that protects
against the failure modes specific to unattended work, and the
runtime mode that runs Electron without a window.

## What changes

- A new `electron/daemon/` module that runs as part of the existing
  Electron main process when launched with a `--daemon` flag or the
  `LEGION_DAEMON=1` environment variable. `createWindow()` is
  suppressed in daemon mode; the GUI may attach later.
- A new GitHub-issue poller that calls `gh issue list` against
  opted-in repos with label filters (`legion/auto-fix`,
  `legion/auto-implement`), throttled by `If-Modified-Since` and a
  per-repo poll interval.
- A new trigger pipeline that synthesises a sub-agent prompt from the
  issue title, body, and allow-listed-author comments, creates a
  branch named from the issue, spawns the agent in a worktree, waits
  for completion, pushes, opens a draft PR, and notifies the
  configured Telegram chat.
- A new safety model layered on top of the existing per-project
  Telegram opt-in: double opt-in (a repo-side `.legion/daemon.yml`
  AND a `state.json` `daemon.repos` entry must both agree), an
  issue-author allow-list, comment redaction before prompt synthesis,
  multi-axis budgets (runs/day, concurrency, wallclock, output bytes,
  files-changed, lines-changed), and a dry-run mode that opens PRs
  as draft only on first install.
- A new `legion daemon` CLI subcommand that uses
  `app.requestSingleInstanceLock` to either send an IPC message to a
  running Electron instance (turning on the daemon poll) or launch
  Electron with `--daemon` when nothing is running.

## Impact

- New capability `background-daemon`.
- New module `electron/daemon/` containing `index.ts`,
  `scheduler.ts`, `gh-poller.ts`, `trigger-pipeline.ts`,
  `budget.ts`, and shared types.
- New persisted state under the `daemon.*` namespace in `state.json`:
  `daemon.enabled`, `daemon.repos[]`, `daemon.budgets`, `daemon.runs`
  (rolling).
- New IPC channels under the `LegionDaemon*` family for GUI ↔ daemon
  configuration and status visibility.
- New CLI surface: `legion daemon start|stop|status`.
- Reuses: Telegram opt-in model and audit log,
  `electron/ipc/tasks.ts` for task creation, `electron/ipc/git.ts`
  for branch and push, `electron/ipc/pr-checks.ts` for PR-state
  observation, `electron/telegram/redact.ts` for the prompt-injection
  defence, the hung-agent detector for failure signals.
- Surface in the existing GUI: daemon-spawned tasks appear in the
  same task list and persistence as user-spawned tasks; a new
  "Daemon" badge marks them.
