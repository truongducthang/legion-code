---
phase: requirements
title: Requirements — Telegram control
feature: telegram-control
description: Source of truth lives in OpenSpec; this stub points at it.
---

# Requirements — Telegram control

**Source of truth: [`openspec/changes/add-telegram-control/proposal.md`](../../../openspec/changes/add-telegram-control/proposal.md).**

This project uses OpenSpec for capability specs. The proposal, design,
tasks, and the per-capability `spec.md` for `telegram-control` are all
maintained under `openspec/changes/add-telegram-control/` until the change
ships, at which point the capability `spec.md` is archived into
`openspec/specs/telegram-control/`.

## What lives where

| Artifact                               | OpenSpec location                                                      |
| -------------------------------------- | ---------------------------------------------------------------------- |
| Problem statement, motivation, scope   | `openspec/changes/add-telegram-control/proposal.md`                    |
| Per-requirement scenarios              | `openspec/changes/add-telegram-control/specs/telegram-control/spec.md` |
| Implementation tasks                   | `openspec/changes/add-telegram-control/tasks.md`                       |
| Architecture, module layout, libraries | `openspec/changes/add-telegram-control/design.md`                      |

## Execution slices

The capability is shipped in incremental slices rather than one big merge:

- **Slice 1 (this branch)** — Module scaffolding, IPC, encrypted token
  storage via `safeStorage`, persistence schema v2 with the `telegram`
  block, per-project `telegramOptIn` opt-in, bot long-poll lifecycle, the
  MVP command set (`/agents`, `/status`, `/prompt`, `/approve`, `/deny`,
  `/kill`, `/help`, `/start` onboarding), allowed-chat handshake, 409
  conflict detection, 403 auto-remove, base redaction + MD2 escaping,
  Settings UI for token / allowed chats / push policy.
- **Slice 2** — Question detector, idle detector, exit notifications,
  live tail with rate limiter, reply-chain routing, inline keyboards,
  `/diff` `/steps` `/cov` `/run` `/ask` commands.
- **Slice 3** — Mini App `initData` verifier, cloudflared auto-tunnel,
  voice prompts (whisper.cpp + OpenAI), document/photo upload to PTY
  paste.

Verification before this slice ships: see
[`testing/feature-telegram-control.md`](../testing/feature-telegram-control.md).
