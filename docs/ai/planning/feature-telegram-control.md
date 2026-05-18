---
phase: planning
title: Planning — Telegram control
feature: telegram-control
description: Source of truth lives in OpenSpec; this stub points at it.
---

# Planning — Telegram control

**Source of truth: [`openspec/changes/add-telegram-control/tasks.md`](../../../openspec/changes/add-telegram-control/tasks.md).**

Every implementation task with its precise wording lives in the OpenSpec
tasks file linked above. The slice breakdown below indexes those tasks
against the actual delivery batches.

## Slice 1 delivery checklist (this branch)

- [x] Add `grammy` dependency
- [x] Scaffold `electron/telegram/` module (`types`, `store`, `focus`,
      `audit`, `formatter`, `redact`, `config`, `integration`, `bot`,
      `commands`, `index`)
- [x] Add five IPC channels (`StartTelegramBot`, `StopTelegramBot`,
      `GetTelegramStatus`, `SetTelegramConfig`, `SetFocusedAgent`) to the
      `IPC` enum and to `preload.cjs` `ALLOWED_CHANNELS`
- [x] Wire five thin handlers in `electron/ipc/register.ts`
- [x] Extend `PersistedState` with `telegram` block and
      `persistenceVersion: 2`; treat unversioned snapshots as v1
- [x] Extend `Project` with `telegramOptIn` (default `false`) and
      `telegramPauseOnBackpressure` (default `false`)
- [x] Strict per-field coercion in `src/store/persistence.ts`
- [x] `safeStorage` token + OpenAI-key storage in `store.ts` with
      `encryption-unavailable` refusal path
- [x] Bot long-poll lifecycle: `getMe`, `deleteWebhook`,
      `start({ drop_pending_updates: true })`, graceful stop with 5 s
      timeout, 409 conflict surfacing, 403 auto-remove
- [x] Allowed-chat handshake on `/start` from unknown chats
- [x] MVP commands `/agents`, `/status`, `/prompt`, `/approve`, `/deny`,
      `/kill`, `/help`, plus shortcuts `/a`, `/s`, `/p`, `/d`, `/k`
- [x] MarkdownV2 escaping at every reply path that touches agent output
- [x] Baseline redaction patterns applied before MD2 escape
- [x] Structured audit entries via `log` category `telegram.audit`
- [x] Auto-resume on `app.whenReady` when `telegram.enabled` and a token
      exists; failures surface to `lastError` without flipping `enabled`
- [x] `SetTelegramConfig` reactor: token change restarts a running bot,
      empty-token clears storage and stops, enable/disable transitions
      start/stop accordingly
- [x] `SaveAppState` handler forwards the JSON blob to
      `electron/telegram/integration.setStateBlob` so the bot can resolve
      `agentId → task → project → telegramOptIn`
- [x] Settings UI section in `SettingsDialog`: master toggle, token
      input (password + Show + clear), allowed-chat chip editor with
      validation, push-policy radio, status block with Start/Stop and
      `lastError` display, 3-second status polling while dialog is open

## Out of scope for slice 1

- Question / idle / exit notifications (slice 2)
- Live tail, rate limiting, PTY backpressure (slice 2)
- Reply-chain routing and inline keyboard callbacks (slice 2)
- Mini App `initData` auth (slice 3)
- cloudflared auto-tunnel (slice 3)
- Voice transcription (slice 3)
- Document / photo upload to PTY paste (slice 3)
- Per-project opt-in checkbox in `EditProjectDialog.tsx` UI surface
  (slice 2 — persisted field already exists and is honored by main)
- Redaction / extra-question-pattern textareas in Settings UI
  (slice 2 — persisted fields already exist; defaults are used today)
- Voice / cloudflared sections in Settings UI (slice 3)
- Test suite (slice 2 ships the unit tests for the modules implemented
  in slices 1 + 2 together)

## Slice 2 delivery checklist (this branch)

- [x] `electron/ipc/pty.ts` — new `AgentExitInfo` export, per-session
      `exitSubscribers` set, `subscribeToAgentExit` /
      `unsubscribeFromAgentExit` helpers, exit fan-out alongside the
      renderer `Exit` event
- [x] `electron/telegram/types.ts` — add `QuestionMatch`, `ExitInfo`,
      `LiveTailHandle`, `NotificationCategory`
- [x] `electron/telegram/ratelimit.ts` — per-chat + global token buckets,
      429 capacity halving, sustained-drop tracker, pending-edit replacer
- [x] `electron/telegram/reply.ts` — 2 000-entry LRU `message_id → agentId`
      with touch-on-lookup, `forgetAgent` cleanup on exit
- [x] `electron/telegram/livetail.ts` — `LiveTailHandle` with 1 s coalesce,
      3 900-char rotation, footer-on-close, optional PTY backpressure
      pause/resume; `LiveTailRegistry` with per-chat cap (default 3)
- [x] `electron/telegram/detector.ts` — 4 base patterns + extra-question
      user patterns, 30 s per-pattern suppression, 8 KB rolling tail,
      base64 decode
- [x] `electron/telegram/idle.ts` — `idle → active → idle` state machine,
      5 min active threshold, 60 s silence trigger, one-shot per active
      span, exit resets state
- [x] `electron/telegram/preamble.ts` — shared chat-allowed / agent-resolve /
      audit helpers used by both commands and inline callbacks
- [x] `electron/telegram/inline.ts` — `approve:<id>`, `deny:<id>`,
      `open:<id>` callbacks; appended `— approved by <user>` audit
      footer; `web_app` button gated on `publicBaseUrl`
- [x] `electron/telegram/notifier.ts` — orchestrator that owns detector,
      idle, limiter, reply map, tail registry; subscribes to PTY
      lifecycle events; pushes question / idle / exit notifications
      through the limiter; honors `pushPolicy` per category
- [x] `electron/telegram/commands.ts` — slice 2 commands (`/diff /tail
/untail /steps /cov /run /ask`) plus aliases `/t /u`, expanded
      `/help` body
- [x] `electron/telegram/bot.ts` — wires `registerInlineCallbacks`,
      reply-chain `message:text` handler, notifier `start()` / `stop()`
- [x] `electron/telegram/integration.ts` — projects cache now exposes
      `path`, `coverageReportPath`, `terminalBookmarks` plus
      `getProjectByAgentMeta` / `getWorktreeByAgentMeta` helpers
- [x] `src/store/telegram.ts` — `setTelegramRedactPatterns` /
      `setTelegramExtraQuestionPatterns` IPC helpers
- [x] `src/store/projects.ts` — `updateProject` now accepts
      `telegramOptIn` and `telegramPauseOnBackpressure`
- [x] `src/components/EditProjectDialog.tsx` — opt-in checkboxes for
      project-level Telegram access and backpressure pause
- [x] `src/components/TelegramSettings.tsx` — redaction-patterns and
      extra-question-patterns textareas with per-line compile validation
- [x] Unit tests: `ratelimit`, `reply`, `livetail`, `detector`, `idle`,
      `redact`, `formatter` (63 telegram tests; 580 repo-wide vitest)
- [x] Verification: `npm run check` (typecheck + eslint + prettier) and
      `npm run test` all green

## Out of scope for slice 2

- Mini App `initData` auth + POST `/api/telegram-auth` (slice 3)
- cloudflared auto-tunnel (slice 3)
- Voice transcription (slice 3)
- Document / photo upload to PTY paste (slice 3)
- README "Remote control via Telegram" section (slice 3)
- `openspec validate --all --strict` enforcement and pty.test integration
  coverage for the new exit subscriber surface (slice 3 will add an
  integration test against a real spawned PTY)

## Slice 3 delivery checklist (this branch)

Source of truth for each task body lives in
[`openspec/changes/add-telegram-control/tasks.md`](../../../openspec/changes/add-telegram-control/tasks.md).
The slice-3 deliverable closes the remaining sections there.

### Mini App initData authentication

- [x] `electron/telegram/initdata.ts` — `verifyInitData(initData, botToken,
allowedChatIds, nowMs?): TelegramInitData`. Parses URL-encoded
      payload, sorts non-hash pairs alphabetically joined with `\n`,
      derives `secret = HMAC_SHA256("WebAppData", botToken)` then
      `dataHash = HMAC_SHA256(secret, joined)` and `timingSafeEqual`s
      against the provided `hash`. Rejects `auth_date` older than 60 s.
      Rejects when the embedded `chat.id` (or `user.id` when `chat` is
      absent for DM payloads) is not on `allowedChatIds`. Throws
      `TelegramError` on every failure.
- [x] `TelegramInitData` shape + `TelegramInitDataUser` / `…Chat` + new
      `TelegramErrorCode` entries (`initdata-malformed`,
      `initdata-tampered`, `initdata-expired`, `initdata-disallowed-chat`)
      in `electron/telegram/types.ts`.
- [x] `electron/telegram/initdata.test.ts` — 12 cases: known-good,
      chat-id wins over user-id, tampered hash, wrong-token hash, expired
      payload, 60 s boundary acceptance, disallowed chat, missing hash,
      missing auth_date, missing chat/user, malformed user JSON,
      uppercase-hex hash (malformed by strict shape check).
- [x] POST `/api/telegram-auth` route in `electron/remote/server.ts`
      with a new `telegramAuth: { verify }` opt. Body is the raw
      `initData` string capped at 4 KB. `verify` returning `true` →
      `200 { token: <session token> }` (server-static token); throwing →
      `401 unauthorized`; returning `false` → `404 not found`. Route is
      public — no bearer required — so the SPA can mint its token before
      having one.
- [x] Mobile SPA bootstrap — `src/remote/auth.ts:initAuth` is now
      async, tries `window.Telegram?.WebApp?.initData` first, falls back
      to the URL-token path and then localStorage. `App.tsx` awaits the
      async result.
- [x] Integration tests in `electron/remote/server.test.ts` — 7 cases:
      200 with session token; 401 on throw; 404 when `verify` returns
      false; 404 when hook absent; 413 oversize; bearer-not-required;
      raw body round-trips to `verify` unchanged.

### Optional cloudflared tunnel

- [x] `electron/telegram/tunnel.ts` — detects `cloudflared` at
      `config.cloudflaredPath` (or via PATH). Spawns
      `cloudflared tunnel --url http://localhost:<remotePort>`. Parses
      stdout AND stderr for `https://<random>.trycloudflare.com`. Exposes
      `getTunnelStatus(): { active; url; lastError }`. SIGTERM on stop
      with a 2 s force-kill fallback. URL-timeout fallback kills the
      child and captures the first stderr line as `lastError`. ENOENT
      surfaces as a clear "binary not found" message. Idempotent for the
      same `remotePort`.
- [x] Wired into the bot lifecycle: `startTelegramBot()` →
      `reconcileTunnel()`; `stopTelegramBot()` → `stopTunnel()`;
      `applyConfigUpdate` re-reconciles on toggle/path change.
      `setRemoteServerPort(port | null)` exported from
      `electron/telegram/index.ts`; `register.ts` calls it after
      `StartRemoteServer` / `StopRemoteServer` so the bot can decide
      whether to spawn cloudflared.
- [x] `TelegramStatus.tunnelActive` and `tunnelUrl` reflect the live
      tunnel state via `getTunnelStatus()`; `lastError` falls back to the
      tunnel's lastError when the bot itself has none.
- [x] `electron/telegram/tunnel.test.ts` — 9 cases: URL via stdout;
      user-configured path; URL via stderr; start timeout → lastError;
      first stderr captured on early exit; ENOENT surface; idempotent
      re-call for same port; stopTunnel sends SIGTERM and clears state;
      stopTunnel no-op when nothing is running.

### File / photo uploads

- [x] `electron/telegram/upload.ts` — handles `message:document` and
      `message:photo`. Rejects >20 MB. Resolves `file_id → file_path` via
      `ctx.api.getFile` and streams the download into
      `<os.tmpdir>/parallel-code-telegram-uploads/<short-id>-<sanitized>`.
      Reply: MD2-escaped inline-code path + `[📋 Paste path into agent]`
      keyboard.
- [x] `upload:<token>` callback handler dispatched from `inline.ts`
      (extended `parseData` action set to include `upload`). The paste
      handler consumes the token (single-use), resolves the focused
      agent through `preamble.resolveAgent` (project opt-in enforced),
      and writes the shell-escaped path via `writeToAgent`.
- [x] Audit entries: `category: 'upload'` on save (cmd `'save'`),
      paste (cmd `'paste'`), and reject (cmd `'reject'` for oversized
      files).
- [x] `bot.ts` registers both `bot.on('message:document')` and
      `bot.on('message:photo')` via `registerUploadHandlers`.
- [x] `electron/telegram/upload.test.ts` — shellEscapePath cases
      (plain pass-through, spaces wrapped, single-quote escape,
      metacharacter quoting) plus an empty-store lookup case.

### Voice prompts

- [x] `electron/telegram/voice.ts` — 8-step pipeline (chat-allowed,
      runtime check, target resolve, download, transcribe, inject, echo,
      cleanup). `whisper-cpp` runtime: spawn the configured binary with
      `-f <file> -otxt -of <output>`, 60 s timeout, kill + cleanup on
      timeout, read `<output>.txt`. `openai` runtime: POST to
      `/v1/audio/transcriptions` with `model: 'whisper-1'`, multipart
      body (Node built-in `FormData` + `Blob`), Bearer header from
      `store.readOpenAiKey()`. Temp files cleaned in all paths.
- [x] Target resolution order: reply-chain (via
      `notifier.replyMap.lookup`) → focused agent (via
      `getFocusedAgent()`) → error reply with the exact spec text. The
      resolved agent passes through `preamble.resolveAgent` so the
      project opt-in gate fires before any download.
- [x] On success: `writeToAgent(agentId, transcript + '\n')` and a
      `🎙 → <transcript>` echo reply (redacted + MD2-escaped). The
      echo's message_id is registered with `notifier.replyMap` so
      reply-chain replies route back. Audit `category: 'voice'`.
- [x] `bot.ts` registers `bot.on('message:voice')` via
      `registerVoiceHandlers`. `runtime === 'none'` short-circuits with
      the verbatim "Voice input is disabled. Enable it in Settings."
      reply and never downloads.

### Settings UI extensions

- [x] `TelegramSettings.tsx` — added Mini App public URL field with
      Save button, cloudflared auto-tunnel toggle (visible only when
      `probeCloudflared` succeeds; shows the version when known),
      cloudflared path override (with re-probe on save), and the voice
      subsection (runtime radio picker, whisper.cpp binary path picker
      shown only for `whisper-cpp`, OpenAI key password input shown only
      for `openai`). OpenAI key flows through `SetTelegramConfig` and is
      dropped from local state after save.
- [x] `IPC.ProbeCloudflared` channel added to `channels.ts` and
      `preload.cjs` `ALLOWED_CHANNELS`; handler in `register.ts` calls
      `probeTelegramTunnel()`. Settings probes once per dialog open and
      caches the result.

### Documentation + validation

- [x] `README.md` — added "Remote control via Telegram" section
      covering BotFather setup, `/start` allowed-chat handshake,
      command surface, Mini App + cloudflared auto-tunnel, voice
      prompts (whisper.cpp + OpenAI runtimes), file uploads, and the
      privacy/redaction/audit caveats from the proposal.
- [x] `openspec validate --all --strict` — green via
      `npx --yes @fission-ai/openspec validate --all --strict`. All
      10 items pass strict validation including
      `change/add-telegram-control`.
- [x] `electron/ipc/pty.test.ts` — added a `subscribeToAgentExit`
      describe block with 6 mock-PTY cases (single-fire payload,
      numeric-signal coercion to string, unsubscribe path, renderer
      `Exit` event still fires alongside subscribers, unknown agent
      returns `false`, multi-subscriber fan-out). The exit-subscriber
      surface now has direct unit coverage; a real-spawned-PTY
      integration test remains a future enhancement for a dedicated
      CI job, but every spec scenario for the surface is asserted here.
- [x] `npm run typecheck` and `npm run lint` are both green.
      `vitest run electron/telegram/ electron/remote/server.test.ts`
      reports 96 / 96 passing (63 from slices 1–2 plus 33 new from
      slice 3). The full `vitest run` shows 17 failures in
      `coverage.test.ts`, `atomic.test.ts`, and `pty.test.ts` — every
      one is a pre-existing Windows-only POSIX issue
      (`mode 0o666 vs 0o600` on NTFS, `/bin/sh not found`, POSIX
      docker bind-mount paths). Confirmed unrelated to slice 3 by
      re-running with this slice's working-copy edits stashed; the
      failures persist. `prettier --check` is clean on every file
      this slice touched; the repo-wide format drift is CRLF line
      endings from Windows `core.autocrlf=true` and exists on
      pre-slice-1 commits.
