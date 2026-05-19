# Add Mobile Spawn Task

## Why

The remote mobile view already authenticates over WebSocket, lists running
agents, and lets the user type into an agent's PTY. What it can't do is
start a new task — the phone is read/append only, not create. If a user
wants to dispatch a new agent while away from the desktop, they have to
walk back to the machine, open the app, and create the task there.

The mobile UI is the natural place to fire-and-forget short tasks
("rebase this branch", "draft a fix for issue 42") and to come back later
to watch the diff. Wiring the existing remote channel to the existing
`create_task` + auto-start-agent path closes that gap without inventing
a new transport or duplicating task-creation logic.

## What changes

- The remote view gains a "New task" entry point. The user picks a
  project, base branch, and agent preset, types a prompt, and submits.
- The desktop creates the worktree, spawns the agent, and auto-sends the
  prompt — the same path the desktop UI uses, not a parallel one.
- On success the server pushes the updated `agents` list and the new
  `agentId`; the mobile client opens the agent detail view automatically.
- Project and branch choices are derived from the desktop's current
  state. The phone never browses the filesystem and never names a path
  the desktop didn't already know about.

## Impact

- New capability `mobile-spawn-task`.
- New client → server messages `list_projects`, `list_branches`,
  `spawn_task` in `electron/remote/protocol.ts`.
- New server → client messages `projects`, `branches`, `spawn_result`.
- `electron/remote/server.ts` gains a single handler that calls into the
  existing main-process task-create + agent-start flow; no new
  task-creation code path.
- Renderer-only `src/remote/` gains a new task screen and ws helpers.
- No persisted state changes. No new IPC channels between main and
  renderer. The phone still authenticates with the same paired token.
