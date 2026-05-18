/**
 * Best-effort redaction of common secret shapes before agent output crosses
 * Telegram's servers. The filter runs after ANSI stripping so escapes cannot
 * be used to bypass a pattern.
 *
 * NOT a security boundary — the Settings UI says so verbatim.
 */

import { warn as logWarn } from '../log.js';

interface Pattern {
  name: string;
  rx: RegExp;
}

const BASE_REDACTIONS: Pattern[] = [
  { name: 'aws-akid', rx: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: 'gh-pat', rx: /\bghp_[A-Za-z0-9]{36,}\b/g },
  { name: 'gh-fine', rx: /\bgithub_pat_[A-Za-z0-9_]{82,}\b/g },
  { name: 'jwt', rx: /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g },
  { name: 'sk-bearer', rx: /\bsk-[A-Za-z0-9_-]{20,}\b/g },
  { name: 'env-assign', rx: /(?<=(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD)\s*[:=]\s*)\S+/gi },
];

function compileUserPatterns(raw: string[]): Pattern[] {
  const out: Pattern[] = [];
  for (let i = 0; i < raw.length; i++) {
    const src = raw[i];
    try {
      out.push({ name: `user-${i}`, rx: new RegExp(src, 'g') });
    } catch (err) {
      logWarn(
        'telegram.redact',
        `Failed to compile redaction pattern at index ${i}: ${(err as Error).message}`,
      );
    }
  }
  return out;
}

export function redact(input: string, userPatterns: string[] = []): string {
  if (!input) return input;
  const patterns = [...BASE_REDACTIONS, ...compileUserPatterns(userPatterns)];
  let out = input;
  for (const p of patterns) {
    out = out.replace(p.rx, `[REDACTED:${p.name}]`);
  }
  return out;
}
