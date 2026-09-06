import { COMMENT_PREVIEW_CHARS, digestComment } from './commentQuery.js';
import type {
  TaskBoardChange,
  TaskBoardComment,
  TaskBoardExecution,
  TaskBoardExecutionContextTruncation,
} from '../../../shared/src/types/taskboard.js';

/**
 * execution.context 过去只有条数上限（changes ≤ 500，comments/executions 完全不限），
 * 没有任何字节预算。历史 `pull_request.inspected` 事件把整份 GitHub PR 快照
 * （workflowRuns → jobs → steps 全展开，单条约 25KB）存进任务事件流，于是
 * historyMode="full" 一次就返回过 4,873,793 字符，落进事件日志和 transcript 各一份，
 * 而模型侧最终只吃 8,000 字符。
 *
 * 这里补三层收口：单条 payload 摘要化、总字符预算、comments/executions 条数上限。
 * 事件与评论原文都留在库里，不做任何删改。
 */
export const EXECUTION_CONTEXT_MAX_CHARS = 200_000;
export const EXECUTION_CONTEXT_PAYLOAD_MAX_CHARS = 4_000;
export const EXECUTION_CONTEXT_NESTED_KEEP_CHARS = 1_000;
export const EXECUTION_CONTEXT_STRING_KEEP_CHARS = 200;
export const EXECUTION_CONTEXT_COMMENTS_LIMIT = 200;
/**
 * 评论正文过去只有条数上限、不受总字符预算约束（预算先减去评论字节再分给 changes，
 * 评论自身永不裁剪）。单条 execution.finish body 上限 20,000 字符，200 条封顶时
 * 仍可达数 MB，因此这里给评论单独设预算。
 *
 * 注意两个常量的关系：目录行单条 JSON 约 500~700 字符，200 条就已经 10 万字符以上，
 * 所以**字符预算才是真正的约束**，EXECUTION_CONTEXT_COMMENTS_LIMIT 只是上界。
 * 收缩顺序固定为：先降级旧的全文 → 再丢弃最旧的目录行 → 最后才动受保护的最新窗口，
 * 保证「最近一条全文」在任何规模下都还在。
 */
export const EXECUTION_CONTEXT_COMMENTS_MAX_CHARS = 60_000;
export const EXECUTION_CONTEXT_EXECUTIONS_LIMIT = 100;

function jsonChars(value: unknown): number {
  return JSON.stringify(value)?.length ?? 0;
}

/** 保留顶层标量与小对象，省略大字段；用于单条 change payload 超预算时。 */
function summarizePayload(payload: Record<string, unknown>): Record<string, unknown> {
  const summarized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (value === null || typeof value === 'number' || typeof value === 'boolean') {
      summarized[key] = value;
      continue;
    }
    if (typeof value === 'string') {
      summarized[key] =
        value.length <= EXECUTION_CONTEXT_STRING_KEEP_CHARS
          ? value
          : `${value.slice(0, EXECUTION_CONTEXT_STRING_KEEP_CHARS)}…[共 ${value.length} 字符]`;
      continue;
    }
    const chars = jsonChars(value);
    summarized[key] =
      chars <= EXECUTION_CONTEXT_NESTED_KEEP_CHARS
        ? value
        : `[已省略 ${chars} 字符的${Array.isArray(value) ? '数组' : '对象'}]`;
  }
  return summarized;
}

function projectChange(change: TaskBoardChange): { change: TaskBoardChange; summarized: boolean } {
  if (jsonChars(change.payload) <= EXECUTION_CONTEXT_PAYLOAD_MAX_CHARS) {
    return { change, summarized: false };
  }
  return {
    change: {
      ...change,
      payload: {
        ...summarizePayload(change.payload),
        __truncated:
          '单条事件 payload 超出上下文预算；CI 与 PR 现状请调用 execution.pull_request.inspect 取实时快照。',
      },
    },
    summarized: true,
  };
}

/** 只保留最近 N 条，顺序维持原有升序。 */
function keepRecent<T>(items: T[], limit: number): T[] {
  return items.length <= limit ? items : items.slice(items.length - limit);
}

export interface ExecutionContextBudgetInput {
  changes: TaskBoardChange[];
  comments?: TaskBoardComment[];
  executions?: TaskBoardExecution[];
  /** 任务当前可见评论总数；SQL 层已截断时用于报告真实规模。 */
  commentTotal?: number;
  /** 末尾必须保留全文的评论条数（execution.context 的 commentLimit）；至少 1。 */
  keepFullComments?: number;
  /** SQL 层 limit+1 探测到的「还有下一页」。 */
  hasMore: boolean;
}

/**
 * 评论收敛到自身预算内，返回结果与预算动作计数。
 *
 * 关键：默认路径下 SQL 已把除最新一条外的评论截成目录行，数组里唯一的全文正是
 * 「最近一条」。若不保护尾部窗口，降级循环会跳过所有目录行、直接把它降级掉——
 * 恰好牺牲本特性承诺保留的那条。故顺序为：先降级受保护窗口之前的全文，再从最旧
 * 开始丢弃，最后才在窗口自身仍超预算时降级窗口内较旧的条目。
 */
function fitCommentsBudget(
  comments: TaskBoardComment[],
  keepFullComments: number,
): { comments: TaskBoardComment[]; digested: number; dropped: number } {
  const fitted = [...comments];
  const sizes = fitted.map(jsonChars);
  let used = sizes.reduce((sum, size) => sum + size, 0);
  let digested = 0;
  let dropped = 0;
  const overBudget = () => used > EXECUTION_CONTEXT_COMMENTS_MAX_CHARS;
  const degrade = (index: number): void => {
    const comment = fitted[index]!;
    if (comment.bodyTruncated) return;
    const next = digestComment(comment);
    if (next.body.length === comment.body.length) return;
    const size = jsonChars(next);
    used += size - sizes[index]!;
    fitted[index] = next;
    sizes[index] = size;
    digested += 1;
  };

  const keep = Math.max(1, keepFullComments);
  for (let index = 0; index < fitted.length - keep && overBudget(); index += 1) degrade(index);
  while (fitted.length > keep && overBudget()) {
    used -= sizes[0]!;
    fitted.shift();
    sizes.shift();
    dropped += 1;
  }
  for (let index = 0; index < fitted.length - 1 && overBudget(); index += 1) degrade(index);
  // 只剩最新一条却仍超预算（单条正文本身超大）：降级它，模型可用 comment.get 取原文。
  if (fitted.length === 1 && overBudget()) degrade(0);
  return { comments: fitted, digested, dropped };
}

export interface ExecutionContextBudgetResult {
  changes: TaskBoardChange[];
  comments?: TaskBoardComment[];
  executions?: TaskBoardExecution[];
  hasMore: boolean;
  nextCursor?: string;
  truncation?: TaskBoardExecutionContextTruncation;
}

export function applyExecutionContextBudget(
  input: ExecutionContextBudgetInput,
): ExecutionContextBudgetResult {
  const fittedComments = input.comments
    ? fitCommentsBudget(
      keepRecent(input.comments, EXECUTION_CONTEXT_COMMENTS_LIMIT),
      input.keepFullComments ?? 1,
    )
    : undefined;
  const comments = fittedComments?.comments;
  const executions = input.executions
    ? keepRecent(input.executions, EXECUTION_CONTEXT_EXECUTIONS_LIMIT)
    : undefined;

  let budget = EXECUTION_CONTEXT_MAX_CHARS - jsonChars(comments) - jsonChars(executions);
  const changes: TaskBoardChange[] = [];
  let summarizedPayloads = 0;
  let droppedChanges = 0;

  for (const source of input.changes) {
    const { change, summarized } = projectChange(source);
    const size = jsonChars(change);
    // changes 按 seq 升序向前翻页，截掉尾部等价于少返回一页的一部分，
    // 下一次带 nextCursor 从截断处继续，不会产生空洞。
    if (changes.length > 0 && size > budget) {
      droppedChanges = input.changes.length - changes.length;
      break;
    }
    if (summarized) summarizedPayloads += 1;
    changes.push(change);
    budget -= size;
  }

  const commentTotal = input.commentTotal ?? input.comments?.length ?? 0;
  const digestedComments = comments?.filter((comment) => comment.bodyTruncated).length ?? 0;
  const droppedByBudget = fittedComments?.dropped ?? 0;
  const truncatedComments = Boolean(comments) && (commentTotal > comments!.length || digestedComments > 0);
  const truncatedExecutions =
    input.executions && executions && input.executions.length > executions.length;
  const truncation: TaskBoardExecutionContextTruncation | undefined =
    summarizedPayloads > 0 || droppedChanges > 0 || truncatedComments || truncatedExecutions
      ? {
          ...(summarizedPayloads > 0 ? { summarizedChangePayloads: summarizedPayloads } : {}),
          ...(droppedChanges > 0 ? { droppedChanges } : {}),
          ...(truncatedComments
            ? {
                comments: {
                  returned: comments!.length,
                  total: commentTotal,
                  ...(digestedComments > 0 ? { digested: digestedComments } : {}),
                  ...(droppedByBudget > 0 ? { droppedByBudget } : {}),
                },
              }
            : {}),
          ...(truncatedExecutions
            ? { executions: { returned: executions!.length, total: input.executions!.length } }
            : {}),
        }
      : undefined;

  const lastSeq = changes[changes.length - 1]?.seq;
  return {
    changes,
    ...(comments ? { comments } : {}),
    ...(executions ? { executions } : {}),
    hasMore: input.hasMore || droppedChanges > 0,
    ...((input.hasMore || droppedChanges > 0) && lastSeq ? { nextCursor: lastSeq } : {}),
    ...(truncation ? { truncation } : {}),
  };
}
