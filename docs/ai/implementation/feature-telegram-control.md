---
phase: implementation
title: Implementation — Telegram control
feature: telegram-control
description: Slice 1 + Slice 2 implementation notes, cross-checked against design.md
---

# Implementation — Telegram control

Source of truth for the design contract:
[`openspec/changes/add-telegram-control/design.md`](../../../openspec/changes/add-telegram-control/design.md).

This document summarises the as-built layout for slices 1 + 2 and the
deviations from `design.md` worth flagging.

## Module map (as built)

```
electron/telegram/
  index.ts        — public entry; IPC handler implementations
  bot.ts          — long-poll lifecycle, error fan-out, reply-chain handler
  commands.ts     — slash command router (MVP + slice 2 set)
  preamble.ts     — shared chat-allowed / agent-resolve / audit helper
  inline.ts       — callback_query handlers (approve / deny / open)
  notifier.ts     — orchestrator: detector + idle + limiter + reply map +
                    tail registry; subscribes to PTY lifecycle
  detector.ts     — agent-question pattern detector
  idle.ts         — idle-after-activity state machine
  livetail.ts     — LiveTailHandle + LiveTailRegistry (slice 2)
  formatter.ts    — stripAnsi / escapeMd2 / lastLines / truncate / codeBlock
  redact.ts       — secret-shape redaction (base + user patterns)
  ratelimit.ts    — per-chat + global token buckets, 429 handling, sustained-drop
  reply.ts        — LRU message_id → agentId map
  integration.ts  — projects/tasks cache fed by renderer state JSON blob
  config.ts       — non-secret config cache + coercion loader
  store.ts        — encrypted token / OpenAI key via Electron safeStorage
  audit.ts        — structured audit log via existing logger
  focus.ts        — renderer-mirrored focused agent id
  types.ts        — public types: TelegramConfig, TelegramStatus,
                    AuditEntry, QuestionMatch, LiveTailHandle, …
```

Files NOT yet present (deferred to slice 3): `initdata.ts`, `voice.ts`,
`upload.ts`, `tunnel.ts`.

## Deviations from `design.md`

- **LiveTailHandle lives in `livetail.ts`, not `formatter.ts`** —
  `formatter.ts` stays pure string helpers; the stateful tail logic is a
  separate module so it can be unit-tested without grammy mocks.
- **`Notifier` class is the orchestrator** — `design.md` lists the
  detectors / limiter / reply map as siblings of `bot.ts`. Wrapping them
  in one class keeps the lifecycle wiring in `bot.ts` to two lines
  (`new Notifier(bot); notifier.start()`) and gives commands.ts a single
  `getNotifier()` lookup for cross-component access (tail registry,
  reply map, worktree resolver).
- **`preamble.ts`** — `design.md` does not name a shared preamble module.
  The slice 1 implementation duplicated `chatAllowed`/`resolveAgent`
  inside `commands.ts`. Slice 2 needed the same checks from `inline.ts`,
  so the helpers moved out. Net diff is smaller; the public surface
  is unchanged.
- **`integration.ts` widened** — was `id/name/optIn` only; slice 2 needs
  `path`, `coverageReportPath`, `terminalBookmarks` for `/cov` and
  `/run`. Field-by-field coercion mirrors the persistence loader pattern.

## Spec compliance (slice 2 requirements)

Cross-reference against
[`openspec/changes/add-telegram-control/specs/telegram-control/spec.md`](../../../openspec/changes/add-telegram-control/specs/telegram-control/spec.md):

| Requirement                                                             | Status                                                         |
| ----------------------------------------------------------------------- | -------------------------------------------------------------- |
| Agent-question detection with 30 s suppression                          | implemented in `detector.ts`; unit-tested                      |
| Inline keyboard `[Allow] [Deny] [Open]`                                 | `notifier.ts` builds keyboard; `inline.ts` handles callbacks   |
| Idle-after-activity detection (single fire per active span)             | `idle.ts`; unit-tested                                         |
| Agent exit handling (subscribe surface + error notifications)           | `electron/ipc/pty.ts` exit subscriber + `notifier.onAgentExit` |
| Live tail (1 s coalesce, 3 900-char rotation, 3-per-chat cap)           | `livetail.ts` + `commands.ts:/tail`                            |
| MarkdownV2 escaping at every reply path                                 | `formatter.escapeMd2`; called from every send/edit             |
| Output sanitisation (base + user patterns, post-ANSI-strip)             | `redact.ts`                                                    |
| Rate limiting + optional PTY backpressure                               | `ratelimit.ts` + `livetail.ts:flush`                           |
| Reply-chain routing                                                     | `reply.ts` + `bot.ts:bot.on('message:text', …)`                |
| Push policy filtering                                                   | `notifier.chatsAllowing(category)`                             |
| Project opt-in gate (also closes live tails on flip-off)                | `preamble.resolveAgent`; tail-close on `closeAgent`            |
| Command surface (`/diff /tail /untail /steps /cov /run /ask` + aliases) | `commands.ts`                                                  |
| Audit log                                                               | `audit.ts` + `preamble.auditAndReturn`                         |

Slice 3 still owes: Mini App `initData` verifier and POST
`/api/telegram-auth` route; cloudflared auto-tunnel; voice + file
uploads; README "Remote control via Telegram" section;
`openspec validate --all --strict` pass.

## Integration points

- **PTY (`electron/ipc/pty.ts`)** — bot consumes `subscribeToAgent`
  (base64 chunks), the new `subscribeToAgentExit` (per-agent exit info),
  `writeToAgent`, `killAgent`, `pauseAgent`, `resumeAgent`,
  `getAgentScrollback`, `getActiveAgentIds`, `getAgentMeta`.
- **Persisted state (`src/store/persistence.ts`)** — owns the renderer
  side of `telegram` config; main reads it via
  `electron/telegram/config.ts:bootstrapFromPersistedState` and
  `setStateBlob` on each `SaveAppState`.
- **Logger (`electron/log.ts`)** — every Telegram module logs under
  categories `telegram.*`. Audit entries go through `telegram.audit`.

## Performance + resource notes

- **Token bucket capacity 25 global / 3 per chat** with sub-second
  refill keeps the bot inside Telegram's 30/sec hard cap with headroom.
- **`LiveTailHandle` coalesces output at 1 Hz**, so a chatty agent
  produces at most one `editMessageText` per second per chat regardless
  of PTY throughput.
- **Sustained-drop pause** (5 s of dropped edits for the same
  `(chat, agent)` pair) calls `pauseAgent` only when the project has
  `telegramPauseOnBackpressure === true` — default off; users opt in
  per-project from `EditProjectDialog`.
- **Question detector tail window** is bounded at 8 KB per agent.
- **Reply map** is bounded at 2 000 entries with LRU eviction.

## Security notes

- **Bot token** and **OpenAI API key** persist via `safeStorage` (macOS
  Keychain / Linux libsecret). `IsEncryptionAvailable()` is enforced;
  no plaintext fallback. Renderer never sees the plaintext token.
- **Project opt-in is mandatory** for every command, callback,
  notification, and live tail. `telegramOptIn === false` returns
  `That project is not opted in to Telegram control.` and audit-records
  `denied`.
- **Allowed-chat handshake** — first `/start` from an unknown chat
  echoes the chat id and instructions but takes no other action.
- **MarkdownV2 escaping** is applied to every agent-derived string
  before it crosses the bot transport.
- **Redaction filter** runs on already-ANSI-stripped text so escape
  sequences cannot mask matches. Settings UI labels it as best-effort,
  not a security boundary.

## Verification evidence (slice 2)

- `npm run check` (typecheck + eslint + prettier) — passes.
- `npm run test` — 580 / 580 tests pass; 63 of those exercise the
  telegram module (ratelimit 13, reply 7, livetail 9, detector 8,
  idle 5, redact 9, formatter 12).
- Manual integration smoke (long-poll start, `/agents`, `/status`,
  `/tail`, `/untail`, `/diff`, `/help`, project opt-in flip, inline
  approve/deny, reply-chain prompt) is the slice-3 follow-up; not yet
  documented here.

## Known follow-ups for slice 3

- Slice 3 ships the Mini App auth, cloudflared tunnel, voice prompts,
  and file/photo uploads. The `notifier.tailIO` interface is already
  factored so `index.ts` can extend it for those flows without
  re-shaping `livetail.ts`.
- README documentation block per `tasks.md` "Documentation" section.
- `openspec validate --all --strict` should pass after slice 3 closes
  out the deferred requirements.
