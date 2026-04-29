# Design — Support Paste-Image into Terminal

## Why a design doc

The user-facing behaviour ("dropping or pasting an image types its absolute
path into the terminal") is one sentence; the spec covers the visible
contract. Three things need a written design because they are non-obvious
choices that future contributors will be tempted to "fix" the wrong way:

1. Why clipboard resolution lives in the main process instead of the
   renderer.
2. Why the drop handler runs in DOM capture phase rather than bubble.
3. Why dropped binary payloads cross the IPC boundary as base64 strings
   instead of `Uint8Array` / `ArrayBuffer`.

Plus a fourth: why `escapePath` uses backslash escaping and not
single-quote wrapping or any per-agent convention.

## 1. Clipboard resolution lives in the main process

The renderer has access to `navigator.clipboard.readText()` and
`navigator.clipboard.read()`. They are insufficient for our use case:

- `readText()` on macOS returns the basename when Finder copied a file
  (Finder writes the basename to the `text/plain` flavour of the
  clipboard alongside the file URL). The renderer cannot tell that the
  basename belongs to a real file on disk without also walking
  `clipboard.read()` for the `Files` flavour, which is gated by
  permissions, only available in secure contexts, and does not return
  paths.
- The Electron main process can read OS-specific clipboard flavours via
  `clipboard.read('public.file-url')` (macOS) and
  `clipboard.read('text/uri-list')` (Linux) and call `fileURLToPath` to
  recover the absolute path.

So the resolution must live in main. A single IPC, `ResolveClipboardPaste`,
returns a tagged-union response (`{ kind: 'file' | 'image' | 'text' | 'empty', … }`)
that encodes the priority order:

```
1. public.file-url      (macOS Finder copy)
   or text/uri-list     (Linux file managers)
        → return { kind: 'file', path }
2. clipboard.readImage()
        → save PNG to temp + return { kind: 'image', path }
3. clipboard.readText()
        → return { kind: 'text', text }
4. nothing
        → return { kind: 'empty' }
```

The renderer's Cmd+V handler is a `switch` on `kind`. One round-trip,
no `readText`-then-`readImage` race, no opportunity to insert a
basename when a file URL was available the whole time.

`SaveClipboardImage` (the legacy single-purpose handler) becomes dead
code as soon as the renderer migrates. It is removed in this change to
keep the IPC surface tight and to prevent future callers re-introducing
the basename trap by accident.

## 2. Drop handler runs in DOM capture phase

xterm's element subscribes to `drop` and `dragover` itself. Its default
handler reads `dataTransfer.getData('text/plain')`, which the OS
populates with the basename when files are dragged from a file manager.
If the application's drop handler runs in the bubble phase (the default
for `addEventListener` and JSX `on:drop`), xterm's handler runs first and
inserts the basename before our handler ever runs.

The fix is to register the listener in the DOM capture phase:

```ts
containerRef.addEventListener('dragover', handleDragOver, true); // capture
containerRef.addEventListener('drop', handleDrop, true);
```

Plus `e.preventDefault()` and `e.stopPropagation()` inside the handler.
`stopPropagation` short-circuits the bubble phase entirely; xterm's
listeners never fire. The capture-phase registration is what makes the
two `preventDefault()` calls sufficient — without capture, xterm
sometimes runs synchronously before the bubble phase even starts.

The handler also calls `term.focus()` before `enqueueInput()` so the
terminal is the active element when the typed input arrives. Without it,
dropping onto a non-focused terminal types into the previously-focused
field (which can be a text input elsewhere in the UI).

## 3. Binary payloads cross IPC as base64

The repo's renderer-side `invoke()` wrapper does this:

```ts
const safeArgs = args ? (JSON.parse(JSON.stringify(args)) as …) : undefined;
return window.electron.ipcRenderer.invoke(cmd, safeArgs);
```

The JSON round-trip exists to make `Channel` tokens work
(`Channel.toJSON` produces a plain `{__CHANNEL_ID__}` object). It also
silently destroys typed arrays: `JSON.stringify(new Uint8Array([137,80,78]))`
produces `'{"0":137,"1":80,"2":78}'`. The receiving handler's
`instanceof Uint8Array` check then fails and throws `data must be
ArrayBuffer or Uint8Array`. Browser-image drops therefore look like
they "do nothing" with no surfaced error.

Two ways out:

- **A. Base64 the payload in the renderer**, decode in the main process
  via `Buffer.from(data, 'base64')`. Stays inside the JSON envelope; no
  invasive change to the existing IPC wrapper; works through the
  contextBridge as a plain string.
- **B. Bypass the JSON round-trip** for known-binary channels. Smaller
  wire payload (~33 % overhead saved) but requires either a parallel
  `invokeBinary()` API or a per-channel allowlist inside `invoke()`,
  and risks mis-handling `Channel` tokens that legitimately appear in
  the payload.

We pick **A**. The blast radius is one channel and one helper. The
`SaveDroppedImage` handler accepts `{ name: string, data: string /*
base64 */ }` and reconstructs a `Buffer`. The 50 MB renderer-side cap
on dropped item size makes the base64 overhead negligible in practice.

## 4. `escapePath` uses backslash escaping

The path is going to one of two places:

- A POSIX shell (when the terminal hosts `bash` / `zsh` directly).
- An agent's prompt parser (when the terminal hosts `claude`, `codex`,
  etc.).

Backslash escaping works in both:

- A real shell parses `\<char>` as a literal char, so
  `My\ File.png` becomes the single argv `My File.png`.
- An agent reads the prompt as text. The backslashes are visible but
  every popular agent's path parser strips them. The output also matches
  what the user would see if they dragged the same file into a native
  macOS Terminal session — least surprise.

Single-quote wrapping was the first cut and was rejected for two
reasons: it produces ugly `'…'\''…'` quote walls when paths contain
apostrophes, and it does not match any native terminal's drag-insert
convention.

The metaset escaped is intentionally wide:

```
[whitespace ' " \ $ ` ! ( ) ; & | < > * ? [ ] { } ~ #]
```

Filenames legitimately contain `&` `(` `)` etc., and a too-narrow set
will break in real shells (`ls foo&bar.png` backgrounds `ls foo`).
Backslash before a normal letter is a no-op in bash, so over-escaping
is harmless; under-escaping silently corrupts.

## 5. Resolved payloads go through `term.paste()`, not the PTY directly

The first cut wrote the resolved path straight to the PTY via
`enqueueInput`. The path arrived at the agent — but agents like Claude
Code do not act on a path that arrives byte-by-byte the same way they
act on a path that arrives inside a paste. CC enables bracketed-paste
mode (`\x1b[?2004h`) on startup; the terminal is then expected to
wrap pasted content in `\x1b[200~ … \x1b[201~`. CC's input parser
inspects the wrapped payload, recognises image-file paths, and
attaches them as `[Image #N]`. Direct PTY writes carry no such
wrapper, so CC sees literal typing and skips the attachment.

The fix is to deliver paste / drop payloads via xterm's
`term.paste(data)`. xterm reads the agent's current bracketed-paste
setting and either emits the markers or not, automatically. The
`onData` event still fires (the existing PTY forwarding pipeline
keeps working), and the spec keeps the rule observable: when
bracketed-paste mode is on, the PTY sees the marker bytes.

A second-order benefit: multi-line text pastes (e.g. a snippet
copied from a doc) now arrive as a single bracketed paste instead
of N separate "typed line" events, which is what shells and agents
expect for proper history and indentation handling.

## Why the legacy SaveClipboardImage handler is removed

Keeping it as a "backward compatibility" shim invites future callers to
reach for the simple `→ image path` API and re-create the basename
trap. The handler has exactly one historical caller (the old paste
flow), and that caller migrates in this change. Removing it now is
cheaper than removing it later.

## Why no UX feedback when a drop is over the size cap or fails

`dataTransferToShellArgs` silently filters out files that fail to
resolve (over the 50 MB cap, `getPathForFile` returns `''` and there
are no bytes to fall back on, etc.). The user-visible result of
"dropped a 200 MB video and nothing happened" is acceptable for the
v1 of this feature; a toast or status-bar notice is intentionally out
of scope. If real users hit it, it earns its own change.

## Capture-phase listener teardown

The two `addEventListener('…', …, true)` registrations are paired with
`removeEventListener('…', …, true)` inside `onCleanup`. The third
argument MUST match between add and remove or the listener leaks.
This is the kind of thing that breaks silently and only shows up
under HMR / repeated mount-unmount; the spec calls it out explicitly
to keep it from regressing.
