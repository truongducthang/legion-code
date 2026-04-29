# Terminal Image Paste Specification

## ADDED Requirements

### Requirement: Cmd+V resolves the clipboard to its most useful representation

The system SHALL resolve the clipboard to a single representation chosen
by priority — a filesystem path the agent can read, an image saved to a
temp file, or plain text — and never insert a bare basename when the
underlying file URL was available. Resolution happens when the user
invokes the paste keybinding while the terminal has focus.

#### Scenario: Finder-copied image file pastes its absolute path

- **WHEN** the user copies an image file in macOS Finder and presses
  Cmd+V in the terminal
- **THEN** the absolute path to that file is typed into the terminal
- **AND** the typed value is escaped per the path-escaping requirement
- **AND** the basename alone is never inserted

#### Scenario: Linux GNOME file-manager copy pastes its absolute path

- **WHEN** the user copies a file in a GNOME-family file manager
  (Nautilus, Nemo, Caja) and presses the paste binding
- **THEN** the system reads the `x-special/gnome-copied-files` clipboard
  flavour, skips the leading `copy` / `cut` verb line, takes the first
  remaining `file://` URL, converts it to an absolute path, and types
  the escaped path
- **AND** the GNOME flavour is checked before `text/uri-list` so it
  wins when both flavours are present

#### Scenario: Other Linux file managers fall back to text/uri-list

- **WHEN** the user copies a file from a non-GNOME Linux file manager
  (KDE Dolphin, Xfce Thunar, etc.) that publishes only the cross-desktop
  RFC 2483 format
- **THEN** the system reads the `text/uri-list` clipboard flavour, takes
  the first non-comment `file://` URL, converts it to an absolute path,
  and types the escaped path

#### Scenario: Raw image on the clipboard is saved and pasted as a path

- **WHEN** the clipboard does not contain a file URL but does contain
  raster image bytes (e.g. a screenshot)
- **THEN** the system writes the image as PNG to the OS temp directory
- **AND** types the escaped absolute path of that file

#### Scenario: Plain text on the clipboard pastes as text

- **WHEN** the clipboard contains neither a file URL nor a raster image
  but does contain plain text
- **THEN** that text is typed verbatim, with no quoting and no escaping

#### Scenario: Empty clipboard does nothing

- **WHEN** the clipboard contains no file, no image, and no text
- **THEN** no input is sent to the terminal
- **AND** the keypress is consumed (the keybinding's `preventDefault`
  still runs so xterm does not insert a fallback)

#### Scenario: Resolution happens in the main process via a single IPC

- **WHEN** the renderer needs to resolve a paste
- **THEN** it makes exactly one IPC call (`ResolveClipboardPaste`) and
  switches on the returned `kind`
- **AND** it does NOT call `navigator.clipboard.readText()` first

### Requirement: File drop on the terminal types absolute path(s)

The system SHALL type each dropped file's absolute path into the
terminal — space-joined and escaped — instead of allowing the browser
default to insert the basename. This applies whenever the user drops
one or more files onto the terminal viewport.

#### Scenario: Single file dropped from the OS file manager

- **WHEN** the user drags one file from Finder / Nautilus and drops it
  on the terminal
- **THEN** the file's absolute path is typed into the terminal, escaped
  per the path-escaping requirement
- **AND** the basename alone is never inserted

#### Scenario: Multiple files dropped at once

- **WHEN** the user drops two or more files in a single drop
- **THEN** every file's escaped path is typed
- **AND** the paths are joined with a single ASCII space, in the order
  the OS reported them
- **AND** no trailing space is appended

#### Scenario: Drop target is the terminal even when not focused

- **WHEN** the user drops a file on the terminal while focus is in a
  different element (e.g. the prompt input or sidebar)
- **THEN** the terminal is focused before the path is typed
- **AND** the resulting input arrives at the terminal, not at the
  previously-focused element

#### Scenario: Drop handler runs in DOM capture phase

- **WHEN** a `drop` event fires on the terminal container
- **THEN** the application's handler runs in the capture phase, calls
  `preventDefault()` and `stopPropagation()`, and xterm's own bubble
  phase listener does not run

#### Scenario: Capture-phase listeners are torn down on unmount

- **WHEN** a `TerminalView` unmounts
- **THEN** the application's `dragover` and `drop` listeners are removed
  with the same `{ capture: true }` setting they were registered with
- **AND** subsequent drops on the unmounted node do nothing

#### Scenario: Drop without files is ignored

- **WHEN** a `drop` fires on the terminal but `dataTransfer.files` is
  empty (e.g. text-only drag, GitHub URL drag)
- **THEN** the application's terminal drop handler returns without
  preventing default and without typing anything
- **AND** the surrounding application's URL-drop handler may still
  process the drop normally

### Requirement: Browser-origin items without a path are persisted to a temp file

The system SHALL read a dropped item's bytes and persist them to the OS
temp directory, then type that temp path, whenever the item has no
backing filesystem path (e.g. an `<img>` dragged from a browser tab, an
item from a virtual file system).

#### Scenario: Browser image drop produces a usable temp path

- **WHEN** the user drags an `<img>` element from a browser into the
  terminal
- **AND** `webUtils.getPathForFile(file)` returns the empty string
- **THEN** the renderer reads the file as an `ArrayBuffer`,
  base64-encodes it, and calls `SaveDroppedImage` with `{ name, data }`
- **AND** the main process decodes the base64 to a `Buffer` and writes
  it to the OS temp directory
- **AND** the returned absolute path is typed into the terminal,
  escaped per the path-escaping requirement

#### Scenario: Filename for the temp file is sanitized

- **WHEN** the renderer-supplied filename contains path separators (`/`,
  `\`), a NUL byte, leading dots, or extra surrounding whitespace
- **THEN** the main process strips those characters / runs before
  writing
- **AND** clamps the remaining basename to 200 characters
- **AND** prefixes the basename with
  `parallel-code-drop-<unix-ms>-<6-hex>-` where `<6-hex>` is a fresh
  random suffix per call so two same-name drops landing in the same
  millisecond never collide on disk
- **AND** when the sanitized basename is empty, falls back to
  `parallel-code-drop-<unix-ms>-<6-hex>.png`

#### Scenario: Renderer caps oversized drops without surfacing an error

- **WHEN** the dropped item is larger than 50 MB
- **THEN** the renderer skips that item without sending it across IPC
- **AND** continues to process other items in the same drop

#### Scenario: One failing item does not cancel the rest of the drop

- **WHEN** a mixed drop contains both items that resolve successfully
  (path-backed Files or path-less items whose bytes save cleanly)
  and items whose resolution throws (oversized, `arrayBuffer()` rejects,
  `SaveDroppedImage` rejects, base64 encoding fails)
- **THEN** the failing items are silently filtered out
- **AND** the successfully-resolved items are still typed into the
  terminal as a space-joined escaped string
- **AND** no error is surfaced through the drop handler's catch
  block (the failure is local to the failing item)

#### Scenario: Binary payload survives the IPC envelope

- **WHEN** binary bytes are sent over `SaveDroppedImage`
- **THEN** they are encoded as base64 in the renderer and decoded with
  `Buffer.from(data, 'base64')` in the main process
- **AND** the file written to disk has the exact byte length of the
  source payload
- **AND** they are NOT sent as `Uint8Array` or `ArrayBuffer` (the
  application's `invoke()` wrapper destroys typed arrays via its
  `JSON.parse(JSON.stringify(args))` round-trip)

### Requirement: Paths are escaped with backslash before insertion

Paths typed into the terminal SHALL be backslash-escaped before
insertion so they round-trip correctly through both POSIX shells (bash,
zsh) and CLI agents that parse paths from prompt text.

#### Scenario: Safe paths pass through unchanged

- **WHEN** a path contains only characters from
  `[A-Za-z0-9_./@:+,%=-]`
- **THEN** it is typed verbatim with no escape characters added

#### Scenario: Whitespace is escaped

- **WHEN** a path contains a space or any other whitespace character
- **THEN** each whitespace character is preceded by a single backslash

#### Scenario: Shell metacharacters are escaped

- **WHEN** a path contains any of the characters
  `' " \ $ \` ! ( ) ; & | < > \* ? [ ] { } ~ #`
- **THEN** each such character is preceded by a single backslash

#### Scenario: Empty path renders as empty bash literal

- **WHEN** a path is the empty string
- **THEN** it renders as `""` (two ASCII double quotes) so a real shell
  receives an explicit empty argument rather than dropping the position

#### Scenario: Multiple paths are space-joined after escaping

- **WHEN** more than one resolved path is being inserted in one drop
- **THEN** each path is escaped individually
- **AND** the escaped paths are joined with a single ASCII space

### Requirement: Resolved paste/drop content flows through xterm's paste pipeline

The system SHALL deliver resolved paste and drop payloads (file paths,
image temp paths, plain text) to the agent through `term.paste()`,
never via a direct PTY write. This causes xterm to wrap the payload
with bracketed-paste markers (`\x1b[200~` … `\x1b[201~`) when the agent
has bracketed-paste mode enabled, which CLI agents like Claude Code use
to distinguish "the user pasted this" from "the user typed this
character by character" — the former is what triggers automatic
image-file recognition and attachment.

#### Scenario: Cmd+V file path uses term.paste

- **WHEN** the paste handler resolves the clipboard to `kind: 'file'`
  or `kind: 'image'`
- **THEN** the escaped path is delivered via `term.paste(path)`
- **AND** is NOT delivered via direct PTY write

#### Scenario: Cmd+V plain text uses term.paste

- **WHEN** the paste handler resolves the clipboard to `kind: 'text'`
- **THEN** the text is delivered via `term.paste(text)` so a paste of
  multiple lines into a bracketed-paste-aware shell is treated as a
  single paste rather than a sequence of typed lines

#### Scenario: Drop payload uses term.paste

- **WHEN** the drop handler has resolved the dropped files into a
  space-joined escaped path string
- **THEN** the string is delivered via `term.paste(args)` after
  `term.focus()`

#### Scenario: Bracketed-paste markers appear when the agent enables them

- **WHEN** the agent has previously sent the bracketed-paste-mode
  enable sequence (`\x1b[?2004h`)
- **THEN** the bytes the PTY actually receives for a paste/drop
  delivery start with `\x1b[200~` and end with `\x1b[201~`
- **AND** when bracketed-paste mode is disabled (or never enabled),
  the bytes the PTY receives are the payload alone with no marker
  bytes

### Requirement: IPC contract for clipboard and drop

The system SHALL communicate clipboard and drop intents through dedicated
IPC channels declared in `electron/ipc/channels.ts` and allowlisted in
the preload bridge.

#### Scenario: ResolveClipboardPaste channel exists

- **WHEN** the renderer invokes `IPC.ResolveClipboardPaste`
- **THEN** the main process returns a tagged-union object with one of
  the shapes `{ kind: 'file', path: string }`,
  `{ kind: 'image', path: string }`, `{ kind: 'text', text: string }`,
  or `{ kind: 'empty' }`
- **AND** no other shape is ever returned

#### Scenario: SaveDroppedImage channel exists

- **WHEN** the renderer invokes `IPC.SaveDroppedImage` with
  `{ name: string, data: string /* base64 */ }`
- **THEN** the main process returns the absolute path of the file it
  wrote
- **AND** rejects payloads whose `data` is not a string

#### Scenario: getPathForFile is exposed via the preload bridge

- **WHEN** the renderer calls `window.electron.getPathForFile(file)`
  with a `File` object obtained from a drop event
- **THEN** the function returns the absolute filesystem path for files
  that have one
- **AND** returns the empty string for files that do not (browser-origin
  items, virtual file system items, etc.)
- **AND** returns the empty string instead of throwing on any internal
  error from `webUtils.getPathForFile`

#### Scenario: Both new channels are flagged NEVER_SAFE for tracing

- **WHEN** the IPC trace module initialises
- **THEN** both `ResolveClipboardPaste` and `SaveDroppedImage` are
  members of `NEVER_SAFE`
- **AND** their argument and return payloads are never written to the
  debug log

#### Scenario: The legacy SaveClipboardImage channel is removed

- **WHEN** this change is shipped
- **THEN** the IPC enum no longer contains `SaveClipboardImage`
- **AND** the preload allowlist no longer contains
  `'save_clipboard_image'`
- **AND** no main-process handler for the legacy channel is registered
