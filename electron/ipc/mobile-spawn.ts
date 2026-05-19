import crypto from 'crypto';
import path from 'path';
import type { BrowserWindow } from 'electron';
import type { SpawnTaskRequest } from '../remote/server.js';
import type { RemoteProject, SpawnResultMessage } from '../remote/protocol.js';
import { spawnAgent, writeToAgent } from './pty.js';
import { createTask } from './tasks.js';
import { listAgents } from './agents.js';
import { validateBranchName } from '../mcp/validation.js';
import { IPC } from './channels.js';

/** Mirrors src/store/tasks.ts:AGENT_WRITE_READY_TIMEOUT_MS so a mobile-spawned
 *  prompt waits the same amount of time for the PTY to come up as a
 *  desktop-driven one. */
const AGENT_WRITE_READY_TIMEOUT_MS = 8_000;
const AGENT_WRITE_RETRY_MS = 50;
const BRACKETED_PASTE_START = '\x1b[200~';
const BRACKETED_PASTE_END = '\x1b[201~';

function pasteDelayMs(text: string): number {
  const lines = text.split('\n').length;
  return Math.min(500, Math.max(50, lines * 15));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isAgentNotFoundError(err: unknown): boolean {
  return String(err).toLowerCase().includes('agent not found');
}

/** Same retry-until-ready loop the renderer uses in src/store/tasks.ts. */
async function writeToAgentWhenReady(agentId: string, data: string): Promise<void> {
  const deadline = Date.now() + AGENT_WRITE_READY_TIMEOUT_MS;
  let lastErr: unknown;
  while (Date.now() <= deadline) {
    try {
      writeToAgent(agentId, data);
      return;
    } catch (err) {
      lastErr = err;
      if (!isAgentNotFoundError(err)) throw err;
      await sleep(AGENT_WRITE_RETRY_MS);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

async function sendInitialPrompt(
  agentId: string,
  prompt: string,
  promptReadyDelayMs: number | undefined,
): Promise<void> {
  if (promptReadyDelayMs && promptReadyDelayMs > 0) {
    await sleep(promptReadyDelayMs);
  }
  // Bracketed paste + delay + Enter — same shape the renderer uses for
  // initial prompts so TUI agents (Claude Code, Codex, etc.) consume the
  // paste before the submit \r arrives.
  await writeToAgentWhenReady(agentId, BRACKETED_PASTE_START + prompt + BRACKETED_PASTE_END);
  await sleep(pasteDelayMs(prompt));
  await writeToAgentWhenReady(agentId, '\r');
}

export async function runMobileSpawn(
  win: BrowserWindow,
  req: SpawnTaskRequest,
  projectsByRoot: Map<string, RemoteProject>,
  lastBranchesByRoot: Map<string, Set<string>>,
  taskNames: Map<string, string>,
): Promise<SpawnResultMessage> {
  const { requestId } = req;

  // --- Validation (typed errors before any side effect) ---
  if (!projectsByRoot.has(req.projectRoot)) {
    return {
      type: 'spawn_result',
      requestId,
      ok: false,
      error: 'invalid_project',
      message: 'project not in current project list',
    };
  }
  if (req.baseBranch !== null) {
    const known = lastBranchesByRoot.get(req.projectRoot);
    if (!known || !known.has(req.baseBranch)) {
      return {
        type: 'spawn_result',
        requestId,
        ok: false,
        error: 'invalid_branch',
        message: 'branch not in latest branches reply',
      };
    }
    try {
      validateBranchName(req.baseBranch, 'baseBranch');
    } catch (err) {
      return {
        type: 'spawn_result',
        requestId,
        ok: false,
        error: 'invalid_branch',
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }
  const trimmedName = req.taskName.trim();
  if (!trimmedName) {
    return {
      type: 'spawn_result',
      requestId,
      ok: false,
      error: 'invalid_name',
      message: 'taskName is empty after trimming',
    };
  }
  if (!req.prompt) {
    return {
      type: 'spawn_result',
      requestId,
      ok: false,
      error: 'invalid_prompt',
      message: 'prompt is empty',
    };
  }

  // Project path sanity (mirrors desktop validatePath in register.ts:CreateTask).
  if (!path.isAbsolute(req.projectRoot) || req.projectRoot.includes('..')) {
    return {
      type: 'spawn_result',
      requestId,
      ok: false,
      error: 'invalid_project',
      message: 'projectRoot is not absolute or contains ".."',
    };
  }

  const agents = await listAgents().catch(() => []);
  const agentDef = agents.find((a) => a.id === req.agentId);
  if (!agentDef) {
    return {
      type: 'spawn_result',
      requestId,
      ok: false,
      error: 'invalid_agent',
      message: `unknown agent preset: ${req.agentId}`,
    };
  }

  // --- Create worktree (same path desktop uses) ---
  let taskId: string;
  let worktreePath: string;
  let branchName: string;
  try {
    const result = await createTask(
      trimmedName,
      req.projectRoot,
      [],
      'task',
      req.baseBranch ?? undefined,
    );
    taskId = result.id;
    worktreePath = result.worktree_path;
    branchName = result.branch_name;
    taskNames.set(taskId, trimmedName);
  } catch (err) {
    return {
      type: 'spawn_result',
      requestId,
      ok: false,
      error: 'create_failed',
      message: err instanceof Error ? err.message : String(err),
    };
  }

  // --- Spawn agent + send initial prompt ---
  const newAgentId = crypto.randomUUID();
  try {
    spawnAgent(win, {
      taskId,
      agentId: newAgentId,
      command: agentDef.command,
      args: agentDef.args,
      cwd: worktreePath,
      env: {},
      cols: 80,
      rows: 24,
      isShell: false,
      onOutput: { __CHANNEL_ID__: `mobile-${newAgentId}` },
    });
  } catch (err) {
    // Spec: agent spawn failure leaves the task in place (worktree on disk)
    // and returns ok:true with agentId:'' so the mobile client falls back to
    // the agent list instead of trying to open a non-existent detail view.
    console.warn('[mobile-spawn] spawn failed:', err);
    return {
      type: 'spawn_result',
      requestId,
      ok: true,
      taskId,
      agentId: '',
    };
  }

  // Fire-and-forget initial prompt. Failures here don't undo the spawn —
  // the user can still drive the agent manually from the mobile detail view.
  void sendInitialPrompt(newAgentId, req.prompt, agentDef.prompt_ready_delay_ms).catch((err) => {
    console.warn('[mobile-spawn] initial prompt send failed:', err);
  });

  // Tell the desktop renderer about the new task so its store mirrors what
  // the mobile client (and the now-running PTY) sees. Without this the PC
  // UI stays empty even though the worktree and agent exist on disk/in
  // memory. The renderer is responsible for re-attaching to the PTY when
  // its TerminalView mounts (agent.attachExisting: true).
  //
  // Wrapped: a renderer-notify failure must not poison the spawn_result the
  // mobile client is waiting on — the PTY is already running and the WS
  // broadcast (onPtyEvent('spawn')) has already gone out.
  try {
    if (typeof win.isDestroyed === 'function' && !win.isDestroyed() && win.webContents) {
      win.webContents.send(IPC.MobileTaskSpawned, {
        taskId,
        agentId: newAgentId,
        projectRoot: req.projectRoot,
        agentDefId: req.agentId,
        taskName: trimmedName,
        baseBranch: req.baseBranch,
        branchName,
        worktreePath,
        prompt: req.prompt,
      });
    }
  } catch (err) {
    console.warn('[mobile-spawn] notify renderer failed:', err);
  }

  return {
    type: 'spawn_result',
    requestId,
    ok: true,
    taskId,
    agentId: newAgentId,
  };
}
