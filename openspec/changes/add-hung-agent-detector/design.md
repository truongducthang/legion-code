# Design — Add Hung-Agent Detector

## Source of truth

The only signal needed is "when did the PTY last emit a chunk of
output". `electron/ipc/pty.ts` already routes every `onData` callback
through the session's `subscribers` set and ring-buffer scrollback;
the patch is to stamp `session.lastDataAt = Date.now()` once per
`onData` event, in the same callback that drives the scrollback
write.

No new event bus. No new subscription path. The classifier reads
the timestamp from the existing `sessions` map.

## Classification

Per running agent, three states:

- `active` — `now - lastDataAt < idleThresholdMs`.
- `idle` — `idleThresholdMs ≤ now - lastDataAt < hungThresholdMs`.
- `hung` — `now - lastDataAt ≥ hungThresholdMs`.

`active` and `idle` exist so the UI can show a soft "quiet" hint
before the loud "looks hung" badge. The thresholds are independent;
the only invariant enforced by validation is
`0 < idleThresholdMs ≤ hungThresholdMs`.

Setting either threshold to `0` disables the classifier for that
direction:

- `idleThresholdMs === 0` → no agent is ever classified `idle`;
  agents skip straight from `active` to `hung` once
  `hungThresholdMs` is reached.
- `hungThresholdMs === 0` → the detector is disabled entirely; no
  classifications above `active` are emitted, no notifications
  fire.

## Loop

One interval, owned by the main process, ticks every 30 s. On each
tick the loop walks the `sessions` map:

1. Skip sessions whose `proc.exitCode != null` — they're already
   exited and the existing exit event handles cleanup.
2. Skip shell sessions (`isSession.isShell === true`). The detector
   is for agent PTYs, not the user's own shell.
3. Compute the new classification from `lastDataAt`.
4. If the classification changed from the previous tick for that
   agent, push a `HungAgentUpdate` to the renderer.
5. On the specific `active → hung` or `idle → hung` transition,
   fire one OS notification, dedupe key `(agentId, hungOnsetAt)`.

The classifier owns its own previous-state map keyed by `agentId`;
that map is cleared on `pty exit` (via the existing
`onPtyEvent('exit', ...)` hook) so a re-spawn doesn't inherit a
stale `hung` state.

## Notification policy

- Fire once per `(agentId, hungOnsetAt)` pair, where `hungOnsetAt`
  is the tick on which the agent first crossed into `hung`.
- The body identifies the task by name and reports the silence
  duration ("Silent for 17 min").
- A subsequent re-classification back to `active` resets the
  dedupe key for that agent, so if it goes silent again it
  notifies again.
- `Notification.isSupported()` guard mirrors the existing
  `ShowNotification` handler.

## Nudge and kill from the renderer

Two actions on the badge:

- "Send a newline" → renderer fires `NudgeAgent { agentId }`. The
  handler writes a single `\r` to the agent's PTY via the existing
  `writeToAgent` helper. No new write path.
- "Kill agent" → renderer fires the existing `KillAgent` IPC. No
  new logic.

The newline is the smallest possible payload that makes a CLI
waiting on a prompt move on. We do not send arbitrary text;
anything more complex is the user's job in the existing input box.

## Settings

Two numeric fields, persisted in the existing settings store:

- `hungAgent.idleThresholdMs` — default `5 * 60 * 1000` (5 min).
- `hungAgent.hungThresholdMs` — default `15 * 60 * 1000` (15 min).

Both are validated on write:

- Must be integers ≥ 0.
- Either may be 0 (see above) but `hungThresholdMs` may not be
  strictly less than `idleThresholdMs` when `idleThresholdMs > 0`.
- Reasonable upper cap (e.g. 24 h) to avoid pathological values.

A settings change takes effect on the next tick — the classifier
re-reads from the settings store every tick rather than caching.

## Window visibility

Same rule as `add-pr-ci-status` and `add-conflict-preflight`:
clear the interval on `hide`/`minimize`, resume + immediate tick on
`show`/`restore`. `blur` does not pause — the whole point is to
ping a user who is in another app.

## Failure modes

- PTY exits between the timestamp read and the classification
  decision → the next tick skips it (exit code is set). No update
  is pushed; the agent's row in the renderer is updated by the
  existing exit handler.
- Notification API throws → swallow, log once at debug level.
- Settings store unreadable → defaults are used and a warn is
  logged; the detector still runs.

## What this does NOT do

- It does not attempt to detect "agent is making no useful
  progress". Output bursts trip the classifier back to `active`;
  a spinning agent that prints a heartbeat every 30 s is still
  `active`. Heuristic quality detection is out of scope.
- It does not auto-kill. Reclaiming the slot is the user's
  decision; the badge surfaces it.
- It does not introduce a new write path. Nudge is a single `\r`
  through the existing PTY write.
