# Tasks — Add Telegram Control

## Module scaffolding

- [ ] Add `grammy` to `dependencies` in `package.json`. Run install and
      commit the lockfile update.
- [ ] Create `electron/telegram/` with the files listed in `design.md`
      ("Three layers, one module"): `index.ts`, `bot.ts`, `commands.ts`,
      `inline.ts`, `formatter.ts`, `detector.ts`, `idle.ts`, `redact.ts`,
      `ratelimit.ts`, `initdata.ts`, `voice.ts`, `upload.ts`, `reply.ts`,
      `audit.ts`, `tunnel.ts`, `store.ts`, `config.ts`, `focus.ts`,
      `types.ts`. Each file starts as a named-exports stub that throws
      `TelegramError('not-implemented')` so the rest of the codebase can
      import the public surface before any logic exists.
- [ ] Define `TelegramError` (a class extending `Error` with a `code`
      field), `TelegramStatus`, `TelegramConfig`, `QuestionMatch`,
      `LiveTailHandle`, `AuditEntry`, `TelegramInitData` in
      `electron/telegram/types.ts`. The public surface in `index.ts`
      exposes async functions that throw — there is NO `Result<T, E>`
      type; the codebase does not use one elsewhere (verified against
      `electron/ipc/git.ts` and the other handlers in
      `electron/ipc/register.ts`) and introducing one here would
      be inconsistent.

## IPC

- [ ] Add `StartTelegramBot`, `StopTelegramBot`, `GetTelegramStatus`,
      `SetTelegramConfig`, `SetFocusedAgent` to the `IPC` enum in
      `electron/ipc/channels.ts`.
- [ ] Add the five channel strings to the hardcoded `ALLOWED_CHANNELS`
      set in `electron/preload.cjs`. The preload's
      `channel.startsWith('channel:')` fallback is for streaming events
      only; explicit handlers must be whitelisted by exact match.
- [ ] Implement the five handlers in `electron/ipc/register.ts`. Each
      handler is a thin pass-through to `electron/telegram/index.ts` —
      no business logic in `register.ts`. The handlers throw on
      failure; the renderer's `invoke` rejects, matching every other
      IPC in this file.
- [ ] `SetFocusedAgent` is a fire-and-forget IPC the renderer calls
      whenever `activeAgentId` in `src/store/types.ts:219` changes.
      Main caches the value in `electron/telegram/focus.ts`. Voice and
      reply-chain code read it when no `<id>` is provided in the
      Telegram message.
- [ ] Wire the handlers to the existing logger
      (`openspec/specs/logging/spec.md` — note that the logging spec is
      itself a change-in-progress in `add-structured-logging/`; if it
      has not landed, fall back to `console.warn` / `console.error`
      under the same `telegram.*` category tags so the eventual
      migration is mechanical) under category `telegram.ipc`. Every
      handler emits a `debug` entry on enter and on success, and `warn`
      on failure.

## Persisted state (non-secret)

- [ ] Extend `PersistedState` in `src/store/types.ts` with the
      `telegram` object described in `design.md` ("Persisted state
      (non-secret)"). The shape MUST NOT include `botToken` or
      `openaiApiKey` — those are owned by `store.ts` via `safeStorage`.
- [ ] Update the loader / saver in `src/store/persistence.ts`. The
      main-side `electron/ipc/persistence.ts` continues to be a dumb
      blob save/load and does NOT learn the shape. Each field gets an
      explicit `typeof` / shape coercion to its default; corrupted
      `enabled: "yes"` becomes `false`. Mirror the `typeof raw.X ===
'boolean' ? raw.X : false` pattern already used at
      `src/store/persistence.ts:456` for `showPromptInput`.
- [ ] Add `persistenceVersion: number` to `PersistedState`. On load,
      treat a missing field as version 1 and apply default
      `telegram` block. After successful load, write back with
      `persistenceVersion: 2`.
- [ ] Extend the `Project` record (`src/store/types.ts:25`) with
      `telegramOptIn: boolean` defaulting to `false`, and
      `telegramPauseOnBackpressure: boolean` defaulting to `false`.
      Update the per-project loader / saver to coerce non-boolean
      values to `false`.
- [ ] Update the project-edit dialog (`EditProjectDialog.tsx`) with
      two checkboxes: "Allow Telegram bot to attach to this project"
      and "Pause agents when Telegram tail backpressures" (the second
      visible only when the first is on). Help text: "When off, the
      bot cannot read scrollback, push notifications, or accept
      commands targeting this project's agents."

## Token storage via safeStorage

- [ ] Implement `electron/telegram/store.ts` per `design.md` ("Token
      storage via safeStorage"). Functions: `writeToken(token)`,
      `readToken()`, `clearToken()`, `writeOpenAiKey(key)`,
      `readOpenAiKey()`, `clearOpenAiKey()`. Token file path:
      `<userData>/telegram-token.bin`. OpenAI key path:
      `<userData>/telegram-openai.bin`. Both with mode `0o600`.
- [ ] On platforms where `safeStorage.isEncryptionAvailable() === false`
      (Linux without libsecret), `writeToken` and `writeOpenAiKey`
      throw `TelegramError('encryption-unavailable')`. The Settings UI
      renders the verbatim message: "Encrypted token storage is
      unavailable. Install libsecret (Linux) or use the macOS Keychain."
- [ ] The renderer never receives the token. `SetTelegramConfig`
      carries an optional `token` (and optional `openaiApiKey`); the
      handler writes them via `store.ts` and drops the in-memory copy
      after the write. `GetTelegramStatus` returns `hasToken:
boolean` only.
- [ ] On `SetTelegramConfig` with `token: ""` (empty string), call
      `clearToken()` and stop the bot if it is running.

## Settings UI

- [ ] Add a new "Telegram" section to `SettingsDialog`. Fields per
      `design.md` ("Settings UI"). The bot-token input is a
      `<input type="password">` with a "Show" toggle; on save the
      field is cleared from the renderer state immediately after the
      IPC reply, and a `Token set ✓` indicator renders next to it
      when `hasToken === true`.
- [ ] The Settings section uses the theme tokens introduced in commit
      `ed1557e` (Themes settings tab) and obeys the dialog
      accessibility rules from
      `openspec/changes/improve-dialog-accessibility/`. Every input
      has a programmatic `label`/`aria-labelledby`; the section is
      keyboard-navigable in the same tab order as the existing
      sections.
- [ ] When the master toggle flips to on with no token, the toggle
      stays off and a one-line error appears under the toggle: "Set a
      bot token first."
- [ ] Add the allowed-chats list editor: numeric input + add button,
      each added chat appears as a chip with a remove button.
      Validate each input as a positive integer; reject negative or
      non-integer entries with a one-line inline error.
- [ ] Add the redaction-patterns textarea (one regex per line). On
      save, compile each line as `new RegExp(line, 'g')` inside a
      try/catch; if any line fails to compile, the field's error
      message names the line number and the regex error. Saving is
      blocked until every line compiles.
- [ ] Add the extra-question-patterns textarea with the same compile-
      validate behaviour as redaction patterns. Compiled with the
      `i` flag.
- [ ] Add the auto-tunnel toggle, visible only when `cloudflared` is
      detected in `PATH` (probed via main on Settings open and
      cached for the session). Toggling on while the remote server
      is running spawns a tunnel and updates `publicBaseUrl` in
      `TelegramStatus`.
- [ ] Add the voice subsection, hidden when `telegram.enabled` is
      false or `hasToken` / `allowedChatIds` are empty. Three
      controls: runtime picker (none / whisper.cpp / openai),
      whisper.cpp binary path (file picker, shown only when runtime
      = whisper-cpp), OpenAI API key (password input, shown only
      when runtime = openai). The OpenAI key is sent through
      `SetTelegramConfig` and never stored in renderer state.

## Bot lifecycle

- [ ] Implement `bot.ts`: `startBot(token: string)` constructs a
      `grammy` `Bot`, registers the command router and inline
      handlers, calls `deleteWebhook(drop_pending_updates: true)` to
      defeat stale webhook state, then `bot.start({
drop_pending_updates: true })`. On `getMe` failure the function
      throws `TelegramError`. The bot's `catch` handler routes every
      uncaught handler error to the logger under `telegram.bot` and
      replies to the offending chat with
      `Sorry — something went wrong. The error has been logged.`
- [ ] Implement `stopBot()` which calls `bot.stop()` and waits up to
      5 s for graceful shutdown before resolving. After 5 s the
      module's internal state is reset regardless so a later
      `StartTelegramBot` succeeds without a desktop restart.
- [ ] `index.ts` enforces "only one bot at a time": a second
      `StartTelegramBot` call while a bot is running returns the
      running bot's status without re-initializing. Pattern mirrors
      `electron/ipc/register.ts:920` for `StartRemoteServer`.
- [ ] Auto-resume: on `app.whenReady()`, if `telegram.enabled ===
true` and `readToken()` returns non-null, call `startBot`. On
      failure, surface the error to `lastError` but leave
      `enabled: true` in persisted state so a retry from Settings is
      a single click.
- [ ] Multi-instance conflict: when the first `getUpdates` after start
      returns `409 Conflict`, set `lastError` to
      `Another process is polling this bot token. Stop the other
instance or revoke the token.` and stop. Do not retry — the
      conflict will persist until the other instance stops.
- [ ] Bot blocked: on `403 Forbidden: bot was blocked by the user`,
      remove the offending chat id from `allowedChatIds`, persist the
      change via the renderer-facing IPC, and log under
      `telegram.audit` at `info` with `outcome: 'auto-remove'`.
- [ ] On `/start` from an unknown chat (chat id not in
      `allowedChatIds`), the bot replies with the chat id and the
      instruction text from `design.md` ("Allowed chats"), then drops
      every subsequent message from that chat until the id is added.

## Command router

- [ ] Implement each command in `commands.ts` per the table in
      `design.md` ("Command router"). Every command runs through a
      common preamble that (a) verifies the chat is allowed,
      (b) verifies any agent id argument exists, (c) verifies the
      target agent's project has `telegramOptIn === true`,
      (d) writes one `AuditEntry` to `audit.ts` before side-effects
      run. Failures reply with a single-line error.
- [ ] `/status <id>` calls the existing scrollback IPC and runs the
      result through `formatter.ts` (ANSI strip + chunk to 30 lines +
      redact + escapeMd2) before sending. The reply uses Telegram's
      `MarkdownV2` parse mode with the scrollback inside a
      triple-backtick block.
- [ ] `/prompt`, `/approve`, `/deny`, `/kill` route through the same
      PTY-write / kill helpers used by `electron/remote/server.ts`.
      The reply is a single-line ack: `→ prompted` / `→ approved` /
      `→ denied` / `→ killed`. Both the ack message and any later
      live-tail message are registered with `reply.ts` so a Telegram
      reply on the ack routes back to the agent.
- [ ] `/diff <id>` shells out to `git diff --stat` inside the agent's
      worktree using the existing helper in `electron/ipc/git.ts`.
      The reply is the stat output (escapeMd2-applied) inside a
      triple-backtick block, truncated to 3500 characters with
      `… (truncated)` if longer.
- [ ] `/tail <id>` opens a `LiveTailHandle` (see "Live tail" tasks
      below). `/untail <id>` closes one; if no tail exists for the
      chat/agent pair the reply is `No tail running for <id>.`
- [ ] `/steps <id>` reads the existing steps-tracking source per
      `openspec/specs/steps-tracking/spec.md` and returns the
      progress summary.
- [ ] `/ci <id>` calls the PR/CI status helpers planned in
      `openspec/changes/add-pr-ci-status/` (or `console.warn`s a stub
      reply if that change has not landed yet). When the PR/CI
      capability ships, the stub is replaced with the real call.
- [ ] `/cov <id>` reads the `Project.coverageReportPath` from the
      agent's project, parses the report via the existing coverage
      module in `electron/ipc/coverage.ts`, and replies with the
      summary inside a triple-backtick block.
- [ ] `/run <id> <bookmark>` looks up the named bookmark in the
      agent's project (`Project.terminalBookmarks` in
      `src/store/types.ts:20`) and writes the bookmark's `command`
      into the agent's PTY. If the bookmark name is unknown the
      reply is `Unknown bookmark "<name>".`
- [ ] `/ask <id> <question>` routes through the existing Ask-Code
      IPC in `electron/ipc/ask-code.ts`. The reply is the answer
      escaped through `escapeMd2`, truncated to 3500 characters,
      with `… (truncated)` if longer.
- [ ] Command aliases: register `/a`, `/p`, `/k`, `/d`, `/s`, `/t`,
      `/u` as aliases for `/agents`, `/prompt`, `/kill`, `/deny`,
      `/status`, `/tail`, `/untail`. `/help` lists both forms.

## Reply-chain routing

- [ ] Implement `reply.ts` with an LRU `Map<messageId, agentId>`
      bounded at 2 000 entries. Every bot-sent message that names an
      agent (status replies, prompt acks, live-tail messages,
      question notifications, idle notifications, exit
      notifications) is registered.
- [ ] On any Telegram message that is a reply (`message.reply_to_message`)
      from an allowed chat, look up the parent's id in the map. If
      found, treat the reply body as `/prompt <agentId> <body>` and
      route. If not found, ignore (do not error — older messages may
      have evicted from the LRU).

## Inline keyboard

- [ ] Implement `inline.ts` callbacks for `approve:<id>`, `deny:<id>`,
      and `open:<id>`. Each callback verifies the same preamble as
      the slash command counterpart (chat allowed, agent exists,
      project opted in) and then performs the same action. The bot's
      `answerCallbackQuery` is called with a 1-line toast
      (`Approved.` / `Denied.` / `Opening…`).
- [ ] After successful `approve`/`deny`, the bot edits the original
      notification message to append `\n— approved by <user>` (or
      `denied`) so the action is auditable in the chat history.
- [ ] `open:<id>` constructs the Mini App URL from
      `telegram.publicBaseUrl` + `?agent=<id>`. If `publicBaseUrl` is
      null, the callback replies with `Set a public URL in Settings
to open the full session.` and does NOT surface a `web_app`
      button.

## Question detector

- [ ] Implement `detector.ts` with the four base patterns from
      `design.md` ("Agent-question detection"). Subscribe to PTY
      output via `subscribeToAgent(agentId, cb)`. The callback receives
      **base64-encoded** chunks (see `pty.ts:518`), so each chunk is
      first decoded: `Buffer.from(encoded, 'base64').toString('utf8')`.
      Patterns are matched against the ANSI-stripped tail of the last
      8 KB of output per agent. Per-agent state is keyed by agent id
      and lives in a `Map` inside the module.
- [ ] Match coalescing: after a successful match for `(agentId,
patternId)`, suppress further matches of the same pair for
      30 s. Different pattern ids on the same agent fire
      independently.
- [ ] On match, build the notification payload per `design.md`'s
      example and push to every allowed chat whose `pushPolicy`
      permits questions (`'all'` or `'questions-only'`). Pushes go
      through `ratelimit.ts`. The notification body is the last
      non-empty line of the tail, run through `redact()` and
      `escapeMd2()`.
- [ ] User-extensible patterns: load any user entries from the
      `extraQuestionPatterns` field in `telegram` config and append
      them after the base set. Each user line compiles via
      `new RegExp(line, 'i')`; compile failures are logged under
      `telegram.detector` at `warn` and the entry is skipped.

## Idle detector

- [ ] Implement `idle.ts` per `design.md` ("Idle-after-activity
      detection"). The state machine is `idle → active → idle` keyed
      by agent id. Active = ≥ 2 chunks/sec sustained for ≥ 5 minutes.
      Idle fire = 60 s without a chunk after being active. Idle fires
      at most once per active span.
- [ ] On idle fire, push one notification per chat with
      `pushPolicy === 'all'`. The notification body is the last
      non-empty line of the tail, redacted and MD2-escaped. The
      keyboard has one button: `[👁 Open]`.

## Agent exit subscriber

- [ ] Add `subscribeToAgentExit(agentId, cb)` and
      `unsubscribeFromAgentExit(agentId, cb)` to `electron/ipc/pty.ts`
      alongside the existing data subscriber helpers at line 518. The
      callback receives the same `{ exitCode, signal, lastOutput }`
      payload that `pty.ts:434` already builds for the renderer's
      `Exit` event. Refactor the existing `Exit` send path so it also
      fans out to exit subscribers without duplicating the
      `lastOutput` parsing.
- [ ] `detector.ts`, `idle.ts`, and live tails subscribe to the
      exit event for the agents they track. On exit: - `detector.ts` drops the agent's match-state Map entry. - `idle.ts` resets state. - Live tails finalise their message with `\n— tail closed
(agent exited)` and unsubscribe.
- [ ] If `exitCode !== 0` or `signal !== null`, the formatter pushes
      an error notification to every chat with `pushPolicy ∈ {'all',
'errors-only'}`. The body shows the exit code, signal, and
      `lastOutput` lines (redacted + MD2-escaped).

## Live tail

- [ ] Implement `formatter.ts`'s `LiveTailHandle`: subscribes to the
      agent's PTY stream via `subscribeToAgent`, decodes the base64
      chunks, buffers, and on a 1 s tick emits at most one edit per
      chat through `ratelimit.ts`.
- [ ] Edit-target rotation: when the live message hits 3900
      characters (buffer below the 4096 cap to leave room for the
      MarkdownV2 wrapper), finalise the current message with a
      `— continued ↓` footer, send a fresh message, and route
      subsequent edits to it.
- [ ] Unsubscribe path: `/untail <id>` from the chat, or the agent
      exiting, both close the handle. The handle's last act is a
      one-line message: `agent-<id> tail closed (<reason>).`
- [ ] Concurrency cap: at most 3 live tails per chat. A fourth
      `/tail` reply is `Too many tails (limit 3). Use /untail to
free one.` and does not open the subscription.

## MarkdownV2 escaping

- [ ] Implement `formatter.ts`'s `escapeMd2(text: string): string`
      escaping the full reserved set
      (`_ * [ ] ( ) ~ ` > # + - = | { } . !`).
- [ ] Apply `escapeMd2` at every reply path that includes
      agent-derived content: scrollback, diff, live tail, question
      notification tail line, idle notification last line, voice
      transcript echo, file-upload path display, ask-code answer.
      Triple-backtick code blocks contain the escaped content; the
      backticks themselves are not escaped.

## Redaction

- [ ] Implement `redact.ts` with the base patterns from `design.md`
      ("Output sanitisation") plus the user-supplied list from
      `telegram.redactPatterns`. Run on already-ANSI-stripped text.
- [ ] Each match is replaced with `[REDACTED:<name>]`. User patterns
      use the index-suffixed name `user-<n>` so they remain
      distinguishable from the base set in case of bug reports.
- [ ] Apply redaction at the formatter boundary, NOT at the bot
      transport boundary: scrollback `/status` replies, `/diff`
      output, live tails, and question-detection notifications all
      pass through the same `redact()` call. Telegram bot API
      responses themselves are not redacted (no agent data flows
      through them).

## Rate limiting + PTY backpressure

- [ ] Implement `ratelimit.ts` with the two token buckets from
      `design.md` ("Live tail" subsection on rate limits):
      per-chat capacity 3 / refill 1 per second; global capacity 25 /
      refill 25 per second.
- [ ] Dropped updates: when a per-chat bucket is empty, replace the
      pending edit for that `(chat, agent)` pair rather than queue.
      Replays use the most recent edit only.
- [ ] `429 Too Many Requests` responses from Telegram trigger a
      sleep of `retry_after + 250 ms` jitter before any further send
      to that chat. The bucket capacity for that chat is halved
      until the next successful send to give Telegram further
      headroom.
- [ ] Optional PTY backpressure: when the rate limiter has dropped
      edits for the same `(chat, agent)` pair for 5 consecutive
      seconds AND the agent's project has
      `telegramPauseOnBackpressure === true`, call `pauseAgent(id)`
      from `electron/ipc/pty.ts:459`. On the next successful send,
      call `resumeAgent(id)` from `pty.ts:465`.

## Mini App initData verification

- [ ] Implement `initdata.ts` with
      `verifyInitData(initData: string, botToken: string,
allowedChatIds: number[]): TelegramInitData`. Throws
      `TelegramError` on any failure (tampered hash, expired
      auth_date, disallowed chat, malformed URL encoding). Steps
      follow Telegram's spec exactly: 1. Parse the URL-encoded payload. 2. Extract `hash`, sort the remaining `key=value` pairs
      alphabetically, join with `\n`. 3. Compute
      `secretKey = HMAC_SHA256(key="WebAppData", data=botToken)`. 4. Compute
      `dataHash = HMAC_SHA256(key=secretKey, data=joined)`. 5. Compare the hex of `dataHash` to `hash` with `timingSafeEqual`.
- [ ] Reject entries with `auth_date` older than 60 s.
- [ ] Reject entries whose embedded `chat.id` is not on
      `allowedChatIds`.
- [ ] Expose a new POST `/api/telegram-auth` route in
      `electron/remote/server.ts`. The body is the raw initData
      string; the response on success is the standard remote-server
      session token. The route only exists while
      `telegram.enabled === true`; otherwise it returns 404 to
      avoid leaking the bot's presence.
- [ ] Update the mobile SPA bootstrap in `src/remote/auth.ts` to try
      initData first when `window.Telegram?.WebApp?.initData`
      exists. On success, store the returned token in the same
      place as the QR-path token; on failure, fall back to the
      existing token-in-URL flow.

## Optional cloudflared tunnel

- [ ] Implement `tunnel.ts`: detect `cloudflared` in `PATH` (or at
      the user-configured `cloudflaredPath`). On `autoTunnel === true`
      and bot start, spawn `cloudflared tunnel --url
http://localhost:<remotePort>`. Parse stdout for the assigned
      `https://<random>.trycloudflare.com` URL. Set
      `tunnelActive: true` and `tunnelUrl: <url>` in
      `TelegramStatus`; update `publicBaseUrl` in memory.
- [ ] On bot stop OR Settings toggle off, SIGTERM the
      `cloudflared` process and clear the URL. Settle the tunnel
      child within 2 s; force-kill if it does not exit.
- [ ] Surface `cloudflared` stderr to `lastError` when the spawn
      fails to produce a URL within 10 s. The tunnel is best-effort
      — if it fails, the bot keeps running with
      `tunnelActive: false`.

## Voice prompts

- [ ] Implement `voice.ts` with the seven-step pipeline from
      `design.md` ("Voice prompts"). Downloads stream to a temp file
      under the OS temp directory; the file is deleted after
      transcription, regardless of outcome.
- [ ] Whisper.cpp runtime: spawn the user-configured binary with
      `-f <file> -otxt -of <output>` and read the produced text
      file. The spawn timeout is 60 s; on timeout the temp files
      are cleaned up and the chat receives `Transcription timed
out.`
- [ ] OpenAI runtime: POST the file to `/v1/audio/transcriptions`
      with `model: 'whisper-1'`. Use the existing `fetch` from the
      Node 22 standard library; no `node-fetch` dependency. The
      API key is read from `store.ts` via `readOpenAiKey()` — never
      from renderer state.
- [ ] Inject the transcript via the same PTY-write path as
      `/prompt`. Resolve the target agent in this order:
      reply-chain → focused agent (from `focus.ts`) → error reply
      `No agent is focused — open one on the desktop first, or
reply to a notification.`
- [ ] After successful transcription, reply with
      `🎙 → <transcript>` (redacted + MD2-escaped).

## File uploads

- [ ] Implement `upload.ts` to handle `document` and `photo`
      messages from allowed chats. The file is downloaded to a
      stable path under the OS temp directory (not the agent's
      worktree).
- [ ] Reply with the absolute path (inside a MarkdownV2 inline-code
      span) and an inline keyboard:
      `[📋 Paste path into agent]`. The button's callback writes
      the escaped path into the focused agent's PTY using the
      helper shared with the image-paste flow.
- [ ] Reject files larger than 20 MB (Telegram's bot-API ceiling)
      with a single-line message rather than attempting the
      download.

## Project opt-in enforcement

- [ ] Every command, inline callback, live tail, question
      notification, idle notification, exit notification, and voice
      / file inject MUST consult the agent's project
      `telegramOptIn` field before touching the agent. A project
      that flips the flag from on to off while a live tail is
      running causes the tail to close with the reason `project
opted out`.
- [ ] The flip-off path also clears any in-flight question /
      idle / exit notifications for the project's agents from the
      rate limiter's pending queues.

## Audit log

- [ ] Implement `audit.ts`: a single function `record(entry:
AuditEntry)` that emits a structured log entry under
      `telegram.audit` at `info`. Schema per `design.md` ("Audit
      log"): `ts`, `chatId`, `username`, `category`, `cmd`,
      `agentId`, `outcome`, `detail`. NEVER include token values,
      transcripts, file contents, or scrollback text.
- [ ] Every command handler, inline callback, voice ingest, file
      ingest, config change, and auto-remove (bot-blocked) event
      records exactly one entry.

## Observability

- [ ] All Telegram API errors log under `telegram.api` with the
      returned `error_code` and `description`. The logger's level
      gating (`openspec/specs/logging/spec.md`) determines
      visibility.
- [ ] The bot logs a single `info` entry on successful start with
      `{ botUsername, allowedChats: <count> }`, and a single `info`
      entry on stop with the same shape plus `runtimeMs`.
- [ ] `GetTelegramStatus` exposes `lastError: string | null` so the
      Settings UI can render the most recent error without polling
      the log.

## Tests

- [ ] Unit-test `redact.ts` with the base patterns plus edge
      cases: overlapping matches (jwt inside env-assign), empty
      strings, very long strings (1 MB), strings with ANSI not yet
      stripped (should be redacted post-strip, not before).
- [ ] Unit-test `formatter.ts`'s `escapeMd2`: every reserved
      character escaped, idempotent (escape-then-escape leaves
      backslashes alone is fine), code-block characters not
      escaped inside backticks.
- [ ] Unit-test `initdata.ts`'s `verifyInitData`: a known-good
      fixture from Telegram's docs, a tampered fixture, an expired
      fixture (`auth_date` 61 s old), a fixture with a `chat.id`
      not on the allowed list, a fixture with a malformed
      URL-encoding.
- [ ] Unit-test `detector.ts`'s pattern matcher: each base
      pattern hits exactly once in the canonical example output,
      suppresses its own re-fire for 30 s, lets different
      patterns through, and correctly handles base64-encoded
      chunks (assert the decoder runs before the regex).
- [ ] Unit-test `idle.ts`'s state machine: active → idle fires
      after 60 s silence post-activity, never fires twice without
      an intervening active span, resets on agent exit.
- [ ] Unit-test `ratelimit.ts`'s token bucket: standard refill,
      capacity cap, 429 path halves capacity, the recent-edit
      replacement rule, the 5-second sustained-drop trigger for
      `pauseAgent` when project opts in.
- [ ] Unit-test `reply.ts`'s LRU: 2 000-entry cap, oldest-evicted
      ordering, lookup correctness.
- [ ] Unit-test `store.ts`: `writeToken` round-trips through
      `readToken`; missing file returns null; encryption-
      unavailable path throws the right error.
- [ ] Integration test for `/api/telegram-auth`: spin up the
      remote server with `telegram.enabled = true`, POST a valid
      initData, assert a token is returned; POST an invalid one,
      assert 401; POST with `telegram.enabled = false`, assert 404.

## Documentation

- [ ] Add a "Remote control via Telegram" section to `README.md`
      after the existing "Mobile remote access" section. Cover:
      bot creation via BotFather, the `/start` → allowed-chats
      handshake, the cloudflared auto-tunnel option for Mini App
      support, the `safeStorage` token-storage caveat (libsecret
      on Linux), and the security caveats from the proposal
      ("Privacy" paragraph).
- [ ] Add `openspec/changes/add-telegram-control/` to the next
      release notes under "New capability: telegram-control".

## Validation

- [ ] `openspec validate --all --strict` passes.
- [ ] `npm run typecheck` passes.
- [ ] `npm run build` produces a working desktop app that runs
      the bot in long-poll mode end-to-end on macOS and Linux.
