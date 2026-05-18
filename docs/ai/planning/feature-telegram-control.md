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
