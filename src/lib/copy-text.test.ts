import { describe, expect, it } from 'vitest';
import {
  cleanCopiedTerminalText,
  reflowWrappedParagraphs,
  stripTrailingWhitespacePerLine,
} from './copy-text';

describe('stripTrailingWhitespacePerLine', () => {
  it('removes trailing spaces from a single line', () => {
    expect(stripTrailingWhitespacePerLine('hello   ')).toBe('hello');
  });

  it('removes trailing tabs from a single line', () => {
    expect(stripTrailingWhitespacePerLine('hello\t\t')).toBe('hello');
  });

  it('removes trailing whitespace from each line of a multi-line string', () => {
    const input = 'foo   \nbar \t\nbaz';
    expect(stripTrailingWhitespacePerLine(input)).toBe('foo\nbar\nbaz');
  });

  it('preserves leading and interior whitespace', () => {
    expect(stripTrailingWhitespacePerLine('  hello   world   ')).toBe('  hello   world');
  });

  it('preserves blank lines as-is, including between content', () => {
    const input = 'foo  \n\nbar  ';
    expect(stripTrailingWhitespacePerLine(input)).toBe('foo\n\nbar');
  });

  it('reduces an all-whitespace line to empty without consuming its newline', () => {
    const input = 'foo\n     \nbar';
    expect(stripTrailingWhitespacePerLine(input)).toBe('foo\n\nbar');
  });

  it('leaves a string with no trailing whitespace untouched', () => {
    expect(stripTrailingWhitespacePerLine('foo\nbar\nbaz')).toBe('foo\nbar\nbaz');
  });

  it('handles an empty string', () => {
    expect(stripTrailingWhitespacePerLine('')).toBe('');
  });

  it('preserves the trailing newline if present', () => {
    expect(stripTrailingWhitespacePerLine('foo  \n')).toBe('foo\n');
  });
});

describe('reflowWrappedParagraphs', () => {
  it('leaves a single-line paragraph untouched', () => {
    expect(reflowWrappedParagraphs('Hello world.')).toBe('Hello world.');
  });

  it('does not reflow when interior lines are too short (haiku)', () => {
    const input = [
      '  Stars blink out one by one',
      '  The last lamp on the street dims',
      '  A cat finds its door',
    ].join('\n');
    expect(reflowWrappedParagraphs(input)).toBe(input);
  });

  it('reflows a 2-line paragraph when the interior line is long enough', () => {
    const input =
      "  Let me know if you'd like to commit this or want a\n  different change instead.";
    expect(reflowWrappedParagraphs(input)).toBe(
      "  Let me know if you'd like to commit this or want a different change instead.",
    );
  });

  it('reflows a 3-line paragraph when both interior lines are long and similar', () => {
    const input = [
      '※ recap: Added a second haiku to readme.md as a random',
      '  change. Next: commit the change if it looks good.',
      '  (disable recaps in /config)',
    ].join('\n');
    expect(reflowWrappedParagraphs(input)).toBe(
      '※ recap: Added a second haiku to readme.md as a random change. Next: commit the change if it looks good. (disable recaps in /config)',
    );
  });

  it('does not reflow when interior line lengths vary too much', () => {
    // First line short, second line long — varied widths suggest intentional breaks
    const input = [
      'short line',
      'this is a much longer line of about fifty characters here',
      'tail',
    ].join('\n');
    expect(reflowWrappedParagraphs(input)).toBe(input);
  });

  it('preserves blank lines as paragraph separators', () => {
    const input = [
      '  First paragraph here is long enough to qualify for reflowing.',
      '  continued tail.',
      '',
      '  Second paragraph.',
    ].join('\n');
    expect(reflowWrappedParagraphs(input)).toBe(
      [
        '  First paragraph here is long enough to qualify for reflowing. continued tail.',
        '',
        '  Second paragraph.',
      ].join('\n'),
    );
  });

  it('strips leading whitespace only on continuation lines, preserves first-line indent', () => {
    const input =
      '    indented prose that wraps at terminal width and then keeps\n    going onto the next line.';
    expect(reflowWrappedParagraphs(input)).toBe(
      '    indented prose that wraps at terminal width and then keeps going onto the next line.',
    );
  });

  it('handles multiple paragraphs with mixed reflow decisions (the reported example)', () => {
    const input = [
      '● Added a second haiku to readme.md:',
      '',
      '  Stars blink out one by one',
      '  The last lamp on the street dims',
      '  A cat finds its door',
      '',
      "  Let me know if you'd like to commit this or want a",
      '  different change instead.',
      '',
      '※ recap: Added a second haiku to readme.md as a random',
      '  change. Next: commit the change if it looks good.',
      '  (disable recaps in /config)',
    ].join('\n');
    const expected = [
      '● Added a second haiku to readme.md:',
      '',
      '  Stars blink out one by one',
      '  The last lamp on the street dims',
      '  A cat finds its door',
      '',
      "  Let me know if you'd like to commit this or want a different change instead.",
      '',
      '※ recap: Added a second haiku to readme.md as a random change. Next: commit the change if it looks good. (disable recaps in /config)',
    ].join('\n');
    expect(reflowWrappedParagraphs(input)).toBe(expected);
  });

  it('handles empty input', () => {
    expect(reflowWrappedParagraphs('')).toBe('');
  });

  it('preserves leading and trailing blank lines', () => {
    const input = '\n\nhello\n\n';
    expect(reflowWrappedParagraphs(input)).toBe(input);
  });

  it('honors custom thresholds', () => {
    const input = 'short one\nshort two';
    // With a permissive minInteriorLength, the haiku-shaped 2-line input reflows
    expect(reflowWrappedParagraphs(input, { minInteriorLength: 5 })).toBe('short one short two');
    // Default thresholds leave it alone
    expect(reflowWrappedParagraphs(input)).toBe(input);
  });

  it('strips a tab-indented continuation when joining', () => {
    const input =
      'This first line is long enough to qualify the paragraph for reflow.\n\tcontinuation line.';
    expect(reflowWrappedParagraphs(input)).toBe(
      'This first line is long enough to qualify the paragraph for reflow. continuation line.',
    );
  });

  it('reflows a 2-line paragraph even when the second line was an intentional break (accepted failure mode)', () => {
    // Documented limitation: with only one interior line we cannot detect
    // variance, so any ≥40-char first line will reflow with whatever follows.
    // Pinning this here so a future "improvement" cannot silently change it.
    const input = 'A long sentence end here with a period for sure okay.\nUnrelated next sentence.';
    expect(reflowWrappedParagraphs(input)).toBe(
      'A long sentence end here with a period for sure okay. Unrelated next sentence.',
    );
  });

  it('is a no-op on whitespace-only input (after a prior strip)', () => {
    // Mirrors the realistic pipeline order: strip first, then reflow.
    const stripped = stripTrailingWhitespacePerLine('   \n  \n');
    expect(reflowWrappedParagraphs(stripped)).toBe('\n\n');
  });
});

describe('cleanCopiedTerminalText', () => {
  it('strips per-line padding then reflows wrapped paragraphs', () => {
    // Mirrors a real Claude-Code-rendered block: padded to terminal width AND
    // mid-paragraph hard-wrapped. Both pieces of cleanup must run.
    const input = [
      "  Let me know if you'd like to commit this or want a   ",
      '  different change instead.                              ',
    ].join('\n');
    expect(cleanCopiedTerminalText(input)).toBe(
      "  Let me know if you'd like to commit this or want a different change instead.",
    );
  });

  it('leaves an unpadded haiku unchanged', () => {
    const input = [
      '  Stars blink out one by one',
      '  The last lamp on the street dims',
      '  A cat finds its door',
    ].join('\n');
    expect(cleanCopiedTerminalText(input)).toBe(input);
  });

  it('normalizes CRLF and CR-only line endings before strip + reflow', () => {
    // Mixed CRLF (Windows) and bare CR (classic Mac) both collapse to LF.
    const input =
      "  Let me know if you'd like to commit this or want a   \r\n" +
      '  different change instead.                              \r\n' +
      '\r' +
      '  Tail.\r\n';
    expect(cleanCopiedTerminalText(input)).toBe(
      "  Let me know if you'd like to commit this or want a different change instead.\n\n  Tail.\n",
    );
  });
});
