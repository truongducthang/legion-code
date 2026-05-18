# Telegram Control Specification

## Purpose

Allow a user to monitor and control their parallel-code AI agents from any
Telegram client (mobile or desktop) without needing the desktop and the
phone to share a network, and to receive native push notifications when an
agent needs human input. The capability is opt-in per project, the bot
token is stored encrypted on the desktop and never leaves it, and agent
output is sanitised before crossing Telegram's servers.

## ADDED Requirements

### Requirement: On-demand bot lifecycle

The app SHALL run at most one Telegram bot instance, started and stopped
explicitly through IPC, and SHALL reuse the existing instance if a second
start is requested while one is already running.

#### Scenario: User starts the bot

- **WHEN** the renderer sends the `StartTelegramBot` IPC request
- **THEN** the main process reads the encrypted bot token from
  `safeStorage`-backed secret storage
- **AND** constructs a bot client and registers the command, inline-callback,
  voice, and document handlers
- **AND** calls `deleteWebhook(drop_pending_updates: true)` then begins
  long-polling Telegram's `getUpdates` endpoint with
  `drop_pending_updates: true`
- **AND** the response includes the bot's `botUsername` and the count of
  currently allowed chats

#### Scenario: User stops the bot

- **WHEN** the renderer sends the `StopTelegramBot` IPC request
- **THEN** the main process calls the bot client's `stop()` and waits up
  to 5 seconds for in-flight handlers to settle
- **AND** subsequent `GetTelegramStatus` requests report the bot as
  stopped
- **AND** if shutdown does not complete within the timeout, the module's
  internal state is reset so a later `StartTelegramBot` succeeds without
  a restart of the desktop app

#### Scenario: Only one bot runs at a time

- **WHEN** `StartTelegramBot` is requested while a bot is already running
- **THEN** the existing bot instance is reused and its status is returned
- **AND** no second `getUpdates` long-poll is opened

#### Scenario: Start fails on invalid token

- **WHEN** `StartTelegramBot` is requested with a token that Telegram's
  `getMe` rejects
- **THEN** the bot does not begin polling
- **AND** the IPC handler throws with the Telegram-returned `error_code`
  and `description`
- **AND** `GetTelegramStatus` reports `running: false` with `lastError`
  set to the same description

#### Scenario: Auto-resume on app start

- **WHEN** the Electron `app.whenReady` event fires
- **AND** the persisted `telegram.enabled === true`
- **AND** the encrypted token store returns a non-null token
- **THEN** the main process auto-starts the bot
- **AND** failures during auto-start surface to `lastError` without
  flipping `telegram.enabled` to `false`

#### Scenario: Multi-instance conflict surfaces a clear error

- **WHEN** another process is already long-polling the same bot token
  and the first `getUpdates` returns `409 Conflict`
- **THEN** the bot stops without retrying
- **AND** `lastError` is set to "Another process is polling this bot
  token. Stop the other instance or revoke the token."

### Requirement: Per-chat authorisation

The bot SHALL process commands, callbacks, voice, and file messages only
from chats whose numeric ids are on the persisted `allowedChatIds` list,
and SHALL onboard new chats through an explicit handshake without
trusting the chat's `/start` alone.

#### Scenario: First-time `/start` from an unknown chat

- **WHEN** a chat not on `allowedChatIds` sends `/start`
- **THEN** the bot replies with the chat's numeric id and the instruction
  "Paste this id into Settings → Telegram → Allowed chats, then send
  /start again."
- **AND** all subsequent messages from that chat are silently dropped
  until the id is added

#### Scenario: Command from an allowed chat

- **WHEN** a chat on `allowedChatIds` sends any registered command
- **THEN** the bot routes the message to the command handler

#### Scenario: Command from a disallowed chat

- **WHEN** a chat not on `allowedChatIds` sends any registered command
  other than `/start`
- **THEN** the bot does not reply, does not log the chat's content, and
  does not record the chat in any persisted state

#### Scenario: Bot blocked auto-removes the chat

- **WHEN** Telegram returns `403 Forbidden: bot was blocked by the user`
  on any send to a known chat
- **THEN** the chat id is removed from `allowedChatIds`
- **AND** the change is persisted
- **AND** an audit entry is logged with `outcome: 'auto-remove'`

### Requirement: Project opt-in gate

The bot SHALL refuse to read scrollback from, push notifications about,
or accept commands targeting an agent whose project has
`telegramOptIn === false`, regardless of chat authorisation.

#### Scenario: Command targets an opted-out project

- **WHEN** an allowed chat sends `/status <agentId>` for an agent whose
  project has `telegramOptIn === false`
- **THEN** the bot replies with `That project is not opted in to Telegram
control.`
- **AND** no scrollback is sent

#### Scenario: Question notification suppressed for opted-out project

- **WHEN** an agent whose project has `telegramOptIn === false` emits
  output matching a question pattern
- **THEN** no notification is pushed to any chat
- **AND** the detector still records the match internally for the 30 s
  suppression window so a later flip to `telegramOptIn === true` does not
  cause a notification storm

#### Scenario: Live tail closes on opt-out flip

- **WHEN** a project flips `telegramOptIn` from `true` to `false` while a
  live tail for one of its agents is running
- **THEN** the tail closes with reason `project opted out`
- **AND** any pending edits for that agent in the rate limiter's
  per-chat queues are discarded

### Requirement: Command surface

The bot SHALL expose the command set described in this requirement, each
with the listed reply shape and side effect, and SHALL reject unknown
commands with a single-line help pointer.

#### Scenario: `/agents` lists active agents

- **WHEN** an allowed chat sends `/agents`
- **THEN** the bot replies with one line per active agent in the form
  `<id> — <project> — <status>`
- **AND** the line count is capped at 30 with `… (N more)` if the list is
  longer

#### Scenario: `/status <id>` returns recent scrollback

- **WHEN** an allowed chat sends `/status <id>` for a known agent in an
  opted-in project
- **THEN** the bot replies with the last 30 lines of scrollback wrapped
  in a MarkdownV2 triple-backtick block
- **AND** the scrollback is ANSI-stripped, passed through the redaction
  filter, then MarkdownV2-escaped before being sent
- **AND** if scrollback is shorter than 30 lines, the entire scrollback
  is returned without padding

#### Scenario: `/prompt <id> <text>` writes to the agent

- **WHEN** an allowed chat sends `/prompt <id> hello world`
- **THEN** the bot writes `hello world\n` into the PTY of agent `<id>`
- **AND** replies with `→ prompted`

#### Scenario: `/approve` and `/deny` write `y` or `n`

- **WHEN** an allowed chat sends `/approve <id>`
- **THEN** the bot writes `y\n` into the PTY of `<id>` and replies with
  `→ approved`
- **WHEN** an allowed chat sends `/deny <id>`
- **THEN** the bot writes `n\n` into the PTY of `<id>` and replies with
  `→ denied`

#### Scenario: `/kill <id>` terminates the agent

- **WHEN** an allowed chat sends `/kill <id>`
- **THEN** the bot routes to the same agent-kill IPC the desktop UI uses
- **AND** replies with `→ killed`

#### Scenario: `/diff <id>` returns git stat

- **WHEN** an allowed chat sends `/diff <id>`
- **THEN** the bot runs `git diff --stat` inside the agent's worktree
- **AND** replies with the stat output, MarkdownV2-escaped, inside a
  triple-backtick block, truncated to 3500 characters with
  `… (truncated)` if longer

#### Scenario: `/steps <id>` returns step-tracking progress

- **WHEN** an allowed chat sends `/steps <id>` for a known agent in an
  opted-in project that has a `steps.json` (per
  `openspec/specs/steps-tracking/spec.md`)
- **THEN** the bot replies with the progress summary including the
  current step index, total steps, and the current step's label

#### Scenario: `/cov <id>` returns coverage summary

- **WHEN** an allowed chat sends `/cov <id>` for an agent whose project
  has `coverageReportPath` set and a parseable report on disk
- **THEN** the bot replies with the coverage summary inside a
  triple-backtick block

#### Scenario: `/run <id> <bookmark>` executes a bookmark

- **WHEN** an allowed chat sends `/run <id> tests` and the agent's
  project's `terminalBookmarks` contains an entry with `name === 'tests'`
- **THEN** the bot writes the bookmark's `command` followed by `\n` into
  the agent's PTY
- **AND** replies with `→ ran <name>`

#### Scenario: `/run` with unknown bookmark

- **WHEN** an allowed chat sends `/run <id> <name>` and no bookmark with
  that name exists for the agent's project
- **THEN** the bot replies with `Unknown bookmark "<name>".`
- **AND** does not write to the PTY

#### Scenario: `/ask <id> <question>` routes through ask-code

- **WHEN** an allowed chat sends `/ask <id> where is auth handled?`
- **THEN** the bot calls the existing ask-code IPC for `<id>`
- **AND** replies with the answer inside a triple-backtick block,
  MarkdownV2-escaped, truncated to 3500 characters with `… (truncated)`
  if longer

#### Scenario: Command aliases work

- **WHEN** an allowed chat sends `/p <id> hello`
- **THEN** the bot behaves as if `/prompt <id> hello` had been sent
- **AND** the same alias mapping applies to `/a`, `/k`, `/d`, `/s`,
  `/t`, `/u`

#### Scenario: Unknown command

- **WHEN** an allowed chat sends a slash command not in the registered
  set
- **THEN** the bot replies with `Unknown command. Send /help for the
list.`

### Requirement: Reply-chain routing

The bot SHALL infer the target agent of any chat message that is a
Telegram reply to a previously-sent bot message tagged with an `agentId`,
treating the reply body as `/prompt <agentId> <body>` without requiring
an explicit `<id>` argument.

#### Scenario: Reply to a notification routes back to the agent

- **WHEN** the bot has sent a question notification for agent `<id>` and
  an allowed chat replies (Telegram's "reply to" feature) to that
  notification with the text `try again with --force`
- **THEN** the bot writes `try again with --force\n` into the PTY of
  `<id>`
- **AND** replies with `→ prompted`

#### Scenario: Reply to a non-tagged message is ignored

- **WHEN** the chat replies to a bot message that is not registered in
  the reply map (e.g. an older message that has been evicted from the
  2 000-entry LRU)
- **THEN** the bot does not process the reply as a prompt
- **AND** does not surface an error

### Requirement: Inline-keyboard callbacks

The bot SHALL handle the inline-keyboard callbacks `approve:<id>`,
`deny:<id>`, and `open:<id>`, applying the same authorisation and opt-in
checks as their slash-command counterparts, and SHALL acknowledge each
callback with a brief toast.

#### Scenario: `approve` callback

- **WHEN** an allowed chat taps an `[✅ Allow]` inline button on a
  question notification for agent `<id>` in an opted-in project
- **THEN** the bot writes `y\n` into the agent's PTY
- **AND** answers the callback with the toast `Approved.`
- **AND** edits the original notification message to append
  `\n— approved by <user>`

#### Scenario: `open` callback with public URL configured

- **WHEN** an allowed chat taps an `[👁 Open]` inline button and
  `telegram.publicBaseUrl` is set (either by user input or by the
  cloudflared auto-tunnel)
- **THEN** the bot answers the callback with the toast `Opening…`
- **AND** sends a `web_app` button whose URL is
  `<publicBaseUrl>/?agent=<id>` so Telegram opens the SPA inside its
  WebApp container

#### Scenario: `open` callback without public URL

- **WHEN** an allowed chat taps `[👁 Open]` and `telegram.publicBaseUrl`
  is null
- **THEN** the bot replies with `Set a public URL in Settings to open
the full session.`
- **AND** does not send a `web_app` button

### Requirement: Agent-question detection

The bot SHALL detect a small set of input-needed patterns in agent PTY
output and push a notification to every allowed chat whose `pushPolicy`
permits questions, suppressing re-fires for the same agent + pattern for
30 seconds.

#### Scenario: PTY output chunks are base64-decoded before matching

- **WHEN** the detector receives a chunk via the
  `subscribeToAgent(agentId, cb)` callback (whose payload is a base64
  string per `electron/ipc/pty.ts`)
- **THEN** the chunk is decoded with `Buffer.from(encoded,
'base64').toString('utf8')` before ANSI stripping and pattern
  matching

#### Scenario: `[y/N]` prompt triggers a notification

- **WHEN** an agent in an opted-in project emits output ending with
  `Continue? [y/N]`
- **THEN** the bot pushes one notification to each chat with
  `pushPolicy === 'all'` or `pushPolicy === 'questions-only'`
- **AND** the notification body contains the last non-empty line of the
  tail, redacted and MarkdownV2-escaped
- **AND** the notification carries an inline keyboard with three buttons:
  `[✅ Allow]`, `[❌ Deny]`, `[👁 Open]`

#### Scenario: Repeated question within 30 s does not re-notify

- **WHEN** the same agent emits a second match of the same pattern id
  within 30 seconds of the first match
- **THEN** no second notification is sent
- **AND** the agent's match-state Map is updated so the suppression
  window restarts from the second match's timestamp

#### Scenario: Different pattern fires independently

- **WHEN** an agent emits output matching pattern `yn-bracket` and 10
  seconds later emits output matching pattern `press-enter`
- **THEN** the bot pushes two notifications, one per match

#### Scenario: Push policy filters notifications

- **WHEN** a chat's `pushPolicy === 'errors-only'`
- **THEN** that chat receives no question notifications
- **AND** still receives error notifications (see "Push policy"
  requirement below)

### Requirement: Idle-after-activity detection

The bot SHALL push a single "agent looks done" notification when an
agent that has been active for at least 5 minutes goes silent for 60
seconds, and SHALL NOT re-fire idle until the agent becomes active
again.

#### Scenario: Active → idle transition fires once

- **WHEN** an agent has emitted ≥ 2 chunks/sec sustained for 5 minutes
- **AND** then emits no chunk for 60 consecutive seconds
- **THEN** the bot pushes one notification to each chat with
  `pushPolicy === 'all'`
- **AND** the notification body shows the agent's last non-empty
  output line, redacted and MarkdownV2-escaped
- **AND** the notification carries an inline keyboard with one button:
  `[👁 Open]`

#### Scenario: Idle does not re-fire without a new active span

- **WHEN** an agent has already fired one idle notification and emits no
  further activity
- **THEN** no second idle notification is pushed
- **AND** the bot does not re-fire idle until the agent re-enters the
  active state (≥ 2 chunks/sec sustained for 5 minutes again)

#### Scenario: Agent exit resets idle state

- **WHEN** an agent that has been tracked by the idle detector exits
- **THEN** the detector's per-agent state is cleared
- **AND** a new spawn with the same agent id starts fresh

### Requirement: Agent exit handling

Main SHALL fan out agent-exit events to a parallel subscriber surface so
the bot can clean up state and push error notifications when relevant.

#### Scenario: New `subscribeToAgentExit` helper

- **WHEN** the bot module calls
  `subscribeToAgentExit(agentId, cb)` on `electron/ipc/pty.ts`
- **THEN** `cb` is invoked once when the agent exits with the same
  `{ exitCode, signal, lastOutput }` payload that the renderer already
  receives via the `Exit` event in `electron/ipc/pty.ts`
- **AND** the existing renderer `Exit` event continues to fire
  unchanged

#### Scenario: Non-zero exit pushes an error notification

- **WHEN** an agent in an opted-in project exits with `exitCode !== 0`
  OR `signal !== null`
- **THEN** every allowed chat with `pushPolicy ∈ {'all',
'errors-only'}` receives a notification including the exit code,
  signal, and `lastOutput` lines (redacted + MD2-escaped)

#### Scenario: Detectors clean up on exit

- **WHEN** an agent exits
- **THEN** the question detector drops its per-agent state Map entry
- **AND** the idle detector resets its per-agent state
- **AND** any active live tails for the agent finalise their message
  with `\n— tail closed (agent exited)` and unsubscribe

### Requirement: Live tail

The bot SHALL support a per-chat, per-agent live-tail subscription that
edits a single message in place at most once per second, rotates to a new
message when the current one approaches Telegram's 4096-character cap,
and caps concurrent tails at 3 per chat.

#### Scenario: `/tail` opens a subscription

- **WHEN** an allowed chat sends `/tail <id>` for a known agent in an
  opted-in project
- **THEN** the bot sends a single new message and begins editing it as
  PTY chunks arrive
- **AND** edits are coalesced on a 1-second timer so at most one edit
  per second per chat is performed

#### Scenario: Rotation at 3900 characters

- **WHEN** the live message accumulates 3900 characters of edited content
- **THEN** the bot finalises the current message with the footer
  `\n— continued ↓`
- **AND** sends a fresh message and routes subsequent edits to it

#### Scenario: `/untail` closes the subscription

- **WHEN** an allowed chat sends `/untail <id>` for an active tail
- **THEN** the bot closes the subscription
- **AND** edits the latest live message with the footer
  `\n— tail closed (user)`

#### Scenario: Agent exit closes the subscription

- **WHEN** an agent with an active tail exits
- **THEN** every chat tailing that agent receives a final edit with the
  footer `\n— tail closed (agent exited)`

#### Scenario: Tail limit reached

- **WHEN** a chat already has 3 live tails open and sends a fourth
  `/tail <id>`
- **THEN** the bot replies with `Too many tails (limit 3). Use /untail
to free one.`
- **AND** does not open the fourth subscription

### Requirement: MarkdownV2 escaping is global

Every bot reply that includes agent-derived content SHALL pass that
content through a single `escapeMd2` helper before sending, so reserved
characters never cause Telegram to reject the message with
`400 Bad Request: can't parse entities`.

#### Scenario: Scrollback containing reserved characters renders correctly

- **WHEN** an agent's scrollback contains a literal `*` or `_` character
- **AND** `/status <id>` is invoked
- **THEN** the rendered message in Telegram shows the literal characters
  rather than emphasis formatting

#### Scenario: Question notification body is escaped

- **WHEN** the agent-question detector fires with a tail line that
  contains `Continue (Y/N)?`
- **THEN** the resulting notification body has the `(`, `)`, and `?`
  characters MarkdownV2-escaped

### Requirement: Output sanitisation

The bot SHALL pass every agent-derived string (scrollback, diff, live
tail content, question-notification tail line, idle-notification last
line, voice transcripts, ask-code answers, file-upload path display)
through a redaction filter that replaces matches of a baseline pattern
set plus user-provided patterns with `[REDACTED:<name>]`, before
MarkdownV2 escaping.

#### Scenario: Baseline pattern matches

- **WHEN** an agent's scrollback contains the string `AKIAIOSFODNN7EXAMPLE`
- **THEN** the scrollback the chat receives contains `[REDACTED:aws-akid]`
  in place of the original string

#### Scenario: User pattern matches

- **WHEN** the user has added `^password:\s*\S+$` to
  `telegram.redactPatterns` (case-insensitive, line anchored), and an
  agent's scrollback contains `password: hunter2`
- **THEN** the scrollback the chat receives contains
  `[REDACTED:user-0]` in place of the matched run
- **AND** the index suffix `0` corresponds to the first user-supplied
  pattern in the textarea

#### Scenario: Redaction runs on ANSI-stripped text

- **WHEN** an agent emits a string containing ANSI colour codes around a
  matching secret (e.g. `\x1b[31mAKIAIOSFODNN7EXAMPLE\x1b[0m`)
- **THEN** the redaction runs after ANSI stripping
- **AND** the chat receives the redacted form without ANSI codes

#### Scenario: Telegram API requests are not redacted

- **WHEN** the bot makes any direct request to Telegram's API that does
  not carry agent-derived content (e.g. `getMe`, `getUpdates`)
- **THEN** the redaction filter is not applied
- **AND** request payloads are sent verbatim

### Requirement: Rate limiting and optional PTY backpressure

The bot SHALL enforce two token-bucket rate limits — per chat at 1
send/edit per second with capacity 3, and global at 25 send/edits per
second with capacity 25 — and SHALL replace the pending edit for a
`(chat, agent)` pair when the per-chat bucket is empty rather than
queueing, and MAY pause the agent's PTY when sustained drops indicate
the Telegram link cannot keep up.

#### Scenario: Per-chat bucket throttles edits

- **WHEN** the live-tail formatter has produced 4 edits for one chat in
  one second
- **THEN** at most 3 edits are sent
- **AND** the 4th edit replaces the 3rd edit's pending payload so the
  most recent state is what eventually reaches Telegram

#### Scenario: Global cap throttles fanout

- **WHEN** 30 chats each receive a notification in the same second
- **THEN** at most 25 sends are dispatched in that second
- **AND** the remaining 5 are deferred to the next second

#### Scenario: `429` response halves capacity

- **WHEN** Telegram responds with `429 Too Many Requests` for a send to
  a specific chat
- **THEN** the bot sleeps for `retry_after + 250 ms` jitter before any
  further send to that chat
- **AND** that chat's bucket capacity is halved (minimum 1)
- **AND** the next successful send to that chat resets the capacity to
  the configured 3

#### Scenario: Sustained drops pause the agent when project opts in

- **WHEN** the rate limiter has dropped edits for the same
  `(chat, agent)` pair for 5 consecutive seconds
- **AND** the agent's project has
  `telegramPauseOnBackpressure === true`
- **THEN** the limiter calls `pauseAgent(<agentId>)` on
  `electron/ipc/pty.ts`
- **AND** on the next successful send for that pair, calls
  `resumeAgent(<agentId>)`

#### Scenario: Sustained drops do not pause when project opts out

- **WHEN** the same sustained-drop condition holds but the project's
  `telegramPauseOnBackpressure === false`
- **THEN** the limiter continues dropping edits without pausing the
  agent

### Requirement: Encrypted token storage

The bot token and any optional OpenAI Whisper API key SHALL be stored
encrypted via Electron `safeStorage` on disk, owned entirely by the
main process, and SHALL NEVER be readable from the renderer process or
from the renderer's `state.json`.

#### Scenario: SetTelegramConfig stores the token via safeStorage

- **WHEN** the renderer sends `SetTelegramConfig` with a non-empty
  `token` field
- **THEN** main encrypts the token via `safeStorage.encryptString` and
  writes the ciphertext to `<userData>/telegram-token.bin` with mode
  `0o600`
- **AND** the in-memory copy of the plaintext is discarded after the
  write
- **AND** the IPC reply does not echo the token back to the renderer

#### Scenario: GetTelegramStatus never exposes the token

- **WHEN** the renderer sends `GetTelegramStatus`
- **THEN** the reply includes `hasToken: boolean` but no field
  carrying the token value

#### Scenario: Encryption unavailable

- **WHEN** the platform's `safeStorage.isEncryptionAvailable()` returns
  `false` (e.g. a Linux system without libsecret)
- **THEN** `SetTelegramConfig` with a `token` field throws with code
  `encryption-unavailable`
- **AND** the Settings UI renders the verbatim message: "Encrypted
  token storage is unavailable. Install libsecret (Linux) or use the
  macOS Keychain."

#### Scenario: Empty token clears storage

- **WHEN** `SetTelegramConfig` is called with `token: ""`
- **THEN** main deletes `<userData>/telegram-token.bin`
- **AND** stops the bot if it is running

### Requirement: Mini App auto-auth

The remote server SHALL accept Telegram WebApp `initData` payloads at
POST `/api/telegram-auth`, verify their HMAC-SHA256 signature against
the bot token per Telegram's published algorithm, and issue a normal
remote-server session token on success.

#### Scenario: Valid initData yields a session token

- **WHEN** a client POSTs the `initData` string from
  `window.Telegram.WebApp.initData` to `/api/telegram-auth`
- **AND** the HMAC matches and `auth_date` is within the last 60 seconds
- **AND** the embedded `chat.id` is on `allowedChatIds`
- **THEN** the response is `200 OK` with a JSON body
  `{ "token": "<session token>" }`
- **AND** the token is the same shape and lifecycle as the QR-path
  token from the existing remote-access spec

#### Scenario: Tampered initData is rejected

- **WHEN** any byte of the `initData` payload is modified after Telegram
  signed it
- **THEN** the response is `401 Unauthorized`
- **AND** no token is issued
- **AND** the rejection is logged under category `telegram.initdata`
  at `warn`

#### Scenario: Expired initData is rejected

- **WHEN** the `auth_date` field decodes to a Unix timestamp more than 60
  seconds in the past
- **THEN** the response is `401 Unauthorized`

#### Scenario: initData from a disallowed chat is rejected

- **WHEN** the `chat.id` embedded in a valid-signature `initData` payload
  is not on `allowedChatIds`
- **THEN** the response is `401 Unauthorized`

#### Scenario: Route is gated on enablement

- **WHEN** `telegram.enabled === false`
- **THEN** POST `/api/telegram-auth` returns `404 Not Found`
- **AND** no signature verification is attempted

### Requirement: Optional cloudflared tunnel

The bot module SHALL launch a `cloudflared` child process to expose the
remote server's HTTP endpoint over a public HTTPS URL whenever the user
has opted in via Settings and a `cloudflared` binary is available, and
SHALL surface the assigned URL through `GetTelegramStatus`.

#### Scenario: Auto-tunnel toggle starts cloudflared

- **WHEN** the user enables `autoTunnel` in Settings and a
  `cloudflared` binary is available
- **AND** the bot is starting
- **THEN** the bot spawns
  `cloudflared tunnel --url http://localhost:<remotePort>`
- **AND** parses stdout for the assigned
  `https://<random>.trycloudflare.com` URL
- **AND** updates `publicBaseUrl` in memory and sets `tunnelActive:
true`, `tunnelUrl: <url>` in `GetTelegramStatus`

#### Scenario: cloudflared failure surfaces as lastError

- **WHEN** `cloudflared` exits before producing a URL within 10 seconds
- **THEN** the bot continues running without a tunnel
- **AND** `lastError` captures the first line of `cloudflared`'s
  stderr
- **AND** `tunnelActive: false` in `GetTelegramStatus`

#### Scenario: Tunnel stops with the bot

- **WHEN** the bot stops, either via `StopTelegramBot` or via Settings
  toggle off
- **THEN** the `cloudflared` child process receives SIGTERM
- **AND** is force-killed after 2 seconds if it has not exited
- **AND** `tunnelActive: false`, `tunnelUrl: null` in subsequent
  `GetTelegramStatus` calls

### Requirement: Voice prompts

The bot SHALL optionally accept voice messages, transcribe them through
a user-configured runtime (`whisper.cpp` binary or OpenAI Whisper API),
and inject the transcript into a target agent resolved by reply-chain
then by focus.

#### Scenario: Voice runtime disabled

- **WHEN** an allowed chat sends a voice message and
  `telegram.voice.runtime === 'none'`
- **THEN** the bot replies with `Voice input is disabled. Enable it in
Settings.`
- **AND** does not download the voice file

#### Scenario: Successful transcription via whisper.cpp targets focused agent

- **WHEN** an allowed chat sends a voice message that is not a reply,
  `telegram.voice.runtime === 'whisper-cpp'`, and a focused agent is
  known to main via the `SetFocusedAgent` IPC
- **THEN** the bot downloads the voice file to the OS temp directory
- **AND** spawns the configured whisper.cpp binary with a 60-second
  timeout
- **AND** writes the transcript into the focused agent's PTY
- **AND** replies with `🎙 → <transcript>` (transcript passed through
  the redaction filter and MarkdownV2 escape)

#### Scenario: Voice reply routes to the replied-to agent

- **WHEN** an allowed chat sends a voice message that is a Telegram
  reply to a bot message tagged for agent `<id>`
- **THEN** the transcript is written into `<id>` regardless of which
  agent (if any) is focused on the desktop

#### Scenario: No focused agent and no reply

- **WHEN** a voice message arrives, is not a reply, and no agent has
  been registered as focused via `SetFocusedAgent`
- **THEN** the bot replies with `No agent is focused — open one on the
desktop first, or reply to a notification.`
- **AND** does not transcribe the file

#### Scenario: Transcription timeout

- **WHEN** the whisper.cpp spawn does not complete within 60 seconds
- **THEN** the spawn is killed
- **AND** any temp files are removed
- **AND** the bot replies with `Transcription timed out.`

#### Scenario: OpenAI key is read from safeStorage

- **WHEN** `telegram.voice.runtime === 'openai'` and the bot needs to
  call `/v1/audio/transcriptions`
- **THEN** main reads the OpenAI API key from
  `<userData>/telegram-openai.bin` via `safeStorage.decryptString`
- **AND** the renderer never receives the plaintext key

### Requirement: File uploads

The bot SHALL accept `document` and `photo` messages from allowed chats,
download them to a stable path under the OS temp directory, and offer
to paste the absolute path into the focused agent's PTY via an inline
keyboard.

#### Scenario: Document upload is offered for paste

- **WHEN** an allowed chat sends a document under 20 MB
- **THEN** the bot downloads the file to the OS temp directory
- **AND** replies with the absolute path inside a MarkdownV2 inline-code
  span and an inline keyboard `[📋 Paste path into agent]`

#### Scenario: Paste button writes the path into the PTY

- **WHEN** an allowed chat taps `[📋 Paste path into agent]` and an
  agent is focused
- **THEN** the bot writes the shell-escaped absolute path into the
  focused agent's PTY using the same escaping helper as the existing
  image-paste flow

#### Scenario: File exceeds the 20 MB bot-API ceiling

- **WHEN** an allowed chat sends a document or photo larger than 20 MB
- **THEN** the bot replies with `Files over 20 MB are not supported by
the Telegram bot API.`
- **AND** does not initiate a download

### Requirement: Push policy

The bot SHALL deliver notifications only to chats whose `pushPolicy`
permits the notification's category, where `all` permits questions,
idle, and errors, `questions-only` permits questions only, and
`errors-only` permits errors only.

#### Scenario: Question notification with chat policy `all`

- **WHEN** a question is detected and a chat's `pushPolicy === 'all'`
- **THEN** the chat receives the notification

#### Scenario: Question notification with chat policy `errors-only`

- **WHEN** a question is detected and a chat's
  `pushPolicy === 'errors-only'`
- **THEN** the chat does not receive the notification

#### Scenario: Idle notification requires `all` policy

- **WHEN** the idle detector fires for an agent
- **THEN** only chats with `pushPolicy === 'all'` receive the
  notification

#### Scenario: Error notification reaches every policy

- **WHEN** an agent exits with a non-zero code OR throws an unhandled
  error
- **THEN** every allowed chat with `pushPolicy ∈ {'all', 'errors-only'}`
  receives an error notification

### Requirement: Audit log

The bot SHALL record exactly one structured audit entry per executed
command, inline callback, voice ingest, file ingest, configuration
change, and auto-remove (bot-blocked) event, and SHALL NEVER include
token values, transcripts, file contents, or scrollback text in the
entry.

#### Scenario: Successful command writes an entry

- **WHEN** an allowed chat invokes `/prompt <id> some text`
- **THEN** one entry is recorded with
  `category: 'cmd'`, `cmd: '/prompt'`, `agentId: '<id>'`,
  `outcome: 'ok'`
- **AND** the entry does not include the prompt text

#### Scenario: Denied command writes a denied entry

- **WHEN** an allowed chat invokes `/prompt <id>` for an agent in a
  project with `telegramOptIn === false`
- **THEN** one entry is recorded with `outcome: 'denied'` and a
  short `detail` such as `project not opted in`

#### Scenario: Auto-remove writes an entry

- **WHEN** the bot auto-removes a chat after a `403 Forbidden`
- **THEN** one entry is recorded with `category: 'auto-remove'`,
  `cmd: 'remove-chat'`, `chatId: <removed>`, `outcome: 'ok'`

### Requirement: Persisted configuration

The persisted `telegram` configuration SHALL load each field with a
strict per-type coercion so corrupted state cannot silently re-enable
the bot, SHALL default missing fields to safe values, and SHALL NEVER
store the bot token or OpenAI Whisper API key in renderer-visible
persistence.

#### Scenario: Corrupted `enabled` value loads as false

- **WHEN** the persisted state contains `telegram.enabled: "yes"`
  (string, not boolean)
- **THEN** the loader returns `enabled: false`

#### Scenario: Missing fields use defaults

- **WHEN** the persisted state contains a `telegram` object missing
  `pushPolicy`
- **THEN** the loader fills `pushPolicy: 'questions-only'`

#### Scenario: Non-array `allowedChatIds` loads as empty

- **WHEN** the persisted state contains
  `telegram.allowedChatIds: "100"` (string)
- **THEN** the loader returns `allowedChatIds: []`

#### Scenario: Allowed chats are deduped on load

- **WHEN** the persisted state contains
  `telegram.allowedChatIds: [100, 100, 200]`
- **THEN** the loader returns `allowedChatIds: [100, 200]` preserving
  first-seen order

#### Scenario: Token field is rejected from renderer state

- **WHEN** the persisted state file contains a stray
  `telegram.botToken: "..."` field (legacy state that should not
  exist)
- **THEN** the loader ignores the field and does not surface it to
  any code path
- **AND** does not migrate it to the encrypted store; the user must
  re-enter the token in Settings

### Requirement: Persistence schema version

The persisted state SHALL carry a top-level `persistenceVersion`
field that is bumped when this change lands, and the loader SHALL
treat snapshots without the field as version 1 by applying default
values for the new `telegram` block.

#### Scenario: Snapshot without version is treated as v1

- **WHEN** the loader reads a snapshot with no `persistenceVersion`
  field
- **THEN** it treats the snapshot as version 1
- **AND** fills the `telegram` block with default values
- **AND** writes the snapshot back with `persistenceVersion: 2` on
  the next save

#### Scenario: Snapshot at the current version loads unchanged

- **WHEN** the loader reads a snapshot with
  `persistenceVersion: 2`
- **THEN** no field migration runs

### Requirement: IPC surface

The capability SHALL expose five IPC channels — `StartTelegramBot`,
`StopTelegramBot`, `GetTelegramStatus`, `SetTelegramConfig`,
`SetFocusedAgent` — each added to the `IPC` enum in
`electron/ipc/channels.ts` and to the hardcoded `ALLOWED_CHANNELS` set
in `electron/preload.cjs`.

#### Scenario: Renderer reads status

- **WHEN** the renderer sends `GetTelegramStatus`
- **THEN** the response shape is
  `{ running: boolean; lastError: string | null; connectedChats: number;
botUsername: string | null; hasToken: boolean; tunnelActive: boolean;
tunnelUrl: string | null }`

#### Scenario: SetTelegramConfig persists and re-applies

- **WHEN** the renderer sends `SetTelegramConfig` with a new
  `pushPolicy` value
- **THEN** the new value is persisted via the renderer's
  `src/store/persistence.ts`
- **AND** running bot state reads the new policy without requiring a
  bot restart
- **AND** changes to `allowedChatIds` while the bot is running take
  effect on the next message without a restart

#### Scenario: SetTelegramConfig with new token restarts the bot

- **WHEN** the renderer sends `SetTelegramConfig` with a `token` field
  that differs from the currently-stored token, while the bot is
  running
- **THEN** main stops the bot, writes the new token via the encrypted
  store, and restarts the bot with the new token
- **AND** the renderer's `GetTelegramStatus` reflects the new state
  on the next poll

#### Scenario: SetFocusedAgent mirrors renderer focus

- **WHEN** the renderer's `activeAgentId` changes
- **THEN** the renderer sends `SetFocusedAgent` with
  `{ agentId: string | null }`
- **AND** main caches the value for use by voice and reply-chain
  resolution
