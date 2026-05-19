import { describe, expect, it, beforeEach } from 'vitest';
import { _resetUploadsForTests, _takeUploadForTests, shellEscapePath } from './upload.js';

describe('shellEscapePath', () => {
  it('returns plain alphanumeric paths unchanged', () => {
    expect(shellEscapePath('/tmp/file.txt')).toBe('/tmp/file.txt');
    expect(shellEscapePath('/var/log/system_2026-05.log')).toBe('/var/log/system_2026-05.log');
    expect(shellEscapePath('/home/user/photo+annot.jpeg')).toBe('/home/user/photo+annot.jpeg');
  });

  it('wraps paths with spaces in single quotes', () => {
    expect(shellEscapePath('/tmp/with space.txt')).toBe("'/tmp/with space.txt'");
  });

  it("escapes embedded single quotes via '\\'' pattern", () => {
    expect(shellEscapePath("/tmp/can't.txt")).toBe(`'/tmp/can'\\''t.txt'`);
  });

  it('quotes paths with shell metacharacters', () => {
    expect(shellEscapePath('/tmp/$file;rm.txt')).toBe(`'/tmp/$file;rm.txt'`);
    expect(shellEscapePath('/tmp/`backtick`.txt')).toBe(`'/tmp/\`backtick\`.txt'`);
  });
});

describe('upload token storage', () => {
  beforeEach(() => {
    _resetUploadsForTests();
  });

  it('returns null for an unknown token', () => {
    expect(_takeUploadForTests('does-not-exist')).toBeNull();
  });
});
