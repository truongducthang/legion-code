# Design — Add Public Tunnel Access

## Why this is small

Every moving part already exists. `cloudflared` is spawned, URL is parsed,
errors are captured, the renderer already renders QR codes from arbitrary
URLs. The work is: (1) refcount the tunnel so two consumers can share it,
(2) expose three IPC channels, (3) add one tab to the modal.

## Key decision: refcounted singleton, not per-consumer instances

`electron/telegram/tunnel.ts` is module-singleton today — a single `proc`,
`lastUrl`, `lastError` at module scope. There are two ways to support a
second consumer:

| Option                                 | Mechanics                                                                                                                                    | Trade-off                                                                                                |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| **A. Refcount the singleton** (chosen) | `startTunnel(owner)` adds owner to a set, spawns if empty; `stopTunnel(owner)` removes, kills if now empty. Both consumers see the same URL. | Two consumers cannot have different URLs, but they do not need to — both want the same `localhost:PORT`. |
| B. Factory of independent tunnels      | `createTunnel()` returns an instance; Telegram and Public each own one.                                                                      | Two `cloudflared` processes, two URLs, double the bandwidth. No user benefit.                            |

A is chosen. The owner argument is a string tag so the call sites stay
readable in logs: `startTunnel({ owner: 'telegram', remotePort })`,
`startTunnel({ owner: 'public', remotePort })`.

## Key decision: stopping the remote server releases the public-tunnel hold

If the user toggles remote access off while the public tunnel is active,
the tunnel URL would otherwise point at a closed port — a silent
misconfiguration. The fix: the `StopRemoteServer` handler in
`electron/ipc/register.ts` calls `stopTunnel({ owner: 'public' })` before
closing the server. The Telegram bot's hold is unaffected — if Telegram
keeps the tunnel up, the URL stays valid for `api.telegram.org` traffic
(the bot has no use for it without the server, but that is the bot's
problem to surface, not this change's).

## Key decision: no persisted state

Both `publicUrl` and `publicTunnelState` are runtime-only. Reasons:

- The URL changes every tunnel restart anyway (`trycloudflare.com`
  random subdomain).
- The token-protected access model already assumes session scope.
- The existing `remoteAccess.url` is also non-persisted; this matches.

## Key decision: no auto-start on launch

The user opts in per session by clicking "Start public tunnel" in the
modal. Reasons:

- Exposing a URL to the public Internet should be a deliberate act.
- Auto-start would race with `StartRemoteServer` and the port discovery
  in `electron/remote/server.ts`.

## Cloudflared probe and install hint

The Public tab calls `probeCloudflared(cloudflaredPath?)` on mount and
whenever the user clicks a "Recheck" button. On `available: false`, the
tab renders a verbatim hint:

```
cloudflared is not installed.

macOS:    brew install cloudflared
Linux:    See https://github.com/cloudflare/cloudflared/releases
```

The `cloudflaredPath` config is **reused** from the existing Telegram
settings (`PersistedState.telegram.cloudflaredPath`). One install, both
features. No new persisted field.

## Security surfacing

The Public tab renders one warning line beneath the QR:

> Anyone with this URL and token can connect over the public Internet.
> Stop the tunnel when you are done.

No additional auth changes. The existing token (`server.ts:151`) is
already cryptographically scoped per session, timing-safe compared, and
required on every request. The tunnel does not weaken that — it just
makes the LAN URL globally reachable.

## Status push, not polling

The `connected-clients` counter in the existing UI polls
`GetRemoteStatus` every few seconds (`remote-access` spec, "Connected-
client counter stays current"). For the tunnel, polling is wasteful:
state changes only happen on start, on URL receipt, on cloudflared exit,
and on user stop. The main process pushes `PublicTunnelStatusChanged`
to the renderer at each transition. The renderer reflects state in the
modal immediately.

## Cross-platform note

`CLAUDE.md` ships for macOS + Linux only. `cloudflared` runs on Windows
fine for development, and the existing `tunnel.ts` code is
platform-agnostic; this change does not introduce platform-specific
code. Ship target stays macOS + Linux.

## What stays out of scope

- Named tunnels (require a Cloudflare account and a domain). The Quick
  Tunnel flow is sufficient for the user story.
- Bundling cloudflared. The binary is ~30 MB and Cloudflare ships its
  own auto-update; bundling would duplicate that.
- Custom subdomains. Quick Tunnel's `<random>.trycloudflare.com` is
  fine — the URL is shared via QR, not typed.
- Multiple simultaneous tunnels with different URLs. See refcount
  decision above.
- Tunnels for transports other than `cloudflared` (ngrok, tailscale
  funnel, localhost.run). One transport is enough; adding more is a
  separate change.
