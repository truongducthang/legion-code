/**
 * Telegram command router. Each command runs through a common preamble that
 * (a) verifies the chat is on the allowlist, (b) resolves the agent id when
 * present, (c) verifies the agent's project has `telegramOptIn === true`,
 * and (d) writes one audit entry before side effects.
 *
 * Slice 1 MVP set: /agents /status /prompt /approve /deny /kill /help.
 * Additional commands (/tail /diff /steps /cov /run /ask) ship in later
 * slices per `openspec/changes/add-telegram-control/`.
 */

import type { Bot, Context } from 'grammy';
import {
  getActiveAgentIds,
  getAgentMeta,
  getAgentScrollback,
  writeToAgent,
  killAgent,
} from '../ipc/pty.js';
import { record, buildEntry } from './audit.js';
import { stripAnsi, escapeMd2, lastLines, codeBlock, truncate } from './formatter.js';
import { redact } from './redact.js';
import { getConfig } from './config.js';
import { getTaskForAgent, getProjectForTask } from './integration.js';
import type { AuditEntry } from './types.js';

const SCROLLBACK_LINES = 30;
const REPLY_MAX = 3500;

interface PreambleResult {
  agentId: string;
  taskId: string;
  projectOptIn: boolean;
  projectName: string;
}

function chatAllowed(ctx: Context): boolean {
  const chatId = ctx.chat?.id;
  if (chatId === undefined) return false;
  return getConfig().allowedChatIds.includes(chatId);
}

function chatMeta(ctx: Context): { chatId: number; username: string | null } {
  return {
    chatId: ctx.chat?.id ?? 0,
    username: ctx.from?.username ?? null,
  };
}

async function reply(ctx: Context, text: string): Promise<void> {
  try {
    await ctx.reply(text, { parse_mode: 'MarkdownV2' });
  } catch {
    // Fallback to plain text if MD2 parse fails (defensive — every reply path
    // SHOULD escape, but we don't want a parser error to swallow the message).
    try {
      await ctx.reply(text.replace(/\\/g, ''));
    } catch {
      /* give up — Telegram will surface the original error in the bot's catch */
    }
  }
}

function resolveAgent(agentId: string | undefined): PreambleResult | { error: string } {
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
    projectOptIn: true,
    projectName: project.name,
  };
}

function auditAndReturn(
  ctx: Context,
  cmd: string,
  agentId: string | null,
  outcome: AuditEntry['outcome'],
  detail: string | null,
): void {
  record(
    buildEntry({
      ...chatMeta(ctx),
      category: 'cmd',
      cmd,
      agentId,
      outcome,
      detail,
    }),
  );
}

/* --- /agents --- */
async function handleAgents(ctx: Context): Promise<void> {
  const ids = getActiveAgentIds();
  const lines: string[] = [];
  for (const id of ids.slice(0, 30)) {
    const meta = getAgentMeta(id);
    if (!meta) continue;
    const task = getTaskForAgent(meta.taskId);
    const project = task ? getProjectForTask(task.projectId) : null;
    const optIn = project?.telegramOptIn === true ? '✓' : '✗';
    const projectName = project?.name ?? '?';
    const taskName = task?.name ?? '?';
    lines.push(
      `\`${escapeMd2(id)}\` — ${escapeMd2(projectName)} — ${escapeMd2(taskName)} ${optIn}`,
    );
  }
  if (ids.length > 30) lines.push(escapeMd2(`… (${ids.length - 30} more)`));
  const body = lines.length > 0 ? lines.join('\n') : escapeMd2('No active agents.');
  await reply(ctx, body);
  auditAndReturn(ctx, '/agents', null, 'ok', null);
}

/* --- /status <id> --- */
async function handleStatus(ctx: Context, agentArg: string | undefined): Promise<void> {
  const r = resolveAgent(agentArg);
  if ('error' in r) {
    await reply(ctx, r.error);
    auditAndReturn(ctx, '/status', agentArg ?? null, 'denied', r.error);
    return;
  }
  const cfg = getConfig();
  const scrollbackB64 = getAgentScrollback(r.agentId);
  if (scrollbackB64 === null) {
    await reply(ctx, 'No scrollback available\\.');
    auditAndReturn(ctx, '/status', r.agentId, 'error', 'no scrollback');
    return;
  }
  const text = Buffer.from(scrollbackB64, 'base64').toString('utf8');
  const stripped = stripAnsi(text);
  const tail = lastLines(stripped, SCROLLBACK_LINES).join('\n');
  const redacted = redact(tail || '(empty)', cfg.redactPatterns);
  const escaped = escapeMd2(redacted);
  await reply(ctx, codeBlock(truncate(escaped, REPLY_MAX)));
  auditAndReturn(ctx, '/status', r.agentId, 'ok', null);
}

/* --- /prompt <id> <text> --- */
async function handlePrompt(
  ctx: Context,
  agentArg: string | undefined,
  body: string,
): Promise<void> {
  const r = resolveAgent(agentArg);
  if ('error' in r) {
    await reply(ctx, r.error);
    auditAndReturn(ctx, '/prompt', agentArg ?? null, 'denied', r.error);
    return;
  }
  if (!body || !body.trim()) {
    await reply(ctx, escapeMd2('Usage: /prompt <id> <text>'));
    auditAndReturn(ctx, '/prompt', r.agentId, 'error', 'empty body');
    return;
  }
  try {
    writeToAgent(r.agentId, body + '\n');
    await reply(ctx, '→ prompted');
    auditAndReturn(ctx, '/prompt', r.agentId, 'ok', null);
  } catch (err) {
    await reply(ctx, escapeMd2(`Failed: ${(err as Error).message}`));
    auditAndReturn(ctx, '/prompt', r.agentId, 'error', (err as Error).message);
  }
}

/* --- /approve <id>, /deny <id> --- */
async function handleYesNo(
  ctx: Context,
  agentArg: string | undefined,
  yes: boolean,
): Promise<void> {
  const cmd = yes ? '/approve' : '/deny';
  const r = resolveAgent(agentArg);
  if ('error' in r) {
    await reply(ctx, r.error);
    auditAndReturn(ctx, cmd, agentArg ?? null, 'denied', r.error);
    return;
  }
  try {
    writeToAgent(r.agentId, yes ? 'y\n' : 'n\n');
    await reply(ctx, yes ? '→ approved' : '→ denied');
    auditAndReturn(ctx, cmd, r.agentId, 'ok', null);
  } catch (err) {
    await reply(ctx, escapeMd2(`Failed: ${(err as Error).message}`));
    auditAndReturn(ctx, cmd, r.agentId, 'error', (err as Error).message);
  }
}

/* --- /kill <id> --- */
async function handleKill(ctx: Context, agentArg: string | undefined): Promise<void> {
  const r = resolveAgent(agentArg);
  if ('error' in r) {
    await reply(ctx, r.error);
    auditAndReturn(ctx, '/kill', agentArg ?? null, 'denied', r.error);
    return;
  }
  try {
    killAgent(r.agentId);
    await reply(ctx, '→ killed');
    auditAndReturn(ctx, '/kill', r.agentId, 'ok', null);
  } catch (err) {
    await reply(ctx, escapeMd2(`Failed: ${(err as Error).message}`));
    auditAndReturn(ctx, '/kill', r.agentId, 'error', (err as Error).message);
  }
}

/* --- /help --- */
const HELP_BODY = [
  '*Telegram control commands*',
  '',
  '`/agents` \\(`/a`\\) — list active agents',
  '`/status <id>` \\(`/s`\\) — last 30 scrollback lines',
  '`/prompt <id> <text>` \\(`/p`\\) — write text into the agent',
  '`/approve <id>` — write `y`',
  '`/deny <id>` \\(`/d`\\) — write `n`',
  '`/kill <id>` \\(`/k`\\) — terminate the agent',
  '`/help` — this message',
].join('\n');

async function handleHelp(ctx: Context): Promise<void> {
  await reply(ctx, HELP_BODY);
  auditAndReturn(ctx, '/help', null, 'ok', null);
}

/* --- /start (unknown chat onboarding) --- */
async function handleStart(ctx: Context): Promise<void> {
  const chatId = ctx.chat?.id;
  if (chatId === undefined) return;
  if (getConfig().allowedChatIds.includes(chatId)) {
    await reply(ctx, escapeMd2('Bot is active. Send /help for commands.'));
    return;
  }
  const msg = [
    `Chat id: \`${escapeMd2(String(chatId))}\``,
    '',
    escapeMd2('Paste this id into Settings → Telegram → Allowed chats, then send /start again.'),
  ].join('\n');
  await reply(ctx, msg);
}

/* --- argument parsing --- */
function splitArgs(text: string): { agent: string | undefined; rest: string } {
  // text is the part after the command, e.g. "abc-123 hello world"
  const trimmed = text.trim();
  if (!trimmed) return { agent: undefined, rest: '' };
  const i = trimmed.indexOf(' ');
  if (i === -1) return { agent: trimmed, rest: '' };
  return { agent: trimmed.slice(0, i), rest: trimmed.slice(i + 1) };
}

function commandArgs(ctx: Context): string {
  // grammy stores the text of /cmd arg1 arg2 in `ctx.message.text` minus the prefix.
  // `ctx.match` exposes the part after the command name (grammy populates it for `bot.command`).
  const match = (ctx as unknown as { match?: string }).match;
  return typeof match === 'string' ? match : '';
}

/* --- public registration --- */
export function registerCommands(bot: Bot): void {
  bot.command(['agents', 'a'], async (ctx) => {
    if (!chatAllowed(ctx)) return;
    await handleAgents(ctx);
  });

  bot.command(['status', 's'], async (ctx) => {
    if (!chatAllowed(ctx)) return;
    const { agent } = splitArgs(commandArgs(ctx));
    await handleStatus(ctx, agent);
  });

  bot.command(['prompt', 'p'], async (ctx) => {
    if (!chatAllowed(ctx)) return;
    const { agent, rest } = splitArgs(commandArgs(ctx));
    await handlePrompt(ctx, agent, rest);
  });

  bot.command('approve', async (ctx) => {
    if (!chatAllowed(ctx)) return;
    const { agent } = splitArgs(commandArgs(ctx));
    await handleYesNo(ctx, agent, true);
  });

  bot.command(['deny', 'd'], async (ctx) => {
    if (!chatAllowed(ctx)) return;
    const { agent } = splitArgs(commandArgs(ctx));
    await handleYesNo(ctx, agent, false);
  });

  bot.command(['kill', 'k'], async (ctx) => {
    if (!chatAllowed(ctx)) return;
    const { agent } = splitArgs(commandArgs(ctx));
    await handleKill(ctx, agent);
  });

  bot.command('help', async (ctx) => {
    if (!chatAllowed(ctx)) return;
    await handleHelp(ctx);
  });

  bot.command('start', async (ctx) => {
    await handleStart(ctx);
  });
}
