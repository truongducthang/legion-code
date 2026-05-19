/** Agent summary sent in the agents list. */
export interface RemoteAgent {
  agentId: string;
  taskId: string;
  taskName: string;
  status: 'running' | 'exited';
  exitCode: number | null;
  lastLine: string;
}

/** Project summary sent in the projects list. */
export interface RemoteProject {
  root: string;
  name: string;
  defaultBaseBranch: string | null;
}

/** Branch entry sent in the branches list. */
export interface RemoteBranch {
  name: string;
  current: boolean;
}

/** Typed error codes a spawn_task can fail with. */
export type SpawnErrorCode =
  | 'invalid_project'
  | 'invalid_branch'
  | 'invalid_agent'
  | 'invalid_name'
  | 'invalid_prompt'
  | 'create_failed'
  | 'spawn_failed';

const SPAWN_ERROR_CODES: readonly SpawnErrorCode[] = [
  'invalid_project',
  'invalid_branch',
  'invalid_agent',
  'invalid_name',
  'invalid_prompt',
  'create_failed',
  'spawn_failed',
];

/** Discriminator helper: returns the code if valid, null otherwise. */
export function parseSpawnError(value: unknown): SpawnErrorCode | null {
  if (typeof value !== 'string') return null;
  return (SPAWN_ERROR_CODES as readonly string[]).includes(value)
    ? (value as SpawnErrorCode)
    : null;
}

// --- Server -> Client messages ---

export interface OutputMessage {
  type: 'output';
  agentId: string;
  data: string; // base64
}

export interface StatusMessage {
  type: 'status';
  agentId: string;
  status: 'running' | 'exited';
  exitCode: number | null;
}

export interface AgentsMessage {
  type: 'agents';
  list: RemoteAgent[];
}

export interface ScrollbackMessage {
  type: 'scrollback';
  agentId: string;
  data: string; // base64
  cols: number;
}

export interface ProjectsMessage {
  type: 'projects';
  list: RemoteProject[];
}

export interface BranchesMessage {
  type: 'branches';
  projectRoot: string;
  list: RemoteBranch[];
}

export type SpawnResultMessage =
  | {
      type: 'spawn_result';
      requestId: string;
      ok: true;
      taskId: string;
      agentId: string;
    }
  | {
      type: 'spawn_result';
      requestId: string;
      ok: false;
      error: SpawnErrorCode;
      message: string;
    };

export type ServerMessage =
  | OutputMessage
  | StatusMessage
  | AgentsMessage
  | ScrollbackMessage
  | ProjectsMessage
  | BranchesMessage
  | SpawnResultMessage;

// --- Client -> Server messages ---

export interface InputCommand {
  type: 'input';
  agentId: string;
  data: string;
}

export interface ResizeCommand {
  type: 'resize';
  agentId: string;
  cols: number;
  rows: number;
}

export interface KillCommand {
  type: 'kill';
  agentId: string;
}

export interface SubscribeCommand {
  type: 'subscribe';
  agentId: string;
}

export interface UnsubscribeCommand {
  type: 'unsubscribe';
  agentId: string;
}

export interface AuthCommand {
  type: 'auth';
  token: string;
}

export interface ListProjectsCommand {
  type: 'list_projects';
}

export interface ListBranchesCommand {
  type: 'list_branches';
  projectRoot: string;
}

export interface SpawnTaskCommand {
  type: 'spawn_task';
  requestId: string;
  projectRoot: string;
  baseBranch: string | null;
  agentId: string;
  taskName: string;
  prompt: string;
}

export type ClientMessage =
  | AuthCommand
  | InputCommand
  | ResizeCommand
  | KillCommand
  | SubscribeCommand
  | UnsubscribeCommand
  | ListProjectsCommand
  | ListBranchesCommand
  | SpawnTaskCommand;

// --- Size caps (design.md) ---
const MAX_REQUEST_ID = 100;
const MAX_PROJECT_ROOT = 1024;
const MAX_BASE_BRANCH = 200;
const MAX_PRESET_AGENT_ID = 100;
const MAX_TASK_NAME = 200;
const MAX_PROMPT = 16384;

function isStr(v: unknown, max: number): v is string {
  return typeof v === 'string' && v.length <= max;
}

/** Minimal validation for incoming client messages. */
export function parseClientMessage(raw: string): ClientMessage | null {
  try {
    const msg = JSON.parse(raw) as Record<string, unknown>;
    if (typeof msg.type !== 'string') return null;

    switch (msg.type) {
      case 'auth':
        if (!isStr(msg.token, 200)) return null;
        return { type: 'auth', token: msg.token };

      case 'list_projects':
        return { type: 'list_projects' };

      case 'list_branches':
        if (!isStr(msg.projectRoot, MAX_PROJECT_ROOT)) return null;
        return { type: 'list_branches', projectRoot: msg.projectRoot };

      case 'spawn_task': {
        if (!isStr(msg.requestId, MAX_REQUEST_ID)) return null;
        if (!isStr(msg.projectRoot, MAX_PROJECT_ROOT)) return null;
        if (msg.baseBranch !== null && !isStr(msg.baseBranch, MAX_BASE_BRANCH)) return null;
        if (!isStr(msg.agentId, MAX_PRESET_AGENT_ID)) return null;
        if (!isStr(msg.taskName, MAX_TASK_NAME)) return null;
        if (!isStr(msg.prompt, MAX_PROMPT)) return null;
        return {
          type: 'spawn_task',
          requestId: msg.requestId,
          projectRoot: msg.projectRoot,
          baseBranch: msg.baseBranch === null ? null : (msg.baseBranch as string),
          agentId: msg.agentId,
          taskName: msg.taskName,
          prompt: msg.prompt,
        };
      }

      case 'input':
        if (!isStr(msg.agentId, MAX_PRESET_AGENT_ID)) return null;
        if (typeof msg.data !== 'string') return null;
        if (msg.data.length > 4096) return null;
        return { type: 'input', agentId: msg.agentId, data: msg.data };

      case 'resize':
        if (!isStr(msg.agentId, MAX_PRESET_AGENT_ID)) return null;
        if (typeof msg.cols !== 'number' || typeof msg.rows !== 'number') return null;
        if (!Number.isInteger(msg.cols) || !Number.isInteger(msg.rows)) return null;
        if (msg.cols < 1 || msg.cols > 500 || msg.rows < 1 || msg.rows > 500) return null;
        return {
          type: 'resize',
          agentId: msg.agentId,
          cols: msg.cols,
          rows: msg.rows,
        };

      case 'kill':
        if (!isStr(msg.agentId, MAX_PRESET_AGENT_ID)) return null;
        return { type: 'kill', agentId: msg.agentId };

      case 'subscribe':
        if (!isStr(msg.agentId, MAX_PRESET_AGENT_ID)) return null;
        return { type: 'subscribe', agentId: msg.agentId };

      case 'unsubscribe':
        if (!isStr(msg.agentId, MAX_PRESET_AGENT_ID)) return null;
        return { type: 'unsubscribe', agentId: msg.agentId };

      default:
        return null;
    }
  } catch {
    return null;
  }
}
