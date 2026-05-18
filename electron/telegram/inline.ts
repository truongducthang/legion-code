/**
 * Inline-keyboard callback handlers: `approve:<id>`, `deny:<id>`, `open:<id>`.
 *
 * Each handler enforces the same preamble as the equivalent slash command
 * (chat allowed, agent exists, project opted in), records an audit entry,
 * and answers the callback query with a one-line toast. After approve/deny
 * the original notification is edited to append `— approved by <user>` (or
 * `denied`) so the action is auditable in the chat history.
 */

import type { Bot, Context } from 'grammy';
import { InlineKeyboard } from 'grammy';
import { writeToAgent } from '../ipc/pty.js';
import { chatAllowed, resolveAgent, auditAndReturn } from './preamble.js';
import { getConfig } from './config.js';
import { escapeMd2 } from './formatter.js';
import { warn as logWarn } from '../log.js';
import { handleUploadPaste } from './upload.js';

type Action = 'approve' | 'deny' | 'open' | 'upload';

function parseData(data: string): { action: Action; payload: string } | null {
  const i = data.indexOf(':');
  if (i < 0) return null;
  const action = data.slice(0, i);
  const payload = data.slice(i + 1);
  if (action !== 'approve' && action !== 'deny' && action !== 'open' && action !== 'upload') {
    return null;
  }
  if (!payload) return null;
  return { action, payload };
}

async function answerToast(ctx: Context, text: string): Promise<void> {
  try {
    await ctx.answerCallbackQuery({ text });
  } catch (err) {
    logWarn('telegram.inline', 'answerCallbackQuery failed', {
      msg: err instanceof Error ? err.message : String(err),
    });
  }
}

async function appendNote(ctx: Context, note: string): Promise<void> {
  // Edit the message the inline button was attached to, appending the note.
  const msg = ctx.callbackQuery?.message;
  if (!msg || !('text' in msg) || typeof msg.text !== 'string') return;
  try {
    // The original message is MD2-escaped; the appended note must be too.
    // We cannot easily reconstruct the MD2-escaped original (grammy returns
    // the plain-text form), so the edit uses no parse_mode — Telegram will
    // render the appended note inline as plain text.
    await ctx.editMessageText(`${msg.text}\n— ${note}`);
  } catch (err) {
    logWarn('telegram.inline', 'editMessageText failed', {
      msg: err instanceof Error ? err.message : String(err),
    });
  }
}

async function handleApproveDeny(
  ctx: Context,
  action: 'approve' | 'deny',
  agentId: string,
): Promise<void> {
  const r = resolveAgent(agentId);
  const cmd = action === 'approve' ? 'approve' : 'deny';
  if ('error' in r) {
    await answerToast(ctx, action === 'approve' ? 'Cannot approve.' : 'Cannot deny.');
    auditAndReturn(ctx, 'inline', cmd, agentId, 'denied', r.error);
    return;
  }
  try {
    writeToAgent(r.agentId, action === 'approve' ? 'y\n' : 'n\n');
    await answerToast(ctx, action === 'approve' ? 'Approved.' : 'Denied.');
    const user = ctx.from?.username ?? ctx.from?.first_name ?? 'someone';
    await appendNote(ctx, `${action} by ${user}`);
    auditAndReturn(ctx, 'inline', cmd, r.agentId, 'ok', null);
  } catch (err) {
    await answerToast(ctx, 'Failed.');
    auditAndReturn(ctx, 'inline', cmd, r.agentId, 'error', (err as Error).message);
  }
}

async function handleOpen(ctx: Context, agentId: string): Promise<void> {
  const r = resolveAgent(agentId);
  if ('error' in r) {
    await answerToast(ctx, 'Cannot open.');
    auditAndReturn(ctx, 'inline', 'open', agentId, 'denied', r.error);
    return;
  }
  const cfg = getConfig();
  if (!cfg.publicBaseUrl) {
    await answerToast(ctx, 'No public URL.');
    try {
      await ctx.reply('Set a public URL in Settings to open the full session\\.', {
        parse_mode: 'MarkdownV2',
      });
    } catch {
      /* best effort */
    }
    auditAndReturn(ctx, 'inline', 'open', r.agentId, 'denied', 'no public url');
    return;
  }
  const url = `${cfg.publicBaseUrl.replace(/\/$/, '')}/?agent=${encodeURIComponent(r.agentId)}`;
  await answerToast(ctx, 'Opening…');
  try {
    const kb = new InlineKeyboard().webApp(`Open agent ${r.agentId}`, url);
    await ctx.reply(escapeMd2('Tap to open the full session.'), {
      parse_mode: 'MarkdownV2',
      reply_markup: kb,
    });
    auditAndReturn(ctx, 'inline', 'open', r.agentId, 'ok', null);
  } catch (err) {
    auditAndReturn(ctx, 'inline', 'open', r.agentId, 'error', (err as Error).message);
  }
}

export function registerInlineCallbacks(bot: Bot): void {
  bot.on('callback_query:data', async (ctx) => {
    if (!chatAllowed(ctx)) {
      await answerToast(ctx, 'Not authorised.');
      return;
    }
    const parsed = parseData(ctx.callbackQuery.data);
    if (!parsed) {
      await answerToast(ctx, 'Unknown action.');
      return;
    }
    switch (parsed.action) {
      case 'open':
        await handleOpen(ctx, parsed.payload);
        break;
      case 'upload':
        await handleUploadPaste(ctx, parsed.payload);
        break;
      case 'approve':
      case 'deny':
        await handleApproveDeny(ctx, parsed.action, parsed.payload);
        break;
    }
  });
}
