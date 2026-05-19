import { describe, it, expect } from 'vitest';
import { redact } from './redact.js';

describe('redact — base patterns', () => {
  it('redacts AWS access key ids', () => {
    expect(redact('AKIAIOSFODNN7EXAMPLE in logs')).toContain('[REDACTED:aws-akid]');
  });

  it('redacts JWTs', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc-def_ghi';
    // Wrap in a context where the env-assign pattern does NOT catch it first.
    expect(redact(`auth header: ${jwt}`)).toContain('[REDACTED:jwt]');
  });

  it('redacts GitHub PATs', () => {
    const pat = 'ghp_' + 'a'.repeat(40);
    expect(redact(pat)).toContain('[REDACTED:gh-pat]');
  });

  it('redacts env-style key/secret assignments', () => {
    expect(redact('PASSWORD=hunter2 SECRET=foo')).not.toContain('hunter2');
    expect(redact('PASSWORD=hunter2 SECRET=foo')).not.toContain('foo');
    expect(redact('PASSWORD=hunter2')).toContain('[REDACTED:env-assign]');
  });

  it('returns empty for empty input', () => {
    expect(redact('')).toBe('');
  });

  it('handles very long input efficiently (1 MB)', () => {
    const big = 'x'.repeat(1 * 1024 * 1024) + ' AKIAIOSFODNN7EXAMPLE';
    const result = redact(big);
    expect(result.endsWith('[REDACTED:aws-akid]')).toBe(true);
  });
});

describe('redact — user patterns', () => {
  it('appends user patterns with user-N name', () => {
    const out = redact('hello secret-token-x', ['secret-token-[a-z]+']);
    expect(out).toContain('[REDACTED:user-0]');
  });

  it('preserves user-N indexing across multiple patterns', () => {
    const out = redact('aaa bbb', ['aaa', 'bbb']);
    expect(out).toContain('[REDACTED:user-0]');
    expect(out).toContain('[REDACTED:user-1]');
  });

  it('ignores patterns that fail to compile', () => {
    // Should not throw on bad pattern.
    expect(() => redact('safe text', ['[unclosed'])).not.toThrow();
  });
});
