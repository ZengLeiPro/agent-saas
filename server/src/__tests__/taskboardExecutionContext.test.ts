import { describe, expect, it, vi } from 'vitest';

import { loadExecutionContext } from '../taskboard/continuationStore.js';

const taskRow = {
  id: 'task-1',
  board_id: 'board-1',
  identifier: 'TASK-1',
  title: '隔离复核会话',
  description: '每轮复核使用独立上下文',
  status: 'in_review',
  priority: 'high',
  labels: [],
  sort_order: 1024,
  comment_count: 2,
  version: 4,
  created_at: '2026-08-16T08:00:00.000Z',
  updated_at: '2026-08-16T09:00:00.000Z',
};

function executionRow(input: { purpose: 'work' | 'review'; sessionId: string; contextSince: string | null }) {
  return {
    id: `execution-${input.purpose}`,
    task_id: taskRow.id,
    run_id: `run-${input.purpose}`,
    session_id: input.sessionId,
    status: 'queued',
    purpose: input.purpose,
    requested_by: 'user-1',
    created_at: '2026-08-16T09:00:00.000Z',
    updated_at: '2026-08-16T09:00:00.000Z',
    tenant_id: 'tenant-1',
    owner_user_id: 'user-1',
    board_prompt: '按任务要求执行。',
    context_since: input.contextSince,
  };
}

function commentRow(id: string, body: string, createdAt: string) {
  return {
    id,
    task_id: taskRow.id,
    body,
    attachments: [],
    author_type: 'agent',
    author_id: 'run-review-old',
    author_name: 'Agent',
    version: 1,
    created_at: createdAt,
    updated_at: createdAt,
  };
}

function makeHost(row: ReturnType<typeof executionRow>, commentRows: ReturnType<typeof commentRow>[]) {
  const queries: Array<{ statement: string; params: unknown[] }> = [];
  const pool = {
    query: vi.fn(async (statement: string, params: unknown[] = []) => {
      queries.push({ statement, params });
      if (statement.includes('LEFT JOIN LATERAL')) return { rows: [row] };
      if (statement.includes('FROM comments')) return { rows: commentRows };
      if (statement.includes('SELECT t.*')) return { rows: [taskRow] };
      return { rows: [] };
    }),
  };
  const host = {
    pool,
    boardsTable: 'boards',
    tasksTable: 'tasks',
    commentsTable: 'comments',
    executionsTable: 'executions',
    continuationOutboxTable: 'continuation_outbox',
  } as never;
  return { host, queries };
}

describe('任务看板 Execution 上下文注入', () => {
  it('全新 review Session 注入完整任务评论', async () => {
    const rows = [
      commentRow('comment-work', '实施交付', '2026-08-16T08:30:00.000Z'),
      commentRow('comment-user', '补充验收条件', '2026-08-16T08:45:00.000Z'),
    ];
    const { host, queries } = makeHost(executionRow({
      purpose: 'review',
      sessionId: 'review-session-new',
      contextSince: null,
    }), rows);

    const context = await loadExecutionContext(host, 'run-review');

    expect(context).toMatchObject({
      continuation: false,
      execution: { purpose: 'review', sessionId: 'review-session-new' },
    });
    expect(context?.comments.map((comment) => comment.id)).toEqual(['comment-work', 'comment-user']);
    const executionQuery = queries.find(({ statement }) => statement.includes('LEFT JOIN LATERAL'));
    expect(executionQuery?.statement).toContain('prior.session_id=e.session_id');
    const commentsQuery = queries.find(({ statement }) => statement.includes('FROM comments'));
    expect(commentsQuery?.params).toEqual([taskRow.id, null]);
  });

  it('返工 work Session 只补入上轮 work 结束后的复核反馈', async () => {
    const contextSince = '2026-08-16T08:40:00.000Z';
    const rows = [commentRow('comment-review', '复核不通过：补充并发测试', '2026-08-16T08:50:00.000Z')];
    const { host, queries } = makeHost(executionRow({
      purpose: 'work',
      sessionId: 'work-session',
      contextSince,
    }), rows);

    const context = await loadExecutionContext(host, 'run-work');

    expect(context).toMatchObject({
      continuation: true,
      execution: { purpose: 'work', sessionId: 'work-session' },
    });
    expect(context?.comments.map((comment) => comment.id)).toEqual(['comment-review']);
    const commentsQuery = queries.find(({ statement }) => statement.includes('FROM comments'));
    expect(commentsQuery?.statement).toContain('c.created_at >= $2::timestamptz');
    expect(commentsQuery?.params).toEqual([taskRow.id, contextSince]);
  });
});
