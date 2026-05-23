import { beforeEach, describe, expect, it, vi } from 'vitest';

type MockTask = {
  projectId?: string;
  coordinatorMode?: boolean;
  coordinatedBy?: string;
  collapsed?: boolean;
};

const { mockStore } = vi.hoisted(() => ({
  mockStore: {
    tasks: {} as Record<string, MockTask>,
    taskOrder: [] as string[],
    collapsedTaskOrder: [] as string[],
    projects: [] as Array<{ id: string }>,
  },
}));

vi.mock('./core', () => ({
  store: mockStore,
}));

import {
  computeGroupedTasks,
  computeSidebarTaskOrder,
  getCoordinatorChildren,
} from './sidebar-order';

beforeEach(() => {
  mockStore.tasks = {};
  mockStore.taskOrder = [];
  mockStore.collapsedTaskOrder = [];
  mockStore.projects = [];
});

describe('sidebar coordinator ordering', () => {
  it('groups coordinator children only under their coordinator', () => {
    mockStore.projects = [{ id: 'proj-1' }];
    mockStore.taskOrder = ['coord-1', 'child-1', 'task-1'];
    mockStore.collapsedTaskOrder = ['child-2'];
    mockStore.tasks = {
      'coord-1': { projectId: 'proj-1', coordinatorMode: true },
      'child-1': { projectId: 'proj-1', coordinatedBy: 'coord-1' },
      'child-2': { projectId: 'proj-1', coordinatedBy: 'coord-1', collapsed: true },
      'task-1': { projectId: 'proj-1' },
    };

    expect(getCoordinatorChildren('coord-1')).toEqual({
      active: ['child-1'],
      collapsed: ['child-2'],
    });
    expect(computeGroupedTasks().grouped['proj-1']).toEqual({
      active: ['coord-1', 'task-1'],
      collapsed: [],
    });
  });

  it('includes visible nested subtasks in keyboard navigation order', () => {
    mockStore.projects = [{ id: 'proj-1' }];
    mockStore.taskOrder = ['coord-1', 'child-1', 'task-1'];
    mockStore.collapsedTaskOrder = ['child-2'];
    mockStore.tasks = {
      'coord-1': { projectId: 'proj-1', coordinatorMode: true },
      'child-1': { projectId: 'proj-1', coordinatedBy: 'coord-1' },
      'child-2': { projectId: 'proj-1', coordinatedBy: 'coord-1', collapsed: true },
      'task-1': { projectId: 'proj-1' },
    };

    expect(computeSidebarTaskOrder()).toEqual(['coord-1', 'child-1', 'child-2', 'task-1']);
  });
});
