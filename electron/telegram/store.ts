import { app, safeStorage } from 'electron';
import { promises as fs } from 'fs';
import path from 'path';
import { TelegramError } from './types.js';

function tokenPath(): string {
  return path.join(app.getPath('userData'), 'telegram-token.bin');
}

function openaiKeyPath(): string {
  return path.join(app.getPath('userData'), 'telegram-openai.bin');
}

async function writeEncrypted(filePath: string, plaintext: string): Promise<void> {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new TelegramError(
      'encryption-unavailable',
      'Encrypted token storage is unavailable. Install libsecret (Linux) or use the macOS Keychain.',
    );
  }
  const enc = safeStorage.encryptString(plaintext);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, enc, { mode: 0o600 });
}

async function readEncrypted(filePath: string): Promise<string | null> {
  try {
    const enc = await fs.readFile(filePath);
    return safeStorage.decryptString(enc);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    return null;
  }
}

async function clearFile(filePath: string): Promise<void> {
  try {
    await fs.unlink(filePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
}

export async function writeToken(token: string): Promise<void> {
  await writeEncrypted(tokenPath(), token);
}

export async function readToken(): Promise<string | null> {
  return readEncrypted(tokenPath());
}

export async function clearToken(): Promise<void> {
  await clearFile(tokenPath());
}

export async function hasToken(): Promise<boolean> {
  try {
    await fs.access(tokenPath());
    return true;
  } catch {
    return false;
  }
}

export async function writeOpenAiKey(key: string): Promise<void> {
  await writeEncrypted(openaiKeyPath(), key);
}

export async function readOpenAiKey(): Promise<string | null> {
  return readEncrypted(openaiKeyPath());
}

export async function clearOpenAiKey(): Promise<void> {
  await clearFile(openaiKeyPath());
}
