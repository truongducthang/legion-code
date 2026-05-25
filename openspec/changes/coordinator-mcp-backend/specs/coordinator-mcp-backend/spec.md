# Coordinator MCP Backend Specification

## ADDED Requirements

### Requirement: Coordinator registration owns sub-task scope

The app SHALL register a coordinator task before exposing coordinator MCP tools,
and every sub-task created through those tools MUST be scoped to that
coordinator.

#### Scenario: Coordinator creates a sub-task

- **WHEN** a coordinator calls `create_task`
- **THEN** the app creates a child task owned by that coordinator task
- **AND** generates a per-task done token and MCP config path for that child
- **AND** starts the child agent with the generated MCP config

#### Scenario: Coordinator lists tasks

- **WHEN** a coordinator calls `list_tasks`
- **THEN** the response includes only child tasks owned by that coordinator
- **AND** tasks owned by other coordinators are omitted

### Requirement: Coordinator tokens are isolated by coordinator ID

The remote API SHALL require coordinator-token requests to identify the owning
coordinator and SHALL reject cross-coordinator access.

#### Scenario: Missing coordinator header

- **WHEN** a coordinator-token request reaches a coordinator task route without
  `X-Coordinator-Id`
- **THEN** the server responds with HTTP `401` or `403`
- **AND** no task data is returned or modified

#### Scenario: Coordinator ID does not own the target task

- **WHEN** a coordinator-token request names a task owned by a different
  coordinator
- **THEN** the server rejects the request
- **AND** the target task state is unchanged

### Requirement: Sub-task done tokens are task-local

The remote API SHALL allow `signal_done` only for the matching sub-task token
and SHALL NOT allow sub-task tokens to call coordinator control routes.

#### Scenario: Matching sub-task signals done

- **WHEN** `POST /api/tasks/:id/done` includes the matching bearer token and
  `X-Done-Token`
- **THEN** the server records the done signal for that task
- **AND** any matching `wait_for_signal_done` waiter can return that task result

#### Scenario: Sub-task token calls another route

- **WHEN** a sub-task token is used for any coordinator route other than that
  task's done endpoint
- **THEN** the server rejects the request
- **AND** no coordinator task data is returned

### Requirement: Signal wait results survive retries

The app SHALL replay completed `wait_for_signal_done` results by request ID so
coordinators can retry after a dropped response.

#### Scenario: Wait response is retried

- **WHEN** a coordinator calls `wait_for_signal_done` with a request ID that
  already completed
- **THEN** the app returns the cached done result for that request ID
- **AND** it does not consume a newer done signal

### Requirement: Orphaned coordinated tasks remain operable until closed

The app SHALL preserve child task MCP configuration and done metadata when a
coordinator is deregistered, and SHALL remove those files only when the child is
closed.

#### Scenario: Coordinator exits before child

- **WHEN** a coordinator is deregistered while one of its children is still live
- **THEN** the child is marked as orphaned
- **AND** its `mcpConfigPath` remains on the task record
- **AND** its done token remains valid for that child

#### Scenario: Orphaned child is closed

- **WHEN** an orphaned coordinated child task is closed
- **THEN** the app removes the per-task MCP config file for that child
- **AND** strips the injected sub-task preamble if present

### Requirement: Manual remote server cannot invalidate live coordinator tasks

The app SHALL keep manual remote-server rebinding from invalidating MCP URLs and
tokens already handed to coordinator or orphaned coordinated tasks.

#### Scenario: Manual remote start while coordinator tasks are live

- **WHEN** the renderer requests a manual remote-server start while coordinator
  or orphaned coordinated tasks exist
- **THEN** the app rejects the rebind
- **AND** the existing coordinator remote-server state remains unchanged

#### Scenario: Manual remote start without coordinator tasks

- **WHEN** the renderer requests a manual remote-server start and no
  coordinator-owned or orphaned coordinated tasks are live
- **THEN** the app starts the manual remote server
- **AND** the server is reachable by configured remote clients

### Requirement: Coordinator task metadata is persistent

The app SHALL persist coordinator metadata needed to restore task grouping and
coordinator state after restart.

#### Scenario: App reloads persisted coordinated tasks

- **WHEN** the task store is loaded after restart
- **THEN** coordinator global state and per-task coordinator fields are restored
- **AND** coordinated child tasks can be grouped with their parent coordinator

### Requirement: Sidebar grouping reflects coordinator relationships

The renderer SHALL group coordinated children under their coordinator when the
coordinator task is present, and SHALL still show orphaned coordinated children.

#### Scenario: Coordinator and children are present

- **WHEN** the sidebar computes task groups for a coordinator and its children
- **THEN** the children are returned as that coordinator's child tasks
- **AND** the children are not duplicated as top-level tasks

#### Scenario: Coordinator is absent

- **WHEN** the sidebar computes task groups for an orphaned coordinated child
- **THEN** the child remains visible as a top-level task

### Requirement: Coordinator review and auto-trust states are reflected

The task status layer SHALL mark coordinator review tasks as review-attention
states and SHALL auto-settle trust prompts for coordinated children that run
with skipped permissions.

#### Scenario: Coordinator review needs attention

- **WHEN** a task enters coordinator review state
- **THEN** task status reports the task as needing review attention

#### Scenario: Coordinated child runs with skipped permissions

- **WHEN** a coordinated child task starts with skipped permissions
- **THEN** the trust prompt is settled for that child without requiring global
  auto-trust to be enabled

### Requirement: Docker shared-auth preparation avoids synchronous JSON I/O

Docker shared-auth setup SHALL avoid synchronous Claude config reads and writes
on the spawn setup path.

#### Scenario: Claude shared auth is enabled

- **WHEN** a Docker-mode Claude agent is spawned with shared auth enabled
- **THEN** the app prepares the host auth directory and `.claude.json` before
  spawning the PTY
- **AND** it does not call synchronous file read or write APIs for the Claude
  trust JSON during that setup
- **AND** the spawned container receives a bind mount for the prepared
  `.claude.json` file
