# Time-Travel Agent Debugger — Design

Status: design draft
Date: 2026-05-20
Owners: Legion core

> This is an exploratory design doc under `docs/superpowers/specs/`. It is NOT
> a capability spec under `openspec/specs/`. If/when we decide to ship, a
> formal OpenSpec change (`openspec/changes/add-time-travel-debugger/`) will
> be raised and the spec deltas archived into `openspec/specs/time-travel/`.

---

## 1. Problem & success criteria

When an agent goes the wrong direction, today the user has two bad options:

1. **Kill + restart**: loses 10 minutes of correct early context (file reads,
   exploration, the half of the plan that was right).
2. **Try to talk the agent back**: wastes another N minutes while the agent
   thrashes; sunk-cost loop.

We want a **scrubbable timeline** of everything that happened during a task
(PTY output, tool calls, file edits) and a one-click **fork**: "rewind to
this point, restore the worktree as it was, and try a different prompt."

### Success criteria (concrete, testable)

1. **Capture overhead**: < 3 % CPU steady-state on a 6-core machine while a
   single Claude Code agent is running at full throttle. Measured by spawning
   a noisy `yes`-equivalent inside the agent's PTY and comparing
   `process.cpuUsage()` of the main process with the recorder enabled vs.
   disabled across a 60-second window.
2. **Scrub latency**: dragging the timeline scrubber across an entire 1-hour
   session feeds new "state-at-T" frames at ≥ 30 fps (≤ 33 ms per frame),
   without re-reading any event from disk twice. Measured by playing the
   timeline of a fixture session end-to-end in a Vitest integration test.
3. **Fork latency**: from "user clicks Fork at T" to "new agent PTY is alive
   in a forked worktree with the worktree contents restored to T-state and
   the edited prompt typed into stdin": **< 2 s p95** on a repo whose
   tracked content is ≤ 200 MB. Measured by a synthetic fork test that
   stubs the agent CLI with `cat`.
4. **Storage budget**: ≤ 200 MB / hour of recorded session for a typical
   Claude Code session (mostly text, some file writes ≤ 1 MB each). Sessions
   that exceed the per-task cap evict their oldest snapshot tier first.
5. **Crash-safety**: an Electron crash mid-record must not corrupt a prior
   completed session, and the in-flight session must be replayable up to
   the last fsynced event boundary.

### Explicit non-goals

- Recording network traffic from the agent's HTTP calls to Anthropic / OpenAI.
- Bit-for-bit replay of the agent's RNG (impossible without runtime
  cooperation).
- Time-travel across multiple worktrees in the same view (each task is its
  own timeline).
- Distributed / shared timelines (single-machine feature).

---

## 2. What is "an event"?

The capture layer emits a single canonical stream per task. One event type,
many `kind` variants. Each event has a stable, monotonic `seq` number and a
host-clock `ts` (ms since epoch, same clock the steps tracker uses — see
`electron/ipc/steps.ts:applyTimestamps`).

```ts
// Lives in electron/ipc/timetravel/types.ts
export type TimelineEventKind =
  | 'pty_out'       // raw bytes the agent printed (base64)
  | 'pty_in'        // bytes the user typed into the PTY (base64)
  | 'tool_call'     // structured (Claude Code hook only)
  | 'tool_result'   // structured (Claude Code hook only)
  | 'file_write'    // synthetic: a file changed on disk
  | 'file_read'     // structured (Claude Code hook only) — best-effort
  | 'step'          // mirror of an existing steps.json append
  | 'snapshot'      // pointer to a worktree snapshot (see §4)
  | 'agent_spawn'   // agent process started / resumed
  | 'agent_exit'    // agent process exited
  | 'fork_marker';  // recorded into the *parent* timeline when a fork is made

export interface TimelineEvent {
  seq: number;        // monotonic per task; never reset
  ts: number;         // Date.now() at capture
  kind: TimelineEventKind;
  payload: unknown;   // schema depends on kind, validated on read
  // Optional pointer back into the byte stream for pty_out: which byte
  // offset of the scrollback recording does this event correspond to?
  // Used so a scrub can "rewind the terminal" to the same visual state.
  byteOffset?: number;
}
```

Per-`kind` payload shapes are defined in §7 (IPC contract).

---

## 3. Capture layer

Capture is **always-on per task** (no opt-in toggle for v1: the steps-tracking
pattern showed that opt-in features are forgotten and then someone wants the
data they didn't record). It is **off by default for shell sessions**
(`isShell === true` in `pty.ts`) — those are the user's own typing and
recording them would surprise people.

There is a **kill switch** in Settings → "Record agent sessions for
time-travel" (default ON). Symmetric with the Telegram opt-in pattern in
`telegram.optIn` — flagged per-project later if demand exists.

### 3.1 Three capture channels, decreasing fidelity

| Channel | Source | Granularity | Works for |
|---|---|---|---|
| **A. Structured hooks** | Claude Code `PreToolUse` / `PostToolUse` / `Stop` settings hooks | Per-tool-call | `claude-code` only |
| **B. PTY byte stream** | Existing `proc.onData` in `electron/ipc/pty.ts` | Per-flush (~8 ms or 64 KB) | All five agents |
| **C. Filesystem watch** | `chokidar` (or `fs.watch` if size allows) on the worktree | Per-file-write (debounced 200 ms, same as steps) | All five agents |

Channel B is the floor: even for Codex/Gemini/OpenCode/Copilot — which expose
no hook surface — we always have the PTY bytes and we always have the
filesystem watcher. Channel A is gravy when it's available: it gives us
*semantic* labels ("ran Edit on src/foo.ts") that the UI can show as
clickable rows instead of opaque blobs.

**Assumption**: Claude Code's settings-hook mechanism stays stable. If it
breaks, we lose semantic labels but the debugger still works on channels B+C.
The test plan (§9) includes a smoke test that runs without channel A.

### 3.2 Hooking the PTY (channel B)

`spawnAgent` in `electron/ipc/pty.ts` already maintains a `RingBuffer` and a
broadcast (`subscribers`). We add **one more subscriber per session**: the
timeline recorder. No changes to the existing flush path — we tap the same
batched chunks (`batchChunks` after the `flush()` in `proc.onData`) so we
match exactly what the renderer sees.

```ts
// Inside spawnAgent, just after `session.subscribers = new Set()`
if (shouldRecord(session)) {
  startTimelineRecording(session); // attaches a subscriber + chokidar watcher
}
```

`shouldRecord(session)` returns false for `isShell`, when the user has
disabled recording in Settings, and when the task is older than
`store.timetravel.retentionDays` (rolling deletion — see §4.4).

For `pty_in` we add a hook inside `writeToAgent` — a one-line append that
forwards the same data to the recorder. Same code path the existing
`session.proc.write(data)` already exercises.

### 3.3 Hooking Claude Code's settings hooks (channel A)

Claude Code reads settings from `<worktree>/.claude/settings.json` (already
seeded by `ensureClaudeSandboxFiles` in `git.ts`). We extend that seed to
include a `hooks` block:

```jsonc
// .claude/settings.json — additions only
{
  "hooks": {
    "PreToolUse":  [ { "command": "node <legionResources>/hooks/preToolUse.js" } ],
    "PostToolUse": [ { "command": "node <legionResources>/hooks/postToolUse.js" } ],
    "Stop":        [ { "command": "node <legionResources>/hooks/stopHook.js" } ]
  }
}
```

The hook scripts ship as resources (similar to `docker/Dockerfile`,
`build/icon.png` — see `package.json#build.extraResources`). They are
tiny — each reads its JSON payload from stdin, appends one line to
`<worktree>/.claude/timeline.ndjson`, and exits. They MUST NOT call back into
Electron (the agent process may not have network access to it, and the hook
must be fast — Claude blocks the tool call until the PreToolUse hook exits).

The recorder (in main) watches `timeline.ndjson` with `chokidar`, the same
way `steps.ts` watches `steps.json`, and forwards each new line as a
`tool_call` / `tool_result` / `step` event into the unified stream.

**Why an on-disk hop and not a socket?** Three reasons:
1. Symmetric with `.claude/steps.json` — proven pattern, same watcher
   plumbing.
2. Survives Docker mode: a hook running inside the container can write to a
   bind-mounted path (the worktree is already mounted at the same path).
3. Survives Electron restart: the hook never knows Legion is running.

### 3.4 Filesystem watch (channel C)

A single `chokidar.watch(worktreePath, { ignoreInitial: true, ignored: [...] })`
per task. Ignored patterns:

- `.git/**` (worktree internals)
- `.claude/steps.json`, `.claude/timeline.ndjson` (we already emit events
  for these through their dedicated paths)
- `.legion/**` (our own state)
- `node_modules/**`, `dist/**`, `build/**`, anything matched by the repo's
  `.gitignore`. We parse `.gitignore` with the existing `ignore` heuristic
  from `git.ts` (if needed we add a tiny dep; preference is to reuse
  `git check-ignore` since it's already a hot path here).

For each `add` / `change` / `unlink` event we record:

```ts
// kind: 'file_write'
{
  path: 'src/foo.ts',          // worktree-relative
  op: 'change',                // 'add' | 'change' | 'unlink'
  size: 1234,                  // post-change file size, or 0 for unlink
  contentSha: '…hex…',         // sha-256 of the post-change content; we
                                // store the *content* once in CAS (§4)
  contentRef: 'cas/sha256/ab…' // pointer into the per-task CAS directory
}
```

**Important**: the file *content* isn't in the event payload; only its hash
and a CAS pointer. Repeated writes of the same content are free. This is
how we make scrub-to-diff cheap (§5) and how we keep storage in check (§4).

---

## 4. Storage model

### 4.1 On-disk layout

```
<userData>/timetravel/
└── <projectId>/
    └── <taskId>/
        ├── meta.json              # version, taskId, createdAt, lastSeq, sizeBytes
        ├── events/
        │   ├── 000000.ndjson      # 5 MB max per file, rotated by seq range
        │   ├── 000001.ndjson
        │   └── …
        ├── pty/
        │   ├── 000000.bin         # raw PTY bytes (utf-8 / xterm escape), zstd-framed
        │   └── …
        ├── cas/                   # content-addressed file snapshots
        │   └── sha256/ab/cd/ab cd…   # one zstd-compressed file per content
        └── snapshots/             # coarse worktree snapshots (see §4.3)
            ├── manifest.ndjson    # one row per snapshot: { seq, ts, tree }
            └── trees/
                └── <sha>.json     # { path: contentSha, … } for the whole tracked tree
```

`<userData>` is `app.getPath('userData')` — same root as
`electron/ipc/persistence.ts`. In dev we suffix `-dev`, same convention as
that file (line 8). All writes are atomic-rename via `.tmp` exactly like
`saveAppState`, so a crash mid-write never corrupts the previous good file.

### 4.2 Why three layers (events / pty / cas)?

- **events** is the source of truth: a strictly ordered log. NDJSON because
  it's append-only, streamable, and survives partial writes (last line
  truncated → drop on read, same as steps.ts tolerates).
- **pty** stores the raw bytes separately because they're hot and big. The
  event row for a `pty_out` only carries `{ byteOffset, length }`, not the
  bytes themselves — we mmap the corresponding `pty/NNNNNN.bin` for
  scrub-to-terminal-state.
- **cas** holds the actual file content. Deduplication is free (same hash =
  same file). This is what makes "diff at any T" cheap (§5).

### 4.3 Coarse snapshots

Every `N` events OR every `M` seconds (whichever first), we materialise a
**tree snapshot**: a JSON map `{worktreeRelPath: contentSha}` of every
tracked, non-ignored file. This is the equivalent of `git write-tree` but
content-addressed against our own CAS, not git's object store, because:

- We don't want to pollute the user's `.git` with thousands of debug commits.
- We need snapshots of *uncommitted* state at high frequency without git
  add/commit overhead.
- The CAS already exists for file_write events; trees are basically free.

`N = 200 events` and `M = 30 s` are the v1 defaults. Snapshots are the
anchors a scrub seeks to; events between snapshots are replayed forward
from the nearest preceding snapshot.

**Initial snapshot**: the moment a task spawns its first agent, we record
snapshot 0 of the worktree contents. That's the "before anything happened"
state and the implicit fork target for "start over."

### 4.4 Retention & size budget

Three-tier eviction, all configurable in Settings:

1. **Per-task cap** (default 500 MB). When exceeded, drop oldest PTY
   bin-files until under cap. Events and CAS stay (events are cheap, CAS
   is shared). PTY bytes are the only thing that bloats meaningfully.
2. **Per-project cap** (default 5 GB). Drops oldest *whole task* timelines
   first.
3. **Age cap** (default 30 days). Whole-task timelines older than this are
   evicted on app start.

On task delete (`deleteTask` in `electron/ipc/tasks.ts`) we delete the
timeline directory async — fire-and-forget; if it fails the next start-up
sweeper picks it up.

### 4.5 Compression

PTY bin files: zstd level 3, framed every 64 KB so we can mmap-seek without
decompressing the whole file. CAS files: zstd level 9, since they're written
once and read on every diff. Events NDJSON: no compression in v1 — they're
small (typical row ≤ 256 bytes) and we want grep-ability during incident
triage. Move to a periodic compaction (oldest 10 MB → `.ndjson.zst`) if
size becomes a problem.

We bundle `@mongodb-js/zstd` or `fzstd` (depending on Electron-builder
binary compatibility). **Assumption**: a pure-JS zstd at 50–100 MB/s is
acceptable since recording is bursty; if profiling shows otherwise we
switch to native.

---

## 5. Replay & UI

### 5.1 Where it lives

A new **collapsible panel** inside `TaskPanel.tsx`, sibling to
`TaskAITerminal` and `TaskStepsSection`. Default-collapsed (28 px header);
expands to 220 px when the user clicks **"Timeline"**, same sizing pattern
as the steps panel (§ openspec/specs/steps-tracking).

Focus-mode integration: the timeline panel is **hidden** in focus mode
(focus is for the one task you're driving forward, not for spelunking
history). The user can still trigger fork-from-now via the existing
keyboard binding (§5.4).

### 5.2 Scrubber

```
[●━━━━━━━━━━━━━━○━━━━━━━━━]   00:42:13 / 01:17:05
 ↑ playhead     ↑ hover preview
```

Rendered as an SVG track over the event range. Events are bucketed into
**~600 horizontal pixels** so a 1-hour session shows one bucket per ~6
seconds. Each bucket is colored by its dominant `kind`:

- gray: `pty_out` only (idle agent chatter)
- blue: `tool_call`
- green: `file_write`
- yellow: `step` (awaiting_review etc.)
- red: `agent_exit` with non-zero code
- purple: `fork_marker`

Drag-scrub fires a debounced `agent:timeline-seek` IPC at 16 ms; the main
process responds with a `StateAtT` payload:

```ts
interface StateAtT {
  taskId: string;
  seq: number;
  ts: number;
  // Terminal scrollback up to T, base64-encoded (re-using the PTY ring's
  // toBase64 format so xterm can write() it directly).
  ptyReplay: string;
  // List of files that differ between snapshot-0 and this point, with their
  // diff body inlined OR a CAS pointer for large diffs.
  diff: Array<{ path: string; before: string | null; after: string | null }>;
  // The semantic step the agent was "in" at T, if known.
  step: StepEntry | null;
  // The most recent tool call at T (for the right-side detail pane).
  lastToolCall: ToolCallPayload | null;
}
```

The renderer pipes `ptyReplay` into a **headless xterm** (re-using the
existing `TerminalView` component, but in "replay" mode: no PTY backing, no
input). Diff list reuses `MonacoDiffEditor`. Tool-call detail reuses the
markdown/shiki rendering already used by plan/steps.

### 5.3 Granularity controls

A small toolbar above the scrubber:

- **Per-tool-call** (default when channel A is on): only events with
  `kind ∈ {tool_call, step, file_write, agent_exit, fork_marker}` are
  scrub anchors. PTY chatter is hidden from the seek but still visible
  in the replayed terminal.
- **Per-second**: every event is an anchor.
- **All events**: scrub one event at a time (keyboard `[` / `]`).

### 5.4 Fork UI

A "Fork from here" button next to the playhead. Clicking it opens a
`Dialog.tsx` with:

- The current diff at T against snapshot-0 (read-only Monaco).
- The last user prompt that was *pending* at T (auto-extracted from
  `pty_in` events since the previous `step.status === 'awaiting_review'`
  or `tool_result`).
- A **textarea** pre-filled with that prompt, editable.
- A **branch-name** field, pre-filled with
  `<originalBranch>-fork-<seq>`.
- A **base** selector (default: snapshot-0; alternative: snapshot-K of any
  earlier point — for forking from a fork).
- Buttons: **Fork** / **Cancel**.

Keyboard: `Shift+F` triggers fork-at-playhead.

---

## 6. Fork semantics

This is the trickiest part of the whole feature. Mechanics:

### 6.1 What restores

1. **Worktree contents** are restored to the state at seq `T`. We do NOT use
   `git reset` because the recorder doesn't commit. Instead:
   - Compute the closest snapshot ≤ T from `snapshots/manifest.ndjson`.
   - Walk forward from that snapshot replaying every `file_write` event up
     to and including T, building the final `{path → contentSha}` tree
     in-memory.
   - In a **new** worktree (see §6.2), write each file from its CAS blob.
     Files present in snapshot-0 but absent from the T-tree are deleted.
2. **Git branch** is `<originalBranch>-fork-<seq>`. The fork worktree is
   created with `git worktree add -b <newBranch>` based off the same
   `baseBranch` as the original task. Then we overwrite working-tree files
   with CAS contents as in (1), then `git add -A && git commit -m
   "legion: fork point seq=<T>"` so the fork starts from a clean commit
   that reflects the agent's actual mid-stream state.
3. **Agent process** in the original task is **not killed** — forking is
   non-destructive. The original timeline keeps recording. A `fork_marker`
   event is appended to the parent's timeline with `{ forkSeq: T, forkTaskId }`.
4. **New agent process**: spawned in the new worktree via the existing
   `spawnAgent` path. After `agent_spawn` settles (we reuse
   `prompt_ready_delay_ms` from `agents.ts`), the edited prompt is sent
   via `writeToAgent`. The new task is its own root timeline with its own
   `seq=0`; it carries `parentTaskId` and `parentForkSeq` in its meta.json
   for cross-linking in the UI ("Forked from task X at 00:42:13").

### 6.2 Worktree choice

The fork gets **its own brand-new worktree**. Reasons:

- Original task may still be running; we cannot stomp its files.
- `git worktree add` is the established creation path
  (`createWorktree` in `electron/ipc/git.ts:674`); we reuse it verbatim.
- Symlink seeding (`.cursor`, `node_modules`, etc.) is automatically
  inherited because we pass the same `symlinkDirs` as the parent task.

### 6.3 Mid-tool-call forks

The trickiest edge case: the user wants to fork at a `seq` that falls
*between* a `PreToolUse` event and its matching `PostToolUse`. Our policy:

- The fork's worktree is built from `file_write` events that *completed*
  before T. Events whose `tool_call` was in flight at T but never produced
  a `tool_result` are dropped (they didn't actually finish, so the bytes
  they would have written aren't in our CAS).
- A warning in the fork dialog: **"Tool call `Edit src/foo.ts` was in
  progress at this point and will be skipped."** The user sees exactly
  which calls are being thrown out.

### 6.4 Forking from a fork

Forks have their own timelines. Forking a fork is the same code path;
`parentTaskId` chains. The UI shows the chain in the fork dialog header
("Task A → fork-1 → fork-2"). No special infrastructure needed.

### 6.5 Large repos

For repos > 500 MB of tracked content, snapshot-0 alone would dominate
storage. Mitigation:

- Snapshot trees only record paths the agent has *touched* since
  task-spawn (we maintain a "dirty set" populated by channel-C). The
  fork-restore path falls back to git for untouched paths (since they're
  still the same content as `baseBranch`, the fresh `git worktree add`
  already provides them correctly).
- Concretely: snapshot N stores only `{ path → contentSha }` for the
  union of dirty-set ∪ snapshot-0.

This caps timeline storage to "size of files the agent touched", which is
typically a few MB even on huge repos.

### 6.6 Long sessions (8 h+)

Storage grows linearly. Two mitigations:

- The per-task cap (§4.4) kicks in. We trim PTY bin files first
  (oldest-first); event log + CAS stays so semantic scrub still works.
- Snapshots are pruned to a logarithmic distribution (keep every snapshot
  in the last hour, every 4th in the prior hour, every 16th before that).
  Coarser anchors → slower scrub *near old time*, but bounded total size.

---

## 7. IPC contract

All channels live in the `IPC` enum in `electron/ipc/channels.ts`, allowlisted
in `electron/preload.cjs`, and registered in `electron/ipc/register.ts`.
New code lives in `electron/ipc/timetravel/` (subdir, to avoid bloating
`ipc/`):

```
electron/ipc/timetravel/
├── recorder.ts        # PTY/file watchers, NDJSON appender, CAS writer
├── store.ts           # paths, retention sweeper, atomic writes
├── replay.ts          # snapshot+events → StateAtT
├── fork.ts            # build new worktree, copy from CAS, spawn agent
├── types.ts           # TimelineEvent and payload types
└── recorder.test.ts   # vitest
```

### 7.1 Channels (additions to the `IPC` enum)

```ts
// --- Time-Travel debugger ---
StartTimelineRecording   = 'start_timeline_recording',   // renderer → main
StopTimelineRecording    = 'stop_timeline_recording',
TimelineSummary          = 'timeline_summary',           // request: get bucket data
TimelineSeek             = 'timeline_seek',              // request: StateAtT for a seq
TimelineForkFrom         = 'timeline_fork_from',         // request: create fork
TimelineEvent            = 'timeline_event',             // push: main → renderer, live append
TimelineEvictionNotice   = 'timeline_eviction_notice',   // push: "we dropped your old PTY bytes"
```

### 7.2 Payload shapes

```ts
// Renderer → main
interface StartTimelineRecordingReq { taskId: string; worktreePath: string; }

interface TimelineSummaryReq {
  taskId: string;
  /** Number of buckets to compute (the renderer passes the scrubber pixel width). */
  bucketCount: number;
}
interface TimelineBucket {
  startSeq: number;
  endSeq: number;
  ts: number;
  /** Histogram of event kinds in this bucket. */
  kinds: Record<TimelineEventKind, number>;
}
interface TimelineSummaryResp {
  taskId: string;
  totalEvents: number;
  startTs: number;
  endTs: number;
  buckets: TimelineBucket[];
}

interface TimelineSeekReq { taskId: string; seq: number; }
type TimelineSeekResp = StateAtT;  // §5.2

interface TimelineForkFromReq {
  taskId: string;
  atSeq: number;
  newBranchName: string;
  prompt: string;
}
interface TimelineForkFromResp {
  newTaskId: string;
  newBranchName: string;
  newWorktreePath: string;
  skippedToolCalls: number;  // see §6.3
}

// Main → renderer (push)
interface TimelineEventPush {
  taskId: string;
  event: TimelineEvent;     // strictly increasing seq per task
}
interface TimelineEvictionNoticePush {
  taskId: string;
  reason: 'task-cap' | 'project-cap' | 'age-cap';
  evictedBytes: number;
}
```

### 7.3 Wiring into existing modules

- `electron/ipc/pty.ts`: add `subscribeToAgentRaw` (parallel to existing
  `subscribeToAgent` — that one emits base64 strings; recorder wants the
  raw `Buffer` to avoid double-encoding). Recorder also calls
  `subscribeToAgentExit` and `onPtyEvent('spawn', ...)` so it can emit
  `agent_spawn` / `agent_exit` events with the right `seq` ordering.
- `electron/ipc/tasks.ts`: `deleteTask` calls `stopTimelineRecording` and
  fires async deletion of the timeline directory.
- `electron/ipc/register.ts`: registers the new handlers, same style as
  `startStepsWatcher` registration.

### 7.4 Renderer wiring

A new store domain `src/store/timetravel.ts`:

```ts
interface TimelineState {
  taskId: string;
  buckets: TimelineBucket[];
  playheadSeq: number | null;
  state: StateAtT | null;
  isRecording: boolean;
}
```

Per-task `TimelineState` lives under `store.timelines[taskId]`. The
`TimelineEvent` push appends to `buckets` (with bucketing recomputed
incrementally — cheap because we only ever append). Scrubbing calls
`invoke(IPC.TimelineSeek, ...)` and stores the result in `state`.

---

## 8. Security / safety

- Recorded data may contain secrets (API keys typed into the PTY,
  credentials in file_write payloads). The timeline directory has the
  same protection as `<userData>/state.json` — userland-readable on Mac
  and Linux; we do not encrypt it in v1. **Documented as a caveat in the
  user-facing Settings toggle.**
- The hook scripts (channel A) run inside Claude Code's bwrap sandbox.
  They MUST be deterministic and never make network calls. We unit-test
  each hook script with a fixture payload to confirm "stdin in, NDJSON
  line out, exit 0."
- The recorder NEVER writes anything to the user's git history. Snapshots
  use our own CAS. Forks create new branches but never modify the
  original branch.
- Fork dialog displays the diff and the truncated prompt before commit so
  the user can confirm what's about to land in a new worktree commit.

---

## 9. Testing strategy

### 9.1 Unit (Vitest)

`electron/ipc/timetravel/recorder.test.ts`:

- A noop "agent" (`spawn('cat')` in a PTY) writes a known sequence of bytes,
  events are recorded with monotonic `seq` and matching `byteOffset`.
- File-watcher emits exactly one `file_write` event per debounced change.
- Recorder ignores `.git/**` and `node_modules/**`.
- Channel A: feed a fixture Claude hook payload into the hook script via
  child-process spawn, assert NDJSON shape.

`electron/ipc/timetravel/replay.test.ts`:

- Given a known event log + CAS, `replay.stateAt(seq)` returns the
  expected PTY scrollback (byte-for-byte) and diff list.
- Scrub across 10 000 events stays under the 33 ms per-frame budget.

`electron/ipc/timetravel/fork.test.ts`:

- Fork from snapshot-0: new worktree equals `baseBranch` HEAD.
- Fork from mid-session: new worktree contents equal the in-memory replay
  state; the `legion: fork point seq=<T>` commit is created.
- Fork from a fork: parent chain stored correctly in meta.

### 9.2 Integration

`electron/ipc/timetravel/__tests__/end-to-end.test.ts`:

- Spawn a real PTY with a scripted "agent" (a Node script that prints
  output, writes files, exits). Drive a full record → seek → fork cycle
  through the IPC handlers. Assert the new task's worktree, branch, and
  spawned agent match expectations.
- Run with channel A disabled to verify the PTY+filesystem floor works.

### 9.3 Performance / soak

- A 60-minute synthetic session generating 200 events/min. Assert: < 200
  MB on disk, < 3 % CPU overhead, scrub the full 60 minutes end-to-end in
  ≤ 5 seconds wall clock (i.e. > 720 frames per 5 s, ≥ 144 fps).

### 9.4 What we don't test

- Real Anthropic / OpenAI calls. We mock the agent CLIs in tests because
  CI must not require an API key.

---

## 10. Alternatives considered

### A. **PTY-only naive recorder** (record stdout, replay terminal at T)

- **Pro**: trivially simple. ~200 LOC.
- **Pro**: works for every agent runtime with zero hooks.
- **Con**: you can scrub to "this is what the screen looked like" but you
  cannot **fork**, because you have no idea what files the agent changed
  at T — the user has the same problem they started with.
- **Con**: scrolling is the only navigation; no semantic anchors.
- **Verdict**: insufficient. We keep PTY recording as channel B but it
  isn't enough alone.

### B. **Git-stash snapshots at every event**

- **Pro**: reuses git; no CAS to build.
- **Pro**: `git reset` is the canonical restore primitive.
- **Con**: dumps thousands of stashes into the user's repo. Pollutes
  reflog, slows `git gc`, surprises users when they `git log` and see
  `legion-stash-237` everywhere.
- **Con**: `git add` of a 500 MB working tree is not fast enough for
  every-event capture (we'd be forced to snapshot only every N events,
  which is what we end up doing anyway in §4.3).
- **Verdict**: rejected as the primary mechanism; we use git only for
  the *fork-commit* (one commit per fork, in the new worktree's new
  branch — that's clean and the user expects it).

### C. **Parse Claude's transcript JSON instead of hooks**

Claude Code writes a session transcript to
`~/.claude/projects/.../session-<uuid>.jsonl`. We could `tail -f` it.

- **Pro**: no hook scripts to install. Less moving parts in the worktree.
- **Pro**: catches everything, including the agent's internal reasoning
  output.
- **Con**: Claude-only. Codex/Gemini/Copilot/OpenCode don't expose a
  comparable transcript. We'd still need channels B+C as the floor and
  would have to maintain two semantic-event parsers (transcript +
  hooks). One is cheaper.
- **Con**: file format is undocumented and changes between Claude versions.
  Hooks are a documented surface.
- **Verdict**: rejected for v1. Reconsider if Anthropic stabilizes the
  transcript schema or if reasoning capture becomes a key UX request.

---

## 11. Open questions

1. **Hook script delivery in Docker mode.** `<legionResources>/hooks/...`
   lives outside the container's mounts. Options: (a) bind-mount the
   resources path read-only into the container, (b) copy the hook scripts
   into `.claude/` itself at worktree creation (then we have to filter
   them out of `git status` — `.git/info/exclude` again). (a) feels
   cleaner. Needs prototyping.
2. **Should `pty_in` recording mask known secret patterns?** The user
   pastes their OpenAI key when configuring an agent. Recording it means
   it's on disk in clear. Telegram's `redactPatterns` is the obvious
   prior art — share that config? Defer to v1.1, document the caveat,
   ship with `pty_in` recording **off by default** and a Settings toggle.
3. **Cross-task forks.** "Take task A's exploration phase + task B's
   plan, run a new agent from that combined state." Out of scope for
   v1 but the timeline schema doesn't preclude it.
4. **Multi-agent (Arena) timelines.** AI Arena runs N agents in N
   worktrees concurrently for the same prompt. Should the timeline view
   support a synchronised playhead across all N? Probably yes, but the
   per-task timeline model already supports it — the UI is the only new
   piece. Out of scope for v1.
5. **Editor jump-to-event from the timeline.** Clicking a `tool_call ▸
   Edit src/foo.ts` event could open the diff in the existing
   `DiffViewerDialog`. Trivial wiring; deferred to the implementation PR.
6. **Auto-fork on hung-agent detection.** The hung-agent detector
   already classifies stuck PTYs. Should it surface a "Rewind to last
   known good and try again with skip-permissions" button? Strong v1.1
   candidate, design-only mention here.

---

## 12. Rollout plan (informational)

1. Land recorder + CAS + retention behind a feature flag
   (`store.timetravel.enabled`, default false).
2. Land the panel UI behind the same flag.
3. Dogfood for two weeks on the Legion repo itself.
4. Default-on for new tasks. Existing tasks remain unrecorded — there's no
   honest way to backfill a timeline for sessions we didn't record.
5. Promote to a real OpenSpec capability under
   `openspec/specs/time-travel/` once requirements stabilise.
