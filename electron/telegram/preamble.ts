/**
 * Shared command/callback preamble: chat-allowed check, agent resolution,
 * project opt-in gate, audit-and-reply helper. Used by both slash commands
 * (`commands.ts`) and inline keyboard callbacks (`inline.ts`).
 */

import type { Context } from 'grammy';
import { getAgentMeta } from '../ipc/pty.js';
import { getConfig } from './config.js';
import { getTaskForAgent, getProjectForTask } from './integration.js';
import { escapeMd2 } from './formatter.js';
import { record, buildEntry } from './audit.js';
import type { AuditEntry } from './types.js';

export interface ResolvedAgent {
  agentId: string;
  taskId: string;
  projectId: string;
  projectName: string;
  projectOptIn: true;
}

export type ResolveResult = ResolvedAgent | { error: string };

export function chatAllowed(ctx: Context): boolean {
  const chatId = ctx.chat?.id;
  if (chatId === undefined) return false;
  return getConfig().allowedChatIds.includes(chatId);
}

export function chatMeta(ctx: Context): { chatId: number; username: string | null } {
  return {
    chatId: ctx.chat?.id ?? 0,
    username: ctx.from?.username ?? null,
  };
}

export async function reply(ctx: Context, text: string): Promise<number | null> {
  try {
    const sent = await ctx.reply(text, { parse_mode: 'MarkdownV2' });
    return sent.message_id ?? null;
  } catch {
    try {
      const sent = await ctx.reply(text.replace(/\\/g, ''));
      return sent.message_id ?? null;
    } catch {
      return null;
    }
  }
}

export function resolveAgent(agentId: string | undefined): ResolveResult {
  if (!agentId) return { error: 'Agent id missing.' };
  const meta = getAgentMeta(agentId);
  if (!meta) return { error: `Unknown agent: ${escapeMd2(agentId)}` };
  const task = getTaskForAgent(meta.taskId);
  if (!task) return { error: 'Agent task not found.' };
  const project = getProjectForTask(task.projectId);
  if (!project) return { error: 'Agent project not found.' };
  if (project.telegramOptIn !== true) {
    return { error: 'That project is not opted in to Telegram control\\.' };
  }
  return {
    agentId,
    taskId: meta.taskId,
    projectId: project.id,
    projectName: project.name,
    projectOptIn: true,
  };
}

export function auditAndReturn(
  ctx: Context,
  category: AuditEntry['category'],
  cmd: string,
  agentId: string | null,
  outcome: AuditEntry['outcome'],
  detail: string | null,
): void {
  record(
    buildEntry({
      ...chatMeta(ctx),
      category,
      cmd,
      agentId,
      outcome,
      detail,
    }),
  );
}
