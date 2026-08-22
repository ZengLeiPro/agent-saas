import type {
  TaskBoardAttachment,
  TaskBoardComment,
} from '../../../shared/src/types/taskboard.js';
import { formatDateTime } from '../utils/timestamp.js';
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

export function executionWritebackInstructions(context: TaskboardExecutionContext): string[] {
  const instructions = [
    '- 读取任务看板返回的最新事实和结构化职责约束。',
    '- 自主完成当前职责，按需记录重要进展。',
    '- 结束前提交明确、真实且可验证的阶段结果。',
  ];
  if (context.task.kind === 'integration' && context.task.workflowVersion === 3
    && context.execution.purpose === 'work') {
    instructions.splice(2, 0,
      '- 读取 execution.context 的 integrationCandidate；若 revision.compositionComplete=false，必须处理 sourceSnapshots 中完整冻结来源集与 lastError 指定冲突，不得用无关改动或空提交宣称完成。',
      '- 创建单父提交后调用 execution.integration_candidate.push 且只传 commitOid；正常修复以当前 head 为父，基线漂移重建以冻结 base 为父；不得执行 git push。',
      '- 只有完整冻结来源集已纳入结果且受控 push 成功后，才能通过 execution.resolve 提交 ready_for_review。');
  }
  return instructions;
}

export function formatTaskboardComment(
  comment: TaskBoardComment,
  timezone?: string,
  currentAuthorName?: string,
): string {
  const createdAt = new Date(comment.createdAt);
  const timestamp = Number.isNaN(createdAt.getTime())
    ? comment.createdAt
    : formatDateTime(createdAt, timezone);
  const attachments = comment.attachments?.length
    ? `\n附件：\n${formatAttachments(comment.attachments)}`
    : '';
  return `[${timestamp}] ${currentAuthorName || comment.authorName}（${comment.authorType}）\n${comment.body || '（无文字）'}${attachments}`;
}

function formatAttachments(attachments: readonly TaskBoardAttachment[]): string {
  if (attachments.length === 0) return '（无附件）';
  return attachments.map((attachment) => `- ${attachment.originalName}：${attachment.relativePath}`).join('\n');
}
