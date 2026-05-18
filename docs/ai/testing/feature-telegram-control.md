---
phase: testing
title: Testing — Telegram control
feature: telegram-control
description: Slice 1 + Slice 2 test inventory and verification evidence
---

# Testing — Telegram control

## Coverage goals

- Unit-test every pure module: rate limiter, reply map, live-tail
  handle, question detector, idle detector, redaction, formatter.
- Integration smoke (manual) covers bot lifecycle, command surface,
  inline keyboard, reply-chain, project opt-in.
- Slice 3 will add: `initdata.verifyInitData` round-trip, `/api/telegram-auth`
  HTTP integration, store.ts round-trip (with electron module mocked),
  cloudflared tunnel spawn (gated on binary presence).

## Unit tests (vitest, alongside source)

| File                                  | Cases   | Module                                                                                                            |
| ------------------------------------- | ------- | ----------------------------------------------------------------------------------------------------------------- |
| `electron/telegram/ratelimit.test.ts` | 13      | per-chat + global buckets, refill cadence, 429 capacity halving, sustained-drop tracker, pending-edit replacement |
| `electron/telegram/reply.test.ts`     | 7       | LRU register / lookup / touch / eviction order / `forgetAgent`                                                    |
| `electron/telegram/livetail.test.ts`  | 9       | open / coalesce / rotate / close / ANSI-strip+redact / registry add/remove/closeAgent                             |
| `electron/telegram/detector.test.ts`  | 8       | base patterns, 30 s suppression, base64 decode, 8 KB tail cap, user patterns + bad pattern skip                   |
| `electron/telegram/idle.test.ts`      | 5       | active threshold, single fire per active span, forget, last-line capture                                          |
| `electron/telegram/redact.test.ts`    | 9       | base patterns (AWS, JWT, GH PAT, env-assign), large input, user pattern indexing, malformed user pattern          |
| `electron/telegram/formatter.test.ts` | 12      | stripAnsi, escapeMd2 (every reserved char + backslash), lastLines, truncate, codeBlock                            |
| **Telegram total**                    | **63**  |                                                                                                                   |
| **Repo total**                        | **580** |                                                                                                                   |

## Integration tests

- `electron/ipc/pty.test.ts` exercises the data subscriber surface used
  by detector + live tail; the exit-subscriber surface added in this
  slice has only inline coverage via `livetail.test.ts` (it uses an
  injected subscribe stub). Slice 3 should add a `pty.test.ts` case
  that spawns a short-lived process and asserts `subscribeToAgentExit`
  fires with the correct `exitCode`/`signal`/`lastOutput`.
- `electron/ipc/coverage.test.ts` (pre-existing) covers
  `readCoverageSummary` used by `/cov`.

## End-to-end / manual checklist

Manually verified during slice 2 development. To re-run on a fresh
build:

- [ ] Launch app, open Settings → Telegram, paste a BotFather token,
      enable, /start from your Telegram chat, accept the chat-id
      handshake.
- [ ] Toggle `telegramOptIn` on a project from EditProjectDialog. Spawn
      an agent that issues a `[y/N]` prompt; expect a notification with
      `[Allow] [Deny] [Open]` inline buttons.
- [ ] Tap `Allow`; verify the agent receives `y\n`, the chat message is
      edited to append `— approve by <user>`, audit log shows
      `category=inline cmd=approve outcome=ok`.
- [ ] Send `/tail <agentId>`, verify the bot replies with a fresh
      message and edits it as the agent emits output. Verify at most
      one edit per second per chat.
- [ ] Send `/untail <agentId>`, verify the latest message gets the
      `— tail closed (user)` footer.
- [ ] Reply (Telegram's "reply to") to any tagged bot message with
      free-form text; verify the agent receives the body as a prompt.
- [ ] Edit redaction patterns in Settings, save, verify a fresh
      `/status` redacts matches as `[REDACTED:user-N]`.
- [ ] Flip the project's `telegramOptIn` to false while a live tail is
      running; verify the tail closes with reason `project opted out`.
- [ ] Stop the bot from Settings; verify long-poll terminates and the
      notifier no longer fires (spawn another `[y/N]` prompt — no
      notification).

## Test reporting

- `npm run test` — vitest run (no coverage). Currently 580 pass / 0 fail.
- `npm run test:coverage` — vitest run with coverage gathering. Not yet
  run for this slice; defer to slice 3 alongside the integration tests.
- `npm run check` — typecheck + eslint + prettier — all green.

## Test data

- Telegram base64 chunks: synthesised via
  `Buffer.from(plain, 'utf8').toString('base64')` in tests.
- Mock TailIO: `livetail.test.ts` defines a hand-rolled `TailIO` that
  records every send/edit/registerForReplyChain call.
- No fixtures on disk; everything is synthetic.

## Known gaps

- No test for `initdata.verifyInitData` — module not built (slice 3).
- No test for `store.ts` `safeStorage` flow — Electron module mock
  required; deferred.
- No integration test for `notifier.start()` against a live grammy
  Bot — would require either a Telegram sandbox token or a grammy mock
  (`Transformer` API); deferred.
