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
    '- 当前职责完成或确实阻塞时，只调用一次 execution.finish({targetStatus, body})，原子写入明确、真实且可验证的交接评论并指定下一状态；不得使用旧 status 字段。',
  ];
  if (context.execution.purpose === 'work' && context.task.kind !== 'integration') {
    instructions.splice(2, 0,
      '- 登记当前唯一非 Draft PR 后，调用 execution.pull_request.inspect 并等待当前精确 head 的必需 CI 全绿；pending、failure、unknown 均不得提交复核。',
      '- CI 失败时用 execution.pull_request.log 读取 receipt 所列失败 job 日志，在同一分支和原 PR 修复并重新检查；inspection/log 后重新读取最新 context receipt。');
  } else if (context.execution.purpose === 'review' && context.task.kind !== 'integration') {
    instructions.splice(2, 0,
      '- 独立调用 execution.pull_request.inspect 检查当前精确 head/base/subject 与 CI，再登记 reviewed subject 并重新读取最新 context receipt；不得复用 Work 阶段旧结果。',
      '- inspection receipt 与当前 head 全绿是 approved 的服务端硬门禁；pending、failure、unknown 均不得批准。');
  } else if (context.execution.purpose === 'review'
    && context.task.kind === 'integration'
    && context.task.workflowVersion === 3) {
    instructions.splice(2, 0,
      '- 独立调用 execution.pull_request.inspect 检查当前 Integration Agent 的精确 PR/head/base 与 CI；失败 job 用 execution.pull_request.log 读取，随后重新读取最新 context receipt。',
      '- 当前 Review Execution、Integration Agent 当前 PR/head/subject 与全绿 head 绑定的 inspection receipt 是 approved 的服务端硬门禁；pending、failure、unknown 均不得批准。');
  } else if (context.execution.purpose === 'merge'
    && context.task.kind === 'integration'
    && context.task.workflowVersion === 3) {
    instructions.splice(2, 0,
      '- 依次调用 integration.agent.merge 与 integration.agent.cleanup；Merge Gateway 会重读当前 PR/head、审批与 CI，cleanup 会按持久 receipt 对账并清理绑定的来源 PR/branch、integration branch 与任务 worktree。cleanup 成功后才可 execution.finish({targetStatus: "done", body})。不得调用 legacy integration.source.inspect/log/merge。');
  } else if (context.execution.purpose === 'merge') {
    instructions.splice(2, 0,
      '- 合并前必须调用 integration.source.inspect 重新读取当前精确 head、reviewed subject、required checks 与 mergeability；失败 job 用 integration.source.log 读取，Provider 不可用时失败关闭。');
  }
  if (context.task.kind === 'integration' && context.task.workflowVersion === 3) {
    instructions.splice(2, 0,
      '- 这是一个持久的 Integration Agent：先以 GitHub PR、head 与 CI 为唯一代码事实对账，不得相信旧协调状态、revision、lease 或 outbox 字段。',
      '- Work 必须处理 execution.context 中完整冻结来源集；组合来源、修复 CI 和处理 Review 反馈都在同一 integration branch/PR 上完成，不得用无关改动或空提交宣称完成；head 变化后必须重新发起只读 Review。',
      '- 只有当前 Review 对当前 head 的明确批准且 CI 全绿时才请求受控 Merge Gateway；红 CI、过期 review 或 head 变化必须拒绝合并。',
      '- 普通网络、CI 或可修复冲突错误应继续对账和重试，不得把任务置为 blocked。');
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
