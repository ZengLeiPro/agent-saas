import type { RunContext } from '../runtime/types.js';
import type { TaskboardExecutionStore } from './types.js';

export const TASKBOARD_UNFINISHED_EXECUTION_PROMPT = [
  '[任务看板运行时可信控制指令]',
  '当前任务看板职责尚未通过 execution.finish 完成交接；普通文本不会结束当前职责。',
  '请继续自主执行。等待外部结果时，继续使用现有工具等待、检查或管理后台任务。',
  '只有当前职责完成或确实需要人工处理时，才调用一次 execution.finish({ targetStatus, body })。',
].join('\n');

export function createTaskboardSuccessfulCompletionCheck(
  store: Pick<TaskboardExecutionStore, 'getExecutionContextByRunId'> | undefined,
  runId: string,
): RunContext['checkSuccessfulCompletion'] | undefined {
  if (!store) return undefined;
  return async () => {
    const context = await store.getExecutionContextByRunId(runId);
    if (!context || context.execution.protocolVersion !== 2 || context.execution.transitionedAt) {
      return { action: 'allow' };
    }
    if (['succeeded', 'failed', 'cancelled'].includes(context.execution.status)) {
      return {
        action: 'reject',
        error: `taskboard execution reached ${context.execution.status} before successful completion handoff`,
      };
    }
    return { action: 'continue', prompt: TASKBOARD_UNFINISHED_EXECUTION_PROMPT };
  };
}
