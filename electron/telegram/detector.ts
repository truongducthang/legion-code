/**
 * Agent-question detector.
 *
 * Subscribes to base64-encoded PTY chunks for a given agent, decodes them,
 * strips ANSI, accumulates a rolling 8 KB tail, and matches a small ordered
 * set of "agent is waiting for input" patterns. Each match fires at most
 * once per agent + pattern id per 30-second window.
 *
 * The detector is purely a producer of `QuestionMatch` events; the bot
 * wiring in `index.ts` is responsible for pushing notifications through the
 * rate limiter to allowed chats.
 */

import { stripAnsi } from './formatter.js';
import { warn as logWarn } from '../log.js';
import type { QuestionMatch } from './types.js';

const TAIL_BYTES = 8 * 1024;
const SUPPRESS_MS = 30_000;

interface Pattern {
  id: string;
  rx: RegExp;
}

const BASE_PATTERNS: Pattern[] = [
  { id: 'yn-bracket', rx: /\?\s*\[y\/N\]\s*$/i },
  { id: 'yn-words', rx: /(?:do you (?:want|wish) to|proceed\??)\s*$/i },
  { id: 'claude-permission', rx: /Allow this (?:tool|command) to run\?/i },
  { id: 'press-enter', rx: /press (?:enter|return) to continue/i },
];

function compileUserPatterns(raw: string[]): Pattern[] {
  const out: Pattern[] = [];
  for (let i = 0; i < raw.length; i++) {
    const src = raw[i];
    try {
      out.push({ id: `user-${i}`, rx: new RegExp(src, 'i') });
    } catch (err) {
      logWarn(
        'telegram.detector',
        `Failed to compile extra question pattern at index ${i}: ${(err as Error).message}`,
      );
    }
  }
  return out;
}

interface AgentState {
  tail: string;
  lastFire: Map<string, number>;
}

export class QuestionDetector {
  private readonly state = new Map<string, AgentState>();
  private patterns: Pattern[] = [...BASE_PATTERNS];

  setUserPatterns(patterns: string[]): void {
    this.patterns = [...BASE_PATTERNS, ...compileUserPatterns(patterns)];
  }

  /** Drop an agent's tracked state. Call on agent exit. */
  forget(agentId: string): void {
    this.state.delete(agentId);
  }

  /** Feed one base64-encoded PTY chunk. Returns 0+ matches that should be
   *  pushed as notifications (suppression already applied). */
  feed(agentId: string, encoded: string, now: number = Date.now()): QuestionMatch[] {
    const decoded = Buffer.from(encoded, 'base64').toString('utf8');
    const stripped = stripAnsi(decoded);
    let s = this.state.get(agentId);
    if (!s) {
      s = { tail: '', lastFire: new Map() };
      this.state.set(agentId, s);
    }
    s.tail = (s.tail + stripped).slice(-TAIL_BYTES);

    const matches: QuestionMatch[] = [];
    for (const p of this.patterns) {
      if (!p.rx.test(s.tail)) continue;
      const last = s.lastFire.get(p.id);
      if (last !== undefined && now - last < SUPPRESS_MS) {
        // Refresh suppression window so a slow stream of repeated matches
        // doesn't eventually trigger the second notification.
        s.lastFire.set(p.id, now);
        continue;
      }
      s.lastFire.set(p.id, now);
      matches.push({
        agentId,
        patternId: p.id,
        tailLine: lastNonEmptyLine(s.tail),
        matchedAt: now,
      });
    }
    return matches;
  }
}

function lastNonEmptyLine(text: string): string {
  const lines = text.split('\n').map((l) => l.replace(/\r$/, ''));
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].trim().length > 0) return lines[i];
  }
  return '';
}
