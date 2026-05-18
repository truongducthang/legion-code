import { describe, it, expect } from 'vitest';
import { ReplyMap } from './reply.js';

describe('ReplyMap', () => {
  it('stores and looks up message → agent', () => {
    const m = new ReplyMap();
    m.register(1, 'agent-a');
    expect(m.lookup(1)).toBe('agent-a');
  });

  it('returns null for unknown messages', () => {
    const m = new ReplyMap();
    expect(m.lookup(999)).toBeNull();
  });

  it('evicts the oldest entry when capacity is exceeded', () => {
    const m = new ReplyMap(3);
    m.register(1, 'a');
    m.register(2, 'b');
    m.register(3, 'c');
    m.register(4, 'd');
    expect(m.lookup(1)).toBeNull();
    expect(m.lookup(2)).toBe('b');
    expect(m.lookup(4)).toBe('d');
    expect(m.size()).toBe(3);
  });

  it('touches an entry on lookup so it survives eviction', () => {
    const m = new ReplyMap(3);
    m.register(1, 'a');
    m.register(2, 'b');
    m.register(3, 'c');
    // Touch 1 — now order is 2, 3, 1
    m.lookup(1);
    m.register(4, 'd');
    // The oldest is now 2, not 1
    expect(m.lookup(2)).toBeNull();
    expect(m.lookup(1)).toBe('a');
  });

  it('registering an existing key refreshes its position', () => {
    const m = new ReplyMap(3);
    m.register(1, 'a');
    m.register(2, 'b');
    m.register(3, 'c');
    m.register(1, 'a2'); // refresh — order is now 2, 3, 1
    m.register(4, 'd');
    expect(m.lookup(2)).toBeNull();
    expect(m.lookup(1)).toBe('a2');
  });

  it('forgetAgent removes every entry for the given agent', () => {
    const m = new ReplyMap();
    m.register(1, 'a');
    m.register(2, 'a');
    m.register(3, 'b');
    expect(m.forgetAgent('a')).toBe(2);
    expect(m.lookup(1)).toBeNull();
    expect(m.lookup(2)).toBeNull();
    expect(m.lookup(3)).toBe('b');
  });

  it('rejects non-positive capacity', () => {
    expect(() => new ReplyMap(0)).toThrow();
    expect(() => new ReplyMap(-5)).toThrow();
  });
});
