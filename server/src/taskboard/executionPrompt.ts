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

export function executionWritebackInstructions(_context: TaskboardExecutionContext): string[] {
  return [
    '- 读取任务看板返回的最新事实和结构化职责约束。',
    '- 自主完成当前职责，按需记录重要进展。',
    '- 结束前提交明确、真实且可验证的阶段结果。',
  ];
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
