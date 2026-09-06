import type { TaskboardExecutionContext } from './types.js';

export function buildExecutionPrompt(
  context: TaskboardExecutionContext,
  _timezone?: string,
  _ownerDisplayName?: string,
): string {
  return [
    context.continuation
      ? '任务看板中的任务有了新的输入。'
      : '请处理任务看板中的指定任务。',
    '',
    `taskId: ${context.task.id}`,
    `executionId: ${context.execution.id}`,
    '',
    '开始工作前，请读取该任务的最新上下文，并根据当前职责完成工作和回写。',
  ].join('\n');
}
