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
  if (context.execution.purpose === 'work' && context.task.kind === 'advisory') {
    instructions.splice(2, 0,
      '- Advisory 只完成答复、分析或建议；不得修改代码、创建分支、commit、PR 或实施其他外部变更。',
      '- 完成时按结构化 allowedStatuses 交回 todo；只有确需人工输入或流程无法继续时才 blocked。');
  } else if (context.execution.purpose === 'work'
    && (context.task.kind === 'delivery' || context.task.kind === 'remediation')) {
    instructions.splice(2, 0,
      context.task.kind === 'remediation'
        ? '- Remediation 必须复用关联 Delivery 的原分支、worktree 和 PR，不得创建新的交付链路。'
        : '- 登记当前任务唯一的非 Draft PR，不得重复创建 PR。',
      '- 主动调用 execution.pull_request.inspect 读取当前 PR、准确 head/base、observed checks 以及 workflow runs/jobs/steps；需要定位失败时，对当前 observed workflow 中的 job 调用 execution.pull_request.log。',
      '- pending 是正常等待状态，应等待后重新检查；失败须结合 diff 与日志分类为当前改动、主线公共故障或无关/无适用 job。只有认为交付可由 Review 独立复核时才提交 in_review。',
      '- execution.finish 的 body 必须记录 PR、当前 head、实际执行/观察到的检查、任何例外归因及剩余风险；服务端不会依据 CI、head、mergeability 或 inspection 结果替你作准入判断。');
  } else if (context.execution.purpose === 'review' && context.task.kind !== 'integration') {
    instructions.splice(2, 0,
      '- 独立重读当前 PR、准确 head/base、observed checks、workflow 与 diff，不得复用 Work 的结论；发现 head 变化后必须重新检查新 head。',
      '- 代码或测试失败应退回 todo。红 CI 只有在有直接证据证明属于主线公共故障、与当前改动无关或没有适用 job 时才可例外批准，并在 body 中记录证据、归因和风险；否则正常等待或退回修复。',
      context.task.kind === 'remediation'
        ? '- Remediation 批准时提交 done；服务端不会要求 inspection receipt、review subject、精确 head、mergeability 或全绿检查。'
        : '- Delivery 批准时提交 ready_to_merge；服务端不会要求 inspection receipt、review subject、精确 head、mergeability 或全绿检查。');
  }
  if (context.task.kind === 'integration') {
    instructions.splice(2, 0,
      '- 你是本次 Integration 唯一的持久 Agent，负责读取完整来源、组合代码、解决冲突、最终验证、GitHub 合并、资源清理和任务收口；分支/worktree、合并方式及是否调用子 Agent 由你根据现场事实决定。',
      '- 最终组合完成后，自主读取实际 PR/head/base、observed checks、workflow runs/jobs/steps 与必要失败日志，运行适合仓库的本地验证；pending 正常等待，失败结合组合 diff 和证据处理，不把平台状态当作新增质量门禁。',
      '- 直接使用当前运行环境提供的标准 Git 与 GitHub merge 能力；遵守仓库现有权限、branch protection 和 ruleset，不得把任务范围解释为对其他仓库或无关资源的授权。',
      '- push、PR、merge、删除等外部操作结果不确定时，先重读 GitHub 与本地 Git 实际状态，避免重复副作用。GitHub 确认合并后只清理本批次拥有、无未合并提交且 integrationPolicy 允许删除的资源；deleteRemoteBranch=false 时保留远程分支并记录。全部完成后以 done 收口。');
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
