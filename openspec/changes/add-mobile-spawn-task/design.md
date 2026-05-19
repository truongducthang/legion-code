# Design — Add Mobile Spawn Task

## Reuse over rebuild

The desktop already owns the only correct task-creation path: it knows
how to compute branch prefixes, set up the worktree, symlink gitignored
directories, register the task in persisted state, pick an agent preset,
spawn the agent in the worktree, and auto-send the initial prompt once
the PTY signals readiness. The mobile feature MUST call into that same
path. The remote server is a thin RPC over that path, not a fork.

Concretely, the new `spawn_task` handler in `electron/remote/server.ts`
asks the main process to perform the same sequence that the renderer's
`CreateTask` IPC plus `StartAgent` plus initial-prompt-send sequence
performs today. The handler is exposed to the server through callbacks
passed from `startRemoteServer(...)`, mirroring the
`getAgentStatus` / `getTaskName` pattern already in `register.ts:527`.

## Surface from the server

The server can answer two queries the phone needs:

- `list_projects` → returns the current set of project roots the
  desktop knows about, with their display name and default base branch.
- `list_branches { projectRoot }` → returns the set of local + remote
  branch names suitable for use as a base for a new worktree, with the
  currently-checked-out branch flagged.

These queries are best-effort snapshots, not subscriptions: the phone
re-asks when the user opens the new-task screen and again if they
switch projects. No push channel for project/branch changes is
introduced.

## Submit path

`spawn_task` carries:

```
{ type: 'spawn_task',
  requestId: string,
  projectRoot: string,
  baseBranch: string | null,
  agentId: string,        // agent preset id, e.g. 'claude-code'
  taskName: string,
  prompt: string }
```

- `requestId` is a client-chosen opaque string used to correlate
  `spawn_result` back to the originating submit. The server never
  interprets it.
- `projectRoot` MUST match one of the values currently returned by
  `list_projects`. Anything else is rejected without touching the
  filesystem. This is the only protection against a paired phone
  poking at arbitrary paths; the auth token already gates pairing.
- `baseBranch`, when present, MUST match one of the branches currently
  returned by `list_branches` for that project. `null` means "use the
  desktop's default for the project".
- `agentId` MUST match one of the agent presets the desktop has
  configured. Unknown presets are rejected.
- `taskName` is treated like the desktop's task name field: trimmed,
  non-empty, length-capped.
- `prompt` is length-capped (see Validation) and sent verbatim to the
  agent once it signals readiness; the desktop's existing
  prompt-readiness-delay logic applies unchanged.

`spawn_result` is the response:

```
{ type: 'spawn_result',
  requestId: string,
  ok: true,  taskId: string, agentId: string }
| { type: 'spawn_result',
  requestId: string,
  ok: false, error: 'invalid_project' | 'invalid_branch'
                  | 'invalid_agent'   | 'invalid_name'
                  | 'invalid_prompt'  | 'create_failed'
                  | 'spawn_failed',
  message: string }
```

On `ok: true` the server also pushes the standard `agents` list update
so any subscribed phone sees the new agent appear. The submitting
client then opens the existing detail view by `agentId` — no new
screen-routing protocol is needed.

## Validation

Validation runs in two places:

1. `parseClientMessage` rejects malformed shapes (missing fields,
   wrong types, oversized strings) before the message reaches the
   handler. The size caps mirror the existing `input` cap pattern:
   - `requestId` ≤ 100 chars
   - `projectRoot` ≤ 1024 chars
   - `baseBranch` ≤ 200 chars
   - `agentId` ≤ 100 chars
   - `taskName` ≤ 200 chars
   - `prompt` ≤ 16384 chars
2. The `spawn_task` handler then runs the same domain validators the
   desktop IPC handler uses (`validatePath`, `validateBranchName`,
   trimmed-non-empty name), and rejects with the typed `error` code
   above on failure.

The renderer validators in `electron/ipc/register.ts:323` are the
authoritative ones; the handler imports them rather than reimplementing.

## Auth & rate-limit

The new messages are gated by the same `authenticatedClients` check
already in `electron/remote/server.ts:304`. No new auth surface.

`spawn_task` is rate-limited per authenticated client to one in-flight
request at a time plus a 2 s minimum between successful spawns. This is
not a security boundary (the token is the boundary); it's a safety
floor so a sticky phone keyboard can't create a worktree storm. The
limit is enforced in the server handler, not in `parseClientMessage`.

## Failure modes

- `list_projects` returns an empty list → the new-task screen renders
  an empty state with a message ("Open a project on the desktop first")
  and the submit button stays disabled.
- `list_branches` fails (transient git error) → the screen renders the
  base-branch field as "use desktop default" only, and submit still
  works with `baseBranch: null`.
- `spawn_task` succeeds at task creation but the agent spawn fails →
  the desktop's existing behavior wins: the task still exists, the
  user can retry from desktop. The server returns
  `{ ok: true, taskId, agentId: '' }` with `agentId === ''` so the
  phone falls back to the agent list instead of trying to open a
  non-existent detail view. The persistent record is the desktop's
  problem; the phone is read-mostly from then on.
- The window is hidden when `spawn_task` arrives. Task creation does
  not depend on window visibility, so it proceeds normally and the
  push update goes out as usual.

## Out of scope

- No phone-side project file browsing. The phone can only pick from
  what the desktop already knows about.
- No phone-side worktree deletion or branch deletion. Phones can read
  and append; structural mutations stay on the desktop.
- No queueing on the desktop. If the user submits three tasks in
  quick succession they spawn three agents immediately — that's the
  point of parallel.
