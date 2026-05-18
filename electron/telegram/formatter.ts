/**
 * Output formatting helpers: ANSI stripping, scrollback chunking, MarkdownV2
 * escaping. Every reply path that includes agent-derived content runs through
 * these before reaching the bot's send/edit calls.
 */

// Matches the standard ANSI CSI / OSC / SGR escape sequences. Conservative —
// covers the common cases agents emit (colour codes, cursor moves) without
// trying to be a full terminal emulator.
//
// eslint-disable-next-line no-control-regex
const ANSI_RX = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07|\x1b[=>]|\x1b\([A-B0-9]/g;

export function stripAnsi(input: string): string {
  return input.replace(ANSI_RX, '');
}

// MarkdownV2 reserved characters per
// https://core.telegram.org/bots/api#markdownv2-style
const MD2_RESERVED = /[_*[\]()~`>#+\-=|{}.!\\]/g;

export function escapeMd2(text: string): string {
  return text.replace(MD2_RESERVED, '\\$&');
}

/** Take the last `n` non-empty lines of `text`. Lines are stripped of trailing CR. */
export function lastLines(text: string, n: number): string[] {
  return text
    .split('\n')
    .map((l) => l.replace(/\r$/, ''))
    .filter((l) => l.length > 0)
    .slice(-n);
}

/** Truncate to `max` chars, appending `… (truncated)` if cut. */
export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  const marker = '\n… (truncated)';
  return text.slice(0, Math.max(0, max - marker.length)) + marker;
}

/** Wrap content in a MarkdownV2 triple-backtick block. Content should already
 *  be MD2-escaped. The backticks themselves are NOT escaped. */
export function codeBlock(content: string): string {
  return '```\n' + content + '\n```';
}
