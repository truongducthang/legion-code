import { produce } from 'solid-js/store';
import { invoke } from '../lib/ipc';
import { IPC } from '../../electron/ipc/channels';
import { store, setStore } from './core';
import { randomPastelColor } from './projects';
import { markAgentSpawned } from './taskStatus';
import { getLocalDateKey } from '../lib/date';
import type {
  Agent,
  Task,
  PersistedState,
  PersistedTask,
  PersistedTelegramConfig,
  PersistedWindowState,
  Project,
  TelegramPushPolicy,
  TelegramVoiceRuntime,
} from './types';
import { DEFAULT_TELEGRAM_PERSISTED, PERSISTENCE_VERSION } from './types';
import type { AgentDef } from '../ipc/types';
import { inferDockerSource } from '../lib/docker';
import { DEFAULT_TERMINAL_FONT } from '../lib/fonts';
import { isLookPreset } from '../lib/look';
import { syncTerminalCounter } from './terminals';

const RESTORED_AGENT_SPAWN_STAGGER_MS = 1_000;

/** Enrich an agent def with resume/skip-permissions args from fresh defaults. */
function enrichAgentDef(agentDef: AgentDef | null | undefined, availableAgents: AgentDef[]): void {
  if (!agentDef) return;
  const fresh = availableAgents.find((a) => a.id === agentDef.id);
  if (fresh) {
    if (!agentDef.resume_args) agentDef.resume_args = fresh.resume_args;
    if (!agentDef.skip_permissions_args)
      agentDef.skip_permissions_args = fresh.skip_permissions_args;
  }
  if (agentDef.id === 'codex' && agentDef.skip_permissions_args?.includes('--full-auto')) {
    agentDef.skip_permissions_args = ['--dangerously-bypass-approvals-and-sandbox'];
  }
}

function persistedAgentDefs(pt: PersistedTask, availableAgents: AgentDef[]): AgentDef[] {
  const defs =
    pt.agentDefs && pt.agentDefs.length > 0 ? pt.agentDefs : pt.agentDef ? [pt.agentDef] : [];
  for (const def of defs) enrichAgentDef(def, availableAgents);
  return defs;
}

function restoredAgentIds(pt: PersistedTask, count: number, used: Set<string>): string[] {
  const persistedIds = Array.isArray(pt.agentIds) ? pt.agentIds : [];
  return Array.from({ length: count }, (_, i) => {
    const persistedId = persistedIds[i];
    if (persistedId && !used.has(persistedId)) {
      used.add(persistedId);
      return persistedId;
    }
    const id = crypto.randomUUID();
    used.add(id);
    return id;
  });
}

function restoredPromptedAgentIds(pt: PersistedTask, agentIds: string[]): string[] | undefined {
  if (!Array.isArray(pt.promptedAgentIds)) return undefined;
  const valid = pt.promptedAgentIds.filter(
    (id): id is string => typeof id === 'string' && agentIds.includes(id),
  );
  return valid.length > 0 ? valid : undefined;
}

function validPromptedAgentIndexes(value: unknown): number[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const valid = value.filter(
    (index): index is number => Number.isInteger(index) && index >= 0 && index < 100,
  );
  return valid.length > 0 ? valid : undefined;
}

function validAgentId(value: unknown, agentIds: string[]): string | undefined {
  return typeof value === 'string' && agentIds.includes(value) ? value : undefined;
}

function validAgentIndex(value: unknown): number | undefined {
  return Number.isInteger(value) && (value as number) >= 0 && (value as number) < 100
    ? (value as number)
    : undefined;
}

function isTelegramPushPolicy(v: unknown): v is TelegramPushPolicy {
  return v === 'all' || v === 'questions-only' || v === 'errors-only';
}

function isTelegramVoiceRuntime(v: unknown): v is TelegramVoiceRuntime {
  return v === 'none' || v === 'whisper-cpp' || v === 'openai';
}

function coerceTelegramAllowedChatIds(v: unknown): number[] {
  if (!Array.isArray(v)) return [];
  const seen = new Set<number>();
  const out: number[] = [];
  for (const x of v) {
    if (typeof x !== 'number' || !Number.isInteger(x) || x === 0) continue;
    if (seen.has(x)) continue;
    seen.add(x);
    out.push(x);
  }
  return out;
}

function coerceTelegramStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === 'string');
}

export function coercePersistedTelegram(raw: unknown): PersistedTelegramConfig {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ...DEFAULT_TELEGRAM_PERSISTED, voice: { ...DEFAULT_TELEGRAM_PERSISTED.voice } };
  }
  const r = raw as Record<string, unknown>;
  const voiceRaw =
    r.voice && typeof r.voice === 'object' && !Array.isArray(r.voice)
      ? (r.voice as Record<string, unknown>)
      : {};
  return {
    enabled: typeof r.enabled === 'boolean' ? r.enabled : false,
    allowedChatIds: coerceTelegramAllowedChatIds(r.allowedChatIds),
    pushPolicy: isTelegramPushPolicy(r.pushPolicy) ? r.pushPolicy : 'questions-only',
    redactPatterns: coerceTelegramStringArray(r.redactPatterns),
    extraQuestionPatterns: coerceTelegramStringArray(r.extraQuestionPatterns),
    publicBaseUrl: typeof r.publicBaseUrl === 'string' ? r.publicBaseUrl : null,
    autoTunnel: typeof r.autoTunnel === 'boolean' ? r.autoTunnel : false,
    cloudflaredPath: typeof r.cloudflaredPath === 'string' ? r.cloudflaredPath : null,
    voice: {
      runtime: isTelegramVoiceRuntime(voiceRaw.runtime) ? voiceRaw.runtime : 'none',
      whisperCppPath: typeof voiceRaw.whisperCppPath === 'string' ? voiceRaw.whisperCppPath : null,
    },
  };
}

function coerceProjectTelegramFields(p: Project): void {
  const raw = p as Project & { telegramOptIn?: unknown; telegramPauseOnBackpressure?: unknown };
  p.telegramOptIn = raw.telegramOptIn === true;
  p.telegramPauseOnBackpressure = raw.telegramPauseOnBackpressure === true;
}

export async function saveState(): Promise<void> {
  const persisted: PersistedState = {
    persistenceVersion: PERSISTENCE_VERSION,
    projects: store.projects.map((p) => ({ ...p })),
    lastProjectId: store.lastProjectId,
    lastAgentId: store.lastAgentId,
    taskOrder: [...store.taskOrder],
    collapsedTaskOrder: [...store.collapsedTaskOrder],
    tasks: {},
    activeTaskId: store.activeTaskId,
    sidebarVisible: store.sidebarVisible,
    panelUserSize: { ...store.panelUserSize },
    panelUserSizeMigratedV2: true,
    globalScale: store.globalScale,
    completedTaskDate: store.completedTaskDate,
    completedTaskCount: store.completedTaskCount,
    mergedLinesAdded: store.mergedLinesAdded,
    mergedLinesRemoved: store.mergedLinesRemoved,
    terminalFont: store.terminalFont,
    themePreset: store.themePreset,
    showPromptInput: store.showPromptInput,
    fontSmoothing: store.fontSmoothing,
    windowState: store.windowState ? { ...store.windowState } : undefined,
    autoTrustFolders: store.autoTrustFolders,
    showPlans: store.showPlans,
    showSteps: store.showSteps,
    showSidebarTips: store.showSidebarTips,
    showSidebarProgress: store.showSidebarProgress,
    desktopNotificationsEnabled: store.desktopNotificationsEnabled,
    inactiveColumnOpacity: store.inactiveColumnOpacity,
    editorCommand: store.editorCommand || undefined,
    dockerImage: store.dockerImage !== 'parallel-code-agent:latest' ? store.dockerImage : undefined,
    askCodeProvider: store.askCodeProvider !== 'claude' ? store.askCodeProvider : undefined,
    customAgents: store.customAgents.length > 0 ? [...store.customAgents] : undefined,
    keybindingMigrationDismissed: store.keybindingMigrationDismissed || undefined,
    focusMode: store.focusMode || undefined,
    verboseLogging: store.verboseLogging || undefined,
    shareDockerAgentAuth: store.shareDockerAgentAuth || undefined,
    appearanceMode: store.appearanceMode !== 'dark' ? store.appearanceMode : undefined,
    lightThemePreset:
      store.lightThemePreset !== 'islands-light' ? store.lightThemePreset : undefined,
    lightThemeCustomId: store.lightThemeCustomId ?? undefined,
    darkThemePreset: store.darkThemePreset !== 'islands-dark' ? store.darkThemePreset : undefined,
    darkThemeCustomId: store.darkThemeCustomId ?? undefined,
    telegram: { ...store.telegram, voice: { ...store.telegram.voice } },
  };

  for (const taskId of store.taskOrder) {
    const task = store.tasks[taskId];
    if (!task) continue;

    const agentDefs = task.agentIds
      .map((id) => store.agents[id]?.def)
      .filter((def): def is AgentDef => Boolean(def));

    persisted.tasks[taskId] = {
      id: task.id,
      name: task.name,
      nameIsAutoGenerated: task.nameIsAutoGenerated,
      projectId: task.projectId,
      branchName: task.branchName,
      worktreePath: task.worktreePath,
      notes: task.notes,
      lastPrompt: task.lastPrompt,
      promptedAgentIds: task.promptedAgentIds,
      initialPrompt: task.initialPrompt,
      shellCount: task.shellAgentIds.length,
      agentDef: agentDefs[0] ?? null,
      agentDefs: agentDefs.length > 1 ? agentDefs : undefined,
      agentIds: task.agentIds.length > 0 ? [...task.agentIds] : undefined,
      selectedAgentId: task.selectedAgentId,
      gitIsolation: task.gitIsolation,
      baseBranch: task.baseBranch,
      externalWorktree: task.externalWorktree,
      skipPermissions: task.skipPermissions,
      dockerMode: task.dockerMode,
      dockerSource: task.dockerSource,
      dockerImage: task.dockerImage,
      githubUrl: task.githubUrl,
      savedInitialPrompt: task.savedInitialPrompt,
      savedSelectedAgentIndex: task.savedSelectedAgentIndex,
      savedPromptedAgentIndexes: task.savedPromptedAgentIndexes,
      planFileName: task.planFileName,
      stepsEnabled: task.stepsEnabled,
    };
  }

  for (const taskId of store.collapsedTaskOrder) {
    const task = store.tasks[taskId];
    if (!task) continue;

    const agentDefs =
      task.savedAgentDefs && task.savedAgentDefs.length > 0
        ? task.savedAgentDefs
        : task.savedAgentDef
          ? [task.savedAgentDef]
          : task.agentIds
              .map((id) => store.agents[id]?.def)
              .filter((def): def is AgentDef => Boolean(def));

    persisted.tasks[taskId] = {
      id: task.id,
      name: task.name,
      nameIsAutoGenerated: task.nameIsAutoGenerated,
      projectId: task.projectId,
      branchName: task.branchName,
      worktreePath: task.worktreePath,
      notes: task.notes,
      lastPrompt: task.lastPrompt,
      promptedAgentIds: task.promptedAgentIds,
      initialPrompt: task.initialPrompt,
      shellCount: task.shellAgentIds.length,
      agentDef: agentDefs[0] ?? null,
      agentDefs: agentDefs.length > 1 ? agentDefs : undefined,
      agentIds: task.agentIds.length > 0 ? [...task.agentIds] : undefined,
      selectedAgentId: task.selectedAgentId,
      gitIsolation: task.gitIsolation,
      baseBranch: task.baseBranch,
      externalWorktree: task.externalWorktree,
      skipPermissions: task.skipPermissions,
      dockerMode: task.dockerMode,
      dockerSource: task.dockerSource,
      dockerImage: task.dockerImage,
      githubUrl: task.githubUrl,
      savedInitialPrompt: task.savedInitialPrompt,
      savedSelectedAgentIndex: task.savedSelectedAgentIndex,
      savedPromptedAgentIndexes: task.savedPromptedAgentIndexes,
      planFileName: task.planFileName,
      stepsEnabled: task.stepsEnabled,
      collapsed: true,
    };
  }

  for (const id of store.taskOrder) {
    const terminal = store.terminals[id];
    if (!terminal) continue;
    if (!persisted.terminals) persisted.terminals = {};
    persisted.terminals[id] = { id: terminal.id, name: terminal.name };
  }

  await invoke(IPC.SaveAppState, { json: JSON.stringify(persisted) }).catch((e) =>
    console.warn('Failed to save state:', e),
  );
}

/** 20_000 px is ~10× the largest plausible monitor axis and big enough to let
 *  a user pin a panel anywhere reasonable; anything larger points at a
 *  corrupted / hand-edited state file and we drop the record. */
const MAX_PANEL_PX = 20_000;

function isStringNumberRecord(v: unknown): v is Record<string, number> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  return Object.values(v as Record<string, unknown>).every(
    (val) => typeof val === 'number' && Number.isFinite(val) && val >= 0 && val <= MAX_PANEL_PX,
  );
}

/** Resolve the incoming panelUserSize table and apply the v2 migration.
 *
 * Accepts either the new `panelUserSize` field or the legacy `panelSizes`
 * fallback. When the v2 migration flag is absent (pre-v2 / in-progress v2
 * builds), every `task:*` entry is dropped because v1 stored flex-weights
 * mixed with pixels under those keys — re-interpreting them as pixel pins
 * produces visibly broken layouts. `tiling:*` and `sidebar:*` pins were
 * always real pixels, so they pass through untouched.
 */
export function resolveIncomingPanelUserSize(
  rawPanelUserSize: unknown,
  rawPanelSizes: unknown,
  migratedV2: unknown,
): Record<string, number> {
  const incoming = isStringNumberRecord(rawPanelUserSize)
    ? rawPanelUserSize
    : isStringNumberRecord(rawPanelSizes)
      ? rawPanelSizes
      : {};
  if (migratedV2 === true) return incoming;
  return Object.fromEntries(Object.entries(incoming).filter(([k]) => !k.startsWith('task:')));
}

function parsePersistedWindowState(v: unknown): PersistedWindowState | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;

  const raw = v as Record<string, unknown>;
  const x = raw.x;
  const y = raw.y;
  const width = raw.width;
  const height = raw.height;
  const maximized = raw.maximized;

  if (
    typeof x !== 'number' ||
    !Number.isFinite(x) ||
    typeof y !== 'number' ||
    !Number.isFinite(y) ||
    typeof width !== 'number' ||
    !Number.isFinite(width) ||
    width <= 0 ||
    typeof height !== 'number' ||
    !Number.isFinite(height) ||
    height <= 0 ||
    typeof maximized !== 'boolean'
  ) {
    return null;
  }

  return {
    x: Math.round(x),
    y: Math.round(y),
    width: Math.round(width),
    height: Math.round(height),
    maximized,
  };
}

interface LegacyPersistedState {
  projectRoot?: string;
  projects?: Project[];
  lastProjectId?: string | null;
  lastAgentId?: string | null;
  taskOrder: string[];
  collapsedTaskOrder?: string[];
  tasks: Record<string, PersistedTask & { projectId?: string }>;
  activeTaskId: string | null;
  sidebarVisible: boolean;
  // Fields that may be present in newer state files (validated at runtime)
  panelUserSize?: unknown;
  panelUserSizeMigratedV2?: unknown;
  /** Legacy field name — accepted on load as pins, never written on save. */
  panelSizes?: unknown;
  globalScale?: unknown;
  completedTaskDate?: unknown;
  completedTaskCount?: unknown;
  mergedLinesAdded?: unknown;
  mergedLinesRemoved?: unknown;
  terminalFont?: unknown;
  themePreset?: unknown;
  showPromptInput?: unknown;
  fontSmoothing?: unknown;
  windowState?: unknown;
  autoTrustFolders?: unknown;
  showPlans?: unknown;
  showSteps?: unknown;
  showSidebarTips?: unknown;
  showSidebarProgress?: unknown;
  desktopNotificationsEnabled?: unknown;
  inactiveColumnOpacity?: unknown;
  editorCommand?: unknown;
  dockerImage?: unknown;
  askCodeProvider?: unknown;
  minimaxApiKey?: unknown;
  customAgents?: unknown;
  terminals?: unknown;
  keybindingMigrationDismissed?: unknown;
  focusMode?: unknown;
  verboseLogging?: unknown;
  shareDockerAgentAuth?: unknown;
  appearanceMode?: unknown;
  lightThemePreset?: unknown;
  lightThemeCustomId?: unknown;
  darkThemePreset?: unknown;
  darkThemeCustomId?: unknown;
  telegram?: unknown;
  persistenceVersion?: unknown;
}

export async function loadState(): Promise<void> {
  const json = await invoke<string | null>(IPC.LoadAppState).catch(() => null);
  if (!json) return;

  let raw: LegacyPersistedState;
  try {
    raw = JSON.parse(json);
  } catch {
    console.warn('Failed to parse persisted state');
    return;
  }

  // Validate essential structure
  if (
    !raw ||
    typeof raw !== 'object' ||
    !Array.isArray(raw.taskOrder) ||
    typeof raw.tasks !== 'object'
  ) {
    console.warn('Invalid persisted state structure, skipping load');
    return;
  }

  // Migrate from old format if needed
  let projects: Project[] = raw.projects ?? [];
  let lastProjectId: string | null = raw.lastProjectId ?? null;
  const lastAgentId: string | null = raw.lastAgentId ?? null;

  // Assign colors to projects that don't have one (backward compat)
  // Also migrate defaultDirectMode -> defaultGitIsolation
  for (const p of projects) {
    if (!p.color) p.color = randomPastelColor();
    if (typeof p.coverageReportPath === 'string') {
      const trimmed = p.coverageReportPath.trim();
      p.coverageReportPath = trimmed ? trimmed : undefined;
    } else {
      p.coverageReportPath = undefined;
    }
    // Migrate defaultDirectMode -> defaultGitIsolation
    const legacy = p as Project & { defaultDirectMode?: boolean };
    if (legacy.defaultDirectMode !== undefined && p.defaultGitIsolation === undefined) {
      p.defaultGitIsolation = legacy.defaultDirectMode ? 'direct' : undefined;
      delete (legacy as unknown as Record<string, unknown>).defaultDirectMode;
    }
    // Coerce Telegram opt-in fields to strict booleans.
    coerceProjectTelegramFields(p);
  }

  if (projects.length === 0 && raw.projectRoot) {
    const segments = raw.projectRoot.split('/');
    const name = segments[segments.length - 1] || raw.projectRoot;
    const id = crypto.randomUUID();
    projects = [{ id, name, path: raw.projectRoot, color: randomPastelColor() }];
    lastProjectId = id;

    // Assign this project to all existing tasks
    for (const taskId of raw.taskOrder) {
      const pt = raw.tasks[taskId];
      if (pt && !pt.projectId) {
        pt.projectId = id;
      }
    }
  }

  const restoredRunningAgentIds: string[] = [];
  const usedRestoredAgentIds = new Set<string>();
  const today = getLocalDateKey();

  setStore(
    produce((s) => {
      s.projects = projects;
      s.lastProjectId = lastProjectId;
      s.lastAgentId = lastAgentId;
      s.taskOrder = raw.taskOrder;
      s.activeTaskId = raw.activeTaskId;
      s.sidebarVisible = raw.sidebarVisible;
      s.panelUserSize = resolveIncomingPanelUserSize(
        raw.panelUserSize,
        raw.panelSizes,
        raw.panelUserSizeMigratedV2,
      );
      s.globalScale = typeof raw.globalScale === 'number' ? raw.globalScale : 1;
      const completedTaskDate =
        typeof raw.completedTaskDate === 'string' ? raw.completedTaskDate : today;
      const completedTaskCountRaw = raw.completedTaskCount;
      const completedTaskCount =
        typeof completedTaskCountRaw === 'number' && Number.isFinite(completedTaskCountRaw)
          ? Math.max(0, Math.floor(completedTaskCountRaw))
          : 0;
      if (completedTaskDate === today) {
        s.completedTaskDate = completedTaskDate;
        s.completedTaskCount = completedTaskCount;
      } else {
        s.completedTaskDate = today;
        s.completedTaskCount = 0;
      }
      const mergedLinesAddedRaw = raw.mergedLinesAdded;
      const mergedLinesRemovedRaw = raw.mergedLinesRemoved;
      s.mergedLinesAdded =
        typeof mergedLinesAddedRaw === 'number' && Number.isFinite(mergedLinesAddedRaw)
          ? Math.max(0, Math.floor(mergedLinesAddedRaw))
          : 0;
      s.mergedLinesRemoved =
        typeof mergedLinesRemovedRaw === 'number' && Number.isFinite(mergedLinesRemovedRaw)
          ? Math.max(0, Math.floor(mergedLinesRemovedRaw))
          : 0;
      s.terminalFont =
        typeof raw.terminalFont === 'string' && raw.terminalFont.trim()
          ? raw.terminalFont
          : DEFAULT_TERMINAL_FONT;
      s.themePreset = isLookPreset(raw.themePreset) ? raw.themePreset : 'minimal';
      s.showPromptInput = typeof raw.showPromptInput === 'boolean' ? raw.showPromptInput : true;
      s.fontSmoothing = typeof raw.fontSmoothing === 'boolean' ? raw.fontSmoothing : true;
      s.windowState = parsePersistedWindowState(raw.windowState);
      s.autoTrustFolders = typeof raw.autoTrustFolders === 'boolean' ? raw.autoTrustFolders : false;
      s.showPlans = typeof raw.showPlans === 'boolean' ? raw.showPlans : true;
      s.showSteps = typeof raw.showSteps === 'boolean' ? raw.showSteps : false;
      s.showSidebarTips = typeof raw.showSidebarTips === 'boolean' ? raw.showSidebarTips : true;
      s.showSidebarProgress =
        typeof raw.showSidebarProgress === 'boolean' ? raw.showSidebarProgress : true;
      s.desktopNotificationsEnabled =
        typeof raw.desktopNotificationsEnabled === 'boolean'
          ? raw.desktopNotificationsEnabled
          : false;
      const rawOpacity = raw.inactiveColumnOpacity;
      s.inactiveColumnOpacity =
        typeof rawOpacity === 'number' &&
        Number.isFinite(rawOpacity) &&
        rawOpacity >= 0.3 &&
        rawOpacity <= 1.0
          ? Math.round(rawOpacity * 100) / 100
          : 0.6;

      const rawEditorCommand = raw.editorCommand;
      s.editorCommand = typeof rawEditorCommand === 'string' ? rawEditorCommand.trim() : '';

      s.focusMode = raw.focusMode === true;

      s.verboseLogging = typeof raw.verboseLogging === 'boolean' ? raw.verboseLogging : false;

      s.shareDockerAgentAuth = raw.shareDockerAgentAuth === true;

      // Restore appearance mode and per-mode theme preferences
      const savedMode = raw.appearanceMode;
      s.appearanceMode =
        savedMode === 'light' || savedMode === 'dark' || savedMode === 'system'
          ? savedMode
          : 'dark';
      s.darkThemePreset = isLookPreset(raw.darkThemePreset) ? raw.darkThemePreset : 'islands-dark';
      s.lightThemePreset = isLookPreset(raw.lightThemePreset)
        ? raw.lightThemePreset
        : 'islands-light';
      s.darkThemeCustomId =
        typeof raw.darkThemeCustomId === 'string' ? raw.darkThemeCustomId : null;
      s.lightThemeCustomId =
        typeof raw.lightThemeCustomId === 'string' ? raw.lightThemeCustomId : null;

      // Telegram block — strict per-field coercion so corrupted state cannot
      // silently re-enable the bot. Unversioned snapshots get default values.
      s.telegram = coercePersistedTelegram(raw.telegram);

      // Backward compat: if no appearanceMode was persisted, mirror the loaded
      // themePreset into the appropriate slot.
      if (!savedMode) {
        if (isLookPreset(raw.themePreset) && raw.themePreset === 'islands-light') {
          s.appearanceMode = 'light';
          s.lightThemePreset = raw.themePreset;
        } else {
          s.appearanceMode = 'dark';
          if (isLookPreset(raw.themePreset)) s.darkThemePreset = raw.themePreset;
        }
      }

      const rawDockerImage = raw.dockerImage;
      s.dockerImage =
        typeof rawDockerImage === 'string' && rawDockerImage.trim()
          ? rawDockerImage.trim()
          : 'parallel-code-agent:latest';

      s.askCodeProvider = raw.askCodeProvider === 'minimax' ? 'minimax' : 'claude';

      // Restore custom agents
      if (Array.isArray(raw.customAgents)) {
        s.customAgents = raw.customAgents.filter(
          (a: unknown): a is AgentDef =>
            typeof a === 'object' &&
            a !== null &&
            typeof (a as AgentDef).id === 'string' &&
            typeof (a as AgentDef).name === 'string' &&
            typeof (a as AgentDef).command === 'string',
        );
      }

      if (typeof raw.keybindingMigrationDismissed === 'boolean') {
        s.keybindingMigrationDismissed = raw.keybindingMigrationDismissed;
      }

      // Make custom agents findable during task restoration
      for (const ca of s.customAgents) {
        if (!s.availableAgents.some((a) => a.id === ca.id)) {
          s.availableAgents.push(ca);
        }
      }

      for (const taskId of raw.taskOrder) {
        const pt = raw.tasks[taskId];
        if (!pt) continue;

        const agentDefs = persistedAgentDefs(pt, s.availableAgents);
        const agentIds = restoredAgentIds(pt, agentDefs.length, usedRestoredAgentIds);

        const shellAgentIds: string[] = [];
        for (let i = 0; i < pt.shellCount; i++) {
          shellAgentIds.push(crypto.randomUUID());
        }

        const legacy = pt as PersistedTask & { directMode?: boolean };
        const task: Task = {
          id: pt.id,
          name: pt.name,
          nameIsAutoGenerated:
            pt.nameIsAutoGenerated === true
              ? true
              : pt.nameIsAutoGenerated === false
                ? false
                : undefined,
          projectId: pt.projectId ?? '',
          branchName: pt.branchName,
          worktreePath: pt.worktreePath,
          agentIds,
          selectedAgentId: validAgentId(pt.selectedAgentId, agentIds) ?? agentIds[0],
          shellAgentIds,
          notes: pt.notes,
          lastPrompt: pt.lastPrompt,
          promptedAgentIds: restoredPromptedAgentIds(pt, agentIds),
          initialPrompt: typeof pt.initialPrompt === 'string' ? pt.initialPrompt : undefined,
          gitIsolation: legacy.gitIsolation ?? (legacy.directMode ? 'direct' : 'worktree'),
          baseBranch: legacy.baseBranch || undefined,
          externalWorktree: pt.externalWorktree,
          skipPermissions: pt.skipPermissions === true,
          dockerMode: pt.dockerMode === true ? true : undefined,
          dockerSource:
            pt.dockerMode === true
              ? (pt.dockerSource ??
                inferDockerSource(typeof pt.dockerImage === 'string' ? pt.dockerImage : undefined))
              : undefined,
          dockerImage: typeof pt.dockerImage === 'string' ? pt.dockerImage : undefined,
          githubUrl: pt.githubUrl,
          savedInitialPrompt: pt.savedInitialPrompt,
          savedSelectedAgentIndex: validAgentIndex(pt.savedSelectedAgentIndex),
          savedPromptedAgentIndexes: validPromptedAgentIndexes(pt.savedPromptedAgentIndexes),
          planFileName: pt.planFileName,
          stepsEnabled: pt.stepsEnabled,
        };

        s.tasks[taskId] = task;

        for (let i = 0; i < agentDefs.length; i++) {
          const agentId = agentIds[i];
          const agentDef = agentDefs[i];
          const agent: Agent = {
            id: agentId,
            taskId,
            def: agentDef,
            resumed: true,
            status: 'running',
            exitCode: null,
            signal: null,
            lastOutput: [],
            generation: 0,
            spawnDelayMs:
              agentDefs.length > 1 && i > 0 ? i * RESTORED_AGENT_SPAWN_STAGGER_MS : undefined,
            attachExisting: true,
          };
          s.agents[agentId] = agent;
          restoredRunningAgentIds.push(agentId);
        }
      }

      // Restore terminals
      const rawTerminals = (raw.terminals ?? {}) as Record<string, { id: string; name: string }>;
      for (const termId of raw.taskOrder) {
        const pt = rawTerminals[termId];
        if (!pt) continue;
        const agentId = crypto.randomUUID();
        s.terminals[termId] = { id: pt.id, name: pt.name, agentId };
      }

      // Remove orphaned entries from taskOrder
      s.taskOrder = s.taskOrder.filter((id) => s.tasks[id] || s.terminals[id]);

      // Restore collapsed tasks
      const collapsedOrder = raw.collapsedTaskOrder ?? [];
      for (const taskId of collapsedOrder) {
        const pt = raw.tasks[taskId];
        if (!pt || !pt.collapsed) continue;

        const agentDefs = persistedAgentDefs(pt, s.availableAgents);

        const legacyCollapsed = pt as PersistedTask & { directMode?: boolean };
        const task: Task = {
          id: pt.id,
          name: pt.name,
          nameIsAutoGenerated:
            pt.nameIsAutoGenerated === true
              ? true
              : pt.nameIsAutoGenerated === false
                ? false
                : undefined,
          projectId: pt.projectId ?? '',
          branchName: pt.branchName,
          worktreePath: pt.worktreePath,
          agentIds: [],
          selectedAgentId: undefined,
          shellAgentIds: [],
          notes: pt.notes,
          lastPrompt: pt.lastPrompt,
          promptedAgentIds: restoredPromptedAgentIds(pt, []),
          initialPrompt: typeof pt.initialPrompt === 'string' ? pt.initialPrompt : undefined,
          gitIsolation:
            legacyCollapsed.gitIsolation ?? (legacyCollapsed.directMode ? 'direct' : 'worktree'),
          baseBranch: legacyCollapsed.baseBranch || undefined,
          externalWorktree: pt.externalWorktree,
          skipPermissions: pt.skipPermissions === true,
          dockerMode: pt.dockerMode === true ? true : undefined,
          dockerSource:
            pt.dockerMode === true
              ? (pt.dockerSource ??
                inferDockerSource(typeof pt.dockerImage === 'string' ? pt.dockerImage : undefined))
              : undefined,
          dockerImage: typeof pt.dockerImage === 'string' ? pt.dockerImage : undefined,
          githubUrl: pt.githubUrl,
          savedInitialPrompt: pt.savedInitialPrompt,
          savedSelectedAgentIndex: validAgentIndex(pt.savedSelectedAgentIndex),
          savedPromptedAgentIndexes: validPromptedAgentIndexes(pt.savedPromptedAgentIndexes),
          planFileName: pt.planFileName,
          stepsEnabled: pt.stepsEnabled,
          collapsed: true,
          savedAgentDef: agentDefs[0],
          savedAgentDefs: agentDefs.length > 0 ? agentDefs : undefined,
        };

        s.tasks[taskId] = task;
      }
      s.collapsedTaskOrder = collapsedOrder.filter((id) => s.tasks[id]);

      // Defensive: ensure no task appears in both arrays (corrupted state)
      const activeSet = new Set(s.taskOrder);
      s.collapsedTaskOrder = s.collapsedTaskOrder.filter((id) => !activeSet.has(id));

      // Focus mode requires a valid active panel; without one, every panel is
      // hidden and the strip reads blank. Repair or drop focus mode.
      if (s.focusMode) {
        const activeValid =
          s.activeTaskId !== null &&
          (s.tasks[s.activeTaskId] !== undefined || s.terminals[s.activeTaskId] !== undefined);
        if (!activeValid) {
          s.activeTaskId = s.taskOrder[0] ?? null;
          if (s.activeTaskId === null) s.focusMode = false;
        }
      }

      // Set activeAgentId from the active task
      if (s.activeTaskId && s.tasks[s.activeTaskId]) {
        const task = s.tasks[s.activeTaskId];
        s.activeAgentId =
          task.selectedAgentId && task.agentIds.includes(task.selectedAgentId)
            ? task.selectedAgentId
            : (task.agentIds[0] ?? null);
      }
    }),
  );

  // Restored agents are considered running; reflect that immediately in task status dots.
  for (const agentId of restoredRunningAgentIds) {
    markAgentSpawned(agentId);
  }

  syncTerminalCounter();
}
