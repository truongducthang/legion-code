/**
 * Strip trailing horizontal whitespace from each line.
 *
 * Terminal renderers (e.g. markdown TUIs) often pad rendered lines out to
 * column width with spaces — copying that text drags the padding into the
 * clipboard, making pastes look ragged. Stripping per line is deterministic
 * and never collapses real `\n`s, so the structure of the selection is
 * preserved exactly.
 */
export function stripTrailingWhitespacePerLine(text: string): string {
  return text.replace(/[ \t]+(?=\n|$)/g, '');
}

interface ReflowOptions {
  /** A paragraph reflows only if every interior line is at least this long. */
  minInteriorLength?: number;
  /** Interior line lengths must vary by at most this many characters. */
  varianceTolerance?: number;
}

/**
 * Join wrapped-paragraph lines that the source program already broke at
 * terminal width with real `\n`s.
 *
 * Rule (deterministic, no content-shape inference):
 *   A "paragraph" is a run of consecutive non-blank lines. It is treated as
 *   a single wrapped paragraph (lines joined with one space, leading
 *   whitespace on continuations stripped) iff every line except the last —
 *   the "interior" lines — is at least `minInteriorLength` long AND the
 *   spread (max − min) of those interior lengths is within
 *   `varianceTolerance`. Otherwise the paragraph is left untouched.
 *
 * Single-line paragraphs are always left untouched. Blank lines between
 * paragraphs are preserved exactly as separators.
 */
export function reflowWrappedParagraphs(text: string, opts: ReflowOptions = {}): string {
  const minLong = opts.minInteriorLength ?? 40;
  const variance = opts.varianceTolerance ?? 8;

  const lines = text.split('\n');
  const out: string[] = [];

  let i = 0;
  while (i < lines.length) {
    if (lines[i] === '') {
      out.push('');
      i++;
      continue;
    }
    let j = i;
    while (j < lines.length && lines[j] !== '') j++;
    const para = lines.slice(i, j);

    if (shouldReflow(para, minLong, variance)) {
      // Array+join avoids O(n²) concat on pathologically long paragraphs.
      const parts: string[] = [para[0]];
      for (let k = 1; k < para.length; k++) {
        parts.push(para[k].replace(/^[ \t]+/, ''));
      }
      out.push(parts.join(' '));
    } else {
      for (const line of para) out.push(line);
    }
    i = j;
  }

  return out.join('\n');
}

function shouldReflow(para: string[], minLong: number, variance: number): boolean {
  if (para.length < 2) return false;
  const interior = para.slice(0, -1);
  let min = Infinity;
  let max = -Infinity;
  for (const line of interior) {
    const len = line.length;
    if (len < min) min = len;
    if (len > max) max = len;
  }
  if (min < minLong) return false;
  if (max - min > variance) return false;
  return true;
}

/**
 * One-stop pipeline for terminal selection → clipboard text:
 * normalize CRLF → LF, strip trailing per-line whitespace, then reflow
 * wrapped paragraphs.
 *
 * Note: this is for the CLIPBOARD selection only. The X11 PRIMARY selection
 * (middle-click paste on Linux) is intentionally untouched — PRIMARY users
 * generally expect a byte-faithful copy of what they highlighted.
 */
export function cleanCopiedTerminalText(text: string): string {
  const normalized = text.replace(/\r\n?/g, '\n');
  return reflowWrappedParagraphs(stripTrailingWhitespacePerLine(normalized));
}
