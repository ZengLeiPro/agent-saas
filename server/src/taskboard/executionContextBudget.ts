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
  /** SQL 层 limit+1 探测到的「还有下一页」。 */
  hasMore: boolean;
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
  const comments = input.comments
    ? keepRecent(input.comments, EXECUTION_CONTEXT_COMMENTS_LIMIT)
    : undefined;
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

  const truncatedComments = input.comments && comments && input.comments.length > comments.length;
  const truncatedExecutions =
    input.executions && executions && input.executions.length > executions.length;
  const truncation: TaskBoardExecutionContextTruncation | undefined =
    summarizedPayloads > 0 || droppedChanges > 0 || truncatedComments || truncatedExecutions
      ? {
          ...(summarizedPayloads > 0 ? { summarizedChangePayloads: summarizedPayloads } : {}),
          ...(droppedChanges > 0 ? { droppedChanges } : {}),
          ...(truncatedComments
            ? { comments: { returned: comments!.length, total: input.comments!.length } }
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
