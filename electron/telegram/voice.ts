/**
 * Voice prompts: Telegram voice message → audio file → transcription →
 * injected as text into a target agent's PTY.
 *
 * Pipeline:
 *   1. Allowed-chat check.
 *   2. Runtime check — `voice.runtime === 'none'` short-circuits with a
 *      "voice disabled" reply.
 *   3. `getFile(file_id)` → stream-download the OGG/opus payload to a
 *      per-message temp file under `<os.tmpdir>/legion-code-telegram-voice/`.
 *   4. Transcribe via whisper.cpp or OpenAI Whisper API.
 *   5. Resolve the target agent in this order:
 *      reply-chain (via notifier.replyMap) → focused agent → error reply.
 *   6. `writeToAgent(agent, transcript + '\n')`.
 *   7. Reply with `🎙 → <transcript>` (redact() + escapeMd2()).
 *   8. Best-effort temp-file cleanup regardless of outcome.
 *
 * Temp files never persist past the function call. The OpenAI API key is
 * read fresh from `store.readOpenAiKey()` each call; the renderer never
 * sees the plaintext key.
 */

import type { Bot, Context } from 'grammy';
import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import path from 'path';
import { randomBytes } from 'crypto';
import { tmpdir } from 'os';
import { warn as logWarn } from '../log.js';
import { writeToAgent } from '../ipc/pty.js';
import { getConfig } from './config.js';
import { readToken, readOpenAiKey } from './store.js';
import { getFocusedAgent } from './focus.js';
import { escapeMd2 } from './formatter.js';
import { redact } from './redact.js';
import { auditAndReturn, chatAllowed, resolveAgent } from './preamble.js';
import { getNotifier } from './notifier.js';

const WHISPER_TIMEOUT_MS = 60_000;
const TEMP_SUBDIR = 'legion-code-telegram-voice';
const OPENAI_TRANSCRIPTION_URL = 'https://api.openai.com/v1/audio/transcriptions';

async function safeReply(ctx: Context, body: string): Promise<void> {
  try {
    await ctx.reply(body, { parse_mode: 'MarkdownV2' });
  } catch (err) {
    logWarn('telegram.voice', 'reply failed', {
      msg: err instanceof Error ? err.message : String(err),
    });
  }
}

function tempDir(): string {
  return path.join(tmpdir(), TEMP_SUBDIR);
}

async function downloadVoice(filePath: string): Promise<string> {
  const token = await readToken();
  if (!token) throw new Error('No bot token configured.');
  const url = `https://api.telegram.org/file/bot${token}/${filePath}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Telegram voice download failed: ${res.status} ${res.statusText}`);
  }
  const dir = tempDir();
  await fs.mkdir(dir, { recursive: true });
  const dst = path.join(dir, `${randomBytes(8).toString('hex')}.oga`);
  await fs.writeFile(dst, Buffer.from(await res.arrayBuffer()));
  return dst;
}

async function cleanupQuiet(...files: string[]): Promise<void> {
  await Promise.all(
    files.map(async (f) => {
      try {
        await fs.unlink(f);
      } catch {
        /* missing or already removed */
      }
    }),
  );
}

async function transcribeWhisperCpp(audioPath: string, binaryPath: string): Promise<string> {
  const outputPrefix = audioPath.replace(/\.[^.]+$/, '') + '.transcript';
  return await new Promise<string>((resolve, reject) => {
    const proc = spawn(binaryPath, ['-f', audioPath, '-otxt', '-of', outputPrefix], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    let settled = false;

    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };

    const timer = setTimeout(() => {
      settle(() => {
        try {
          proc.kill('SIGTERM');
        } catch {
          /* already exited */
        }
        reject(new Error('TIMEOUT'));
      });
    }, WHISPER_TIMEOUT_MS);

    proc.stderr?.on('data', (b: Buffer) => {
      stderr += b.toString('utf8');
    });

    proc.once('error', (err) => {
      settle(() => reject(err));
    });

    proc.once('close', (code) => {
      settle(async () => {
        if (code !== 0) {
          reject(new Error(`whisper.cpp exited ${code}: ${stderr.trim().slice(0, 200)}`));
          return;
        }
        try {
          const txt = await fs.readFile(`${outputPrefix}.txt`, 'utf8');
          await cleanupQuiet(`${outputPrefix}.txt`);
          resolve(txt.trim());
        } catch (err) {
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      });
    });
  });
}

async function transcribeOpenAi(audioPath: string): Promise<string> {
  const apiKey = await readOpenAiKey();
  if (!apiKey) throw new Error('OpenAI API key not configured.');
  const fileBuf = await fs.readFile(audioPath);
  const form = new FormData();
  form.set(
    'file',
    new Blob([new Uint8Array(fileBuf)], { type: 'audio/ogg' }),
    path.basename(audioPath),
  );
  form.set('model', 'whisper-1');
  const res = await fetch(OPENAI_TRANSCRIPTION_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`OpenAI transcription failed: ${res.status} ${res.statusText} ${text}`);
  }
  const body = (await res.json()) as { text?: unknown };
  if (typeof body.text !== 'string') {
    throw new Error('OpenAI transcription response missing `text`');
  }
  return body.text.trim();
}

function resolveVoiceTarget(ctx: Context): string | null {
  // Reply-chain wins: a Telegram "reply to" on a tagged bot message routes
  // back to the source agent without needing focus.
  const parentId = ctx.message?.reply_to_message?.message_id;
  if (typeof parentId === 'number') {
    const fromReply = getNotifier()?.replyMap.lookup(parentId);
    if (fromReply) return fromReply;
  }
  return getFocusedAgent();
}

export async function onVoiceMessage(ctx: Context): Promise<void> {
  if (!chatAllowed(ctx)) return;

  const voice = ctx.message?.voice;
  if (!voice) return;

  const runtime = getConfig().voice.runtime;
  if (runtime === 'none') {
    await safeReply(ctx, escapeMd2('Voice input is disabled. Enable it in Settings.'));
    auditAndReturn(ctx, 'voice', 'recv', null, 'denied', 'runtime=none');
    return;
  }

  // Resolve target agent BEFORE downloading: avoids paying for transcription
  // we cannot use. resolveAgent enforces project opt-in.
  const targetRaw = resolveVoiceTarget(ctx);
  if (!targetRaw) {
    await safeReply(
      ctx,
      escapeMd2('No agent is focused — open one on the desktop first, or reply to a notification.'),
    );
    auditAndReturn(ctx, 'voice', 'recv', null, 'denied', 'no target');
    return;
  }
  const resolved = resolveAgent(targetRaw);
  if ('error' in resolved) {
    await safeReply(ctx, resolved.error);
    auditAndReturn(ctx, 'voice', 'recv', targetRaw, 'denied', resolved.error);
    return;
  }

  // Download to a temp file we own.
  let audioPath: string;
  try {
    const fileInfo = await ctx.api.getFile(voice.file_id);
    if (!fileInfo.file_path) throw new Error('Telegram returned no file_path');
    audioPath = await downloadVoice(fileInfo.file_path);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logWarn('telegram.voice', 'download failed', { msg });
    await safeReply(ctx, escapeMd2(`Voice download failed: ${msg}`));
    auditAndReturn(ctx, 'voice', 'download', resolved.agentId, 'error', msg);
    return;
  }

  // Transcribe.
  let transcript: string;
  try {
    if (runtime === 'whisper-cpp') {
      const binary = getConfig().voice.whisperCppPath;
      if (!binary) throw new Error('whisper.cpp binary path not configured.');
      transcript = await transcribeWhisperCpp(audioPath, binary);
    } else {
      transcript = await transcribeOpenAi(audioPath);
    }
  } catch (err) {
    await cleanupQuiet(audioPath);
    const msg = err instanceof Error ? err.message : String(err);
    if (msg === 'TIMEOUT') {
      await safeReply(ctx, escapeMd2('Transcription timed out.'));
      auditAndReturn(ctx, 'voice', 'transcribe', resolved.agentId, 'error', 'timeout');
    } else {
      logWarn('telegram.voice', 'transcribe failed', { msg });
      await safeReply(ctx, escapeMd2(`Transcription failed: ${msg}`));
      auditAndReturn(ctx, 'voice', 'transcribe', resolved.agentId, 'error', msg);
    }
    return;
  }
  await cleanupQuiet(audioPath);

  if (!transcript) {
    await safeReply(ctx, escapeMd2('Transcription returned empty text.'));
    auditAndReturn(ctx, 'voice', 'transcribe', resolved.agentId, 'error', 'empty transcript');
    return;
  }

  // Inject into the agent's PTY.
  try {
    writeToAgent(resolved.agentId, transcript + '\r');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await safeReply(ctx, escapeMd2(`Failed to write to agent: ${msg}`));
    auditAndReturn(ctx, 'voice', 'inject', resolved.agentId, 'error', msg);
    return;
  }

  // Echo what we heard (redacted, MD2-escaped) for visibility / trust.
  const cfg = getConfig();
  const sanitized = redact(transcript, cfg.redactPatterns);
  const escaped = escapeMd2(sanitized);
  const mid = await sendEcho(ctx, escaped);
  if (mid !== null) {
    getNotifier()?.replyMap.register(mid, resolved.agentId);
  }
  auditAndReturn(ctx, 'voice', 'inject', resolved.agentId, 'ok', null);
}

async function sendEcho(ctx: Context, escapedTranscript: string): Promise<number | null> {
  const body = `🎙 → ${escapedTranscript}`;
  try {
    const sent = await ctx.reply(body, { parse_mode: 'MarkdownV2' });
    return sent.message_id ?? null;
  } catch (err) {
    logWarn('telegram.voice', 'echo reply failed', {
      msg: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

export function registerVoiceHandlers(bot: Bot): void {
  bot.on('message:voice', async (ctx) => {
    await onVoiceMessage(ctx);
  });
}
