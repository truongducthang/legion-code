// Main-process coordinator for managing sub-agent tasks.
// Manages task lifecycle independently of the SolidJS renderer,
// using existing backend primitives (pty, git, tasks).

import { randomUUID, randomBytes } from 'crypto';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { unlinkSync, readFileSync, existsSync } from 'fs';
import {
  readFile as fsReadFile,
  writeFile as fsWriteFile,
  unlink as fsUnlink,
  access as fsAccess,
  mkdir as fsMkdir,
} from 'fs/promises';
import { join, dirname } from 'path';
import os from 'os';
import { getSubTaskMcpConfigPath } from './config.js';
import { buildMcpLaunchArgs } from './agent-args.js';
import { validateBranchName } from './validation.js';
import { atomicWriteFileSync, atomicWriteFile } from './atomic.js';
import { ReplayCache } from './replay-cache.js';
import {
  detectPreambleFiles,
  filterDiffSections,
  buildNormalizedPreambleFileDiff,
  stripPreambleFromBranch,
} from './preamble.js';

const execAsync = promisify(execFile);
import type { BrowserWindow } from 'electron';
import { createTask as createBackendTask, deleteTask } from '../ipc/tasks.js';
import { getSkipPermissionsArgs } from '../ipc/agents.js';
import {
  spawnAgent,
  writeToAgent,
  killAgent,
  subscribeToAgent,
  unsubscribeFromAgent,
  getAgentScrollback,
  onPtyEvent,
} from '../ipc/pty.js';
import {
  getChangedFiles,
  getAllFileDiffs,
  getDiffBaseSha,
  mergeTask as gitMergeTask,
} from '../ipc/git.js';
import { stripAnsi, chunkContainsAgentPrompt } from './prompt-detect.js';
import { SUB_TASK_PREAMBLE } from './sub-task-preamble.js';
import { warn as logWarn } from '../log.js';
import type {
  CoordinatedTask,
  PendingNotification,
  CoordinatorState,
  ApiTaskSummary,
  ApiTaskDetail,
  ApiDiffResult,
  WaitForSignalDoneResult,
} from './types.js';
import { IPC } from '../ipc/channels.js';

const DEFAULT_WAIT_TIMEOUT_MS = 300_000; // 5 minutes
const PROMPT_WRITE_DELAY_MS = 50;
const REST_COORDINATOR_SENTINEL = 'api';

export class Coordinator {
  private tasks = new Map<string, CoordinatedTask>();
  private tailBuffers = new Map<string, string>();
  private idleResolvers = new Map<
    string,
    Array<(result: { reason: 'idle' | 'human_control' | 'exited' | 'removed' }) => void>
  >();
  private anySignalResolvers = new Map<string, Array<(result: WaitForSignalDoneResult) => void>>();
  private subscribers = new Map<string, (encoded: string) => void>();
  private decoders = new Map<string, TextDecoder>();
  private controlMap = new Map<string, 'coordinator' | 'human'>();
  private blockedByHumanControl = new Set<string>();
  private closingTaskIds = new Set<string>();
  private activeSignalWaitCounts = new Map<string, number>();
  private recentlyDelivered = new ReplayCache<WaitForSignalDoneResult>();
  private win: BrowserWindow | null = null;
  private projectRoot: string | null = null;
  private projectId: string | null = null;
  private defaultCoordinatorTaskId: string | null = null;
  private coordinatorSpawnDefaults: { command: string; args: string[] } = {
    command: 'claude',
    args: [],
  };
  private coordinators = new Map<string, CoordinatorState>();
  private notificationDelayMs = 30_000;
  private readonly COORDINATOR_RESTAMP_DELAY_MS = 5 * 60_000;
  private readonly MAX_ACKED_BATCH_IDS = 64;
  // Serializes concurrent preamble writes to the same file path.
  private preambleWriteQueue = new Map<string, Promise<void>>();
  constructor() {
    // Listen for PTY exits to update task status when agents are killed externally
    // (e.g., user closes a child task from the UI).
    // The singleton guard in enableCoordinatorMode (if (coordinator) return) ensures
    // this constructor is called at most once per app lifetime; no teardown needed.
    onPtyEvent('exit', (agentId, data) => {
      for (const task of this.tasks.values()) {
        if (task.agentId === agentId) {
          const { exitCode } = (data ?? {}) as { exitCode?: number };
          task.status = 'exited';
          task.exitCode = exitCode ?? null;
          // Resolve any idle waiters so they don't hang
          const resolvers = this.idleResolvers.get(task.id);
          if (resolvers?.length) {
            for (const resolve of resolvers) resolve({ reason: 'exited' });
            this.idleResolvers.delete(task.id);
          }
          // Resolve any signal waiters so wait_for_signal_done doesn't hang
          // when the last sub-task exits without calling signal_done.
          const coordinatorId = task.coordinatorTaskId;
          const anyResolvers = this.anySignalResolvers.get(coordinatorId);
          const firstAnyResolver = anyResolvers?.length ? anyResolvers.shift() : undefined;
          if (firstAnyResolver) {
            // Suppress the exit notification — the signal waiter receives the
            // exit info as its return value (mirrors the signalDone path).
            this.suppressPendingNotificationForTask(task);
            task.reviewNotificationQueued = true;
            const remaining = this.countRemaining(coordinatorId);
            firstAnyResolver({
              taskId: task.id,
              name: task.name,
              status: 'exited',
              signalDoneAt: new Date().toISOString(),
              remaining,
            });
            this.finishSignalWait(coordinatorId);
          }
          if (this.closingTaskIds.has(task.id)) break;
          this.maybeQueueReviewNotification(task, 'exited', exitCode ?? null);
          break;
        }
      }
    });

    // Re-subscribe our output callback when the renderer respawns a managed agent.
    // TerminalView kills the existing PTY (clearing all subscribers) then spawns a
    // new one with the same agentId.  Without this, our outputCb is lost and we
    // can never detect idle for that sub-task.
    onPtyEvent('spawn', (agentId) => {
      const outputCb = this.subscribers.get(agentId);
      if (!outputCb) return; // not a coordinated agent, or initial spawn (not yet subscribed)
      this.tailBuffers.set(agentId, ''); // discard stale data from the killed PTY
      for (const task of this.tasks.values()) {
        if (task.agentId === agentId && task.status === 'exited') {
          task.status = 'running';
          task.exitCode = null;
          break;
        }
      }
      subscribeToAgent(agentId, outputCb);
    });
  }

  setTaskControl(taskId: string, who: 'coordinator' | 'human'): void {
    if (!this.tasks.has(taskId)) {
      console.warn(`setTaskControl: unknown taskId ${taskId}`);
      return;
    }
    this.controlMap.set(taskId, who);
    if (who === 'human') {
      // Resolve any pending idle waiters immediately — human has taken over
      const resolvers = this.idleResolvers.get(taskId);
      if (resolvers?.length) {
        for (const resolve of resolvers) resolve({ reason: 'human_control' });
        this.idleResolvers.delete(taskId);
      }
    }
    if (who === 'coordinator') {
      // Fire any idle resolvers queued while human had control
      const resolvers = this.idleResolvers.get(taskId);
      if (resolvers?.length) {
        for (const resolve of resolvers) resolve({ reason: 'idle' });
        this.idleResolvers.delete(taskId);
      }
      // Notify coordinator if it tried to send a prompt while blocked
      if (this.blockedByHumanControl.has(taskId)) {
        this.blockedByHumanControl.delete(taskId);
        const task = this.tasks.get(taskId);
        const coordinator = task ? this.coordinators.get(task.coordinatorTaskId) : null;
        if (task && coordinator) {
          this.notifyRenderer(IPC.MCP_CoordinatorNotificationStaged, {
            coordinatorTaskId: coordinator.taskId,
            batchId: randomUUID(),
            notificationIds: [],
            text: `[Control update]\nTask "${task.name}" has been returned to coordinator control. You may now resume sending prompts to it.`,
            autoFireAt: Date.now() + 2_000,
          });
        }
      }
    }
  }

  setWindow(win: BrowserWindow): void {
    this.win = win;
  }

  setNotificationDelayMs(ms: number): void {
    this.notificationDelayMs = Math.max(5_000, Math.min(300_000, ms));
  }

  setDefaultProject(projectId: string, projectRoot: string, coordinatorTaskId?: string): void {
    this.projectId = projectId;
    this.projectRoot = projectRoot;
    if (coordinatorTaskId) this.defaultCoordinatorTaskId = coordinatorTaskId;
  }

  setMCPServerInfo(
    coordinatorTaskId: string,
    serverUrl: string,
    token: string,
    subtaskToken: string,
    serverPath: string,
  ): void {
    const state = this.coordinators.get(coordinatorTaskId);
    if (state) {
      state.mcpServerInfo = { serverUrl, token, subtaskToken, serverPath };
      state.lifecycle = 'ready';
    }
    // Rewrite config files only for sub-tasks owned by this coordinator so a
    // second coordinator starting up does not overwrite the first's task configs.
    for (const task of this.tasks.values()) {
      if (task.coordinatorTaskId !== coordinatorTaskId) continue;
      if (!task.mcpConfigPath) continue;
      // Preserve existing doneToken; generate a fresh one if not yet set (e.g. older persisted task).
      if (!task.doneToken) task.doneToken = randomBytes(24).toString('base64url');
      const mcpConfig = {
        mcpServers: {
          'parallel-code': {
            type: 'stdio' as const,
            command: 'node',
            args: [serverPath, '--url', serverUrl, '--task-id', task.id],
            env: {
              PARALLEL_CODE_MCP_TOKEN: subtaskToken,
              PARALLEL_CODE_MCP_DONE_TOKEN: task.doneToken,
            },
          },
        },
      };
      atomicWriteFileSync(task.mcpConfigPath, JSON.stringify(mcpConfig, null, 2), { mode: 0o600 });
    }
  }

  setCoordinatorSpawnDefaults(coordinatorTaskId: string, command: string, args: string[]): void {
    const state = this.coordinators.get(coordinatorTaskId);
    if (state) {
      state.spawnDefaults = { command, args };
    }
    // Also update global fallback.
    this.coordinatorSpawnDefaults = { command, args };
  }

  setDockerContainerName(coordinatorTaskId: string, name: string | null): void {
    const state = this.coordinators.get(coordinatorTaskId);
    if (state) {
      state.dockerContainerName = name;
    }
  }

  setDockerImage(coordinatorTaskId: string, image: string | null): void {
    const state = this.coordinators.get(coordinatorTaskId);
    if (state) {
      state.dockerImage = image;
    }
  }

  private maybeQueueReviewNotification(
    task: CoordinatedTask,
    state: 'idle' | 'exited',
    exitCode: number | null,
    delayOverrideMs?: number,
  ): void {
    // Always notify for exits — a task killed before prompt delivery still needs to be
    // reported so the coordinator doesn't think it's still running.
    if (!task.assignedPromptDelivered && state !== 'exited') return;

    const coordinator = this.coordinators.get(task.coordinatorTaskId);
    if (!coordinator) {
      if (task.reviewNotificationQueued) return;
      task.reviewNotificationQueued = true;
      this.notifyRenderer(IPC.MCP_CoordinatorOrphanedNotification, {
        subTaskId: task.id,
        notificationId: randomUUID(),
        state,
        text: `"${task.name}" ${state === 'exited' ? `terminated (exit ${exitCode})` : 'ready for review'} — branch: ${task.branchName}`,
      });
      return;
    }

    if (task.reviewNotificationQueued && state === 'exited') {
      const existing = coordinator.pendingNotifications.find((n) => n.taskId === task.id);
      if (existing && existing.state === 'idle') {
        existing.state = 'exited';
        existing.exitCode = exitCode;
        this.stageBatch(coordinator);
        return;
      }
      return;
    }

    if (task.reviewNotificationQueued) return;
    task.reviewNotificationQueued = true;

    const notification: PendingNotification = {
      id: randomUUID(),
      taskId: task.id,
      taskName: task.name,
      branchName: task.branchName,
      state,
      exitCode,
      completedAt: new Date(),
    };
    coordinator.pendingNotifications.push(notification);
    this.stageBatch(coordinator, delayOverrideMs);
  }

  private stageBatch(coordinator: CoordinatorState, delayOverrideMs?: number): void {
    const pending = coordinator.pendingNotifications;
    if (pending.length === 0) return;
    if (this.hasActiveSignalWaiter(coordinator.taskId)) {
      logWarn('coordinator.notification', 'stageBatch skipped', {
        coordinatorTaskId: coordinator.taskId,
        reason: 'active_signal_wait',
        activeWaitCount: this.activeSignalWaitCounts.get(coordinator.taskId) ?? 0,
        pendingTaskIds: this.pendingNotificationTaskIds(coordinator),
      });
      if (coordinator.restageTimer) {
        clearTimeout(coordinator.restageTimer);
        coordinator.restageTimer = null;
      }
      return;
    }

    // Clear any previously staged batches — they are superseded by this new batch.
    // Leaving old entries causes stagedBatches to grow unboundedly and makes
    // deregisterCoordinator incorrectly believe notifications are still pending.
    coordinator.stagedBatches.clear();
    const batchId = randomUUID();
    const notificationIds = pending.map((n) => n.id);
    coordinator.stagedBatches.set(batchId, notificationIds);

    const anyNonZero = pending.some((n) => n.exitCode !== null && n.exitCode !== 0);
    const defaultDelay = anyNonZero
      ? Math.max(10_000, this.notificationDelayMs / 4)
      : this.notificationDelayMs;
    const delay = delayOverrideMs ?? defaultDelay;
    const autoFireAt = Date.now() + delay;

    const text = this.formatNotificationText(pending);

    logWarn('coordinator.notification', 'stageBatch emitted', {
      coordinatorTaskId: coordinator.taskId,
      batchId,
      notificationIds,
      pendingTaskIds: this.pendingNotificationTaskIds(coordinator),
      delayMs: delay,
      autoFireAt,
    });

    this.notifyRenderer(IPC.MCP_CoordinatorNotificationStaged, {
      coordinatorTaskId: coordinator.taskId,
      batchId,
      notificationIds,
      text,
      autoFireAt,
    });

    if (coordinator.restageTimer) clearTimeout(coordinator.restageTimer);
    coordinator.restageTimer = setTimeout(() => {
      coordinator.restageTimer = null;
      if (coordinator.pendingNotifications.length > 0) {
        this.stageBatch(coordinator);
      }
    }, this.COORDINATOR_RESTAMP_DELAY_MS);
  }

  private formatNotificationText(pending: PendingNotification[]): string {
    const header = `[Sub-task update — ${pending.length} task(s) completed]`;
    const lines = pending.map((n) => {
      const status = n.state === 'exited' ? `terminated (exit ${n.exitCode})` : 'ready for review';
      const line = `- "${n.taskName}" ${status} — branch: ${n.branchName}`;
      const warn =
        n.exitCode !== null && n.exitCode !== 0
          ? '\n  ⚠️  Non-zero exit — may need attention. Consider spawning a follow-up agent.'
          : '';
      return line + warn;
    });
    const footer =
      "Please review each completed task: check its diff, confirm the work looks correct, then commit and merge what's ready. If there are items remaining on the backlog, spawn the next batch.";
    return [header, '', ...lines, '', footer].join('\n');
  }

  async createTask(opts: {
    name: string;
    prompt?: string;
    coordinatorTaskId: string;
    projectId?: string;
    projectRoot?: string;
    agentCommand?: string;
    agentArgs?: string[];
    skipPermissions?: boolean;
    baseBranch?: string;
  }): Promise<CoordinatedTask> {
    const coordinatorId =
      opts.coordinatorTaskId !== REST_COORDINATOR_SENTINEL
        ? opts.coordinatorTaskId
        : this.defaultCoordinatorTaskId;
    if (!coordinatorId) {
      throw new Error(
        'No coordinator task registered yet. Ensure the coordinator task is fully initialized before calling create_task.',
      );
    }

    const coordinatorState = this.coordinators.get(coordinatorId);
    if (!coordinatorState) {
      throw new Error(
        `Unknown coordinator: ${coordinatorId}. Ensure the coordinator task is registered before creating sub-tasks.`,
      );
    }

    if (opts.baseBranch !== undefined) {
      validateBranchName(opts.baseBranch, 'baseBranch');
    }

    const root = opts.projectRoot ?? coordinatorState.projectRoot ?? this.projectRoot;
    const projId = opts.projectId ?? coordinatorState.projectId ?? this.projectId;
    if (!root || !projId) throw new Error('No project configured for coordinator');

    // Create worktree + branch via existing backend
    const result = await createBackendTask(
      opts.name,
      root,
      ['.claude', 'node_modules'],
      'task',
      opts.baseBranch,
    );

    // Re-check after async gap — deregisterCoordinator may have run while we awaited.
    if (!this.coordinators.has(coordinatorId)) {
      // Best-effort cleanup of the worktree we just created.
      deleteTask({
        agentIds: [],
        branchName: result.branch_name,
        deleteBranch: true,
        projectRoot: root,
      }).catch((err) => {
        console.warn('Failed to clean up race-condition worktree:', err);
        this.notifyRenderer(IPC.MCP_TaskCleanupFailed, {
          taskId: result.id,
          error: err instanceof Error ? err.message : String(err),
        });
      });
      throw new Error(`Coordinator ${coordinatorId} was deregistered during task creation`);
    }

    const agentId = randomUUID();
    const task: CoordinatedTask = {
      id: result.id,
      name: opts.name,
      projectId: projId,
      projectRoot: root,
      branchName: result.branch_name,
      baseBranch: opts.baseBranch,
      worktreePath: result.worktree_path,
      agentId,
      coordinatorTaskId: coordinatorId,
      status: 'creating',
      exitCode: null,
      dockerContainerName: this.coordinators.get(coordinatorId)?.dockerContainerName ?? null,
    };

    this.tasks.set(task.id, task);
    this.tailBuffers.set(agentId, '');

    // Subscribe to PTY output for prompt detection
    const decoder = new TextDecoder();
    this.decoders.set(agentId, decoder);

    const outputCb = (encoded: string) => {
      const bytes = Buffer.from(encoded, 'base64');
      const text = (this.decoders.get(agentId) ?? new TextDecoder()).decode(bytes, {
        stream: true,
      });
      const prev = this.tailBuffers.get(agentId) ?? '';
      const combined = prev + text;
      this.tailBuffers.set(
        agentId,
        combined.length > 4096 ? combined.slice(combined.length - 4096) : combined,
      );

      // Check for agent prompt
      const stripped = stripAnsi(combined)
        // eslint-disable-next-line no-control-regex
        .replace(/[\x00-\x1f\x7f]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      if (chunkContainsAgentPrompt(stripped)) {
        if (task.status === 'running') {
          task.status = 'idle';
          this.maybeQueueReviewNotification(task, 'idle', null);
        }
        // Resolve any waiting promises
        const resolvers = this.idleResolvers.get(task.id);
        if (resolvers?.length) {
          for (const resolve of resolvers) resolve({ reason: 'idle' });
          this.idleResolvers.delete(task.id);
        }
      } else if (task.status === 'idle') {
        task.status = 'running';
      }
    };
    this.subscribers.set(agentId, outputCb);

    // Spawn the agent process
    if (!this.win) throw new Error('No window set on coordinator');

    const agentCmd = (opts.agentCommand ?? coordinatorState.spawnDefaults.command).toLowerCase();
    const preamble = `<sub-task-mode>\nThese rules override all skills and hooks:\n- When your work is complete, call the \`signal_done\` MCP tool. That is the finish line — do NOT use finishing-a-development-branch or offer merge/PR options.\n- Asking questions is fine when requirements are unclear or an action is risky.\n</sub-task-mode>`;
    // Declared here so the catch block can restore preamble files on failure.
    let preambleFilePath: string | undefined;
    let preambleFileOriginalContent: string | null = null;

    const dockerContainerName =
      this.coordinators.get(task.coordinatorTaskId)?.dockerContainerName ?? null;

    let subTaskMcpConfigPath: string | undefined;
    try {
      // Inject sub-task instructions via agent-specific mechanism.
      // Inside try so preamble-write failures are cleaned up by the catch block.
      // Serialized per file path to prevent races when multiple tasks target the same path.
      const injectPreamble = async (filePath: string): Promise<void> => {
        const prior = this.preambleWriteQueue.get(filePath) ?? Promise.resolve();
        const next = prior.then(async () => {
          let existing = '';
          try {
            await fsAccess(filePath);
            existing = await fsReadFile(filePath, 'utf8');
            preambleFileOriginalContent = existing;
          } catch {
            /* file does not exist */
          }
          await atomicWriteFile(filePath, existing ? `${existing}\n\n${preamble}` : preamble);
        });
        this.preambleWriteQueue.set(
          filePath,
          next
            .catch(() => {})
            .then(() => {
              if (this.preambleWriteQueue.get(filePath) === next) {
                this.preambleWriteQueue.delete(filePath);
              }
            }),
        );
        await next;
      };

      if (agentCmd.includes('codex') || agentCmd.includes('opencode')) {
        const agentsPath = join(result.worktree_path, 'AGENTS.md');
        preambleFilePath = agentsPath;
        await injectPreamble(agentsPath);
      } else if (agentCmd.includes('gemini')) {
        const geminiPath = join(result.worktree_path, 'GEMINI.md');
        preambleFilePath = geminiPath;
        await injectPreamble(geminiPath);
      } else if (agentCmd.includes('copilot')) {
        const agentMdPath = join(result.worktree_path, '.agent.md');
        preambleFilePath = agentMdPath;
        await injectPreamble(agentMdPath);
      } else {
        // Claude and fallback: settings.local.json (gitignored, no restore needed)
        const settingsDir = join(result.worktree_path, '.claude');
        const settingsPath = join(settingsDir, 'settings.local.json');
        await fsMkdir(settingsDir, { recursive: true });
        const prior = this.preambleWriteQueue.get(settingsPath) ?? Promise.resolve();
        const next = prior.then(async () => {
          let existingSettings: Record<string, unknown> = {};
          try {
            await fsAccess(settingsPath);
            existingSettings = JSON.parse(await fsReadFile(settingsPath, 'utf8'));
          } catch {
            /* ignore */
          }
          existingSettings.systemPrompt = existingSettings.systemPrompt
            ? `${existingSettings.systemPrompt}\n\n${preamble}`
            : preamble;
          await atomicWriteFile(settingsPath, JSON.stringify(existingSettings, null, 2));
        });
        this.preambleWriteQueue.set(
          settingsPath,
          next
            .catch(() => {})
            .then(() => {
              if (this.preambleWriteQueue.get(settingsPath) === next) {
                this.preambleWriteQueue.delete(settingsPath);
              }
            }),
        );
        await next;
      }
      task.preambleFileExistedBefore = preambleFileOriginalContent !== null;
      // Write a per-sub-task MCP config so the agent can call signal_done.
      // In Docker mode, write to the coordinator's .parallel-code/ dir (which IS the explicitly
      // mounted volume) rather than the sub-task worktree (which may not be in the container).
      // Always pass explicit MCP launch args so agents don't rely on auto-discovery.
      const mcpServerInfoForTask = coordinatorState.mcpServerInfo;
      let subTaskMcpConfig: Parameters<typeof buildMcpLaunchArgs>[2] | undefined;
      if (mcpServerInfoForTask) {
        const { serverUrl, subtaskToken, serverPath } = mcpServerInfoForTask;
        const doneToken = randomBytes(24).toString('base64url');
        task.doneToken = doneToken;
        const mcpConfig = {
          mcpServers: {
            'parallel-code': {
              type: 'stdio' as const,
              command: 'node',
              args: [serverPath, '--url', serverUrl, '--task-id', task.id],
              env: {
                PARALLEL_CODE_MCP_TOKEN: subtaskToken,
                PARALLEL_CODE_MCP_DONE_TOKEN: doneToken,
              },
            },
          },
        };
        subTaskMcpConfig = mcpConfig;
        const configPath = getSubTaskMcpConfigPath(dockerContainerName, serverPath, task.id);
        await atomicWriteFile(configPath, JSON.stringify(mcpConfig, null, 2), { mode: 0o600 });
        subTaskMcpConfigPath = configPath;
        task.mcpConfigPath = configPath;
      }

      const agentCommand = opts.agentCommand ?? coordinatorState.spawnDefaults.command;
      const agentArgs = opts.agentArgs ?? coordinatorState.spawnDefaults.args;
      const baseArgs = [
        ...agentArgs,
        ...(coordinatorState.propagateSkipPermissions ? getSkipPermissionsArgs(agentCommand) : []),
      ];
      const mcpArgs = subTaskMcpConfig
        ? buildMcpLaunchArgs(agentCommand, subTaskMcpConfigPath, subTaskMcpConfig)
        : [];
      const agentFinalArgs = [...baseArgs, ...mcpArgs];

      // In Docker coordinator mode, each sub-task gets its own `docker run` container
      // so HOME directories are isolated and cleanup is clean (`docker stop` on the
      // sub-task container, rather than killing processes inside the coordinator).
      const channelId = randomUUID();

      spawnAgent(this.win, {
        taskId: task.id,
        agentId,
        command: agentCommand,
        args: agentFinalArgs,
        cwd: result.worktree_path,
        env: {},
        cols: 120,
        rows: 40,
        ...(dockerContainerName
          ? {
              dockerMode: true,
              dockerImage: coordinatorState.dockerImage ?? undefined,
              // Mount parent dir so the sub-task can reach the coordinator's
              // .parallel-code/ dir (which holds the per-sub-task MCP config).
              // resolveWorktreeGitDirMount adds the main .git dir mount.
              dockerMountWorktreeParent: true,
            }
          : {}),
        onOutput: { __CHANNEL_ID__: channelId },
      });

      // Subscribe for output monitoring
      subscribeToAgent(agentId, outputCb);
      task.status = 'running';

      // Check scrollback in case the prompt was emitted before we subscribed
      const scrollback = getAgentScrollback(agentId);
      if (scrollback) {
        const decoded = Buffer.from(scrollback, 'base64').toString('utf8');
        const stripped = stripAnsi(decoded)
          // eslint-disable-next-line no-control-regex
          .replace(/[\x00-\x1f\x7f]/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();
        if (chunkContainsAgentPrompt(stripped)) {
          task.status = 'idle';
          this.maybeQueueReviewNotification(task, 'idle', null);
        }
      }

      // Notify renderer with the prompt — the renderer sets it as initialPrompt
      // on the task, and PromptInput auto-delivers it using the same code path
      // as manually created tasks (stability checks, quiescence detection, etc.)
      // For renderer storage: only store the inner agent args (without docker wrapper).
      // TaskAITerminal re-wraps with the coordinator's current container name at respawn time
      // so stale container names don't get baked into persisted state.
      const notifyAgentArgs = agentArgs;
      this.notifyRenderer(IPC.MCP_TaskCreated, {
        taskId: task.id,
        name: task.name,
        projectId: task.projectId,
        branchName: task.branchName,
        worktreePath: task.worktreePath,
        agentId: task.agentId,
        coordinatorTaskId: task.coordinatorTaskId,
        prompt: opts.prompt ? SUB_TASK_PREAMBLE + opts.prompt : opts.prompt,
        mcpConfigPath: subTaskMcpConfigPath,
        preambleFileExistedBefore: task.preambleFileExistedBefore,
        agentCommand: agentCommand,
        agentArgs: notifyAgentArgs,
        skipPermissions: coordinatorState.propagateSkipPermissions,
      });

      return task;
    } catch (err) {
      // Restore injected preamble file before cleaning up the worktree.
      // Must await — fire-and-forget could race with cleanupTask removing the worktree.
      if (preambleFilePath !== undefined) {
        try {
          if (preambleFileOriginalContent !== null) {
            await fsWriteFile(preambleFilePath, preambleFileOriginalContent);
          } else {
            await fsUnlink(preambleFilePath);
          }
        } catch {
          /* ignore — worktree cleanup follows */
        }
      }
      // Best-effort cleanup: kill agent, remove worktree/branch, clear in-memory state.
      // cleanupTask handles all of this; the task is still in this.tasks so it can find it.
      // Also delete the MCP config if it was written but not yet stored on task.mcpConfigPath.
      if (subTaskMcpConfigPath && !task.mcpConfigPath) {
        fsUnlink(subTaskMcpConfigPath).catch(() => {});
      }
      this.cleanupTask(task.id).catch(() => {});
      throw err;
    }
  }

  listTasks(): ApiTaskSummary[] {
    return Array.from(this.tasks.values()).map((t) => ({
      id: t.id,
      name: t.name,
      branchName: t.branchName,
      status: t.status,
      coordinatorTaskId: t.coordinatorTaskId,
      signalDoneAt: t.signalDoneAt?.toISOString(),
    }));
  }

  getTaskStatus(taskId: string): ApiTaskDetail | null {
    const task = this.tasks.get(taskId);
    if (!task) return null;
    return {
      id: task.id,
      name: task.name,
      branchName: task.branchName,
      worktreePath: task.worktreePath,
      projectId: task.projectId,
      agentId: task.agentId,
      status: task.status,
      coordinatorTaskId: task.coordinatorTaskId,
      exitCode: task.exitCode,
      pendingPrompt: task.pendingPrompt,
      signalDoneAt: task.signalDoneAt?.toISOString(),
    };
  }

  getTaskDoneToken(taskId: string): string | null {
    return this.tasks.get(taskId)?.doneToken ?? null;
  }

  async sendPrompt(taskId: string, prompt: string): Promise<void> {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    if (this.controlMap.get(taskId) === 'human') {
      this.blockedByHumanControl.add(taskId);
      throw new Error(
        'Task is under human control. Return control to coordinator before sending prompts.',
      );
    }

    // Send text then Enter separately (like the frontend does)
    writeToAgent(task.agentId, prompt);
    await new Promise((r) => setTimeout(r, PROMPT_WRITE_DELAY_MS));
    writeToAgent(task.agentId, '\r');
    task.status = 'running';
    task.pendingPrompt = undefined;
    task.signalDoneAt = undefined;
    this.notifyRenderer(IPC.MCP_TaskStateSync, {
      taskId,
      signalDoneReceived: false,
      signalDoneAt: null,
      signalDoneConsumed: false,
      needsReview: false,
    });
  }

  waitForIdle(
    taskId: string,
    timeoutMs?: number,
  ): Promise<{ reason: 'idle' | 'human_control' | 'exited' | 'removed' }> {
    return this.waitForIdleInternal(taskId, timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS);
  }

  private waitForIdleInternal(
    taskId: string,
    timeoutMs: number,
  ): Promise<{ reason: 'idle' | 'human_control' | 'exited' | 'removed' }> {
    const task = this.tasks.get(taskId);
    if (!task) return Promise.reject(new Error(`Task not found: ${taskId}`));
    if (this.controlMap.get(taskId) === 'human') {
      return Promise.resolve({ reason: 'human_control' }); // resolve immediately — caller gets control-change event instead
    }
    if (task.status === 'exited') return Promise.resolve({ reason: 'exited' });
    if (task.status === 'idle') return Promise.resolve({ reason: 'idle' });

    return new Promise((resolve, reject) => {
      const timerRef = { value: undefined as ReturnType<typeof setTimeout> | undefined };

      const wrappedResolve = (result: {
        reason: 'idle' | 'human_control' | 'exited' | 'removed';
      }) => {
        if (timerRef.value !== undefined) clearTimeout(timerRef.value);
        resolve(result);
      };

      timerRef.value = setTimeout(() => {
        const resolvers = this.idleResolvers.get(taskId);
        if (resolvers) {
          const idx = resolvers.indexOf(wrappedResolve);
          if (idx >= 0) resolvers.splice(idx, 1);
        }
        reject(new Error(`Timed out waiting for task ${taskId} to become idle`));
      }, timeoutMs);

      let resolvers = this.idleResolvers.get(taskId);
      if (!resolvers) {
        resolvers = [];
        this.idleResolvers.set(taskId, resolvers);
      }
      resolvers.push(wrappedResolve);
    });
  }

  async getTaskDiff(taskId: string): Promise<ApiDiffResult> {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);

    // Compute baseSha first so detectDiffBase/pinHead results are cached.
    // getChangedFiles and getAllFileDiffs internally call the same helpers;
    // running all three concurrently causes three simultaneous cache misses.
    const baseSha = await getDiffBaseSha(task.worktreePath, task.baseBranch);
    const [files, diff] = await Promise.all([
      getChangedFiles(task.worktreePath, task.baseBranch),
      getAllFileDiffs(task.worktreePath, task.baseBranch),
    ]);

    // For preamble-bearing files: strip the injected block and show only real sub-task edits.
    // Files with no real changes beyond the preamble are excluded entirely.
    // Files with real changes (before or after the preamble block) include a normalized diff.
    const preambleFiles = await detectPreambleFiles(task.worktreePath);

    let filteredFiles = files;
    let filteredDiff = diff;
    if (preambleFiles.size > 0) {
      // Drop preamble file sections from the raw diff; we'll add normalized sections below.
      filteredDiff = filterDiffSections(diff, preambleFiles);
      // For each preamble file, generate a diff that excludes the injected block.
      const normalizedSections = await Promise.all(
        [...preambleFiles].map((f) =>
          buildNormalizedPreambleFileDiff(f, task.worktreePath, baseSha),
        ),
      );
      const preambleFilesWithChanges = new Set<string>();
      for (let i = 0; i < [...preambleFiles].length; i++) {
        if (normalizedSections[i]) preambleFilesWithChanges.add([...preambleFiles][i]);
      }
      filteredDiff += normalizedSections.filter(Boolean).join('');
      // Files list: exclude preamble-only files, keep files with real changes.
      filteredFiles = files.filter(
        (f) => !preambleFiles.has(f.path) || preambleFilesWithChanges.has(f.path),
      );
    }

    const MAX_DIFF_BYTES = 50_000;
    if (filteredDiff.length > MAX_DIFF_BYTES) {
      return {
        files: filteredFiles,
        diff: filteredDiff.slice(0, MAX_DIFF_BYTES) + '\n... (diff truncated)',
        truncated: true,
        originalSizeBytes: filteredDiff.length,
      };
    }
    return { files: filteredFiles, diff: filteredDiff };
  }

  getTaskOutput(taskId: string): string {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);

    // Try scrollback buffer first, fall back to tail buffer
    const scrollback = getAgentScrollback(task.agentId);
    if (scrollback) {
      const decoded = Buffer.from(scrollback, 'base64').toString('utf8');
      return stripAnsi(decoded);
    }
    return stripAnsi(this.tailBuffers.get(task.agentId) ?? '');
  }

  async mergeTask(
    taskId: string,
    opts?: { squash?: boolean; message?: string; cleanup?: boolean },
  ): Promise<{ mainBranch: string; linesAdded: number; linesRemoved: number }> {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);

    const root = task.projectRoot;

    // Strip injected preamble files before staging so they don't land in history,
    // then auto-commit any uncommitted changes in the task worktree before merging.
    if (task.worktreePath) {
      await stripPreambleFromBranch(task);
      try {
        await execAsync('git', ['add', '-A'], { cwd: task.worktreePath });
        await execAsync('git', ['commit', '-m', 'WIP: auto-commit before merge'], {
          cwd: task.worktreePath,
        });
      } catch {
        // Commit failed — check if uncommitted changes still exist
        const { stdout: statusOut } = await execAsync('git', ['status', '--porcelain'], {
          cwd: task.worktreePath,
        });
        if (statusOut.trim()) {
          throw new Error(
            `Auto-commit failed and the task worktree still has uncommitted changes. ` +
              `Please commit or discard changes in ${task.worktreePath} before merging.`,
          );
        }
        // Nothing to commit — swallow silently
      }
    }

    const coordinatorState = this.coordinators.get(task.coordinatorTaskId);
    const runMerge = () =>
      gitMergeTask(
        root,
        task.branchName,
        opts?.squash ?? false,
        opts?.message ?? null,
        false, // worktree removal is handled by cleanupTask below, not gitMergeTask
        task.baseBranch,
        task.worktreePath,
        coordinatorState?.worktreePath,
      );
    let result: Awaited<ReturnType<typeof runMerge>>;
    try {
      result = await runMerge();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('Another git process') || msg.includes('index.lock')) {
        // Stale git lock — wait for it to clear then retry once
        await new Promise((r) => setTimeout(r, 2000));
        result = await runMerge();
      } else {
        throw err;
      }
    }

    if (opts?.cleanup) {
      await this.cleanupTask(taskId);
    }

    return {
      mainBranch: result.main_branch,
      linesAdded: result.lines_added,
      linesRemoved: result.lines_removed,
    };
  }

  async reviewAndMergeTask(
    taskId: string,
    opts?: { squash?: boolean; message?: string },
  ): Promise<{
    diff: ApiDiffResult;
    merge: { mainBranch: string; linesAdded: number; linesRemoved: number };
  }> {
    const diff = await this.getTaskDiff(taskId);
    const merge = await this.mergeTask(taskId, { ...opts, cleanup: true });
    return { diff, merge };
  }

  async closeTask(taskId: string): Promise<void> {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    await this.cleanupTask(taskId);
  }

  /**
   * Remove a coordinated task's backend state when the UI closes it directly.
   * Unlike cleanupTask, this does NOT kill the agent or delete the worktree —
   * the UI has already done both. It only cleans up in-memory coordinator state.
   */
  removeCoordinatedTask(taskId: string): void {
    const task = this.tasks.get(taskId);
    if (!task) return;

    this.suppressPendingNotificationForTask(task);

    const cb = this.subscribers.get(task.agentId);
    if (cb) {
      unsubscribeFromAgent(task.agentId, cb);
      this.subscribers.delete(task.agentId);
    }

    this.tailBuffers.delete(task.agentId);
    this.decoders.delete(task.agentId);

    const resolvers = this.idleResolvers.get(taskId);
    if (resolvers) {
      for (const resolve of resolvers) resolve({ reason: 'removed' });
      this.idleResolvers.delete(taskId);
    }

    if (task.mcpConfigPath) {
      try {
        unlinkSync(task.mcpConfigPath);
      } catch {
        /* already gone */
      }
    }

    // For Docker sub-tasks, the UI calls killAgent before removeCoordinatedTask,
    // which stops the sub-task's own container via stopDockerContainer in pty.ts.
    // No additional docker cleanup needed here.

    this.tasks.delete(taskId);
    this.blockedByHumanControl.delete(taskId);
    this.controlMap.delete(taskId);
  }

  private async cleanupTask(taskId: string): Promise<void> {
    const task = this.tasks.get(taskId);
    if (!task) return;
    this.closingTaskIds.add(taskId);
    this.suppressPendingNotificationForTask(task);

    // Unsubscribe from PTY output
    const cb = this.subscribers.get(task.agentId);
    if (cb) {
      unsubscribeFromAgent(task.agentId, cb);
      this.subscribers.delete(task.agentId);
    }

    // Kill the agent. For Docker sub-tasks, killAgent also calls docker stop on the
    // sub-task's own container (via stopDockerContainer in pty.ts), which cleanly
    // terminates the entire container rather than just the PTY client process.
    try {
      killAgent(task.agentId);
    } catch {
      /* already dead */
    }

    // Remove worktree. If this fails, keep all coordinator state so the caller
    // can retry. Do NOT emit MCP_TaskClosed — the task still exists on disk.
    try {
      await deleteTask({
        agentIds: [task.agentId],
        branchName: task.branchName,
        deleteBranch: true,
        projectRoot: task.projectRoot,
      });
    } catch (err) {
      console.warn('Failed to delete coordinated task worktree:', err);
      this.closingTaskIds.delete(taskId);
      this.notifyRenderer(IPC.MCP_TaskCleanupFailed, {
        taskId,
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    // Clean up internal state — resolve idle and signal waiters before deleting
    // so callers don't hang until their own timeout fires.
    const idleResolvers = this.idleResolvers.get(taskId);
    if (idleResolvers?.length) {
      for (const resolve of idleResolvers) resolve({ reason: 'exited' });
    }
    this.idleResolvers.delete(taskId);
    const coordinatorId = task.coordinatorTaskId;
    const anyResolvers = this.anySignalResolvers.get(coordinatorId);
    // Guard against double-resolve: the PTY exit handler (onPtyEvent 'exit') may have
    // already consumed a resolver if the process exited between killAgent and here.
    // reviewNotificationQueued is set by whichever path runs first.
    const firstAnyResolver =
      !task.reviewNotificationQueued && anyResolvers?.length ? anyResolvers.shift() : undefined;
    if (firstAnyResolver) {
      this.suppressPendingNotificationForTask(task);
      task.reviewNotificationQueued = true;
      const remaining = this.countRemaining(coordinatorId);
      firstAnyResolver({
        taskId: task.id,
        name: task.name,
        status: 'exited',
        signalDoneAt: new Date().toISOString(),
        remaining,
      });
      this.finishSignalWait(coordinatorId);
    }
    this.tailBuffers.delete(task.agentId);
    this.decoders.delete(task.agentId);
    // Delete per-task MCP config tmp file
    if (task.mcpConfigPath) {
      try {
        unlinkSync(task.mcpConfigPath);
      } catch {
        /* already gone */
      }
    }
    this.tasks.delete(taskId);
    this.controlMap.delete(taskId);
    this.blockedByHumanControl.delete(taskId);
    this.closingTaskIds.delete(taskId);

    // Notify renderer
    this.notifyRenderer(IPC.MCP_TaskClosed, { taskId });
  }

  getTask(taskId: string): CoordinatedTask | undefined {
    return this.tasks.get(taskId);
  }

  hydrateTask(opts: {
    id: string;
    name: string;
    projectId: string;
    projectRoot: string;
    branchName: string;
    baseBranch?: string;
    worktreePath: string;
    agentId: string;
    coordinatorTaskId: string;
    controlledBy?: 'coordinator' | 'human';
    signalDoneAt?: string;
    signalDoneConsumed?: boolean;
    mcpConfigPath?: string;
    preambleFileExistedBefore?: boolean;
  }): void {
    if (!this.coordinators.has(opts.coordinatorTaskId)) {
      throw new Error(`coordinator ${opts.coordinatorTaskId} is not registered`);
    }
    if (this.tasks.has(opts.id)) return;
    const task: CoordinatedTask = {
      id: opts.id,
      name: opts.name,
      projectId: opts.projectId,
      projectRoot: opts.projectRoot,
      branchName: opts.branchName,
      baseBranch: opts.baseBranch,
      worktreePath: opts.worktreePath,
      agentId: opts.agentId,
      coordinatorTaskId: opts.coordinatorTaskId,
      status: 'exited',
      exitCode: null,
      signalDoneAt: opts.signalDoneAt ? new Date(opts.signalDoneAt) : undefined,
      signalDoneConsumed: opts.signalDoneConsumed,
      preambleFileExistedBefore: opts.preambleFileExistedBefore,
    };
    this.tasks.set(task.id, task);
    if (opts.controlledBy === 'human') {
      this.controlMap.set(task.id, 'human');
    }

    // Validate the persisted mcpConfigPath is exactly one of the two paths that
    // getSubTaskMcpConfigPath generates — basename-only is too permissive and would
    // allow a crafted state file to direct the token write to an arbitrary location.
    // Host mode: os.tmpdir()/parallel-code-subtask-{id}.json
    // Docker mode: dirname(serverPath)/subtask-{id}.json  (looked up from live coordinator state)
    const serverInfo = this.coordinators.get(opts.coordinatorTaskId)?.mcpServerInfo;
    const expectedHostPath = join(os.tmpdir(), `parallel-code-subtask-${opts.id}.json`);
    const expectedDockerPath = serverInfo
      ? join(dirname(serverInfo.serverPath), `subtask-${opts.id}.json`)
      : null;
    const safeMcpConfigPath =
      opts.mcpConfigPath &&
      (opts.mcpConfigPath === expectedHostPath ||
        (expectedDockerPath !== null && opts.mcpConfigPath === expectedDockerPath))
        ? opts.mcpConfigPath
        : undefined;
    task.mcpConfigPath = safeMcpConfigPath;

    // Set up output monitoring so wait_for_idle and idle detection work after restart.
    // The agentId matches the one the renderer will use when it respawns the PTY.
    // The token write is inside this try so the cleanup catch removes the task on failure.
    const { agentId } = opts;
    try {
      // If StartMCPServer already ran before this hydration call (the normal restart path),
      // rewrite the config file immediately with the current port/token so the respawned
      // agent gets fresh credentials instead of the stale pre-restart values.
      if (safeMcpConfigPath && serverInfo) {
        const { serverUrl, subtaskToken, serverPath } = serverInfo;
        if (!task.doneToken) task.doneToken = randomBytes(24).toString('base64url');
        const mcpConfig = {
          mcpServers: {
            'parallel-code': {
              type: 'stdio' as const,
              command: 'node',
              args: [serverPath, '--url', serverUrl, '--task-id', task.id],
              env: {
                PARALLEL_CODE_MCP_TOKEN: subtaskToken,
                PARALLEL_CODE_MCP_DONE_TOKEN: task.doneToken,
              },
            },
          },
        };
        atomicWriteFileSync(safeMcpConfigPath, JSON.stringify(mcpConfig, null, 2), { mode: 0o600 });
      }

      this.tailBuffers.set(agentId, '');
      this.decoders.set(agentId, new TextDecoder());
      const outputCb = (encoded: string) => {
        const bytes = Buffer.from(encoded, 'base64');
        const text = (this.decoders.get(agentId) ?? new TextDecoder()).decode(bytes, {
          stream: true,
        });
        const prev = this.tailBuffers.get(agentId) ?? '';
        const combined = prev + text;
        this.tailBuffers.set(
          agentId,
          combined.length > 4096 ? combined.slice(combined.length - 4096) : combined,
        );
        const stripped = stripAnsi(combined)
          // eslint-disable-next-line no-control-regex
          .replace(/[\x00-\x1f\x7f]/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();
        if (chunkContainsAgentPrompt(stripped)) {
          if (task.status === 'running') {
            task.status = 'idle';
            this.maybeQueueReviewNotification(task, 'idle', null);
          }
          const resolvers = this.idleResolvers.get(task.id);
          if (resolvers?.length) {
            for (const resolve of resolvers) resolve({ reason: 'idle' });
            this.idleResolvers.delete(task.id);
          }
        } else if (task.status === 'idle') {
          task.status = 'running';
        }
      };
      this.subscribers.set(agentId, outputCb);
      // Subscribe immediately if the agent is already spawned (restart scenario where
      // PTY existed before hydration). The spawn handler covers the deferred case.
      try {
        subscribeToAgent(agentId, outputCb);
      } catch {
        /* agent not yet spawned — onPtyEvent('spawn') will subscribe when it starts */
      }
    } catch (err) {
      // Clean up partial map entries so the agentId doesn't linger in state.
      this.tailBuffers.delete(agentId);
      this.decoders.delete(agentId);
      this.subscribers.delete(agentId);
      this.tasks.delete(task.id);
      throw err;
    }
  }

  isRegisteredCoordinator(coordinatorTaskId: string): boolean {
    return this.coordinators.has(coordinatorTaskId);
  }

  registerCoordinator(
    coordinatorTaskId: string,
    projectId: string,
    opts?: { worktreePath?: string; skipPermissions?: boolean },
  ): void {
    if (this.coordinators.has(coordinatorTaskId)) return;
    // Snapshot the current global project root and defaults so each coordinator gets
    // the values that were active when IT registered, not whatever a later coordinator sets.
    this.coordinators.set(coordinatorTaskId, {
      taskId: coordinatorTaskId,
      lifecycle: 'starting',
      projectId,
      projectRoot: this.projectRoot ?? '',
      worktreePath: opts?.worktreePath,
      mcpServerInfo: null,
      spawnDefaults: { ...this.coordinatorSpawnDefaults },
      pendingNotifications: [],
      stagedBatches: new Map(),
      ackedBatchIds: [],
      restageTimer: null,
      propagateSkipPermissions: Boolean(opts?.skipPermissions),
      mcpJsonPath: '',
      createdMcpJson: false,
    });
  }

  setMcpJsonInfo(
    coordinatorTaskId: string,
    mcpJsonPath: string,
    createdMcpJson: boolean,
    previousMcpParallelCode?: unknown,
    writtenMcpParallelCode?: unknown,
  ): void {
    const state = this.coordinators.get(coordinatorTaskId);
    if (state) {
      state.mcpJsonPath = mcpJsonPath;
      state.createdMcpJson = createdMcpJson;
      state.previousMcpParallelCode = previousMcpParallelCode;
      state.writtenMcpParallelCode = writtenMcpParallelCode;
    }
  }

  deregisterCoordinator(coordinatorTaskId: string): void {
    const coordinator = this.coordinators.get(coordinatorTaskId);
    if (!coordinator) return;
    coordinator.lifecycle = 'closing';
    if (coordinator.restageTimer) clearTimeout(coordinator.restageTimer);
    if (coordinator.pendingNotifications.length > 0 || coordinator.stagedBatches.size > 0) {
      logWarn('coordinator.notification', 'staged notification cleared', {
        coordinatorTaskId: coordinator.taskId,
        reason: 'deregister',
        pendingTaskIds: this.pendingNotificationTaskIds(coordinator),
      });
      this.notifyRenderer(IPC.MCP_CoordinatorNotificationCleared, {
        coordinatorTaskId: coordinator.taskId,
      });
    }

    // Clean up coordinator .mcp.json — restore or remove only the parallel-code key.
    // Always read current contents (user may have added keys while running).
    // If there was a pre-existing parallel-code entry, restore it; otherwise delete the key.
    if (coordinator.mcpJsonPath) {
      try {
        const raw = existsSync(coordinator.mcpJsonPath)
          ? readFileSync(coordinator.mcpJsonPath, 'utf-8')
          : null;
        if (raw !== null) {
          const content = JSON.parse(raw) as { mcpServers?: Record<string, unknown> };
          if (content.mcpServers) {
            const current = content.mcpServers['parallel-code'];
            const weWrote = coordinator.writtenMcpParallelCode;
            // Only restore/delete if the current value still matches what we wrote,
            // or if we don't have a record of what we wrote (legacy path — always restore).
            const safeToRestore =
              weWrote === undefined || JSON.stringify(current) === JSON.stringify(weWrote);
            if (safeToRestore) {
              if (coordinator.previousMcpParallelCode !== undefined) {
                content.mcpServers['parallel-code'] = coordinator.previousMcpParallelCode;
              } else {
                delete content.mcpServers['parallel-code'];
              }
            }
          }
          const hasServers = Object.keys(content.mcpServers ?? {}).length > 0;
          const hasOtherKeys = Object.keys(content).filter((k) => k !== 'mcpServers').length > 0;
          if (!hasServers && !hasOtherKeys) {
            unlinkSync(coordinator.mcpJsonPath);
          } else {
            if (!hasServers) delete content.mcpServers;
            atomicWriteFileSync(coordinator.mcpJsonPath, JSON.stringify(content, null, 2));
          }
        }
      } catch {
        /* ignore — file may already be gone or malformed */
      }
    }

    this.coordinators.delete(coordinatorTaskId);

    // Resolve any pending wait_for_signal_done calls so they don't hang until
    // the 5-minute timeout fires after the coordinator closes.
    const anyResolvers = this.anySignalResolvers.get(coordinatorTaskId);
    if (anyResolvers?.length) {
      const syntheticResult: WaitForSignalDoneResult = {
        taskId: coordinatorTaskId,
        name: '',
        status: 'exited',
        signalDoneAt: new Date().toISOString(),
        remaining: 0,
      };
      for (const resolve of anyResolvers) resolve(syntheticResult);
    }
    this.anySignalResolvers.delete(coordinatorTaskId);
    this.activeSignalWaitCounts.delete(coordinatorTaskId);

    // Mark all child tasks belonging to this coordinator as orphaned so that
    // signal_done calls from still-running sub-tasks can still resolve.
    // Do NOT delete the task records — they must remain so signal_done can find them.
    for (const [taskId, task] of this.tasks) {
      if (task.coordinatorTaskId !== coordinatorTaskId) continue;

      // Unsubscribe PTY output callback (stop receiving output, but keep task record)
      const cb = this.subscribers.get(task.agentId);
      if (cb) {
        unsubscribeFromAgent(task.agentId, cb);
        this.subscribers.delete(task.agentId);
      }
      this.tailBuffers.delete(task.agentId);
      this.decoders.delete(task.agentId);

      // Resolve pending idle waiters so callers aren't left hanging
      const resolvers = this.idleResolvers.get(taskId);
      if (resolvers) {
        for (const resolve of resolvers) resolve({ reason: 'exited' });
        this.idleResolvers.delete(taskId);
      }

      // If the prompt hadn't been delivered yet, silence future orphaned notifications:
      // the task never started real work so there's nothing to review. If the prompt
      // WAS already delivered, leave reviewNotificationQueued unset so the next idle
      // or exit fires the expected orphaned notification for the user to act on.
      if (!task.assignedPromptDelivered) {
        task.reviewNotificationQueued = true;
      }

      // Transfer control to human so the user can decide what to do with orphaned tasks
      this.controlMap.set(taskId, 'human');
      this.blockedByHumanControl.delete(taskId);

      if (task.mcpConfigPath) {
        try {
          unlinkSync(task.mcpConfigPath);
        } catch {
          /* already gone */
        }
        task.mcpConfigPath = undefined;
      }

      // Notify the frontend so it can detach children consistently regardless
      // of whether backend deregistration or renderer close cleanup wins the IPC race.
      this.notifyRenderer(IPC.MCP_TaskStateSync, {
        taskId,
        coordinatedBy: null,
        controlledBy: null,
        mcpConfigPath: null,
        mcpStartupStatus: null,
        mcpStartupError: null,
        needsReview: task.assignedPromptDelivered,
      });
    }
  }

  markPromptDelivered(taskId: string): void {
    const task = this.tasks.get(taskId);
    if (task) task.assignedPromptDelivered = true;
  }

  rescheduleRestageTimer(coordinatorTaskId: string): void {
    const coordinator = this.coordinators.get(coordinatorTaskId);
    if (!coordinator || coordinator.pendingNotifications.length === 0) return;
    if (this.hasActiveSignalWaiter(coordinatorTaskId)) {
      logWarn('coordinator.notification', 'restage skipped', {
        coordinatorTaskId,
        reason: 'active_signal_wait',
        activeWaitCount: this.activeSignalWaitCounts.get(coordinatorTaskId) ?? 0,
        pendingTaskIds: this.pendingNotificationTaskIds(coordinator),
      });
      return;
    }
    if (coordinator.restageTimer) clearTimeout(coordinator.restageTimer);
    coordinator.restageTimer = setTimeout(() => {
      coordinator.restageTimer = null;
      if (coordinator.pendingNotifications.length > 0) {
        this.stageBatch(coordinator);
      }
    }, this.COORDINATOR_RESTAMP_DELAY_MS);
  }

  dropNotification(coordinatorTaskId: string, batchId: string): void {
    const coordinator = this.coordinators.get(coordinatorTaskId);
    const affectedTaskIds: string[] = [];
    if (coordinator) {
      const pendingIds = coordinator.stagedBatches.get(batchId);
      if (pendingIds) {
        for (const notifId of pendingIds) {
          const notif = coordinator.pendingNotifications.find((n) => n.id === notifId);
          if (notif) affectedTaskIds.push(notif.taskId);
        }
      }
    }
    this.ackNotification(coordinatorTaskId, batchId);
    for (const taskId of affectedTaskIds) {
      this.notifyRenderer(IPC.MCP_TaskStateSync, { taskId, needsReview: true });
    }
  }

  ackNotification(coordinatorTaskId: string, batchId: string): void {
    const coordinator = this.coordinators.get(coordinatorTaskId);
    if (!coordinator) return;

    if (coordinator.ackedBatchIds.includes(batchId)) return;

    const pendingIds = coordinator.stagedBatches.get(batchId);
    if (pendingIds) {
      coordinator.pendingNotifications = coordinator.pendingNotifications.filter((n) => {
        if (pendingIds.includes(n.id)) {
          const task = this.tasks.get(n.taskId);
          if (task) task.reviewNotificationQueued = false;
          return false;
        }
        return true;
      });
      coordinator.stagedBatches.delete(batchId);
    }

    coordinator.ackedBatchIds.push(batchId);
    if (coordinator.ackedBatchIds.length > this.MAX_ACKED_BATCH_IDS) {
      coordinator.ackedBatchIds.shift();
    }

    if (coordinator.pendingNotifications.length === 0 && coordinator.restageTimer) {
      clearTimeout(coordinator.restageTimer);
      coordinator.restageTimer = null;
    }
  }

  hasActiveCoordinator(): boolean {
    return this.coordinators.size > 0;
  }

  signalDone(taskId: string): boolean {
    const task = this.tasks.get(taskId);
    if (!task) return false;
    task.assignedPromptDelivered = true;
    task.signalDoneAt = new Date();
    task.signalDoneConsumed = false;

    const coordinatorId = task.coordinatorTaskId;
    const anyResolvers = this.anySignalResolvers.get(coordinatorId);
    const firstAnyResolver = anyResolvers?.length ? anyResolvers.shift() : undefined;
    if (firstAnyResolver) {
      task.signalDoneConsumed = true;
      // Suppress before finishSignalWait so it doesn't re-stage
      this.suppressPendingNotificationForTask(task);
      const remaining = this.countRemaining(coordinatorId);
      firstAnyResolver({
        taskId,
        name: task.name,
        status: task.status,
        signalDoneAt: (task.signalDoneAt ?? new Date()).toISOString(),
        remaining,
      });
      this.finishSignalWait(coordinatorId);
      // Tell renderer — coordinator already gets result via MCP return value, no UI notification needed
      this.notifyRenderer(IPC.MCP_TaskStateSync, {
        taskId,
        signalDoneReceived: true,
        signalDoneAt: (task.signalDoneAt ?? new Date()).toISOString(),
        signalDoneConsumed: true,
      });
      logWarn('coordinator.signal_wait', 'wait_for_signal_done finish', {
        taskId,
        coordinatorTaskId: coordinatorId,
        reason: 'signal',
        activeWaitCount: this.activeSignalWaitCounts.get(coordinatorId) ?? 0,
      });
      return true;
    }

    // No active waiter — notify via UI so coordinator sees the completion
    this.notifyRenderer(IPC.MCP_TaskStateSync, {
      taskId,
      signalDoneReceived: true,
      signalDoneAt: (task.signalDoneAt ?? new Date()).toISOString(),
      signalDoneConsumed: false,
    });
    // Don't queue a review notification if the agent hasn't finished spawning yet —
    // renderer state is inconsistent while status is 'creating'.
    // For 'running' and 'idle', the worker explicitly signalled done so treat as idle.
    if (task.status !== 'creating') {
      const state: 'idle' | 'exited' = task.status === 'exited' ? 'exited' : 'idle';
      this.maybeQueueReviewNotification(task, state, task.exitCode ?? null, 5_000);
    }
    return true;
  }

  private suppressPendingNotificationForTask(task: CoordinatedTask): void {
    const coordinator = this.coordinators.get(task.coordinatorTaskId);
    if (!coordinator) return;

    const toRemove = coordinator.pendingNotifications.filter((n) => n.taskId === task.id);
    if (toRemove.length === 0) return;

    const removeIds = new Set(toRemove.map((n) => n.id));
    coordinator.pendingNotifications = coordinator.pendingNotifications.filter(
      (n) => n.taskId !== task.id,
    );
    task.reviewNotificationQueued = false;

    for (const [batchId, notifIds] of coordinator.stagedBatches) {
      const remaining = notifIds.filter((id) => !removeIds.has(id));
      if (remaining.length === 0) {
        coordinator.stagedBatches.delete(batchId);
      } else {
        coordinator.stagedBatches.set(batchId, remaining);
      }
    }

    if (coordinator.pendingNotifications.length === 0) {
      if (coordinator.restageTimer) {
        clearTimeout(coordinator.restageTimer);
        coordinator.restageTimer = null;
      }
      logWarn('coordinator.notification', 'staged notification cleared', {
        coordinatorTaskId: coordinator.taskId,
        reason: 'all_suppressed',
        taskId: task.id,
      });
      this.notifyRenderer(IPC.MCP_CoordinatorNotificationCleared, {
        coordinatorTaskId: coordinator.taskId,
      });
    } else {
      // Re-stage with remaining notifications so text is updated
      this.stageBatch(coordinator);
    }
  }

  waitForSignalDone(
    coordinatorTaskId: string,
    timeoutMs = DEFAULT_WAIT_TIMEOUT_MS,
    requestId?: string,
  ): Promise<WaitForSignalDoneResult> {
    if (!this.coordinators.has(coordinatorTaskId)) {
      return Promise.reject(new Error(`Coordinator not found: ${coordinatorTaskId}`));
    }
    // Replay the cached result if this requestId already delivered — handles retry
    // after the HTTP response was lost before the client received it.
    // Key includes coordinatorTaskId to prevent cross-coordinator replay.
    if (requestId) {
      const cached = this.recentlyDelivered.get(coordinatorTaskId, requestId);
      if (cached) return Promise.resolve(cached);
    }
    // Return immediately if there's an unconsumed signal
    for (const task of this.tasks.values()) {
      if (
        task.coordinatorTaskId === coordinatorTaskId &&
        task.signalDoneAt &&
        !task.signalDoneConsumed
      ) {
        task.signalDoneConsumed = true;
        // Suppress the staged UI notification that was queued when signalDone ran
        // without an active waiter — otherwise it will auto-fire as a duplicate.
        this.suppressPendingNotificationForTask(task);
        this.notifyRenderer(IPC.MCP_TaskStateSync, {
          taskId: task.id,
          signalDoneConsumed: true,
        });
        const remaining = this.countRemaining(coordinatorTaskId);
        const result = {
          taskId: task.id,
          name: task.name,
          status: task.status,
          signalDoneAt: task.signalDoneAt.toISOString(),
          remaining,
        };
        if (requestId) this.recentlyDelivered.set(coordinatorTaskId, requestId, result);
        return Promise.resolve(result);
      }
    }

    this.beginSignalWait(coordinatorTaskId);
    logWarn('coordinator.signal_wait', 'wait_for_signal_done start', {
      coordinatorTaskId,
      activeWaitCount: this.activeSignalWaitCounts.get(coordinatorTaskId) ?? 0,
      timeoutMs,
    });

    return new Promise((resolve) => {
      const timerRef = { value: undefined as ReturnType<typeof setTimeout> | undefined };

      const wrapped = (result: WaitForSignalDoneResult) => {
        if (timerRef.value !== undefined) clearTimeout(timerRef.value);
        if (requestId) this.recentlyDelivered.set(coordinatorTaskId, requestId, result);
        resolve(result);
      };

      timerRef.value = setTimeout(() => {
        const resolvers = this.anySignalResolvers.get(coordinatorTaskId);
        if (resolvers) {
          const idx = resolvers.indexOf(wrapped);
          if (idx >= 0) resolvers.splice(idx, 1);
        }
        this.finishSignalWait(coordinatorTaskId);
        logWarn('coordinator.signal_wait', `wait_for_signal_done timed out after ${timeoutMs}ms`, {
          coordinatorTaskId,
          reason: 'timeout',
          timeoutMs,
          activeWaitCount: this.activeSignalWaitCounts.get(coordinatorTaskId) ?? 0,
        });
        const remaining = this.countRemaining(coordinatorTaskId);
        resolve({ remaining, timedOut: true });
      }, timeoutMs);

      let resolvers = this.anySignalResolvers.get(coordinatorTaskId);
      if (!resolvers) {
        resolvers = [];
        this.anySignalResolvers.set(coordinatorTaskId, resolvers);
      }
      resolvers.push(wrapped);
    });
  }

  private countRemaining(coordinatorTaskId: string): number {
    let count = 0;
    for (const task of this.tasks.values()) {
      if (task.coordinatorTaskId !== coordinatorTaskId) continue;
      if (task.signalDoneConsumed) continue; // coordinator already processed this one
      if (task.status === 'exited' && !task.signalDoneAt) continue; // exited without signal — handled by UI
      count++;
    }
    return count;
  }

  private beginSignalWait(coordinatorTaskId: string): void {
    this.activeSignalWaitCounts.set(
      coordinatorTaskId,
      (this.activeSignalWaitCounts.get(coordinatorTaskId) ?? 0) + 1,
    );
    const coordinator = this.coordinators.get(coordinatorTaskId);
    if (coordinator) {
      this.clearStagedNotificationForCoordinator(coordinator);
    }
  }

  private finishSignalWait(coordinatorTaskId: string): void {
    const current = this.activeSignalWaitCounts.get(coordinatorTaskId) ?? 0;
    if (current <= 1) {
      this.activeSignalWaitCounts.delete(coordinatorTaskId);
    } else {
      this.activeSignalWaitCounts.set(coordinatorTaskId, current - 1);
      return;
    }

    const coordinator = this.coordinators.get(coordinatorTaskId);
    if (coordinator && coordinator.pendingNotifications.length > 0) {
      this.stageBatch(coordinator);
    }
  }

  private hasActiveSignalWaiter(coordinatorTaskId: string): boolean {
    return (this.activeSignalWaitCounts.get(coordinatorTaskId) ?? 0) > 0;
  }

  private clearStagedNotificationForCoordinator(coordinator: CoordinatorState): void {
    if (coordinator.restageTimer) {
      clearTimeout(coordinator.restageTimer);
      coordinator.restageTimer = null;
    }
    if (coordinator.stagedBatches.size === 0) return;
    coordinator.stagedBatches.clear();
    logWarn('coordinator.notification', 'staged notification cleared', {
      coordinatorTaskId: coordinator.taskId,
      reason: 'signal_wait_started',
      pendingTaskIds: this.pendingNotificationTaskIds(coordinator),
    });
    this.notifyRenderer(IPC.MCP_CoordinatorNotificationCleared, {
      coordinatorTaskId: coordinator.taskId,
    });
  }

  private pendingNotificationTaskIds(coordinator: CoordinatorState): string[] {
    return coordinator.pendingNotifications.map((n) => n.taskId);
  }

  private notifyRenderer(channel: string, data: unknown): void {
    if (this.win && !this.win.isDestroyed()) {
      this.win.webContents.send(channel, data);
    }
  }
}
