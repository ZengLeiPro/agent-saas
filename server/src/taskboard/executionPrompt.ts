import type {
  TaskBoardAttachment,
  TaskBoardComment,
} from '../../../shared/src/types/taskboard.js';
import { formatDateTime } from '../utils/timestamp.js';
import type { TaskboardExecutionContext } from './types.js';

export function buildExecutionPrompt(
  context: TaskboardExecutionContext,
  timezone?: string,
  ownerDisplayName?: string,
): string {
  const task = context.task;
  const recentComments = context.comments.slice(-50);
  const comments = recentComments.length > 0
    ? recentComments.map((comment) => formatTaskboardComment(
        comment,
        timezone,
        comment.authorType === 'user' && comment.authorId === context.identity.ownerUserId
          ? ownerDisplayName
          : undefined,
      )).join('\n\n')
    : '（暂无评论）';
  return [
    '看板提示语：', context.boardPrompt || '（无）', '',
    `任务：${task.identifier} · ${task.title}`,
    `任务记录 ID：${task.id}`,
    `执行类型：${context.execution.purpose === 'review' ? '独立复核' : '实施'}`,
    `工作分支：${task.branch ?? '未填写'}`,
    `优先级：${task.priority}`,
    `标签：${task.labels.length > 0 ? task.labels.join('、') : '无'}`,
    `截止时间：${task.dueAt ?? '无'}`, '',
    '任务看板回写：', ...executionWritebackInstructions(context), '',
    '任务正文：', task.description || '（无正文）', '',
    '任务附件：', formatAttachments(task.attachments ?? []), '',
    `${context.continuation ? '本次新增评论' : '最近评论'}（${recentComments.length}/${context.comments.length}）：`,
    comments,
  ].join('\n');
}

export function executionWritebackInstructions(context: TaskboardExecutionContext): string[] {
  const taskId = context.task.id;
  const boardId = context.task.boardId;
  const common = [
    `- 创建或确认工作分支后，调用 CronManage：target=taskboard, action=update, id=${taskId}, branch=<分支名>。`,
    `- 需要独立的后续复核、返工或合并时，用 target=taskboard, action=create, boardId=${boardId}, status=todo, dispatch=true 创建并派发新任务。`,
  ];
  if (context.execution.purpose !== 'review') {
    return [...common, '- 实施成功后不要标记 done；系统会把仍在进行中的任务送入待复核。'];
  }
  return [
    ...common,
    '- 本次只做独立复核，不顺手修改交付。',
    `- 复核通过：调用 CronManage：target=taskboard, action=move, id=${taskId}, status=done。`,
    `- 复核不通过：调用 CronManage：target=taskboard, action=move, id=${taskId}, status=todo；最终回执列明返工项。`,
    '- 无法明确判定时不要移动状态；系统会把任务放回待复核。',
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
