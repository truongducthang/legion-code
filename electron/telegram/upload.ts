/**
 * File and photo uploads from Telegram → local temp directory → optional
 * paste into the focused agent's PTY.
 *
 * Flow:
 *   1. Reject files over 20 MB (Telegram bot API ceiling).
 *   2. `getFile(file_id)` → download to
 *      `<os.tmpdir>/legion-telegram-uploads/<name>`.
 *   3. Reply with the absolute path inside an inline-code span and an
 *      inline keyboard `[📋 Paste path into agent]`.
 *   4. When the user taps the paste button, write the shell-escaped path
 *      into the focused agent's PTY (project opt-in enforced).
 *
 * The paste button's callback data carries a short opaque token; the
 * actual path lives in an in-memory map with a 10-minute TTL and a small
 * LRU cap so callback data stays within Telegram's 64-byte limit.
 */

import type { Bot, Context } from 'grammy';
import { InlineKeyboard } from 'grammy';
import { randomBytes } from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';
import { tmpdir } from 'os';
import { warn as logWarn } from '../log.js';
import { writeToAgent } from '../ipc/pty.js';
import { readToken } from './store.js';
import { getFocusedAgent } from './focus.js';
import { escapeMd2 } from './formatter.js';
import { auditAndReturn, chatAllowed, resolveAgent } from './preamble.js';

const MAX_FILE_SIZE = 20 * 1024 * 1024;
const UPLOAD_TTL_MS = 10 * 60 * 1000;
const UPLOAD_CACHE_MAX = 100;
const TEMP_SUBDIR = 'legion-telegram-uploads';

interface UploadEntry {
  absolutePath: string;
  createdAt: number;
}

const uploads = new Map<string, UploadEntry>();

function prune(): void {
  const now = Date.now();
  for (const [k, v] of uploads) {
    if (now - v.createdAt > UPLOAD_TTL_MS) uploads.delete(k);
  }
  while (uploads.size > UPLOAD_CACHE_MAX) {
    const next = uploads.keys().next();
    if (next.done) break;
    uploads.delete(next.value);
  }
}

function storeUpload(absolutePath: string): string {
  prune();
  // 6 random bytes → 8 base64url chars; well under Telegram's 64-byte limit.
  const token = randomBytes(6).toString('base64url');
  uploads.set(token, { absolutePath, createdAt: Date.now() });
  return token;
}

export function _takeUploadForTests(token: string): string | null {
  prune();
  return uploads.get(token)?.absolutePath ?? null;
}

export function _resetUploadsForTests(): void {
  uploads.clear();
}

/** Shell-escape an absolute path for safe pasting into a typical POSIX
 *  shell. Pure characters pass through unchanged. */
export function shellEscapePath(p: string): string {
  if (/^[\w./\-+@:]+$/.test(p)) return p;
  return `'${p.replace(/'/g, "'\\''")}'`;
}

function sanitizeFilename(name: string): string {
  // Keep only path-safe characters; allow the dot/dash/underscore family.
  const cleaned = name.replace(/[^\w.-]/g, '_').slice(0, 80);
  return cleaned || 'file';
}

interface ReceivedFile {
  fileId: string;
  fileSize: number;
}

function fileFromContext(ctx: Context): ReceivedFile | null {
  const msg = ctx.message;
  if (!msg) return null;
  if (msg.document) {
    return {
      fileId: msg.document.file_id,
      fileSize: msg.document.file_size ?? 0,
    };
  }
  if (msg.photo && msg.photo.length > 0) {
    // Photos arrive as a list of size variants; take the largest.
    const largest = msg.photo[msg.photo.length - 1];
    return {
      fileId: largest.file_id,
      fileSize: largest.file_size ?? 0,
    };
  }
  return null;
}

async function downloadToTemp(filePath: string, fileId: string): Promise<string> {
  const token = await readToken();
  if (!token) throw new Error('No bot token configured.');
  const url = `https://api.telegram.org/file/bot${token}/${filePath}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Telegram file download failed: ${res.status} ${res.statusText}`);
  }
  const dir = path.join(tmpdir(), TEMP_SUBDIR);
  await fs.mkdir(dir, { recursive: true });
  const baseRaw = sanitizeFilename(path.basename(filePath));
  const unique = `${fileId.slice(-6)}-${baseRaw}`;
  const dst = path.join(dir, unique);
  const buf = Buffer.from(await res.arrayBuffer());
  await fs.writeFile(dst, buf);
  return dst;
}

async function safeReply(ctx: Context, body: string, kb?: InlineKeyboard): Promise<void> {
  try {
    await ctx.reply(body, {
      parse_mode: 'MarkdownV2',
      ...(kb ? { reply_markup: kb } : {}),
    });
  } catch (err) {
    logWarn('telegram.upload', 'reply failed', {
      msg: err instanceof Error ? err.message : String(err),
    });
  }
}

async function answerToast(ctx: Context, text: string): Promise<void> {
  try {
    await ctx.answerCallbackQuery({ text });
  } catch (err) {
    logWarn('telegram.upload', 'answerCallbackQuery failed', {
      msg: err instanceof Error ? err.message : String(err),
    });
  }
}

export async function onUploadMessage(ctx: Context): Promise<void> {
  if (!chatAllowed(ctx)) return;
  const f = fileFromContext(ctx);
  if (!f) return;

  if (f.fileSize > MAX_FILE_SIZE) {
    await safeReply(ctx, escapeMd2('Files over 20 MB are not supported by the Telegram bot API.'));
    auditAndReturn(ctx, 'upload', 'reject', null, 'denied', 'oversize');
    return;
  }

  let absolutePath: string;
  try {
    const fileInfo = await ctx.api.getFile(f.fileId);
    if (!fileInfo.file_path) throw new Error('Telegram returned no file_path');
    absolutePath = await downloadToTemp(fileInfo.file_path, f.fileId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logWarn('telegram.upload', 'download failed', { msg });
    await safeReply(ctx, escapeMd2(`Upload failed: ${msg}`));
    auditAndReturn(ctx, 'upload', 'download', null, 'error', msg);
    return;
  }

  const callbackToken = storeUpload(absolutePath);
  const kb = new InlineKeyboard().text('📋 Paste path into agent', `upload:${callbackToken}`);
  const body = ['Saved:', `\`${escapeMd2(absolutePath)}\``].join('\n');
  await safeReply(ctx, body, kb);
  auditAndReturn(ctx, 'upload', 'save', null, 'ok', null);
}

/** Called from inline.ts when an `upload:<token>` callback fires. */
export async function handleUploadPaste(ctx: Context, callbackToken: string): Promise<void> {
  const absolutePath = uploads.get(callbackToken)?.absolutePath ?? null;
  if (absolutePath === null) {
    await answerToast(ctx, 'Upload expired.');
    auditAndReturn(ctx, 'upload', 'paste', null, 'denied', 'token expired or unknown');
    return;
  }
  // Consume on use so the same token cannot paste twice.
  uploads.delete(callbackToken);

  const focused = getFocusedAgent();
  if (!focused) {
    await answerToast(ctx, 'No agent focused on the desktop.');
    auditAndReturn(ctx, 'upload', 'paste', null, 'denied', 'no focused agent');
    return;
  }
  const r = resolveAgent(focused);
  if ('error' in r) {
    await answerToast(ctx, 'Cannot paste — project gate.');
    auditAndReturn(ctx, 'upload', 'paste', focused, 'denied', r.error);
    return;
  }

  try {
    writeToAgent(r.agentId, shellEscapePath(absolutePath));
    await answerToast(ctx, 'Pasted.');
    auditAndReturn(ctx, 'upload', 'paste', r.agentId, 'ok', null);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await answerToast(ctx, 'Paste failed.');
    auditAndReturn(ctx, 'upload', 'paste', r.agentId, 'error', msg);
  }
}

export function registerUploadHandlers(bot: Bot): void {
  bot.on('message:document', async (ctx) => {
    await onUploadMessage(ctx);
  });
  bot.on('message:photo', async (ctx) => {
    await onUploadMessage(ctx);
  });
}
