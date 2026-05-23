# Design - Coordinator MCP Backend

## Runtime ownership

Coordinator mode is owned by the Electron main process. When a task starts in
coordinator mode, the main process registers it as a coordinator, starts or
reuses the local MCP/remote server, and passes the coordinator token and URL to
the agent through generated MCP configuration.

Sub-tasks are regular task records with additional coordinator metadata:

- an owning coordinator task link scopes them to the coordinator.
- `mcpConfigPath` points at the per-task MCP config file passed to the agent.
- `doneToken` authorizes only that task to call `signal_done`.
- `coordinatorParentTaskName` is retained for grouping and recovery.

Coordinator deregistration or app restart can orphan sub-tasks. Orphaning
removes only the live owner link. It deliberately keeps child config paths and
tokens until each child is closed, so already-running agents can still report
completion and cleanup can remove the exact files it created.

## Remote API and token scope

The coordinator MCP server uses the existing remote HTTP server instead of a
second listener. The server issues distinct coordinator, sub-task, and mobile
tokens. Coordinator routes require both a coordinator bearer token and
`X-Coordinator-Id`; all task queries are scoped to that coordinator. Sub-task
tokens only authorize `POST /api/tasks/:id/done` with the matching
`X-Done-Token`.

The manual remote-server start path remains separate from coordinator-owned
remote state. Manual starts run in remote-access mode and are rejected while
coordinator or orphaned coordinated tasks are live, because rebinding would
invalidate the MCP URL and tokens that running agents already received. MCP-only
server starts remain loopback-bound unless Docker mode requires host access.

## Agent launch and Docker auth

Sub-task creation spawns a normal PTY session with coordinator-specific launch
arguments. Docker mode mounts the coordinator worktree and, for coordinator
tasks, the parent worktree directory so children created later are visible
inside the container. Docker credential/auth setup prepares host-mounted agent
configuration with asynchronous filesystem calls before spawning the PTY,
keeping large JSON reads and writes off the synchronous Electron main-process
path.

## Store and renderer lifecycle

Coordinator task metadata is persisted with the task store so restart recovery
can restore parent-child relationships, task grouping, and review state. The
sidebar groups coordinated children under their coordinator when both are
present, and still surfaces orphaned children when the coordinator is gone.

Coordinator review tasks are treated as review-attention states in the task
status layer. Coordinated children that run with `skipPermissions` automatically
settle the trust prompt for that task, even when global auto-trust is disabled,
so coordinator-created work can proceed without an interactive prompt.

## Signal lifecycle

`wait_for_signal_done` blocks until one owned sub-task calls `signal_done`.
Results are replay-cached by request ID so a coordinator can retry after a
dropped response without losing the signal. Closing or merging a child strips
the injected preamble and removes the per-task MCP config file.
