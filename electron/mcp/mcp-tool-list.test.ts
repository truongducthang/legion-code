import { describe, expect, it } from 'vitest';
import { selectTools, SUBTASK_TOOLS, COORDINATOR_TOOLS, type ToolDef } from './mcp-tool-list.js';

describe('selectTools — role-based tool list', () => {
  it('sub-task (taskId set, no coordinatorId) gets only signal_done', () => {
    const tools = selectTools('task-abc', '');
    expect(tools).toEqual(SUBTASK_TOOLS);
    expect(tools.map((t: ToolDef) => t.name)).toStrictEqual(['signal_done']);
  });

  it('coordinator (coordinatorId set, no taskId) gets coordinator tools', () => {
    const tools = selectTools('', 'coordinator-xyz');
    expect(tools).toEqual(COORDINATOR_TOOLS);
  });

  it('coordinator tools do NOT include signal_done', () => {
    const tools = selectTools('', 'coordinator-xyz');
    expect(tools.map((t: ToolDef) => t.name)).not.toContain('signal_done');
  });

  it('coordinator tools include the expected lifecycle tools', () => {
    const names = selectTools('', 'coordinator-xyz').map((t: ToolDef) => t.name);
    for (const expected of [
      'create_task',
      'list_tasks',
      'get_task_status',
      'send_prompt',
      'wait_for_idle',
      'wait_for_signal_done',
      'get_task_diff',
      'get_task_output',
      'merge_task',
      'close_task',
    ]) {
      expect(names).toContain(expected);
    }
  });

  it('plain agent (neither taskId nor coordinatorId) gets coordinator tools', () => {
    const tools = selectTools('', '');
    expect(tools).toEqual(COORDINATOR_TOOLS);
  });

  it('sub-task tools do NOT include any coordinator lifecycle tools', () => {
    const names = selectTools('task-abc', '').map((t: ToolDef) => t.name);
    for (const forbidden of ['create_task', 'merge_task', 'close_task', 'wait_for_signal_done']) {
      expect(names).not.toContain(forbidden);
    }
  });
});
