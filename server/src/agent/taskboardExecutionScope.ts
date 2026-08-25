import type { TaskboardExecutionContext, TaskboardIdentity } from '../taskboard/types.js';
import type { TaskboardManageInput } from './taskboardToolActions.js';

const LEGACY_EXECUTION_ACTIONS = ['list', 'create', 'update', 'move', 'execute'] as const;
const EXECUTION_USER_READ_ACTIONS = [
  'board.list', 'board.search', 'board.get',
  'task.list', 'task.search', 'task.get',
  'comment.list', 'execution.list', 'execution.context',
] as const;

/** Enforces the current active Execution as the sole authority for every Agent writeback. */
export function assertTaskboardExecutionScope(
  input: TaskboardManageInput,
  context: TaskboardExecutionContext | undefined,
  identity: TaskboardIdentity,
): void {
  if (!context) return;
  if (context.identity.tenantId !== identity.tenantId
    || context.identity.ownerUserId !== identity.ownerUserId) {
    throw new Error('任务看板执行身份不匹配');
  }
  if (EXECUTION_USER_READ_ACTIONS.includes(
    input.action as (typeof EXECUTION_USER_READ_ACTIONS)[number],
  )) return;
  if (!['queued', 'running', 'waiting_user', 'waiting_approval'].includes(context.execution.status)) {
    throw new Error('任务看板执行已终止，不能继续回写');
  }
  const executionActions = [
    'execution.context', 'execution.finish',
    'execution.pull_request.set', 'execution.pull_request.inspect', 'execution.pull_request.log',
    'execution.review_subject.record',
    'integration.sources', 'integration.source.inspect',
    'integration.source.log', 'integration.source.merge', 'integration.agent.merge', 'integration.agent.cleanup',
  ];
  if (executionActions.includes(input.action)) {
    if (input.taskId && input.taskId !== context.task.id) throw new Error('看板 Agent 只能操作当前任务');
    if (input.action.startsWith('integration.') && context.task.kind !== 'integration') {
      throw new Error('只有 integration 任务可以读取集成来源');
    }
    if (context.task.workflowVersion === 3
      && ['integration.source.inspect', 'integration.source.log', 'integration.source.merge'].includes(input.action)) {
      throw new Error('Workflow v3 Integration Agent 禁止调用 legacy integration.source 操作');
    }
    return;
  }
  if (!LEGACY_EXECUTION_ACTIONS.includes(input.action as (typeof LEGACY_EXECUTION_ACTIONS)[number])) {
    throw new Error('看板 Agent Execution 只能使用当前任务协议 action，不能进入普通会话管理域');
  }
  const currentTask = context.task;
  switch (input.action) {
    case 'list':
      if (input.id !== currentTask.id || input.boardId || input.includeArchived) {
        throw new Error('看板 Agent 只能读取当前任务详情');
      }
      return;
    case 'update': {
      const changed = ['title', 'description', 'priority', 'labels', 'dueAt', 'model']
        .some((field) => input[field as keyof TaskboardManageInput] !== undefined);
      if (currentTask.kind === 'advisory' || context.execution.purpose !== 'work'
        || input.id !== currentTask.id || (input.branch === undefined && input.attachments === undefined) || changed) {
        throw new Error('看板 Agent 只能回写当前任务的 branch 或追加附件，且须符合当前工作流能力');
      }
      return;
    }
    case 'move':
      if (context.execution.protocolVersion === 2) {
        throw new Error('当前 Execution 必须通过 execution.finish 完成当前阶段');
      }
      if (input.id !== currentTask.id || context.execution.purpose !== 'review'
        || !['ready_to_merge', 'todo', 'blocked'].includes(input.status ?? '')) {
        throw new Error('只有当前任务的复核 Agent 可以确认待合并、退回待推进或标记阻塞');
      }
      return;
    case 'create':
      if (currentTask.kind === 'advisory' || input.boardId !== currentTask.boardId
        || (input.status !== undefined && input.status !== 'todo')
        || context.execution.purpose === 'review'
        || (context.execution.purpose === 'work' && input.kind !== undefined && input.kind !== 'delivery')
        || (context.execution.purpose === 'merge' && (input.kind !== 'remediation' || !input.sourceId))) {
        throw new Error('当前职责不能创建该后续任务');
      }
      return;
    case 'execute':
      throw new Error('看板 Agent 不能派发已有任务；请用 create + dispatch 创建独立后续 Agent');
    default:
      throw new Error(`看板 Agent 不支持 action=${input.action}`);
  }
}
