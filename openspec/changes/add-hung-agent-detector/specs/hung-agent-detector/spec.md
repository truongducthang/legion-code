# Hung-Agent Detector Specification

## ADDED Requirements

### Requirement: PTY tracks last-output timestamp

Every running agent PTY session SHALL carry a `lastDataAt`
millisecond timestamp that is updated on each `onData` event and
initialised to the spawn time. The timestamp is in-memory only and
is not persisted.

#### Scenario: Spawn initialises the timestamp

- **WHEN** a new agent PTY is spawned via `spawnAgent`
- **THEN** the session's `lastDataAt` is set to the current
  millisecond time

#### Scenario: Each data event updates the timestamp

- **WHEN** the PTY emits any `onData` event for a registered
  session
- **THEN** `lastDataAt` is overwritten with the current
  millisecond time before any subscriber is notified

#### Scenario: Exit does not clear the timestamp

- **WHEN** the PTY exits
- **THEN** the existing exit handler removes the session from
  the session map
- **AND** no separate cleanup of `lastDataAt` is needed

### Requirement: Classifier taxonomy

The classifier SHALL assign one of `active`, `idle`, or `hung` to
each running agent PTY on every tick, based on the elapsed time
since `lastDataAt` and the configured thresholds.

#### Scenario: Active agent

- **WHEN** `now - lastDataAt < idleThresholdMs`
- **THEN** the agent's status is `active`

#### Scenario: Idle agent

- **WHEN** `idleThresholdMs > 0` and
  `idleThresholdMs ≤ now - lastDataAt < hungThresholdMs`
- **THEN** the agent's status is `idle`

#### Scenario: Hung agent

- **WHEN** `hungThresholdMs > 0` and
  `now - lastDataAt ≥ hungThresholdMs`
- **THEN** the agent's status is `hung`

#### Scenario: Idle threshold disabled

- **WHEN** `idleThresholdMs === 0` and `hungThresholdMs > 0` and
  `now - lastDataAt ≥ hungThresholdMs`
- **THEN** the agent's status is `hung`
- **AND** no agent in this session is ever classified `idle`

#### Scenario: Detector entirely disabled

- **WHEN** `hungThresholdMs === 0`
- **THEN** every running agent is classified `active`
- **AND** no `HungAgentUpdate` with status `idle` or `hung` is
  emitted
- **AND** no notification is fired

#### Scenario: Shell sessions are not classified

- **WHEN** a PTY session has `isShell === true`
- **THEN** the classifier skips it
- **AND** no `HungAgentUpdate` is emitted for that session

#### Scenario: Exited sessions are not classified

- **WHEN** a PTY session's `proc.exitCode` is non-null on a tick
- **THEN** the classifier skips it

### Requirement: Tick cadence and transition pushes

The classifier SHALL run on a shared 30 s interval and push a
`HungAgentUpdate` to the renderer only when an agent's
classification differs from the previous tick's value for that
agent.

#### Scenario: Status unchanged across ticks

- **WHEN** an agent's classification is the same on two
  consecutive ticks
- **THEN** no `HungAgentUpdate` is pushed for that agent on the
  second tick

#### Scenario: Status changes

- **WHEN** an agent's classification on the current tick differs
  from the previous tick's value
- **THEN** a `HungAgentUpdate { agentId, status, lastDataAt,
silentMs, checkedAt }` is pushed on the window's webContents

#### Scenario: First tick after spawn

- **WHEN** an agent is observed by the classifier for the first
  time
- **THEN** the classifier records the current status without
  pushing an update
- **AND** treats every subsequent change as a transition

### Requirement: Notification on hung onset

The detector SHALL fire exactly one OS notification per
`(agentId, hungOnsetAt)` pair, where `hungOnsetAt` is the tick
on which the agent first crossed into `hung`. The dedupe key is
reset when the agent transitions back to `active` or when the
PTY exits.

#### Scenario: First crossing into hung

- **WHEN** an agent transitions from `active` or `idle` to `hung`
- **THEN** the detector calls `new Notification({ title, body
}).show()` with the task name and the silence duration
- **AND** records `(agentId, hungOnsetAt)` as notified

#### Scenario: Continued hung state does not re-notify

- **WHEN** an agent remains classified `hung` on subsequent ticks
- **THEN** no additional notification is fired

#### Scenario: Recovery resets the dedupe key

- **WHEN** an agent transitions from `hung` back to `active`
- **THEN** the `(agentId, hungOnsetAt)` notify record is cleared
- **AND** a subsequent transition to `hung` notifies again with
  its own `hungOnsetAt`

#### Scenario: Notifications API unavailable

- **WHEN** `Notification.isSupported()` returns false
- **THEN** the detector skips the notification call without
  throwing
- **AND** still pushes the `HungAgentUpdate`

#### Scenario: PTY exit clears the dedupe key

- **WHEN** the PTY for an agent exits
- **THEN** the per-agent dedupe record is dropped
- **AND** the per-agent previous-classification record is dropped

### Requirement: Window visibility gates the loop

The classifier SHALL pause its 30 s interval when the main
window is hidden or minimised and resume on show/restore,
running an immediate tick on resume. The classifier SHALL NOT
pause merely because the window lost focus.

#### Scenario: Window is hidden or minimised

- **WHEN** the main window emits `hide` or `minimize`
- **THEN** the classifier interval is cleared
- **AND** no further `HungAgentUpdate` is emitted until the
  window is shown again

#### Scenario: Window is shown or restored

- **WHEN** the main window emits `show` or `restore`
- **THEN** the classifier runs an immediate tick
- **AND** re-establishes the 30 s interval

#### Scenario: Window loses focus without hiding

- **WHEN** the main window emits `blur` while still visible
- **THEN** the interval continues
- **AND** notifications still fire on hung onset

### Requirement: Nudge action sends a single newline

The renderer SHALL be able to dispatch a `NudgeAgent` IPC call
that causes the main process to write exactly one `\r` to the
named agent's PTY. The handler MUST reuse the existing
`writeToAgent` write path and MUST NOT introduce a new write
path.

#### Scenario: Nudge a running agent

- **WHEN** the renderer sends `NudgeAgent { agentId }` for a
  running agent
- **THEN** the main process writes exactly `\r` to that agent's
  PTY via `writeToAgent`
- **AND** the resulting PTY output (if any) updates `lastDataAt`
  through the normal `onData` path

#### Scenario: Nudge a missing or exited agent

- **WHEN** the renderer sends `NudgeAgent` for an `agentId` that
  is not in the sessions map or whose `proc.exitCode` is non-null
- **THEN** the handler is a no-op
- **AND** no error is thrown to the renderer

### Requirement: Settings are configurable and validated

The thresholds `idleThresholdMs` and `hungThresholdMs` SHALL be
persisted user settings, read from the existing settings store
on every classifier tick, with defaults of 5 minutes and 15
minutes respectively.

#### Scenario: First-run defaults

- **WHEN** the settings store has no persisted hung-agent
  settings
- **THEN** the classifier uses
  `idleThresholdMs = 300_000` and
  `hungThresholdMs = 900_000`

#### Scenario: Get returns current values

- **WHEN** the renderer sends `GetHungAgentSettings`
- **THEN** the handler returns the currently effective
  `{ idleThresholdMs, hungThresholdMs }`

#### Scenario: Valid set persists

- **WHEN** the renderer sends `SetHungAgentSettings` with
  `idleThresholdMs` and `hungThresholdMs` that are integers in
  `[0, 86_400_000]` and where `hungThresholdMs ≥ idleThresholdMs`
  or `idleThresholdMs === 0`
- **THEN** the values are persisted
- **AND** the next classifier tick reads the new values

#### Scenario: Invalid set is rejected

- **WHEN** the renderer sends `SetHungAgentSettings` with
  values violating the constraints above (negative, non-integer,
  greater than 24 h, or `idleThresholdMs > hungThresholdMs > 0`)
- **THEN** the handler returns an error
- **AND** the persisted settings are unchanged

#### Scenario: Settings change takes effect on next tick

- **WHEN** `SetHungAgentSettings` succeeds while the classifier
  is running
- **THEN** the new values are applied on the next 30 s tick
- **AND** the classifier does not re-evaluate retroactively for
  past ticks

### Requirement: Renderer surface

The renderer SHALL surface the agent's classification on its
card and offer two actions when classification is `hung`. State
MUST NOT be persisted across restart.

#### Scenario: Idle hint

- **WHEN** an agent's latest status is `idle`
- **THEN** the card shows a low-emphasis "quiet" hint with a
  tooltip naming the silence duration

#### Scenario: Hung badge and actions

- **WHEN** an agent's latest status is `hung`
- **THEN** the card shows a warning badge with the silence
  duration
- **AND** exposes two actions: "Send a newline" and "Kill agent"

#### Scenario: Send a newline action

- **WHEN** the user activates the "Send a newline" action
- **THEN** the renderer sends `NudgeAgent { agentId }`
- **AND** does not optimistically clear the badge — the badge
  clears when the next classifier tick observes new output

#### Scenario: Kill agent action

- **WHEN** the user activates the "Kill agent" action
- **THEN** the renderer sends the existing `KillAgent` IPC for
  the agent
- **AND** the existing exit handler removes the agent

#### Scenario: State is not persisted

- **WHEN** the app restarts
- **THEN** the persisted store contains no hung-agent state
- **AND** classifications re-populate from `HungAgentUpdate`
  pushes once classifier ticks resume
