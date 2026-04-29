# Support Paste-Image into Terminal

## Why

Pasting or dragging an image into a terminal session (typically driving an
agent like Claude Code) used to insert only the file's basename. Agents then
either errored out (`No such file: foo.png`) or fell back to literal text
about a filename, which was useless. The user reported the regression against
v1.2.1 with: "I expected the behavior that Claude Code supports."

Two underlying causes:

1. The terminal had no `drop` handler. xterm fell back to the dragged item's
   `text/plain` payload, which the OS populates with the basename only.
2. The Cmd+V handler called `navigator.clipboard.readText()` first. On
   macOS, copying an image file in Finder puts the basename on the
   clipboard as `text/plain`, so the existing image-fallback never ran —
   the user got the same useless basename.

The user-visible promise we want to make is the same one the macOS Terminal
makes: dragging or pasting a file into the terminal types its absolute path,
and pasting raw image bytes (e.g. a screenshot) saves the bytes to a temp
file and types that path. The receiving agent then reads the file from disk
exactly as if the user had typed the path themselves.

## What changes

- New IPC `ResolveClipboardPaste`: a single main-process call that picks the
  most useful clipboard representation in priority order (file URL → image
  → plain text → empty), so the renderer no longer has to ask twice and
  no longer falls into the basename trap.
- New IPC `SaveDroppedImage`: receives bytes for a dropped item that has no
  filesystem path (e.g. an `<img>` dragged from a browser tab), writes them
  to a sanitized temp file, and returns the absolute path.
- `webUtils.getPathForFile` exposed as `window.electron.getPathForFile`
  through the existing preload bridge — the contextBridge-safe replacement
  for the `File.path` field that Electron 32+ no longer ships.
- `TerminalView` registers capture-phase `dragover` / `drop` listeners on
  its container so xterm's own listeners cannot win and insert the
  basename. Multiple dropped files are resolved to absolute paths and
  inserted as a space-joined, backslash-escaped string.
- New helper `src/lib/terminalDrop.ts` exporting `escapePath(p)` (was
  `shellQuote` in the first cut) and `dataTransferToShellArgs(dt)`.
  Backslash-escape is the single quoting rule across all targets — it
  matches macOS Terminal / iTerm2 / VS Code muscle memory and renders
  cleanly inside agent prompts.
- Cmd+V binding in `TerminalView` switches from the two-call
  (`readText` → `SaveClipboardImage`) flow to the single-call
  `ResolveClipboardPaste` flow and quotes file paths with `escapePath`.
- Drop payloads cross the contextBridge IPC boundary as base64-encoded
  strings. The naive `Uint8Array` payload is destroyed by the existing
  `JSON.parse(JSON.stringify(args))` round-trip in `src/lib/ipc.ts`,
  silently breaking browser-image drops; base64 keeps the envelope
  JSON-clean and is decoded back to a `Buffer` in the main process.
- The legacy `SaveClipboardImage` IPC and its main-process handler are
  removed once `ResolveClipboardPaste` is shipping; nothing else calls it.

## Impact

- **New capability:** `terminal-image-paste`. No prior spec — the whole
  capability is `## ADDED Requirements`.
- **IPC surface:** +`ResolveClipboardPaste`, +`SaveDroppedImage`,
  −`SaveClipboardImage`. Preload allowlist, IPC enum, and `trace.ts`
  `NEVER_SAFE` all updated.
- **Preload bridge:** new `getPathForFile` function exposed through
  `contextBridge`, backed by `webUtils.getPathForFile`. No `nodeIntegration`
  change — preload remains the only privileged surface.
- **Renderer:** new `src/lib/terminalDrop.ts`; `TerminalView.tsx` gains
  capture-phase drop listeners and uses the new IPCs. No changes to the
  PTY / output pipeline.
- **Type surface:** `Window['electron']` gains `getPathForFile(file: File): string`.
- **Persistence / state:** none. Dropped/pasted bytes are written to
  `os.tmpdir()` with a `parallel-code-drop-<timestamp>-<sanitized name>`
  prefix; lifetime tracking is intentionally not specified — the OS
  cleans the temp dir on its own schedule.
- **Platforms:** macOS and Linux only, per project scope. Clipboard
  format detection covers `public.file-url` (macOS) and `text/uri-list`
  (Linux); no Windows clipboard reader.
- **Out of scope:** Windows support (clipboard format `FileNameW`,
  Windows-reserved character sanitization, double-quote vs backslash
  trade-off); per-agent insertion conventions (e.g. `@path` for Claude
  Code, markdown image links); paste/drop into UI surfaces other than
  the terminal (e.g. the new-task dialog has its own GitHub-URL drop
  handler covered elsewhere).
