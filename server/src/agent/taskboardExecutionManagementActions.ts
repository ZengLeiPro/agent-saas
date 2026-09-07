import { assertActiveBoard, assertBoardRole } from '../taskboard/storeHelpers.js';
import {
  TaskboardConflictError,
  TaskboardValidationError,
  type TaskboardExecutionService,
  type TaskboardIdentity,
  type TaskboardService,
} from '../taskboard/types.js';
import type { TaskboardManageInput, TaskboardToolOptions } from './taskboardToolActions.js';

export async function invokeExecutionManagementAction(
  options: TaskboardToolOptions,
  service: TaskboardService,
  identity: TaskboardIdentity,
  input: TaskboardManageInput,
): Promise<Record<string, unknown>> {
  const executionService = requireExecutionService(options.executionService?.());
  const taskId = requireField(input.taskId, 'taskId');
  const executionId = requireField(input.executionId, 'executionId');
  if (input.action === 'execution.cancel') {
    if (!executionService.cancelExecution) throw new Error('任务看板执行取消服务未启用');
    const result = await executionService.cancelExecution(identity, taskId, executionId, {
      expectedVersion: requireVersion(input),
      ...(input.reason ? { reason: input.reason } : {}),
    });
    return { canceled: true, ...result };
  }
  if (input.action === 'execution.activity.inspect') {
    if (!executionService.inspectExecutionActivity) throw new Error('任务看板会话活动查询未启用');
    return { ...await executionService.inspectExecutionActivity(identity, taskId, executionId) };
  }
  if (input.action !== 'execution.activity.reconcile') {
    throw new Error(`不支持的 Execution 管理 action=${input.action}`);
  }
  const task = await service.getTask(identity, taskId);
  const board = await service.getBoard(identity, task.boardId);
  assertBoardRole(board.role, 'maintainer');
  assertActiveBoard(board);
  const expectedVersion = requireVersion(input);
  if (task.version !== expectedVersion) throw new TaskboardConflictError(task);
  const dryRun = input.dryRun !== false;
  if (!dryRun && !input.reason) throw new TaskboardValidationError('实际结算残留活动时必须提供 reason');
  if (!executionService.reconcileExecutionActivity) throw new Error('任务看板会话活动结算未启用');
  return { ...await executionService.reconcileExecutionActivity(identity, taskId, executionId, {
    expectedVersion,
    reason: input.reason ?? 'dry-run',
    dryRun,
  }) };
}

function requireExecutionService(service: TaskboardExecutionService | undefined): TaskboardExecutionService {
  if (!service) throw new Error('任务看板执行服务未启用');
  return service;
}

function requireVersion(input: TaskboardManageInput): number {
  if (!Number.isInteger(input.expectedVersion) || (input.expectedVersion ?? 0) < 1) {
    throw new TaskboardValidationError('该操作必须提供 expectedVersion');
  }
  return input.expectedVersion!;
}

function requireField(value: string | undefined, field: string): string {
  if (!value?.trim()) throw new TaskboardValidationError(`${field} 不能为空`);
  return value.trim();
}
