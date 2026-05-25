/** Pure tool-list logic — extracted so it can be unit-tested without starting the MCP server. */

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, unknown>; required?: string[] };
}

export const SUBTASK_TOOLS: ToolDef[] = [
  {
    name: 'signal_done',
    description:
      'Signal that your assigned work is complete and ready for the coordinator to review. Call this when you have finished your task — do not call it mid-task.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
];

export const COORDINATOR_TOOLS: ToolDef[] = [
  {
    name: 'create_task',
    description:
      'Create a new task with its own git worktree and AI agent. The agent starts automatically and the prompt is delivered once the agent is ready.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Task name (used for branch name)' },
        prompt: {
          type: 'string',
          description: 'Initial prompt to send to the agent once it finishes starting up.',
        },
        baseBranch: {
          type: 'string',
          description:
            'Git branch to base the worktree on. Defaults to the project default branch. Use this to ensure sub-agents start with the right code (e.g. a feature branch).',
        },
      },
      required: ['name'],
    },
  },
  {
    name: 'list_tasks',
    description: 'List all coordinated tasks with their current status.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_task_status',
    description: 'Get detailed status of a specific task including git info and agent state.',
    inputSchema: {
      type: 'object',
      properties: { taskId: { type: 'string', description: 'Task ID' } },
      required: ['taskId'],
    },
  },
  {
    name: 'send_prompt',
    description: "Send a prompt/instruction to a task's AI agent.",
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'Task ID' },
        prompt: { type: 'string', description: 'Prompt text to send' },
      },
      required: ['taskId', 'prompt'],
    },
  },
  {
    name: 'wait_for_idle',
    description:
      "Wait until a task's agent becomes idle (sitting at its prompt). Returns when the agent is ready for the next instruction.",
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'Task ID' },
        timeoutMs: {
          type: 'number',
          description: 'Timeout in milliseconds (default: 300000 = 5 min)',
        },
      },
      required: ['taskId'],
    },
  },
  {
    name: 'get_task_diff',
    description: "Get the changed files and unified diff for a task's work.",
    inputSchema: {
      type: 'object',
      properties: { taskId: { type: 'string', description: 'Task ID' } },
      required: ['taskId'],
    },
  },
  {
    name: 'get_task_output',
    description: "Get recent terminal output from a task's agent (stripped of ANSI codes).",
    inputSchema: {
      type: 'object',
      properties: { taskId: { type: 'string', description: 'Task ID' } },
      required: ['taskId'],
    },
  },
  {
    name: 'merge_task',
    description: "Merge a task's branch into the base branch.",
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'Task ID' },
        squash: { type: 'boolean', description: 'Squash merge (default: false)' },
        message: { type: 'string', description: 'Custom merge commit message' },
        cleanup: {
          type: 'boolean',
          description: 'Clean up worktree and branch after merge (default: false)',
        },
      },
      required: ['taskId'],
    },
  },
  {
    name: 'close_task',
    description: 'Close and clean up a task — kills the agent, removes worktree and branch.',
    inputSchema: {
      type: 'object',
      properties: { taskId: { type: 'string', description: 'Task ID' } },
      required: ['taskId'],
    },
  },
  {
    name: 'wait_for_signal_done',
    description:
      'Wait for ANY sub-task to call signal_done. Returns { taskId, name, status, signalDoneAt, remaining } where remaining is the count of tasks still running or signaled-but-not-yet-reviewed. Call this in a loop until remaining === 0 to process all completed sub-tasks before spawning more. IMPORTANT: you MUST review the returned task before calling wait_for_signal_done again.',
    inputSchema: {
      type: 'object',
      properties: {
        timeoutMs: {
          type: 'number',
          description: 'Timeout in milliseconds (default: 300000 = 5 min)',
        },
      },
      required: [],
    },
  },
  {
    name: 'review_and_merge_task',
    description:
      'DEPRECATED: use get_task_diff → merge_task → close_task instead. This tool merges immediately without giving you a chance to review the diff first — the diff it returns is post-merge. Kept for backwards compatibility only.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'Task ID' },
        squash: { type: 'boolean', description: 'Squash merge (default: false)' },
        message: { type: 'string', description: 'Custom merge commit message' },
      },
      required: ['taskId'],
    },
  },
];

/**
 * Returns the tool list for a given role.
 * Sub-tasks (taskId set, no coordinatorId) get only signal_done.
 * Coordinators (and plain agents) get the full coordinator set — which does NOT include signal_done.
 */
export function selectTools(taskId: string, coordinatorId: string): ToolDef[] {
  if (taskId && !coordinatorId) return SUBTASK_TOOLS;
  return COORDINATOR_TOOLS;
}
