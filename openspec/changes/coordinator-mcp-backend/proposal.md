# Coordinator MCP Backend

## Why

Legion today only supports running a single Claude task at a time in a
given project. Power users want to run a "coordinator" Claude task that spawns
and manages a fleet of "sub-tasks" — each in its own worktree — and collects
their results autonomously. This requires a backend that exposes the task
lifecycle to the coordinator agent over MCP.

## What changes

### New capability: MCP orchestration server

When a task is started in coordinator mode, the Electron backend:

1. Starts an MCP server (stdio) that the coordinator Claude process connects
   to. The server exposes a fixed tool set: `create_task`, `list_tasks`,
   `get_task_status`, `get_task_diff`, `get_task_output`, `send_prompt`,
   `wait_for_idle`, `wait_for_signal_done`, `merge_task`, `close_task`,
   `review_and_merge_task`, and `signal_done` (sub-tasks only).

2. Writes a per-sub-task MCP config file (mode 0o600) to a temp directory and
   passes it explicitly via `--mcp-config` when spawning the sub-task agent.

3. Injects a preamble block into the agent's CLAUDE.md (or AGENTS.md /
   GEMINI.md / settings.local.json for other agents) instructing the sub-task
   to call `signal_done` when finished.

### REST API exposed on the existing remote server

All coordinator operations are reachable at `http://localhost:<port>/api/…`:

| Method | Path                          | Description                                |
| ------ | ----------------------------- | ------------------------------------------ |
| POST   | `/api/tasks`                  | Create a sub-task                          |
| GET    | `/api/tasks`                  | List sub-tasks                             |
| GET    | `/api/tasks/:id`              | Get sub-task status                        |
| POST   | `/api/tasks/:id/prompt`       | Send a prompt to a sub-task                |
| POST   | `/api/tasks/:id/wait`         | Block until sub-task is idle               |
| GET    | `/api/tasks/:id/diff`         | Get sub-task diff                          |
| GET    | `/api/tasks/:id/output`       | Get sub-task scrollback                    |
| POST   | `/api/tasks/:id/merge`        | Merge sub-task branch                      |
| POST   | `/api/tasks/:id/review-merge` | Diff + merge in one call                   |
| DELETE | `/api/tasks/:id`              | Close (cleanup) a sub-task                 |
| POST   | `/api/tasks/:id/done`         | Signal sub-task done (sub-task token only) |
| POST   | `/api/wait-signal`            | Block until any sub-task calls signal_done |

### Auth scoping (three token classes)

The existing remote server issues three distinct tokens per session:

- **coordinator** — full task-API access; MUST supply `X-Coordinator-Id`
  header on every request to enforce per-coordinator isolation.
- **subtask** — restricted to `POST /api/tasks/:id/done` with a matching
  `X-Done-Token` header (one per task, 24-byte random).
- **mobile** — read-only access to `/api/agents` only; cannot access
  coordinator task data.

A coordinator-token caller MUST NOT be able to create, list, or control tasks
owned by a different coordinator, even if it knows the other coordinator's ID.

### Signal / wait lifecycle

`wait_for_signal_done` blocks until any of the coordinator's sub-tasks calls
`signal_done`. Results are replay-cached by `requestId` so a dropped HTTP
response can be safely retried.

### Preamble injection / strip

On sub-task creation, a `<sub-task-mode>` block is atomically written into the
agent's preamble file. On merge or close, the block is stripped. The strip is
idempotent; if no block is present nothing is changed.

### IPC channels added

- `MCP_TaskCreated`, `MCP_TaskClosed`, `MCP_TaskCleanupFailed`
- `MCP_TaskStateSync`, `MCP_ControlChanged`
- `MCP_CoordinatorNotificationStaged`, `MCP_CoordinatorNotificationCleared`
- `MCP_CoordinatorOrphanedNotification`
- `MCP_CoordinatorRegistered`, `MCP_CoordinatorDeregistered`
- `MCP_HydrateCoordinatedTask`, `MCP_TaskHydrated`
- `MCP_CoordinatedTaskPromptDelivered`, `MCP_CoordinatorRestageAfterUserSend`
- `MCP_CoordinatedTaskClosed`, `MCP_CoordinatorNotificationAck`
- `MCP_CoordinatorNotificationDropAck`
- `StartMCPServer`, `StopMCPServer`, `GetMCPStatus`, `GetMCPLogs`

## Impact

- New capability: `coordinator-mcp-backend`
- Extends existing capability: `remote-access` (new token classes, new routes)
