# Tasks — Support Paste-Image into Terminal

Most of the code is already on the `feature/support-paste-images` branch.
The unchecked items are the gaps the spec exposed during retro-review.

## Already implemented

- [x] Add `IPC.ResolveClipboardPaste` and `IPC.SaveDroppedImage` to
      `electron/ipc/channels.ts`.
- [x] Add the same channels to the preload allowlist in
      `electron/preload.cjs`.
- [x] Add both channels to `NEVER_SAFE` in `electron/ipc/trace.ts` so
      paths and bytes are never logged.
- [x] Implement `ResolveClipboardPaste` in `electron/ipc/register.ts`:
      priority order file URL → image → text → empty; macOS reads
      `public.file-url`, Linux reads `text/uri-list`; image fallback
      writes a PNG to `os.tmpdir()`.
- [x] Implement `SaveDroppedImage` in `electron/ipc/register.ts`:
      sanitize the supplied filename, write to `os.tmpdir()` with the
      `parallel-code-drop-<timestamp>-<basename>` prefix, return the
      absolute path.
- [x] Expose `webUtils.getPathForFile(file)` from `electron/preload.cjs`
      as `window.electron.getPathForFile`; update the `Window['electron']`
      type in `src/lib/ipc.ts`.
- [x] Create `src/lib/terminalDrop.ts` with `shellQuote` (initial cut
      using single-quote wrap) and `dataTransferToShellArgs`.
- [x] Add capture-phase `dragover` and `drop` listeners on
      `TerminalView`'s container; teardown in `onCleanup`.
- [x] Migrate the Cmd+V handler in `TerminalView` to use
      `ResolveClipboardPaste` and quote file paths through `shellQuote`.
- [x] Unit tests for `shellQuote` in `src/lib/terminalDrop.test.ts`.
- [x] `npx tsc --noEmit` (renderer + electron tsconfigs) and
      `npx vitest run` pass.

## Remaining

- [x] Rewrite `shellQuote` in `src/lib/terminalDrop.ts` to
      `escapePath`: backslash-escape the metaset
      `[whitespace ' " \ $ \` ! ( ) ; & | < > \* ? [ ] { } ~ #]`. The
empty string becomes `""` (literal empty argv). Update callers
(`TerminalView`paste handler,`dataTransferToShellArgs`).
- [x] Update `src/lib/terminalDrop.test.ts` to cover the new escape
      rule: empty path → `""`; safe path passes through; spaces escape;
      embedded apostrophes escape; embedded `$` `` ` `` `(` `)` `&`
      escape; mixed-meta path escapes every metachar; backslash in path
      itself escapes.
- [x] Fix the binary-IPC bug: change `dataTransferToShellArgs` to
      base64-encode the dropped bytes before calling `SaveDroppedImage`,
      and update `SaveDroppedImage` to accept `data: string` and decode
      via `Buffer.from(data, 'base64')`. Strengthen the main-process
      validation accordingly.
- [x] Add a renderer-side regression test (vitest, no DOM) that exercises
      `dataTransferToShellArgs` end-to-end with a stubbed
      `window.electron.invoke` / `getPathForFile`, asserting the IPC is
      called with a base64 string for a path-less File and the resulting
      command line is correctly escaped.
- [x] Delete the legacy `SaveClipboardImage` flow: remove the
      `IPC.SaveClipboardImage` enum entry, the `'save_clipboard_image'`
      preload allowlist line, the entry in `trace.ts NEVER_SAFE`, and
      the handler implementation in `electron/ipc/register.ts`. The
      `clipboardImagePath` constant moves into the
      `ResolveClipboardPaste` handler closure.
- [x] Codex review follow-up: parse `x-special/gnome-copied-files`
      ahead of `text/uri-list` in `readClipboardFileUrl` so GNOME-family
      file managers (Files / Nautilus, Nemo, Caja) get the absolute
      path treatment they advertise rather than the basename fallback.
- [x] Codex review follow-up: wrap each per-file resolution in
      `pathForDroppedItem` in its own try/catch so one unreadable
      browser/virtual-file in a mixed drop never cancels the whole
      `Promise.all` and silently drops the resolvable siblings.
- [x] Codex review follow-up: append a 6-char `crypto.randomBytes(3)`
      suffix to the `parallel-code-drop-…` temp filename so two
      same-name drops landing inside the same millisecond don't
      overwrite each other on disk.
- [x] Switch paste/drop delivery from `enqueueInput` (direct PTY write) to
      `term.paste()` so xterm emits bracketed-paste markers
      (`\x1b[200~ … \x1b[201~`) when the agent has bracketed-paste mode
      on. Without this, CLI agents like Claude Code see a dropped path
      as literal typed text and skip the file-attachment recognition
      that turns the path into an `[Image #N]` reference.
- [x] Validate with `npm run typecheck`, `npm test`,
      `npm run format:check`, `npm run lint`, and
      `openspec validate --all --strict`.
