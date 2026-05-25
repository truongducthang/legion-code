# Add Hung-Agent Detector

## Why

An agent that has stopped producing PTY output isn't always an agent
that has finished. Sometimes the CLI is waiting on a prompt the user
forgot about, sometimes a child process has wedged, sometimes the
network call the agent is making has hung. To Legion today
all three look identical: the PTY is "running", the agent card sits
quietly, and the slot is wasted until the user happens to click in
and notice nothing's happened in ten minutes.

For a user running multiple agents in parallel, this is the most
common reason a slot silently stops being useful. The desktop has
no visibility into "this agent has been silent for N minutes" even
though the data needed to compute that — the timestamp of the last
`onData` callback per PTY — is already in main process memory; we
just don't keep it.

The ask is for the app to notice prolonged silence per agent, mark
the agent on the card, and offer the user one click to either send
a wake nudge (a newline) or kill the session and reclaim the slot.

## What changes

- Each running PTY session gains a tracked `lastDataAt` timestamp
  that is updated on every `onData` event. The existing
  `subscribers` machinery is untouched.
- A shared per-window watcher classifies each running agent every
  30 s as `active`, `idle`, or `hung`, using a configurable
  threshold (default 5 min for `idle`, 15 min for `hung`).
- On a fresh transition to `hung` the agent card shows a warning
  affordance with two actions: "Send a newline" and "Kill agent".
- One OS notification fires per (agentId, hung-onset) pair, so a
  user in another app finds out without staring at the window.
- The thresholds are user-configurable in the existing settings
  surface, with sensible defaults; setting either threshold to 0
  disables the detector for new agents.

## Impact

- New capability `hung-agent-detector`.
- New IPC channels `HungAgentUpdate`, `NudgeAgent`,
  `GetHungAgentSettings`, `SetHungAgentSettings`.
- `PtySession` in `electron/ipc/pty.ts` gains a `lastDataAt: number`
  field; `onData` writes the timestamp.
- New main-process module `electron/ipc/hung-agent.ts` owns the
  classifier interval and the OS notification de-duping.
- A new persisted settings slice for the two thresholds, mirroring
  the existing settings store.
- One badge + action menu added to the existing agent card.
- No changes to PTY spawn, kill, or write paths beyond the
  timestamp write.
