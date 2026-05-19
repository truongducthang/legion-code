import { describe, it, expect } from 'vitest';
import { stripAnsi, escapeMd2, lastLines, truncate, codeBlock } from './formatter.js';

describe('stripAnsi', () => {
  it('removes CSI colour codes', () => {
    expect(stripAnsi('\x1b[31mred\x1b[0m')).toBe('red');
  });

  it('removes cursor moves', () => {
    expect(stripAnsi('\x1b[2J\x1b[Hclean')).toBe('clean');
  });

  it('leaves non-ANSI content untouched', () => {
    expect(stripAnsi('hello (y/n)?')).toBe('hello (y/n)?');
  });
});

describe('escapeMd2', () => {
  const RESERVED = [
    '_',
    '*',
    '[',
    ']',
    '(',
    ')',
    '~',
    '`',
    '>',
    '#',
    '+',
    '-',
    '=',
    '|',
    '{',
    '}',
    '.',
    '!',
  ];

  it('escapes every reserved character', () => {
    for (const ch of RESERVED) {
      expect(escapeMd2(ch)).toBe(`\\${ch}`);
    }
  });

  it('escapes backslashes too', () => {
    expect(escapeMd2('\\')).toBe('\\\\');
  });

  it('leaves plain letters and digits alone', () => {
    expect(escapeMd2('hello world 42')).toBe('hello world 42');
  });

  it('round-trips through Telegram-style code blocks', () => {
    const content = escapeMd2('a (b)');
    expect(codeBlock(content)).toBe('```\na \\(b\\)\n```');
  });
});

describe('lastLines', () => {
  it('returns the last N non-empty lines', () => {
    const text = 'a\nb\n\nc\nd\n';
    expect(lastLines(text, 2)).toEqual(['c', 'd']);
  });

  it('strips trailing CR', () => {
    expect(lastLines('a\r\nb\r\n', 5)).toEqual(['a', 'b']);
  });

  it('returns all lines when N exceeds count', () => {
    expect(lastLines('one\ntwo', 99)).toEqual(['one', 'two']);
  });
});

describe('truncate', () => {
  it('returns unchanged when within limit', () => {
    expect(truncate('hello', 10)).toBe('hello');
  });

  it('appends truncated marker when over limit', () => {
    const cut = truncate('a'.repeat(50), 20);
    expect(cut.length).toBeLessThanOrEqual(20);
    expect(cut).toContain('truncated');
  });
});
