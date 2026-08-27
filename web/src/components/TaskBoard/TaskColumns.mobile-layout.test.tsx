import { render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { TaskBoardStatus, TaskBoardTask } from '@agent/shared';
import { TaskColumns } from './TaskColumns';

function task(index: number, status: TaskBoardStatus): TaskBoardTask {
  return {
    id: `task-${index}`,
    boardId: 'board-1',
    identifier: `TASK-${index}`,
    title: `移动端长列表任务 ${index}`,
    description: '验证移动端列表可以使用头部操作区之外的全部剩余高度',
    status,
    priority: 'none',
    labels: [],
    sortOrder: index * 1_000,
    commentCount: 0,
    version: 1,
    mergeEligibility: status === 'ready_to_merge' ? 'eligible' : 'not_applicable',
    createdAt: '2026-08-27T00:00:00.000Z',
    updatedAt: '2026-08-27T00:00:00.000Z',
  };
}

function renderLongList(status: TaskBoardStatus) {
  const tasks = Array.from({ length: 20 }, (_, index) => task(index + 1, status));
  render(
    <TaskColumns
      boardId="board-1"
      tasks={tasks}
      readOnly={false}
      canCreateTask
      canReorderTask
      canTransitionTask
      canCreateIntegration
      selectedDeliveryTaskIds={status === 'ready_to_merge' ? new Set([tasks[0].id]) : new Set()}
      creatingIntegration={false}
      archivedCount={2}
      mobileStatus={status}
      onMobileStatusChange={vi.fn()}
      onCreateTask={vi.fn()}
      onOpenTask={vi.fn()}
      onDragStart={vi.fn()}
      onDragEnd={vi.fn()}
      onCreateIntegration={vi.fn()}
      onOpenArchivedTasks={vi.fn()}
      onDeliverySelectedChange={vi.fn()}
      onDrop={vi.fn()}
    />,
  );

  return {
    controls: screen.getByTestId('taskboard-mobile-controls'),
    list: screen.getByTestId('taskboard-mobile-list'),
  };
}

describe('TaskColumns 移动端剩余高度布局', () => {
  it.each([
    ['backlog', '在需求池新建任务'],
    ['ready_to_merge', '创建集成批次（1）'],
  ] as const)('%s 长列表使用操作区之外的全部剩余高度', (status, actionName) => {
    const { controls, list } = renderLongList(status);

    expect(list.parentElement?.className).toContain('flex-col');
    expect(controls.className).toContain('shrink-0');
    expect(list.className).toContain('min-h-0');
    expect(list.className).toContain('flex-1');
    expect(list.className).not.toContain('h-[calc(');
    expect(within(controls).getByRole('button', { name: actionName })).toBeTruthy();
    expect(
      within(controls).getByRole('button', { name: '在移动端查看已归档任务（2）' }),
    ).toBeTruthy();
    expect(within(list).getAllByRole('button', { name: /打开任务 TASK-/ })).toHaveLength(20);
  });
});
