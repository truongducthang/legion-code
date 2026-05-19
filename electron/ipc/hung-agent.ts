import fs from 'fs';
import path from 'path';
import { Notification, type BrowserWindow } from 'electron';
import { IPC } from './channels.js';
import { onPtyEvent, snapshotRunningAgents, writeToAgent } from './pty.js';
import { warn as logWarn } from '../log.js';

export type HungAgentStatus = 'active' | 'idle' | 'hung';

export interface HungAgentSettings {
  idleThresholdMs: number;
  hungThresholdMs: number;
}

export interface HungAgentUpdatePayload {
  agentId: string;
  status: HungAgentStatus;
  lastDataAt: number;
  silentMs: number;
  checkedAt: string;
}

const TICK_MS = 30_000;
const SETTINGS_FILENAME = 'hung-agent-settings.json';
const MAX_THRESHOLD_MS = 24 * 60 * 60 * 1000;

const DEFAULT_SETTINGS: HungAgentSettings = {
  idleThresholdMs: 5 * 60 * 1000,
  hungThresholdMs: 15 * 60 * 1000,
};

let win: BrowserWindow | null = null;
let getTaskName: (taskId: string) => string = (id) => id;
let settingsDir: string | null = null;
let settings: HungAgentSettings = { ...DEFAULT_SETTINGS };
const prevStatus = new Map<string, HungAgentStatus>();
const hungNotified = new Map<string, number>();
let tickHandle: ReturnType<typeof setInterval> | null = null;
let unsubscribeExit: (() => void) | null = null;
// Test seam — when set, classifier reads "now" from here instead of Date.now()
let nowFn: () => number = () => Date.now();

/** Wire window-lifecycle listeners, load persisted settings, register the
 *  PTY exit cleanup hook. Call once from registerAllHandlers — a defensive
 *  teardown runs first so a double-init in tests or hot-reload doesn't
 *  leak listeners. */
export function initHungAgent(
  mainWindow: BrowserWindow,
  opts: { getTaskName: (taskId: string) => string; settingsDir: string },
): void {
  if (unsubscribeExit) teardown();
  win = mainWindow;
  getTaskName = opts.getTaskName;
  settingsDir = opts.settingsDir;
  settings = loadSettingsFromDisk(settingsDir);

  unsubscribeExit = onPtyEvent('exit', (agentId: string) => {
    prevStatus.delete(agentId);
    hungNotified.delete(agentId);
  });

  mainWindow.on('show', resumeTicking);
  mainWindow.on('restore', resumeTicking);
  mainWindow.on('hide', clearTick);
  mainWindow.on('minimize', clearTick);
  mainWindow.on('closed', () => {
    teardown();
  });

  if (windowIsVisible()) {
    ensureInterval();
  }
}

export function getHungAgentSettings(): HungAgentSettings {
  return { ...settings };
}

/** Validate and persist new threshold settings. Throws on invalid input;
 *  the caller is the IPC handler which surfaces the error to the renderer. */
export function setHungAgentSettings(next: HungAgentSettings): HungAgentSettings {
  const validated = validateSettings(next);
  settings = validated;
  if (settingsDir) {
    try {
      saveSettingsToDisk(settingsDir, validated);
    } catch (err) {
      logWarn('hung-agent', 'failed to persist settings', { err: String(err) });
    }
  }
  return { ...validated };
}

/** Send a single `\r` to the named agent via the existing PTY write path.
 *  No-op when the agent is missing or already exited so a renderer racing
 *  with an exit doesn't surface an error. */
export function nudgeAgent(agentId: string): void {
  try {
    writeToAgent(agentId, '\r');
  } catch {
    // Agent not found — race with exit. No-op per spec.
  }
}

// --- Internals ---

function windowIsVisible(): boolean {
  return !!win && !win.isDestroyed() && win.isVisible();
}

function resumeTicking(): void {
  ensureInterval();
  runTick();
}

function ensureInterval(): void {
  if (tickHandle) return;
  if (!windowIsVisible()) return;
  tickHandle = setInterval(runTick, TICK_MS);
  tickHandle.unref();
}

function clearTick(): void {
  if (tickHandle) {
    clearInterval(tickHandle);
    tickHandle = null;
  }
}

function teardown(): void {
  clearTick();
  unsubscribeExit?.();
  unsubscribeExit = null;
  win = null;
  prevStatus.clear();
  hungNotified.clear();
}

function runTick(): void {
  if (!win || win.isDestroyed()) return;
  const now = nowFn();
  const snapshot = snapshotRunningAgents();
  const seen = new Set<string>();

  for (const { agentId, taskId, lastDataAt } of snapshot) {
    seen.add(agentId);
    const silentMs = now - lastDataAt;
    const status = classify(silentMs, settings);
    const prev = prevStatus.get(agentId);

    if (prev === undefined) {
      // First observation: record silently so a long-silent agent isn't
      // flagged the instant the classifier first sees it.
      prevStatus.set(agentId, status);
      continue;
    }

    if (prev === status) continue;

    prevStatus.set(agentId, status);
    pushUpdate({
      agentId,
      status,
      lastDataAt,
      silentMs,
      checkedAt: new Date(now).toISOString(),
    });

    if (status === 'hung') {
      if (!hungNotified.has(agentId)) {
        hungNotified.set(agentId, now);
        fireNotification(agentId, taskId, silentMs);
      }
    } else {
      // Recovery: clear the dedupe so the next hung onset notifies again
      // with its own hungOnsetAt.
      hungNotified.delete(agentId);
    }
  }

  // Drop bookkeeping for agents that disappeared between ticks (e.g. exit
  // listener fired but a snapshot races). The onPtyEvent exit hook is the
  // primary clearing path; this is a belt-and-braces sweep.
  for (const id of [...prevStatus.keys()]) {
    if (!seen.has(id)) {
      prevStatus.delete(id);
      hungNotified.delete(id);
    }
  }
}

/** Classify by elapsed silence. Either threshold may be 0:
 *  - `hungThresholdMs === 0` disables the detector entirely (always active).
 *  - `idleThresholdMs === 0` means agents skip straight from active to hung. */
export function classify(silentMs: number, s: HungAgentSettings): HungAgentStatus {
  if (s.hungThresholdMs === 0) return 'active';
  if (silentMs >= s.hungThresholdMs) return 'hung';
  if (s.idleThresholdMs > 0 && silentMs >= s.idleThresholdMs) return 'idle';
  return 'active';
}

function pushUpdate(payload: HungAgentUpdatePayload): void {
  if (!win || win.isDestroyed()) return;
  win.webContents.send(IPC.HungAgentUpdate, payload);
}

function fireNotification(agentId: string, taskId: string, silentMs: number): void {
  try {
    if (!Notification.isSupported()) return;
    const taskName = getTaskName(taskId);
    const notification = new Notification({
      title: `Agent quiet — ${taskName}`,
      body: `Silent for ${formatSilence(silentMs)}`,
    });
    notification.on('click', () => {
      if (win && !win.isDestroyed()) {
        win.show();
        win.focus();
      }
    });
    notification.show();
    if (process.platform === 'linux') {
      setTimeout(() => notification.close(), 30_000);
    }
  } catch (err) {
    logWarn('hung-agent', 'notification failed', { agentId, err: String(err) });
  }
}

function formatSilence(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rem = minutes - hours * 60;
  return rem === 0 ? `${hours} h` : `${hours} h ${rem} min`;
}

/** Validate threshold settings. Both must be integers in [0, 24h]. When
 *  `idleThresholdMs > 0`, `hungThresholdMs` must be >= `idleThresholdMs`
 *  so a non-zero idle window can never sit beyond the hung window. */
export function validateSettings(input: unknown): HungAgentSettings {
  if (!input || typeof input !== 'object') {
    throw new Error('settings must be an object');
  }
  const raw = input as Record<string, unknown>;
  const idle = raw.idleThresholdMs;
  const hung = raw.hungThresholdMs;
  if (typeof idle !== 'number' || !Number.isInteger(idle)) {
    throw new Error('idleThresholdMs must be an integer');
  }
  if (typeof hung !== 'number' || !Number.isInteger(hung)) {
    throw new Error('hungThresholdMs must be an integer');
  }
  if (idle < 0 || idle > MAX_THRESHOLD_MS) {
    throw new Error('idleThresholdMs must be between 0 and 86400000');
  }
  if (hung < 0 || hung > MAX_THRESHOLD_MS) {
    throw new Error('hungThresholdMs must be between 0 and 86400000');
  }
  if (idle > 0 && hung > 0 && hung < idle) {
    throw new Error('hungThresholdMs must be >= idleThresholdMs when idleThresholdMs > 0');
  }
  return { idleThresholdMs: idle, hungThresholdMs: hung };
}

function loadSettingsFromDisk(dir: string): HungAgentSettings {
  const filePath = path.join(dir, SETTINGS_FILENAME);
  try {
    if (!fs.existsSync(filePath)) return { ...DEFAULT_SETTINGS };
    const content = fs.readFileSync(filePath, 'utf8');
    if (!content.trim()) return { ...DEFAULT_SETTINGS };
    const parsed: unknown = JSON.parse(content);
    return validateSettings(parsed);
  } catch (err) {
    logWarn('hung-agent', 'settings unreadable; using defaults', { err: String(err) });
    return { ...DEFAULT_SETTINGS };
  }
}

function saveSettingsToDisk(dir: string, value: HungAgentSettings): void {
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, SETTINGS_FILENAME);
  const tmpPath = filePath + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(value), 'utf8');
  fs.renameSync(tmpPath, filePath);
}

// --- Test seams ---

/** Reset module state for tests only. */
export function __resetForTests(): void {
  teardown();
  settings = { ...DEFAULT_SETTINGS };
  settingsDir = null;
  getTaskName = (id) => id;
  nowFn = () => Date.now();
}

/** Test-only: inject a mock window without wiring real lifecycle handlers
 *  or loading settings from disk. */
export function __initForTests(opts: {
  win: BrowserWindow;
  getTaskName?: (taskId: string) => string;
  settings?: HungAgentSettings;
  now?: () => number;
}): void {
  win = opts.win;
  if (opts.getTaskName) getTaskName = opts.getTaskName;
  if (opts.settings) settings = { ...opts.settings };
  if (opts.now) nowFn = opts.now;
  unsubscribeExit = onPtyEvent('exit', (agentId: string) => {
    prevStatus.delete(agentId);
    hungNotified.delete(agentId);
  });
}

/** Run one tick synchronously, bypassing the 30 s interval. */
export function __runTickForTests(): void {
  runTick();
}

/** Snapshot internal bookkeeping for assertions. */
export function __getStateForTests(): {
  tickActive: boolean;
  prevStatus: Map<string, HungAgentStatus>;
  hungNotified: Map<string, number>;
  settings: HungAgentSettings;
} {
  return {
    tickActive: tickHandle !== null,
    prevStatus: new Map(prevStatus),
    hungNotified: new Map(hungNotified),
    settings: { ...settings },
  };
}

/** Trigger the visibility-gated start path from tests. */
export function __ensureIntervalForTests(): void {
  ensureInterval();
}

/** Trigger the visibility-gated stop path from tests. */
export function __clearTickForTests(): void {
  clearTick();
}
