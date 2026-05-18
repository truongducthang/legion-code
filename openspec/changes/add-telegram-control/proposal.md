# Add Telegram Control

## Why

The existing remote-access capability (`openspec/specs/remote-access/spec.md`)
solves "see my agents on a phone" but requires the phone and desktop to be on
the same LAN or share a Tailscale tailnet, and it requires the user to keep a
browser session open to receive any kind of update. It cannot deliver a push
notification when an agent stops to ask the human a question, it cannot wake
the user when an agent crashes overnight, and it has no answer for users on
networks where neither LAN nor Tailscale is available (mobile data, locked
corporate WiFi, café hotspots, etc.).

Telegram solves all three: its server-side relay makes the desktop reachable
from anywhere without port-forwarding or VPN, its push channel delivers
native lock-screen notifications, and its bot API gives a low-friction
control surface (inline keyboards, voice messages, file uploads) that does
not require the user to open the desktop app at all.

The premium experience is not "Telegram replaces the SPA" — it is "Telegram
becomes the always-on notification and quick-control surface; the SPA opens
inside Telegram's Mini App when a deep session is needed." Both share one
auth model so the user never types a token.

## What changes

- New capability `telegram-control` covering bot lifecycle, command surface,
  inline-button handling, agent-question detection, idle-after-activity
  detection, agent-exit notifications, Mini App auto-auth, voice prompt
  ingestion, file-upload-to-path conversion, reply-chain routing, audit
  log, and optional cloudflared tunnel.
- New module `electron/telegram/` (bot client, command router, output
  formatter with MarkdownV2 escaping, agent-question detector, idle
  detector, redaction filter, rate limiter with optional PTY backpressure,
  Mini App initData verifier, voice + file ingest, encrypted secret store
  on top of Electron `safeStorage`, audit log, optional cloudflared
  spawner, main-side focused-agent cache).
- New IPC channels: `StartTelegramBot`, `StopTelegramBot`,
  `GetTelegramStatus`, `SetTelegramConfig`, `SetFocusedAgent`. Channel
  names go in the `IPC` enum in `electron/ipc/channels.ts` and in the
  hardcoded `ALLOWED_CHANNELS` set in `electron/preload.cjs`.
- New parallel subscriber surface on `electron/ipc/pty.ts`:
  `subscribeToAgentExit` / `unsubscribeFromAgentExit` so the bot can clean
  up state and push exit-error notifications. The existing renderer
  `Exit` event keeps working unchanged.
- Encrypted secret storage on disk for the bot token and the optional
  OpenAI Whisper API key via Electron `safeStorage`. The renderer never
  sees either credential; both live in `<userData>/telegram-*.bin` with
  mode `0o600`.
- New non-secret persisted fields under a `telegram` object in
  `PersistedState`: `enabled`, `allowedChatIds`, `pushPolicy`,
  `redactPatterns`, `extraQuestionPatterns`, `publicBaseUrl`,
  `autoTunnel`, `cloudflaredPath`, `voice.runtime`,
  `voice.whisperCppPath`. Persisted via the existing renderer pattern in
  `src/store/persistence.ts` (the main-side `electron/ipc/persistence.ts`
  remains a dumb JSON blob save/load and does not learn the shape).
  Strict per-field coercion so corrupted state cannot silently re-enable
  the bot.
- Top-level `persistenceVersion: number` bump to 2 with backward-compat
  read of unversioned snapshots as version 1.
- New `Project` fields: `telegramOptIn: boolean` (default `false`),
  `telegramPauseOnBackpressure: boolean` (default `false`).
- Settings UI: new "Telegram" section in `SettingsDialog` for token
  entry, allowed-chat capture (the bot replies with its chat id on
  `/start` from an unknown chat; the user copies it into the allowed
  list), push-policy picker, redaction-pattern textarea,
  extra-question-pattern textarea, public-URL field, auto-tunnel toggle,
  voice subsection, and on/off toggle. The section reuses the theme
  tokens introduced in commit `ed1557e` (Themes settings tab) and obeys
  the dialog accessibility rules from
  `openspec/changes/improve-dialog-accessibility/`.
- Mobile SPA gains a second auth path: when loaded inside Telegram
  WebApp it receives `Telegram.WebApp.initData`; the desktop server
  verifies the HMAC signature with the bot token and issues a normal
  session token. The existing QR + token path stays intact for
  non-Telegram clients. This change touches `electron/remote/server.ts`
  (new auth verifier) but does not change the remote-access spec — the
  new auth path is additive.
- Codebase-integration commands: `/steps` (reads `steps.json` per
  `openspec/specs/steps-tracking/`), `/ci` (PR/CI status per
  `openspec/changes/add-pr-ci-status/`), `/cov` (parses
  `Project.coverageReportPath`), `/run <bookmark>` (executes
  `Project.terminalBookmarks` entries), `/ask` (routes through
  `electron/ipc/ask-code.ts`).
- Optional Whisper integration for voice-to-prompt: the bot downloads a
  Telegram voice message, transcribes it, and injects the transcript
  into the reply-chain target or the renderer-mirrored focused agent.
  Whisper runtime is configurable (`whisper.cpp` local binary path, or
  OpenAI Whisper API key); voice support is feature-gated and disabled
  by default.

## Impact

- New capability `telegram-control`.
- New runtime dependency: `grammy` (chosen over `node-telegram-bot-api`
  for ESM + TypeScript + Mini App typing; see `design.md`).
- No change to the existing `remote-access` capability spec. The Mini
  App auto-auth verifier is implemented inside the remote server module
  but is exposed only when `telegram.enabled` is true; the QR + token
  flow is preserved.
- The `electron/ipc/pty.ts` API surface grows by two functions
  (`subscribeToAgentExit`, `unsubscribeFromAgentExit`); the existing
  `Exit` event broadcast keeps the renderer flow intact.
- Network: outbound HTTPS to `api.telegram.org` (long-polling). Mini
  App support additionally requires an inbound HTTPS endpoint, which
  the user can provide via the optional cloudflared auto-tunnel, or
  manually via Tailscale Funnel, ngrok, or a reverse proxy. The bot
  still works for commands and notifications without a public URL.
- Token security: the bot token and OpenAI API key are stored
  encrypted via Electron `safeStorage` (macOS Keychain, libsecret on
  Linux). On platforms where `safeStorage.isEncryptionAvailable()` is
  false (a Linux system without libsecret), the change refuses to
  store the token rather than fall back to plaintext; the Settings UI
  surfaces a verbatim install hint.
- Cross-platform: macOS and Linux only (matches `CLAUDE.md`'s
  supported-platform list). No Windows path.
- Privacy: agent output crosses Telegram's servers. The redaction
  filter is enabled by default with a baseline pattern set (common
  API-key prefixes, JWT shape, AWS access-key id shape, `.env`-style
  assignments). Users opt in per project via the existing
  project-edit dialog; the bot refuses to attach to a project whose
  `telegramOptIn` field is `false` (default).
- Audit: every command, inline callback, voice ingest, file ingest,
  config change, and auto-remove event is recorded as a structured
  audit entry under `telegram.audit`. Entries never include token
  values, transcripts, file contents, or scrollback text.
- Rate limits: Telegram caps bot messages at 30/sec globally and
  ~1/sec per chat. Agent output (which can be hundreds of lines per
  second) is funneled through a per-chat token bucket and a single
  rolling "live tail" message that the bot edits in place via
  `editMessageText`, rather than spammed as new messages. Sustained
  drops can optionally call `pauseAgent` / `resumeAgent` on
  `electron/ipc/pty.ts` to relieve the producer; this behaviour is
  opt-in per project.
- Logging: the bot module emits structured log entries under
  `telegram.*` categories. The logging surface is defined in
  `openspec/changes/add-structured-logging/`; if that change has not
  landed, the bot falls back to `console.warn` / `console.error` under
  the same category tags so the eventual migration is mechanical.
