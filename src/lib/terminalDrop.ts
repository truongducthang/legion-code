// Helpers for turning a DataTransfer into a list of paths the terminal can
// type into the active CLI agent. Used by TerminalView's drop handler.
//
// Two sources of files:
//   • Files dragged from the OS file manager — File has a backing path that
//     webUtils.getPathForFile() resolves to an absolute string.
//   • Files dragged from a browser (e.g. an <img> from a website) — no path,
//     just bytes. These are forwarded to the main process which writes them
//     to a temp file and returns the path.
//
// Paths are backslash-escaped before insertion so spaces, quotes, and other
// shell metacharacters round-trip correctly through both POSIX shells (bash,
// zsh) and CLI agents that parse paths from prompt text. Backslash escaping
// matches macOS Terminal / iTerm2 / VS Code muscle memory and renders
// cleanly inside agent prompts (no quote walls).

import { invoke } from './ipc';
import { IPC } from '../../electron/ipc/channels';

const SAFE_PATH = /^[A-Za-z0-9_./@:+,%=-]+$/;
// Conservative metaset: every byte that has special meaning in any common
// POSIX shell. Backslash-escaping a non-special character is harmless, so
// over-escaping is preferred to under-escaping.
//
// Note: `\` itself is in this set so an embedded backslash gets escaped to
// `\\`. The character class is in a single line (not split across lines)
// so the literal whitespace between brackets is part of the set.
// eslint-disable-next-line no-useless-escape -- explicit escapes document intent
const META_CHAR = /[\s'"\\$`!()<>;&|*?\[\]{}~#]/g;

/**
 * Backslash-escape a path so it survives insertion into a terminal that may
 * be hosting either a POSIX shell or a CLI agent. The empty string renders
 * as `""` so a real shell receives an explicit empty argument.
 */
export function escapePath(p: string): string {
  if (p === '') return '""';
  if (SAFE_PATH.test(p)) return p;
  return p.replace(META_CHAR, '\\$&');
}

async function pathForDroppedItem(file: File): Promise<string | null> {
  // Each item resolution is its own try/catch so one unreadable browser /
  // virtual file in a mixed drop never cancels the resolution of the
  // siblings. The caller filters nulls out before joining.
  try {
    const direct = window.electron.getPathForFile?.(file) ?? '';
    if (direct) return direct;

    // No filesystem path — buffer bytes and ask main to persist them. Anything
    // the user drops here is small enough to fit in memory in practice (images,
    // not multi-GB videos), but we still cap to avoid pathological cases.
    const MAX_BYTES = 50 * 1024 * 1024;
    if (file.size > MAX_BYTES) return null;
    const data = bytesToBase64(new Uint8Array(await file.arrayBuffer()));
    // base64 keeps the payload inside the JSON envelope of the renderer's
    // invoke() wrapper. A naive Uint8Array would be destroyed by the
    // JSON.parse(JSON.stringify(args)) round-trip in src/lib/ipc.ts.
    const filePath = await invoke<string>(IPC.SaveDroppedImage, {
      name: file.name || 'image.png',
      data,
    }).catch(() => '');
    return filePath || null;
  } catch {
    return null;
  }
}

/** Resolve every File in a DataTransfer to an escaped absolute path,
 *  joined by spaces. Returns '' when nothing resolvable was dropped. */
export async function dataTransferToShellArgs(dt: DataTransfer): Promise<string> {
  const files = Array.from(dt.files);
  if (files.length === 0) return '';
  const paths = await Promise.all(files.map(pathForDroppedItem));
  return paths
    .filter((p): p is string => Boolean(p))
    .map(escapePath)
    .join(' ');
}

/** Encode a byte array as a base64 string. Uses btoa with a binary-string
 *  shim because Uint8Array is not directly accepted. Chunked to avoid
 *  blowing the call stack on large drops (50 MB cap upstream). */
function bytesToBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    const slice = bytes.subarray(i, Math.min(i + CHUNK, bytes.length));
    binary += String.fromCharCode(...slice);
  }
  return btoa(binary);
}
