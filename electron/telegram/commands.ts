/**
 * Telegram command router. Each command runs through a common preamble that
 * (a) verifies the chat is on the allowlist, (b) resolves the agent id when
 * present, (c) verifies the agent's project has `telegramOptIn === true`,
 * and (d) writes one audit entry before side effects.
 *
 * MVP commands (slice 1): /agents /status /prompt /approve /deny /kill /help
 * Slice 2 commands:       /diff /tail /untail /steps /cov /run /ask
 * Aliases:                /a /s /p /d /k /t /u
 *
 * Reply-chain routing (a Telegram "reply to" a tagged bot message) is
 * handled separately in `bot.ts` so it can fire for non-command messages.
 */

import type { Bot, Context } from 'grammy';
import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import {
  getActiveAgentIds,
  getAgentMeta,
  getAgentScrollback,
  writeToAgent,
  killAgent,
} from '../ipc/pty.js';
import { readStepsForWorktree } from '../ipc/steps.js';
import { readCoverageSummary } from '../ipc/coverage.js';
import { escapeMd2, codeBlock, truncate } from './formatter.js';
import { redact } from './redact.js';
import { getConfig } from './config.js';
import { getTaskForAgent, getProjectForTask } from './integration.js';
import { getNotifier } from './notifier.js';
import {
  chatAllowed,
  chatMeta,
  reply,
  resolveAgent,
  auditAndReturn,
  type ResolvedAgent,
} from './preamble.js';
import { record, buildEntry } from './audit.js';

const SCROLLBACK_LINES = 30;
const REPLY_MAX = 3500;
const ASK_TIMEOUT_MS = 120_000;

const execFileP = promisify(execFile);

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
  const mid = await reply(ctx, body);
  // /agents is not agent-scoped; no reply-chain registration.
  void mid;
  auditAndReturn(ctx, 'cmd', '/agents', null, 'ok', null);
}

/* --- /status <id> --- */
async function handleStatus(ctx: Context, agentArg: string | undefined): Promise<void> {
  const r = resolveAgent(agentArg);
  if ('error' in r) {
    await reply(ctx, r.error);
    auditAndReturn(ctx, 'cmd', '/status', agentArg ?? null, 'denied', r.error);
    return;
  }
  const cfg = getConfig();
  const scrollbackB64 = getAgentScrollback(r.agentId);
  if (scrollbackB64 === null) {
    await reply(ctx, 'No scrollback available\\.');
    auditAndReturn(ctx, 'cmd', '/status', r.agentId, 'error', 'no scrollback');
    return;
  }
  const text = Buffer.from(scrollbackB64, 'base64').toString('utf8');
  const stripped = stripAnsi(text);
  const tail = lastLines(stripped, SCROLLBACK_LINES).join('\n');
  const redacted = redact(tail || '(empty)', cfg.redactPatterns);
  const escaped = escapeMd2(redacted);
  const mid = await reply(ctx, codeBlock(truncate(escaped, REPLY_MAX)));
  if (mid !== null) getNotifier()?.replyMap.register(mid, r.agentId);
  auditAndReturn(ctx, 'cmd', '/status', r.agentId, 'ok', null);
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
    auditAndReturn(ctx, 'cmd', '/prompt', agentArg ?? null, 'denied', r.error);
    return;
  }
  if (!body || !body.trim()) {
    await reply(ctx, escapeMd2('Usage: /prompt <id> <text>'));
    auditAndReturn(ctx, 'cmd', '/prompt', r.agentId, 'error', 'empty body');
    return;
  }
  try {
    writeToAgent(r.agentId, body + '\r');
    const mid = await reply(ctx, '→ prompted');
    if (mid !== null) getNotifier()?.replyMap.register(mid, r.agentId);
    auditAndReturn(ctx, 'cmd', '/prompt', r.agentId, 'ok', null);
  } catch (err) {
    await reply(ctx, escapeMd2(`Failed: ${(err as Error).message}`));
    auditAndReturn(ctx, 'cmd', '/prompt', r.agentId, 'error', (err as Error).message);
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
    auditAndReturn(ctx, 'cmd', cmd, agentArg ?? null, 'denied', r.error);
    return;
  }
  try {
    writeToAgent(r.agentId, yes ? 'y\r' : 'n\r');
    const mid = await reply(ctx, yes ? '→ approved' : '→ denied');
    if (mid !== null) getNotifier()?.replyMap.register(mid, r.agentId);
    auditAndReturn(ctx, 'cmd', cmd, r.agentId, 'ok', null);
  } catch (err) {
    await reply(ctx, escapeMd2(`Failed: ${(err as Error).message}`));
    auditAndReturn(ctx, 'cmd', cmd, r.agentId, 'error', (err as Error).message);
  }
}

/* --- /kill <id> --- */
async function handleKill(ctx: Context, agentArg: string | undefined): Promise<void> {
  const r = resolveAgent(agentArg);
  if ('error' in r) {
    await reply(ctx, r.error);
    auditAndReturn(ctx, 'cmd', '/kill', agentArg ?? null, 'denied', r.error);
    return;
  }
  try {
    killAgent(r.agentId);
    await reply(ctx, '→ killed');
    auditAndReturn(ctx, 'cmd', '/kill', r.agentId, 'ok', null);
  } catch (err) {
    await reply(ctx, escapeMd2(`Failed: ${(err as Error).message}`));
    auditAndReturn(ctx, 'cmd', '/kill', r.agentId, 'error', (err as Error).message);
  }
}

/* --- /diff <id> --- */
async function handleDiff(ctx: Context, agentArg: string | undefined): Promise<void> {
  const r = resolveAgent(agentArg);
  if ('error' in r) {
    await reply(ctx, r.error);
    auditAndReturn(ctx, 'cmd', '/diff', agentArg ?? null, 'denied', r.error);
    return;
  }
  const worktree = getNotifier()?.getWorktreeForAgent(r.agentId) ?? null;
  if (!worktree) {
    await reply(ctx, escapeMd2('No worktree path for this agent.'));
    auditAndReturn(ctx, 'cmd', '/diff', r.agentId, 'error', 'no worktree');
    return;
  }
  try {
    const { stdout } = await execFileP('git', ['diff', '--stat'], { cwd: worktree });
    const out = stdout.trim() || '(no changes)';
    const escaped = escapeMd2(out);
    const mid = await reply(ctx, codeBlock(truncate(escaped, REPLY_MAX)));
    if (mid !== null) getNotifier()?.replyMap.register(mid, r.agentId);
    auditAndReturn(ctx, 'cmd', '/diff', r.agentId, 'ok', null);
  } catch (err) {
    await reply(ctx, escapeMd2(`git diff failed: ${(err as Error).message}`));
    auditAndReturn(ctx, 'cmd', '/diff', r.agentId, 'error', (err as Error).message);
  }
}

/* --- /tail <id> --- */
async function handleTail(ctx: Context, agentArg: string | undefined): Promise<void> {
  const r = resolveAgent(agentArg);
  if ('error' in r) {
    await reply(ctx, r.error);
    auditAndReturn(ctx, 'cmd', '/tail', agentArg ?? null, 'denied', r.error);
    return;
  }
  const notifier = getNotifier();
  if (!notifier) {
    await reply(ctx, escapeMd2('Bot is not running.'));
    auditAndReturn(ctx, 'cmd', '/tail', r.agentId, 'error', 'no notifier');
    return;
  }
  const chatId = ctx.chat?.id;
  if (chatId === undefined) return;
  if (notifier.tails.count(chatId) >= notifier.tails.cap()) {
    await reply(
      ctx,
      escapeMd2(`Too many tails (limit ${notifier.tails.cap()}). Use /untail to free one.`),
    );
    auditAndReturn(ctx, 'cmd', '/tail', r.agentId, 'denied', 'tail cap');
    return;
  }
  if (notifier.tails.has(chatId, r.agentId)) {
    await reply(ctx, escapeMd2('Already tailing this agent.'));
    auditAndReturn(ctx, 'cmd', '/tail', r.agentId, 'denied', 'already tailing');
    return;
  }
  // Resolve the agent's project pause-on-backpressure preference.
  const project = projectFromResolved(r);
  const handle = notifier.openTail(
    chatId,
    r.agentId,
    project?.telegramPauseOnBackpressure === true,
  );
  if (!handle) {
    await reply(ctx, escapeMd2('Could not subscribe (agent may have exited).'));
    auditAndReturn(ctx, 'cmd', '/tail', r.agentId, 'error', 'subscribe failed');
    return;
  }
  const mid = await reply(ctx, escapeMd2(`Tailing agent ${r.agentId}. Send /untail to stop.`));
  if (mid !== null) notifier.replyMap.register(mid, r.agentId);
  auditAndReturn(ctx, 'cmd', '/tail', r.agentId, 'ok', null);
}

/* --- /untail <id> --- */
async function handleUntail(ctx: Context, agentArg: string | undefined): Promise<void> {
  const r = resolveAgent(agentArg);
  if ('error' in r) {
    await reply(ctx, r.error);
    auditAndReturn(ctx, 'cmd', '/untail', agentArg ?? null, 'denied', r.error);
    return;
  }
  const chatId = ctx.chat?.id;
  if (chatId === undefined) return;
  const notifier = getNotifier();
  if (!notifier) return;
  const closed = await notifier.closeTail(chatId, r.agentId, 'user');
  if (!closed) {
    await reply(ctx, escapeMd2(`No tail running for ${r.agentId}.`));
    auditAndReturn(ctx, 'cmd', '/untail', r.agentId, 'denied', 'not tailing');
    return;
  }
  await reply(ctx, '→ untailed');
  auditAndReturn(ctx, 'cmd', '/untail', r.agentId, 'ok', null);
}

/* --- /steps <id> --- */
async function handleSteps(ctx: Context, agentArg: string | undefined): Promise<void> {
  const r = resolveAgent(agentArg);
  if ('error' in r) {
    await reply(ctx, r.error);
    auditAndReturn(ctx, 'cmd', '/steps', agentArg ?? null, 'denied', r.error);
    return;
  }
  const worktree = getNotifier()?.getWorktreeForAgent(r.agentId);
  if (!worktree) {
    await reply(ctx, escapeMd2('No worktree path for this agent.'));
    auditAndReturn(ctx, 'cmd', '/steps', r.agentId, 'error', 'no worktree');
    return;
  }
  const steps = readStepsForWorktree(worktree);
  if (!steps) {
    await reply(ctx, escapeMd2('No steps.json found.'));
    auditAndReturn(ctx, 'cmd', '/steps', r.agentId, 'denied', 'no steps');
    return;
  }
  const total = steps.length;
  const done = steps.filter((s) => isStepDone(s)).length;
  const current = steps.find((s) => !isStepDone(s));
  const label = stepLabel(current);
  const body = [
    `*Steps:* ${done}/${total}`,
    current ? `*Current:* ${escapeMd2(label)}` : escapeMd2('All steps complete.'),
  ].join('\n');
  const mid = await reply(ctx, body);
  if (mid !== null) getNotifier()?.replyMap.register(mid, r.agentId);
  auditAndReturn(ctx, 'cmd', '/steps', r.agentId, 'ok', null);
}

function isStepDone(s: unknown): boolean {
  if (!s || typeof s !== 'object') return false;
  const status = (s as { status?: unknown }).status;
  return status === 'completed' || status === 'done';
}

function stepLabel(s: unknown): string {
  if (!s || typeof s !== 'object') return '(unknown)';
  const o = s as { label?: unknown; description?: unknown; title?: unknown; name?: unknown };
  for (const key of ['label', 'title', 'name', 'description'] as const) {
    const v = o[key];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return '(no label)';
}

/* --- /cov <id> --- */
async function handleCoverage(ctx: Context, agentArg: string | undefined): Promise<void> {
  const r = resolveAgent(agentArg);
  if ('error' in r) {
    await reply(ctx, r.error);
    auditAndReturn(ctx, 'cmd', '/cov', agentArg ?? null, 'denied', r.error);
    return;
  }
  const project = projectFromResolved(r);
  if (!project?.path) {
    await reply(ctx, escapeMd2('Project root path not known.'));
    auditAndReturn(ctx, 'cmd', '/cov', r.agentId, 'error', 'no project path');
    return;
  }
  try {
    const summary = await readCoverageSummary(
      project.path,
      project.coverageReportPath ?? undefined,
    );
    if (!summary) {
      await reply(ctx, escapeMd2('No coverage report found.'));
      auditAndReturn(ctx, 'cmd', '/cov', r.agentId, 'denied', 'no report');
      return;
    }
    const t = summary.totals;
    const fmt = (m: { covered: number; total: number; pct: number }): string =>
      `${m.covered}/${m.total} (${m.pct.toFixed(1)}%)`;
    const body = [
      `*Lines:* ${escapeMd2(fmt(t.lines))}`,
      `*Statements:* ${escapeMd2(fmt(t.statements))}`,
      `*Functions:* ${escapeMd2(fmt(t.functions))}`,
      `*Branches:* ${escapeMd2(fmt(t.branches))}`,
    ].join('\n');
    const mid = await reply(ctx, body);
    if (mid !== null) getNotifier()?.replyMap.register(mid, r.agentId);
    auditAndReturn(ctx, 'cmd', '/cov', r.agentId, 'ok', null);
  } catch (err) {
    await reply(ctx, escapeMd2(`Coverage read failed: ${(err as Error).message}`));
    auditAndReturn(ctx, 'cmd', '/cov', r.agentId, 'error', (err as Error).message);
  }
}

/* --- /run <id> <bookmark> --- */
async function handleRun(
  ctx: Context,
  agentArg: string | undefined,
  bookmarkName: string,
): Promise<void> {
  const r = resolveAgent(agentArg);
  if ('error' in r) {
    await reply(ctx, r.error);
    auditAndReturn(ctx, 'cmd', '/run', agentArg ?? null, 'denied', r.error);
    return;
  }
  if (!bookmarkName.trim()) {
    await reply(ctx, escapeMd2('Usage: /run <id> <bookmark>'));
    auditAndReturn(ctx, 'cmd', '/run', r.agentId, 'error', 'missing bookmark');
    return;
  }
  const project = projectFromResolved(r);
  const bookmark = project?.terminalBookmarks.find((b) => b.id === bookmarkName.trim());
  if (!bookmark) {
    await reply(ctx, escapeMd2(`Unknown bookmark "${bookmarkName}".`));
    auditAndReturn(ctx, 'cmd', '/run', r.agentId, 'denied', `unknown bookmark ${bookmarkName}`);
    return;
  }
  try {
    writeToAgent(r.agentId, bookmark.command + '\r');
    await reply(ctx, escapeMd2(`→ ran ${bookmark.id}`));
    auditAndReturn(ctx, 'cmd', '/run', r.agentId, 'ok', bookmark.id);
  } catch (err) {
    await reply(ctx, escapeMd2(`Failed: ${(err as Error).message}`));
    auditAndReturn(ctx, 'cmd', '/run', r.agentId, 'error', (err as Error).message);
  }
}

/* --- /ask <id> <question> --- */
async function handleAsk(
  ctx: Context,
  agentArg: string | undefined,
  question: string,
): Promise<void> {
  const r = resolveAgent(agentArg);
  if ('error' in r) {
    await reply(ctx, r.error);
    auditAndReturn(ctx, 'cmd', '/ask', agentArg ?? null, 'denied', r.error);
    return;
  }
  if (!question.trim()) {
    await reply(ctx, escapeMd2('Usage: /ask <id> <question>'));
    auditAndReturn(ctx, 'cmd', '/ask', r.agentId, 'error', 'missing question');
    return;
  }
  const worktree = getNotifier()?.getWorktreeForAgent(r.agentId);
  if (!worktree) {
    await reply(ctx, escapeMd2('No worktree path for this agent.'));
    auditAndReturn(ctx, 'cmd', '/ask', r.agentId, 'error', 'no worktree');
    return;
  }
  try {
    const answer = await spawnAsk(worktree, question.trim(), ASK_TIMEOUT_MS);
    const escaped = escapeMd2(answer || '(no answer)');
    const mid = await reply(ctx, codeBlock(truncate(escaped, REPLY_MAX)));
    if (mid !== null) getNotifier()?.replyMap.register(mid, r.agentId);
    auditAndReturn(ctx, 'cmd', '/ask', r.agentId, 'ok', null);
  } catch (err) {
    await reply(ctx, escapeMd2(`Ask failed: ${(err as Error).message}`));
    auditAndReturn(ctx, 'cmd', '/ask', r.agentId, 'error', (err as Error).message);
  }
}

function spawnAsk(cwd: string, prompt: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined) env[k] = v;
    }
    delete env.CLAUDECODE;
    delete env.CLAUDE_CODE_SESSION;
    delete env.CLAUDE_CODE_ENTRYPOINT;
    const proc = spawn(
      'claude',
      [
        '-p',
        prompt,
        '--output-format',
        'text',
        '--model',
        'sonnet',
        '--tools',
        '',
        '--no-session-persistence',
        '--append-system-prompt',
        'Answer concisely about the selected code. Use markdown.',
      ],
      { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let out = '';
    let err = '';
    let finished = false;
    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      proc.kill('SIGTERM');
      reject(new Error('timed out'));
    }, timeoutMs);
    proc.stdout?.on('data', (b: Buffer) => {
      out += b.toString('utf8');
    });
    proc.stderr?.on('data', (b: Buffer) => {
      err += b.toString('utf8');
    });
    proc.on('close', (code) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (code === 0) resolve(out.trim());
      else reject(new Error(err.trim() || `exit ${code}`));
    });
    proc.on('error', (e) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      reject(e);
    });
  });
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
  '`/diff <id>` — git diff stat in worktree',
  '`/tail <id>` \\(`/t`\\) — live\\-tail the agent',
  '`/untail <id>` \\(`/u`\\) — stop tailing',
  '`/steps <id>` — step\\-tracking progress',
  '`/cov <id>` — coverage summary',
  '`/run <id> <bookmark>` — run a saved terminal bookmark',
  '`/ask <id> <question>` — ask\\-code about the worktree',
  '`/help` — this message',
].join('\n');

async function handleHelp(ctx: Context): Promise<void> {
  await reply(ctx, HELP_BODY);
  auditAndReturn(ctx, 'cmd', '/help', null, 'ok', null);
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

/* --- helpers --- */
function projectFromResolved(r: ResolvedAgent) {
  const meta = getAgentMeta(r.agentId);
  if (!meta) return null;
  const task = getTaskForAgent(meta.taskId);
  if (!task) return null;
  return getProjectForTask(task.projectId);
}

function splitArgs(text: string): { agent: string | undefined; rest: string } {
  const trimmed = text.trim();
  if (!trimmed) return { agent: undefined, rest: '' };
  const i = trimmed.indexOf(' ');
  if (i === -1) return { agent: trimmed, rest: '' };
  return { agent: trimmed.slice(0, i), rest: trimmed.slice(i + 1) };
}

function splitThree(text: string): { agent: string | undefined; second: string; rest: string } {
  const first = splitArgs(text);
  if (first.agent === undefined) return { agent: undefined, second: '', rest: '' };
  const second = splitArgs(first.rest);
  return {
    agent: first.agent,
    second: second.agent ?? '',
    rest: second.rest,
  };
}

function commandArgs(ctx: Context): string {
  const match = (ctx as unknown as { match?: string }).match;
  return typeof match === 'string' ? match : '';
}

// Match the helpers from formatter.ts that are used in /status — re-imported
// at the top would shadow the local block; declare them as local imports.
import { stripAnsi, lastLines } from './formatter.js';

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

  bot.command('diff', async (ctx) => {
    if (!chatAllowed(ctx)) return;
    const { agent } = splitArgs(commandArgs(ctx));
    await handleDiff(ctx, agent);
  });

  bot.command(['tail', 't'], async (ctx) => {
    if (!chatAllowed(ctx)) return;
    const { agent } = splitArgs(commandArgs(ctx));
    await handleTail(ctx, agent);
  });

  bot.command(['untail', 'u'], async (ctx) => {
    if (!chatAllowed(ctx)) return;
    const { agent } = splitArgs(commandArgs(ctx));
    await handleUntail(ctx, agent);
  });

  bot.command('steps', async (ctx) => {
    if (!chatAllowed(ctx)) return;
    const { agent } = splitArgs(commandArgs(ctx));
    await handleSteps(ctx, agent);
  });

  bot.command('cov', async (ctx) => {
    if (!chatAllowed(ctx)) return;
    const { agent } = splitArgs(commandArgs(ctx));
    await handleCoverage(ctx, agent);
  });

  bot.command('run', async (ctx) => {
    if (!chatAllowed(ctx)) return;
    const { agent, second } = splitThree(commandArgs(ctx));
    await handleRun(ctx, agent, second);
  });

  bot.command('ask', async (ctx) => {
    if (!chatAllowed(ctx)) return;
    const { agent, rest } = splitArgs(commandArgs(ctx));
    await handleAsk(ctx, agent, rest);
  });

  bot.command('help', async (ctx) => {
    if (!chatAllowed(ctx)) return;
    await handleHelp(ctx);
  });

  bot.command('start', async (ctx) => {
    await handleStart(ctx);
  });
}

/* Internal export so bot.ts can wire the reply-chain catch-all to the same
 * handler path used by /prompt. */
export async function handlePromptForReplyChain(
  ctx: Context,
  agentId: string,
  body: string,
): Promise<void> {
  await handlePrompt(ctx, agentId, body);
}

/* Silence unused-import warnings for the audit re-imports — both are used
 * via `auditAndReturn` from preamble; keep imports here as the indirect
 * dependency for clarity. */
void record;
void buildEntry;
void chatMeta;
