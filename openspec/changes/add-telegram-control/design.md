# Design — Add Telegram Control

## Three layers, one module

`electron/telegram/` is the single home for everything Telegram-related so the
boundary with the existing PTY/git/remote subsystems is one import line. The
module is split into three layers that map cleanly onto Telegram's three
surfaces:

```
electron/telegram/
  index.ts          ─ public entry: start/stop/status, IPC handlers
  bot.ts            ─ long-poll / webhook lifecycle, send/edit/answer wrappers
  commands.ts       ─ command router (/agents, /status, /prompt, /kill, …)
  inline.ts         ─ inline-keyboard callbacks (approve/deny/open-session)
  formatter.ts      ─ ANSI-stripping, scrollback chunking, live-tail editor,
                      MarkdownV2 escaping helper used by every reply path
  detector.ts       ─ agent-question detection from PTY chunks
  idle.ts           ─ "agent went quiet after long activity" detector
  redact.ts         ─ regex-based output sanitiser
  ratelimit.ts      ─ per-chat token bucket + global 25/sec governor with
                      optional PTY pause integration
  initdata.ts       ─ Telegram WebApp initData HMAC verifier
  voice.ts          ─ voice-message download + Whisper transcription
  upload.ts         ─ file/photo download + path injection
  reply.ts          ─ reply-chain routing (Map<messageId, agentId>) so
                      Telegram replies route to the source agent without
                      requiring an explicit <id>
  audit.ts          ─ structured audit log for every executed command
  tunnel.ts         ─ optional cloudflared spawn for Mini App public URL
  store.ts          ─ encrypted token store via Electron safeStorage, in
                      a file owned by main, never round-tripped through
                      the renderer
  config.ts         ─ non-secret persisted-state loader + change reactor
  focus.ts          ─ main-side cache of the renderer's focused agent id
  types.ts          ─ shared types
```

`index.ts` is the only file imported from outside the module. Every other file
is internal so the public surface can evolve without rippling.

## Library choice: `grammy`

`grammy` over `node-telegram-bot-api` because:

- Pure ESM, first-class TypeScript types, no `@types/` ambiguity.
- Built-in middleware composition fits the command router cleanly.
- Native Mini App helper types (`InitData`, `WebAppData`).
- Active maintenance; `node-telegram-bot-api` is stagnant on bug fixes.

Tradeoff: `grammy` ships its own session/store abstractions we will not use,
adding ~30 KB of bundle. Acceptable inside Electron main where bundle size
is irrelevant.

## Bot lifecycle

`StartTelegramBot` decrypts the persisted bot token from `store.ts`,
constructs a `grammy` `Bot` instance, registers the command router and
inline handlers, and starts long-polling via `bot.start({
drop_pending_updates: true })`. Long-polling is the default because it
requires no inbound HTTPS, no DNS, no certificates. Webhook mode is
supported but feature-gated on the presence of `publicBaseUrl` and
disabled in MVP.

Stopping calls `bot.stop()` and waits for in-flight handlers to settle.
The module is fully re-entrant: a second `StartTelegramBot` while one is
already running returns the existing instance's status (matching the
`remote-access` server's "only one server at a time" pattern from
`openspec/specs/remote-access/spec.md`).

### Auto-resume on app start

On Electron `app.whenReady()`, the module checks `telegram.enabled`. If
true and a token is stored, it auto-starts the bot. The renderer never
has to be open for the bot to come online — important for daemon-style
usage. Failures during auto-start surface to `lastError` and the bot
state stays `running: false` until the user retries via Settings.

### Multi-instance conflict detection

Telegram allows only one active long-poll per token. If the user runs
the same token on a second desktop, both processes silently fail. On
start, `bot.ts` calls `deleteWebhook(drop_pending_updates: true)` then
issues its first `getUpdates`. A `409 Conflict` response surfaces a
clear `lastError`: `Another process is polling this bot token. Stop the
other instance or revoke the token.` The retry loop is disabled so the
user sees the error immediately rather than churning.

## Allowed chats

Telegram bots receive messages from any chat that has previously sent
`/start`. The bot does NOT trust the sender by default; it consults the
`allowedChatIds` list before processing any command. A first-time
`/start` from an unknown chat receives a single reply with the chat id
and the literal text "Paste this id into Settings → Telegram → Allowed
chats, then send /start again." All further messages from that chat
are silently dropped until the user adds the id.

This pattern avoids the trap of trusting the bot token alone: the token
is enough to send messages but not to whitelist a chat, so a leaked
token cannot be used to drive agents without also compromising the
desktop's persisted config.

### Bot blocked / kicked from a chat

If Telegram returns `403 Forbidden: bot was blocked by the user` on any
send to a known chat, the chat id is auto-removed from `allowedChatIds`
and the event is logged under `telegram.audit` at `info`. This stops a
retry loop and keeps `connectedChats` honest in the status response.

## Command router

Commands are dispatched by `grammy`'s built-in `bot.command(name, handler)`.
The router is in `commands.ts` and is a thin layer over the existing
agent IPC surface in `electron/ipc/register.ts`. The MVP set:

| Command                | Effect                                                                                            |
| ---------------------- | ------------------------------------------------------------------------------------------------- |
| `/agents`              | Replies with a list of active agents, each as a one-liner with id                                 |
| `/status <id>`         | Replies with the last 30 scrollback lines for `<id>`, ANSI stripped                               |
| `/prompt <id> <text>`  | Writes `<text>\n` into `<id>`'s PTY                                                               |
| `/approve <id>`        | Writes `y\n` into `<id>`'s PTY                                                                    |
| `/deny <id>`           | Writes `n\n` into `<id>`'s PTY                                                                    |
| `/kill <id>`           | Sends the agent-kill IPC                                                                          |
| `/diff <id>`           | Replies with the agent worktree's `git diff --stat`                                               |
| `/tail <id>`           | Subscribes the chat to live tail (see "Live tail" below)                                          |
| `/untail <id>`         | Unsubscribes                                                                                      |
| `/steps <id>`          | Returns the current step-tracking progress (integrates `openspec/specs/steps-tracking/spec.md`)   |
| `/ci <id>`             | Returns the worktree's latest PR/CI status (integrates `openspec/changes/add-pr-ci-status/`)      |
| `/cov <id>`            | Returns the coverage summary (reads `Project.coverageReportPath`)                                 |
| `/run <id> <bookmark>` | Executes a saved terminal bookmark (reads `Project.terminalBookmarks`)                            |
| `/ask <id> <question>` | Routes through the existing Ask-Code IPC (`electron/ipc/ask-code.ts`) and replies with the answer |
| `/help`                | Lists commands                                                                                    |

Each command verifies (a) the chat id is allowed, (b) the agent id (if
present) is known, (c) the agent's project has `telegramOptIn = true`,
(d) the user-facing audit log records `(chatId, username, cmd, agentId,
ts)` before side-effects run. Failures get a one-line error reply.

### Reply-chain routing

When a chat replies (Telegram's "reply to") to a bot message that
`reply.ts` has tagged with an `agentId`, the bot infers the target and
treats the reply body as if the chat had typed `/prompt <id> <body>`.
The `Map<messageId, agentId>` is in-memory only, bounded to the last
2 000 entries with LRU eviction. Notifications, status replies, and
live-tail messages all tag themselves so any reply works without
typing `<id>`.

### Command shortcuts

`/a`, `/p`, `/k`, `/d`, `/s`, `/t`, `/u` alias `/agents`, `/prompt`,
`/kill`, `/deny`, `/status`, `/tail`, `/untail`. Aliases are listed in
`/help` so users discover them.

## Agent-question detection

The PTY layer in `electron/ipc/pty.ts` already emits per-agent output
events. `detector.ts` subscribes via `subscribeToAgent(agentId, cb)` —
the callback receives **base64-encoded** chunks (see `pty.ts:518`), so
the first step is always `Buffer.from(encoded, 'base64').toString('utf8')`.
On each decoded chunk, the detector strips ANSI, accumulates a rolling
tail window of the last 8 KB per agent, and matches a small ordered set
of patterns:

```ts
const QUESTION_PATTERNS: Array<{ id: string; rx: RegExp }> = [
  { id: 'yn-bracket', rx: /\?\s*\[y\/N\]\s*$/i },
  { id: 'yn-words', rx: /(?:do you (?:want|wish) to|proceed\??)\s*$/i },
  { id: 'claude-permission', rx: /Allow this (?:tool|command) to run\?/i },
  { id: 'press-enter', rx: /press (?:enter|return) to continue/i },
];
```

A match suppresses re-fire for the same agent + pattern id for 30 s to
avoid notification storms during repeated prompts. Each match enqueues
one "agent needs you" message with inline buttons:

```
🤖 agent-<id> is asking:
  > <last non-empty line of the tail>

[✅ Allow]   [❌ Deny]   [👁 Open]
```

`[Allow]` and `[Deny]` route through `inline.ts` and call the same PTY
write path used by `/approve` / `/deny`. `[Open]` constructs the Mini
App URL (see below) and sends a `web_app` inline button which Telegram
opens inside its in-app browser.

The pattern set is intentionally small and conservative: false negatives
(missing a question) are recoverable — the user still has `/tail` and
the Mini App — while false positives (waking the user when no input is
needed) destroy trust. New patterns must be opt-in via the redaction
textarea's sibling "extra question patterns" field, never added blindly.

## Idle-after-activity detection

`idle.ts` watches each agent's output rate. When an agent has been
active (>2 chunks/sec sustained) for at least 5 minutes and then emits
no chunk for 60 seconds, the detector pushes one notification per
allowed chat with `pushPolicy === 'all'`:

```
✅ agent-<id> looks done.
  > <last non-empty line>

[👁 Open]
```

A second idle event for the same agent does not re-fire until the
agent becomes active again — the state machine is `active → idle →
active`, idle never fires twice in a row.

## Agent exit notifications

`subscribeToAgent` only emits `data`. Agent exit is broadcast separately
via the renderer-facing `Exit` event (see `electron/ipc/pty.ts:434`).
The bot adds a parallel subscriber surface in `pty.ts`:

```ts
export function subscribeToAgentExit(
  agentId: string,
  cb: (info: { exitCode: number; signal: string | null; lastOutput: string[] }) => void,
): boolean;
```

`detector.ts` and `idle.ts` use it to clean up state on exit, and
the formatter uses it to push an error notification (`pushPolicy ∈
{'all', 'errors-only'}`) when `exitCode !== 0` or `signal !== null`,
including the same `lastOutput` lines main already builds for the
renderer.

## Live tail

`/tail <id>` opens a per-chat subscription. The first chunk after
subscription produces a new message; subsequent chunks edit the same
message via `editMessageText` until either (a) the message hits Telegram's
4096-character cap, in which case the formatter rotates to a new message
and the old one is finalised, or (b) the chat sends `/untail <id>`.

The editor coalesces chunks on a 1-second timer so a verbose agent
produces at most one edit per second per chat — staying inside the per-
chat rate limit. Coalescing is bounded by character count, not chunk
count: enough chunks to overflow the 4096 cap force a rotation
immediately.

`ratelimit.ts` enforces:

- per chat: ≤ 1 send/edit per second (token bucket, capacity 3)
- global: ≤ 25 sends/edits per second (token bucket, capacity 25;
  headroom below Telegram's 30/sec hard cap)

When a token bucket empties, new updates are dropped silently except
for the most recent edit per (chat, agent) pair, which is replayed when
a token frees up. This is the same "always show the latest" semantics
the renderer uses for its own scrollback throttling in `TerminalView`.

### Optional PTY backpressure integration

When the per-chat rate limiter has dropped edits for the same `(chat,
agent)` pair for 5 consecutive seconds, the limiter calls
`pauseAgent(agentId)` from `electron/ipc/pty.ts:459` to halt the
producer until the queue drains. On the next successful send, the
limiter calls `resumeAgent(agentId)` from `pty.ts:465`. This avoids
runaway memory growth when a chatty agent is being tailed by a Telegram
client on a slow link.

Tradeoff: pausing the agent because Telegram is slow is a surprising
side effect. The behaviour is opt-in per project via
`Project.telegramPauseOnBackpressure: boolean`, default `false`.

## Output sanitisation

`redact.ts` applies a baseline set of regex replacements before any agent
output leaves the desktop:

```ts
const BASE_REDACTIONS: Array<{ name: string; rx: RegExp }> = [
  { name: 'aws-akid', rx: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: 'gh-pat', rx: /\bghp_[A-Za-z0-9]{36,}\b/g },
  { name: 'gh-fine', rx: /\bgithub_pat_[A-Za-z0-9_]{82,}\b/g },
  { name: 'jwt', rx: /\beyJ[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\b/g },
  { name: 'sk-bearer', rx: /\bsk-[A-Za-z0-9_\-]{20,}\b/g },
  { name: 'env-assign', rx: /(?<=(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD)\s*[:=]\s*)\S+/gi },
];
```

User-provided patterns from `telegram.redactPatterns` are appended after
the baseline. Each match is replaced with `[REDACTED:<name>]`. The
filter runs on already-ANSI-stripped strings to avoid pattern bypass via
embedded escapes.

The filter is best-effort, not a security boundary. The user-visible
copy in `SettingsDialog` says so verbatim: "Redaction reduces accidental
leaks. Do not rely on it as a secret-management strategy."

## MarkdownV2 escaping is global

Telegram's MarkdownV2 parse mode reserves many characters
(`_ * [ ] ( ) ~ ` > # + - = | { } . !`). Any unescaped reserved
character in agent-derived content causes the message to be rejected
with `400 Bad Request: can't parse entities`.

`formatter.ts` exposes a single helper:

```ts
export function escapeMd2(text: string): string;
```

Every reply path that includes agent-derived content (scrollback, diff
output, live tail body, question-notification tail line, idle-notif
last line, voice-transcript echo, file-upload path display) runs the
final string through `escapeMd2` before calling `sendMessage` /
`editMessageText`. Triple-backtick code blocks contain the escaped
content; only the backticks themselves are not escaped.

## Mini App auth via initData

When a chat taps `[👁 Open]` or `/open <id>`, the bot constructs a URL of
the form `<publicBaseUrl>/?agent=<id>` and sends it as a `web_app` inline
button. Telegram opens the URL inside its WebApp container and injects
`window.Telegram.WebApp.initData`, a URL-encoded query string of user +
chat info plus an HMAC-SHA256 hash signed with `HMAC_SHA256(key="WebAppData",
data=botToken)`.

The mobile SPA bootstraps:

```ts
const initData = window.Telegram?.WebApp?.initData;
if (initData) {
  const r = await fetch('/api/telegram-auth', {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: initData,
  });
  if (r.ok) {
    const { token } = await r.json();
    // proceed as if scanned QR
  }
}
```

`initdata.ts` runs in main and verifies the hash per Telegram's docs
(`https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app`).
Verification is timing-safe and rejects entries with `auth_date` older
than 60 s — Telegram's recommended ceiling. On success, the server
issues a normal session token (same lifecycle as the QR path) and
returns it.

The route is registered in `electron/remote/server.ts` alongside the
existing `/api/agents` endpoints. It does NOT require a token (its
job is to issue one) but it does require `telegram.enabled` to be true
and the `chat.id` decoded from initData to be on `allowedChatIds`.

### Optional cloudflared auto-tunnel

`tunnel.ts` detects a `cloudflared` binary in `PATH` (or at a user-
configured path) and exposes an opt-in toggle in the Settings UI. When
enabled, the module spawns `cloudflared tunnel --url
http://localhost:<remotePort>`, parses stdout for the assigned
`https://<random>.trycloudflare.com` URL, and writes it to the
in-memory `publicBaseUrl`. On stop, the spawned process is SIGTERM'd
and the URL cleared. This is a UX shortcut, not a security feature —
the underlying `/api/telegram-auth` enforcement is unchanged.

## Focus tracking for voice / reply injection

The renderer already tracks `activeAgentId` per task (`src/store/types.ts`
line 219) but main does not see it. A new IPC channel
`SetFocusedAgent` (renderer → main, fire-and-forget) carries
`{ agentId: string | null }` whenever the focused agent changes. Main
caches the value in `focus.ts`; voice transcripts and reply-chain
fallbacks read it when no `<id>` is in the message.

Voice with no focused agent and no reply chain replies:
`No agent is focused — open one on the desktop first, or reply to a
notification.`

This is the only renderer → main state mirror this capability needs;
all other state lives in main already.

## Voice prompts

`voice.ts` subscribes to messages of type `voice`. On receipt:

1. Verify the sender is on `allowedChatIds`.
2. Resolve `voice.file_id` → `voice.file_path` via Telegram's `getFile`.
3. Stream-download `https://api.telegram.org/file/bot<token>/<path>`
   to a temp `.oga` (`opus` in OGG).
4. Run transcription via the configured runtime:
   - `whisper.cpp`: spawn the user-configured binary with the file path.
   - OpenAI API: POST to `/v1/audio/transcriptions`.
5. Resolve the target agent: reply-chain → focused agent → error reply.
6. Inject the transcript into the resolved agent's PTY.
7. Reply with `🎙 → <transcript>` (passed through `redact()` and
   `escapeMd2()`) so the user can see what was heard.

Voice is opt-in. The Settings UI hides the voice controls when no
transcription runtime is configured.

## File uploads

`upload.ts` reuses the same `file_id` → `file_path` → download pipeline
as voice. The downloaded file is saved to a temp path; the bot replies
with the path and an inline `[📋 Paste path into agent]` button that
writes the escaped path into the focused agent's PTY using the same
helper the existing image-paste flow uses
(`openspec/specs/terminal-image-paste/spec.md`).

This is intentionally a two-step flow rather than auto-paste: agents
should never receive surprise filesystem mutations from a chat the user
might have shared with a collaborator.

## Token storage via `safeStorage`

The bot token is a credential. It must never appear in the renderer's
`state.json` (which is plain-text JSON readable by anyone with disk
access) and must never round-trip through the renderer process (which
runs untrusted webview code).

`store.ts` owns the token life cycle entirely in main:

```ts
// electron/telegram/store.ts
import { safeStorage, app } from 'electron';
import { promises as fs } from 'fs';
import { join } from 'path';

function tokenPath(): string {
  return join(app.getPath('userData'), 'telegram-token.bin');
}

export async function writeToken(token: string): Promise<void> {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new TelegramError('encryption-unavailable');
  }
  const enc = safeStorage.encryptString(token);
  await fs.writeFile(tokenPath(), enc, { mode: 0o600 });
}

export async function readToken(): Promise<string | null> {
  try {
    const enc = await fs.readFile(tokenPath());
    return safeStorage.decryptString(enc);
  } catch {
    return null;
  }
}

export async function clearToken(): Promise<void> {
  try {
    await fs.unlink(tokenPath());
  } catch {
    /* ignore */
  }
}
```

`safeStorage` is backed by macOS Keychain on macOS, libsecret /
gnome-keyring on Linux. If the platform has no keychain available the
module refuses to write and the Settings UI surfaces the error
verbatim. There is no "fall back to plain text" path — users on
keychain-less Linux systems must install libsecret or use a different
remote-control approach.

The renderer never sees the token. `SetTelegramConfig` carries a
`token: string | undefined` field; if present, main writes it via
`store.ts` and immediately discards the in-memory copy. The renderer's
view via `GetTelegramStatus` is `{ ..., hasToken: boolean,
botUsername: string | null }` — never the token itself.

## Persisted state (non-secret)

```ts
type TelegramConfig = {
  enabled: boolean; // default false
  allowedChatIds: number[]; // default []; deduped on load
  pushPolicy: 'all' | 'questions-only' | 'errors-only'; // default 'questions-only'
  redactPatterns: string[]; // default []
  extraQuestionPatterns: string[]; // default []
  publicBaseUrl: string | null; // default null
  autoTunnel: boolean; // default false
  cloudflaredPath: string | null; // default null (auto-detect from PATH)
  voice: {
    runtime: 'none' | 'whisper-cpp' | 'openai';
    whisperCppPath: string | null;
    openaiApiKey: string | null;
  }; // default { runtime: 'none', ... }
};
```

This shape lives in `src/store/types.ts` under the existing
`PersistedState` and is loaded / saved by the existing renderer
persistence in `src/store/persistence.ts`. Every field gets an explicit
`typeof` / shape check, mirroring the `showPromptInput` coercion at
`src/store/persistence.ts:456`. A corrupted `enabled: "yes"` becomes
`false`, not `true`.

The main-side `electron/ipc/persistence.ts` continues to be a dumb
save/load of the renderer's JSON blob — it does NOT know the shape.

Two things are kept OUT of `PersistedState`:

- **Bot token** — handled entirely by `store.ts` via `safeStorage`.
- **`openaiApiKey`** — also handled by `store.ts` for the same reason;
  Settings UI sends it through `SetTelegramConfig` and immediately drops
  it from the renderer's reactive state after the IPC reply.

Project opt-in lives on the existing `Project` record:
`telegramOptIn: boolean` defaulting to `false`, plus
`telegramPauseOnBackpressure: boolean` defaulting to `false`. The bot
refuses to attach to a project with `telegramOptIn === false`; the
project-edit dialog gains a single checkbox.

## Settings UI

A new "Telegram" section in `SettingsDialog`:

- Master toggle (binds to `telegram.enabled`)
- Bot token field (password-style input, masked, with a "Show" toggle).
  On save, the token is sent via `SetTelegramConfig` and the field is
  cleared from the renderer immediately. The field renders empty on
  subsequent opens with a `Token set ✓` indicator next to it.
- Allowed chats list with add/remove (numeric input + paste from `/start`)
- Push policy radio: all / questions-only / errors-only
- Public URL field (with an inline `cloudflared` install hint)
- Auto-tunnel toggle (visible only when `cloudflared` is in `PATH`)
- Redaction patterns textarea (one regex per line)
- Extra question patterns textarea
- Voice section (hidden until token + at least one chat)

Field-level help mirrors the existing `verboseLogging` section's tone:
short, factual, points at the risk. The section reuses the theme
tokens introduced in commit `ed1557e` (Themes settings tab) and obeys
the dialog accessibility rules from
`openspec/changes/improve-dialog-accessibility/`.

## IPC channels

```ts
// electron/ipc/channels.ts (added to IPC enum)
StartTelegramBot   = 'start_telegram_bot',
StopTelegramBot    = 'stop_telegram_bot',
GetTelegramStatus  = 'get_telegram_status',
SetTelegramConfig  = 'set_telegram_config',
SetFocusedAgent    = 'set_focused_agent',
```

All five go in the hardcoded `ALLOWED_CHANNELS` set in
`electron/preload.cjs`. The preload's `channel.startsWith('channel:')`
fallback is for streaming events and does NOT cover these channels —
they must be added by exact match.

`GetTelegramStatus` returns:

```ts
type TelegramStatus = {
  running: boolean;
  lastError: string | null;
  connectedChats: number;
  botUsername: string | null;
  hasToken: boolean;
  tunnelActive: boolean;
  tunnelUrl: string | null;
};
```

The renderer polls it every 3 s while the Settings dialog is open,
matching the remote-server's status-polling cadence.

## Error handling

Telegram API errors are logged via the structured logger
(`openspec/specs/logging/spec.md`; note the spec lives in the
`add-structured-logging` change which must land first or, if it does
not, the bot module falls back to `console.warn` / `console.error`
under the same category tags) under category `telegram.api` with the
returned `error_code` and `description`. Network errors get one retry
with exponential backoff (1 s, 2 s, 4 s) before surfacing to
`lastError` in `GetTelegramStatus`. Rate-limit responses (HTTP 429)
honor `retry_after` exactly.

The bot module's public surface in `index.ts` exposes async functions
that throw on failure, matching the convention used by every other IPC
handler in `electron/ipc/register.ts` (which throws into rejected
promises that the renderer's `invoke` wrapper surfaces). There is NO
`Result<T,E>` return type — the codebase does not use one elsewhere
and adopting one here would introduce inconsistency.

Internally, the module catches every external-call boundary (Telegram
API, `safeStorage`, file I/O, `cloudflared` spawn) and converts errors
to typed `TelegramError` values for the audit log and `lastError`
surface; only the IPC handler boundary re-throws.

## Audit log

`audit.ts` writes one structured log entry per executed command, inline
callback, voice ingest, file ingest, and config change. Schema:

```ts
type AuditEntry = {
  ts: number;
  chatId: number;
  username: string | null; // Telegram username if available
  category: 'cmd' | 'inline' | 'voice' | 'upload' | 'config' | 'auto-remove';
  cmd: string; // e.g. '/prompt', 'approve', 'set-token'
  agentId: string | null;
  outcome: 'ok' | 'denied' | 'error';
  detail: string | null; // short reason on denied/error
};
```

Entries route through the existing structured logger under category
`telegram.audit` at `info`. The logger's level gating
(`openspec/specs/logging/spec.md`) determines persistence. Token
values, voice transcripts, and file paths are never written to the
audit log — only the operation, the actor, and the outcome.

## Why not webhook for MVP

A webhook needs an inbound HTTPS endpoint with a valid certificate, which
forces the user to set up cloudflared / Tailscale Funnel / ngrok before
the bot does anything. Long-polling needs nothing inbound and works on
locked-down corporate networks. Webhook becomes worthwhile when the bot
is in many high-traffic chats (Telegram's polling rate caps around
50 updates per call); a single-user desktop tool stays well inside the
long-polling regime.

The webhook path is left as a follow-up. Switching is a single function
in `bot.ts` and does not affect any other module.

## Persistence schema version

`PersistedState` does not currently carry a schema version. To make
future migrations safer, this change adds a top-level
`persistenceVersion: number` field (default 1, bumped to 2 when this
change lands so the loader knows it can read the new `telegram` block
without warnings). Older snapshots without the field are treated as
version 1 and the missing `telegram` block is filled with defaults.

## Cross-platform notes

The bot module runs unchanged on macOS and Linux (the only supported
platforms per `CLAUDE.md`). `safeStorage` falls back gracefully on
Linux without a keyring — see "Token storage" — by refusing to operate
rather than persisting plaintext. `cloudflared` is platform-agnostic.
Voice transcription via `whisper.cpp` requires the user to provide a
compiled binary; the module does not bundle one.
