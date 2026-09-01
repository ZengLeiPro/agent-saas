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
    '- 读取任务看板返回的最新事实和结构化职责约束；可按当前用户权限只读查询其他看板、任务、评论与 Execution。',
    '- 自主完成当前职责；工作过程中不要写 Agent 进度评论。',
    '- 普通文本回复不会结束当前职责；只有 execution.finish 成功后，当前 Execution 才会正常结束。',
    '- 外部结果 pending 时继续使用工具等待或检查，不得仅说明“等待中”后退出。',
    '- 当前职责完成或确实阻塞时，只调用一次 execution.finish({targetStatus, body})，原子写入明确、真实且可验证的交接评论并指定下一状态；不得使用旧 status 字段。返回最终文本前自检是否已成功调用 execution.finish。',
  ];
  if (context.execution.purpose === 'work' && context.task.kind !== 'integration') {
    instructions.splice(2, 0,
      '- 登记当前唯一非 Draft PR 后，调用 execution.pull_request.inspect 并等待当前精确 head 的必需 CI 全绿；pending、failure、unknown 均不得提交复核。',
      '- CI 失败时用 execution.pull_request.log 读取 receipt 所列失败 job 日志，在同一分支和原 PR 修复并重新检查；inspection/log 后重新读取最新 context receipt。');
  } else if (context.execution.purpose === 'review' && context.task.kind !== 'integration') {
    instructions.splice(2, 0,
      '- 独立调用 execution.pull_request.inspect 检查当前精确 head/base/subject 与 CI，再登记 reviewed subject 并重新读取最新 context receipt；不得复用 Work 阶段旧结果。',
      '- inspection receipt 与当前 head 全绿是 approved 的服务端硬门禁；pending、failure、unknown 均不得批准。');
  }
  if (context.task.kind === 'integration') {
    instructions.splice(2, 0,
      '- 你是本次 Integration 唯一的持久 Agent，负责从读取来源任务到 GitHub 合并、资源清理和任务收口的完整过程；是否创建 integration branch/worktree、采用何种合并方式、是否调用子 Agent，均由你根据现场事实自行决定。',
      '- 直接使用当前运行环境提供的标准 Git 与 GitHub 能力；不要调用 Delivery 专用的 execution.pull_request.* 或 execution.review_subject.record receipt 协议。遵守仓库现有权限、branch protection 和 ruleset，不得把任务范围解释为对其他仓库或无关资源的授权。',
      '- 任何 push、PR、merge、删除等外部操作结果不确定时，必须先重新读取 GitHub 与本地 Git 的实际状态，再决定是否继续，避免重复副作用。',
      '- GitHub 确认合并后，清理本批次拥有的本地 worktree、本地分支、远程分支和临时目录；删除前确认归属且没有未合并提交。全部完成后调用 execution.finish({targetStatus: "done", body})；只有确实需要人工决策或补充条件时才使用 blocked。');
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
