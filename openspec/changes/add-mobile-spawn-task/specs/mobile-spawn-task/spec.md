# Mobile Spawn Task Specification

## ADDED Requirements

### Requirement: Authenticated phones can query available projects

The remote server SHALL answer a `list_projects` query from any
authenticated client with the set of project roots the desktop is
currently tracking, so the phone can populate its project picker
without naming a path the desktop did not already know about.

#### Scenario: Authenticated client asks for projects

- **WHEN** an authenticated client sends `list_projects`
- **THEN** the server replies with `projects` containing one entry
  per desktop-tracked project root, each with `root`, `name`, and
  `defaultBaseBranch`

#### Scenario: Unauthenticated client asks for projects

- **WHEN** a client that has not completed `auth` sends
  `list_projects`
- **THEN** the server closes the socket with code `4001` and does
  not emit `projects`

#### Scenario: Desktop has no open projects

- **WHEN** an authenticated client sends `list_projects` and the
  desktop has no projects currently registered
- **THEN** the server replies with `projects` carrying an empty list

### Requirement: Authenticated phones can query base branches per project

The remote server SHALL answer a `list_branches` query for a given
`projectRoot` with the set of branches usable as a base for a new
worktree, including a flag for the desktop's currently checked-out
branch.

#### Scenario: Branches for a known project

- **WHEN** an authenticated client sends `list_branches` with a
  `projectRoot` that appears in the latest `projects` reply
- **THEN** the server replies with `branches` containing one entry
  per local branch, plus remote branches with no local counterpart,
  with the desktop's currently checked-out branch flagged
  `current: true`

#### Scenario: Branches for an unknown project

- **WHEN** an authenticated client sends `list_branches` with a
  `projectRoot` that is not in the latest `projects` reply
- **THEN** the server replies with `branches` carrying an empty list
- **AND** does not invoke any git command

#### Scenario: Git enumeration fails

- **WHEN** the underlying git call to enumerate branches fails
- **THEN** the server replies with `branches` carrying an empty list

### Requirement: Authenticated phones can spawn a new task

The remote server SHALL accept a `spawn_task` request from an
authenticated client and, on validation success, create a worktree,
spawn the configured agent in that worktree, and auto-send the
supplied prompt — using the same code path the desktop uses for
its own task creation.

#### Scenario: Valid spawn

- **WHEN** an authenticated client sends `spawn_task` with a
  `projectRoot` matching the latest `projects` reply, a `baseBranch`
  matching the latest `branches` reply for that project (or `null`),
  a known `agentId`, a non-empty trimmed `taskName`, and a non-empty
  `prompt`
- **THEN** the server creates a task and starts the agent via the
  desktop's own create-task path
- **AND** broadcasts an updated `agents` list including the new
  agent
- **AND** replies to the submitting client with
  `spawn_result { requestId, ok: true, taskId, agentId }`
- **AND** the prompt is auto-sent to the agent once the agent
  signals readiness, using the desktop's existing readiness logic

#### Scenario: Project is not in the desktop's project list

- **WHEN** the request's `projectRoot` is not in the latest
  `projects` reply
- **THEN** the server replies with
  `spawn_result { requestId, ok: false, error: 'invalid_project' }`
- **AND** does not create any worktree or write to disk
- **AND** does not broadcast an `agents` update

#### Scenario: Base branch is not in the project's branch list

- **WHEN** the request's `baseBranch` is non-null and is not in the
  latest `branches` reply for that project
- **THEN** the server replies with
  `spawn_result { requestId, ok: false, error: 'invalid_branch' }`
- **AND** does not create any worktree

#### Scenario: Agent preset is unknown

- **WHEN** the request's `agentId` does not match any configured
  agent preset
- **THEN** the server replies with
  `spawn_result { requestId, ok: false, error: 'invalid_agent' }`
- **AND** does not create any worktree

#### Scenario: Task name is empty after trimming

- **WHEN** `taskName.trim()` is empty
- **THEN** the server replies with
  `spawn_result { requestId, ok: false, error: 'invalid_name' }`

#### Scenario: Prompt is empty

- **WHEN** `prompt` is empty
- **THEN** the server replies with
  `spawn_result { requestId, ok: false, error: 'invalid_prompt' }`

#### Scenario: Worktree creation fails

- **WHEN** the underlying `createTask` call rejects
- **THEN** the server replies with
  `spawn_result { requestId, ok: false, error: 'create_failed',
message }` carrying the rejection message
- **AND** no agent is spawned

#### Scenario: Agent spawn fails after task is created

- **WHEN** task creation succeeds but starting the agent in the new
  worktree fails
- **THEN** the server replies with
  `spawn_result { requestId, ok: true, taskId, agentId: '' }`
- **AND** the task remains in the desktop's persisted state for the
  user to retry from the desktop

### Requirement: Phone-driven spawning is rate-limited per client

The server SHALL allow at most one in-flight `spawn_task` per
authenticated client and SHALL reject a second successful spawn
issued within 2 s of the previous successful spawn from the same
client.

#### Scenario: Second request arrives while the first is in flight

- **WHEN** a client sends `spawn_task` and immediately sends a
  second `spawn_task` before the first `spawn_result` is sent
- **THEN** the second request is rejected with
  `spawn_result { requestId, ok: false, error: 'spawn_failed',
message: 'busy' }`
- **AND** the first request still completes normally

#### Scenario: Burst within the 2 s floor

- **WHEN** a client sends two `spawn_task` requests with valid
  fields, the first succeeds, and the second is sent less than 2 s
  after the first `spawn_result`
- **THEN** the second is rejected with `spawn_failed` and message
  `'rate_limited'`
- **AND** no second worktree is created

### Requirement: Wire-format validation runs before any side effect

The remote server SHALL parse and validate every incoming message
shape before dispatching it, and SHALL silently drop messages that
exceed the documented size caps without closing the socket.

#### Scenario: Oversized prompt

- **WHEN** `parseClientMessage` receives a `spawn_task` with a
  `prompt` longer than 16384 characters
- **THEN** the parser returns `null`
- **AND** the server treats the message as ignored (no reply, no
  spawn, socket stays open)

#### Scenario: Missing required field

- **WHEN** `parseClientMessage` receives a `spawn_task` without
  `projectRoot`
- **THEN** the parser returns `null`
- **AND** no `spawn_result` is emitted

#### Scenario: Unknown message type

- **WHEN** a client sends a message whose `type` is not in the
  protocol enum
- **THEN** the parser returns `null`
- **AND** the server takes no action

### Requirement: Phone UI exposes spawning without inventing a new transport

The remote client SHALL provide a "New task" screen reached from the
agent list, MUST submit only via the `spawn_task` protocol message,
and MUST NOT expose any filesystem path other than those returned
by `list_projects`.

#### Scenario: Opening the new-task screen

- **WHEN** the user activates the "New task" entry in the agent
  list
- **THEN** the client sends `list_projects`
- **AND** renders a screen with a project picker pre-populated from
  the reply

#### Scenario: Project selection triggers branch query

- **WHEN** the user picks a project from the new-task screen
- **THEN** the client sends `list_branches` for that project's
  `root`
- **AND** renders the base-branch field from the reply, defaulting
  the selection to the `current: true` branch when one exists, or
  to "use desktop default" when none exists

#### Scenario: Submit while a spawn is in flight

- **WHEN** the user taps Submit and the client is awaiting a
  `spawn_result` for a previous submit
- **THEN** the new submit is ignored
- **AND** the Submit button remains disabled

#### Scenario: Successful spawn opens the new agent

- **WHEN** the client receives `spawn_result { ok: true, agentId }`
  for its own `requestId` with a non-empty `agentId`
- **THEN** the client navigates to the existing agent detail view
  for `agentId`

#### Scenario: Successful task creation but agent failed to start

- **WHEN** the client receives `spawn_result { ok: true, agentId: '' }`
- **THEN** the client navigates back to the agent list and surfaces
  a non-blocking message indicating the task was created on the
  desktop but the agent did not start

#### Scenario: Rejected spawn keeps the user on the form

- **WHEN** the client receives `spawn_result { ok: false, error,
message }`
- **THEN** the client keeps the user on the new-task screen with
  the entered values preserved
- **AND** displays a human-readable message derived from `error`
  and `message`
