import { info as logInfo } from '../log.js';
import type { AuditEntry } from './types.js';

/**
 * Record one structured audit entry per command, inline callback, voice
 * ingest, file ingest, config change, or auto-remove event.
 *
 * Token values, transcripts, file contents, and scrollback text are NEVER
 * passed in via `detail`. Callers must summarise outcomes only.
 */
export function record(entry: AuditEntry): void {
  logInfo('telegram.audit', `${entry.category}:${entry.cmd}`, {
    chatId: entry.chatId,
    username: entry.username,
    agentId: entry.agentId,
    outcome: entry.outcome,
    detail: entry.detail,
    ts: entry.ts,
  });
}

export function buildEntry(partial: Omit<AuditEntry, 'ts'> & { ts?: number }): AuditEntry {
  return { ...partial, ts: partial.ts ?? Date.now() };
}
