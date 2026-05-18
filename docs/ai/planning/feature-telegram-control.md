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
