import { describe, it, expect } from 'vitest';
import { QuestionDetector } from './detector.js';

function b64(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64');
}

describe('QuestionDetector', () => {
  it('decodes base64 chunks before matching', () => {
    const d = new QuestionDetector();
    // If the decoder were skipped, the regex would never match raw base64.
    const matches = d.feed('a', b64('Continue? [y/N]'), 1_000);
    expect(matches.length).toBe(1);
    expect(matches[0].patternId).toBe('yn-bracket');
  });

  it('matches the four base patterns', () => {
    const d = new QuestionDetector();
    expect(d.feed('a', b64('Continue? [y/N]'), 1)[0]?.patternId).toBe('yn-bracket');
    d.forget('a');
    expect(d.feed('a', b64('Do you want to proceed'), 2)[0]?.patternId).toBe('yn-words');
    d.forget('a');
    expect(d.feed('a', b64('Allow this tool to run?'), 3)[0]?.patternId).toBe('claude-permission');
    d.forget('a');
    expect(d.feed('a', b64('press enter to continue'), 4)[0]?.patternId).toBe('press-enter');
  });

  it('suppresses the same pattern for 30 seconds', () => {
    const d = new QuestionDetector();
    const m1 = d.feed('a', b64('Continue? [y/N]'), 1_000_000);
    expect(m1.length).toBe(1);
    const m2 = d.feed('a', b64('Continue? [y/N]'), 1_010_000);
    expect(m2.length).toBe(0);
    const m3 = d.feed('a', b64('Continue? [y/N]'), 1_040_001);
    expect(m3.length).toBe(1);
  });

  it('different patterns on the same agent fire independently', () => {
    const d = new QuestionDetector();
    const m1 = d.feed('a', b64('Continue? [y/N]'), 1_000);
    const m2 = d.feed('a', b64('press enter to continue'), 2_000);
    expect(m1[0]?.patternId).toBe('yn-bracket');
    expect(m2[0]?.patternId).toBe('press-enter');
  });

  it('forget clears suppression so a new active span fires again', () => {
    const d = new QuestionDetector();
    d.feed('a', b64('Continue? [y/N]'), 1_000);
    d.forget('a');
    const m = d.feed('a', b64('Continue? [y/N]'), 2_000);
    expect(m.length).toBe(1);
  });

  it('caps the tail window at 8 KB', () => {
    const d = new QuestionDetector();
    // Push 16 KB of unrelated output, then the prompt.
    d.feed('a', b64('x'.repeat(16_384)), 1);
    const m = d.feed('a', b64('Continue? [y/N]'), 2);
    expect(m.length).toBe(1);
  });

  it('user-supplied extra patterns extend the base set', () => {
    const d = new QuestionDetector();
    d.setUserPatterns(['^awaiting input:\\s*$']);
    const matches = d.feed('a', b64('awaiting input:'), 1);
    expect(matches.some((m) => m.patternId === 'user-0')).toBe(true);
  });

  it('a malformed user pattern is skipped, not thrown', () => {
    const d = new QuestionDetector();
    expect(() => d.setUserPatterns(['[unclosed'])).not.toThrow();
    // Other patterns still work.
    const m = d.feed('a', b64('Continue? [y/N]'), 1);
    expect(m.length).toBe(1);
  });
});
