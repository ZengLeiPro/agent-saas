import { describe, expect, it } from 'vitest';

import {
  SESSION_EVENT_LIST_MAX_TOTAL_CHARS,
  boundSessionEventList,
} from '../runtime/eventContentBudget.js';
import { MODEL_TOOL_RESULT_MAX_CHARS } from '../runtime/replayEventBounds.js';
import {
  TRANSCRIPT_TOOL_RESULT_MAX_CHARS,
  projectToolResultContentForTranscript,
} from '../runtime/transcriptToolResultBudget.js';
import type { PlatformEvent } from '../runtime/types.js';
import { COMMENT_PREVIEW_CHARS } from '../taskboard/commentQuery.js';
import {
  EXECUTION_CONTEXT_COMMENTS_LIMIT,
  EXECUTION_CONTEXT_COMMENTS_MAX_CHARS,
  EXECUTION_CONTEXT_EXECUTIONS_LIMIT,
  EXECUTION_CONTEXT_MAX_CHARS,
  EXECUTION_CONTEXT_PAYLOAD_MAX_CHARS,
  applyExecutionContextBudget,
} from '../taskboard/executionContextBudget.js';
import type {
  TaskBoardChange,
  TaskBoardComment,
  TaskBoardExecution,
} from '../../../shared/src/types/taskboard.js';

function toolResultEvent(id: string, content: string): PlatformEvent {
  return {
    id,
    timestamp: '2026-09-03T02:36:47.553Z',
    type: 'tool_result',
    runId: 'run-1',
    sessionId: 'session-1',
    toolCallId: `call_${id}`,
    toolName: 'CronManage',
    content,
  } as PlatformEvent;
}

function change(seq: number, payload: Record<string, unknown>): TaskBoardChange {
  return {
    seq: String(seq),
    taskId: 'task-1',
    type: 'pull_request.inspected',
    actorType: 'agent',
    actorId: 'execution-1',
    payload,
    tombstone: false,
    createdAt: '2026-09-01T03:44:49.395Z',
  };
}

/** 复刻生产 payload 形状：小 receipt + 巨大的 workflowRuns/jobs/steps 快照。 */
function inspectedPayload(): Record<string, unknown> {
  return {
    receipt: { inspectionId: 'insp-1', headOid: 'abc123', providerPullRequestId: '346' },
    gateStatus: 'pending',
    snapshot: {
      state: 'open',
      number: 346,
      workflowRuns: Array.from({ length: 40 }, (_, runIndex) => ({
        id: `run-${runIndex}`,
        jobs: Array.from({ length: 10 }, (_, jobIndex) => ({
          id: `job-${runIndex}-${jobIndex}`,
          steps: Array.from({ length: 12 }, (_, stepIndex) => ({
            number: stepIndex,
            name: `step ${stepIndex} of job ${jobIndex}`,
            status: 'completed',
            conclusion: 'success',
          })),
        })),
      })),
    },
  };
}

describe('transcript tool_result budget', () => {
  it('leaves content within budget byte-identical', () => {
    const content = 'x'.repeat(TRANSCRIPT_TOOL_RESULT_MAX_CHARS);
    expect(projectToolResultContentForTranscript(content, 'call_1')).toBe(content);
  });

  it('keeps head and tail windows and points at the durable full text', () => {
    const content = `HEAD${'m'.repeat(6_000_000)}TAIL`;
    const projected = projectToolResultContentForTranscript(content, 'call_1');

    expect(projected.length).toBeLessThan(TRANSCRIPT_TOOL_RESULT_MAX_CHARS + 500);
    expect(projected.startsWith('HEAD')).toBe(true);
    expect(projected.endsWith('TAIL')).toBe(true);
    expect(projected).toContain(`共 ${content.length} 字符`);
    expect(projected).toContain('SessionContext(action="trace", toolCallId="call_1")');
  });
});

describe('session event list budget', () => {
  it('projects oversized tool_result content without dropping events', () => {
    const events = [toolResultEvent('a', 'small'), toolResultEvent('b', 'y'.repeat(5_000_000))];

    const bounded = boundSessionEventList(events);

    expect(bounded).toHaveLength(2);
    expect((bounded[0] as { content: string }).content).toBe('small');
    const big = (bounded[1] as { content: string }).content;
    expect(big.length).toBeLessThan(MODEL_TOOL_RESULT_MAX_CHARS + 200);
    expect(big).toContain('SessionContext');
  });

  it('narrows every event further when the page still exceeds the total budget', () => {
    const events = Array.from({ length: 200 }, (_, index) =>
      toolResultEvent(String(index), 'z'.repeat(100_000)),
    );

    const bounded = boundSessionEventList(events);

    expect(bounded).toHaveLength(200);
    const total = bounded.reduce((sum, event) => sum + JSON.stringify(event).length, 0);
    // 逐条等额收窄后允许截断标记带来的固定开销，但必须远小于未收口时的 20MB 量级。
    expect(total).toBeLessThan(SESSION_EVENT_LIST_MAX_TOTAL_CHARS * 2);
  });

  it('leaves non tool_result events untouched', () => {
    const event = {
      id: 'x',
      type: 'run_started',
      runId: 'r',
      sessionId: 's',
    } as unknown as PlatformEvent;
    expect(boundSessionEventList([event])[0]).toBe(event);
  });
});

describe('execution context budget', () => {
  it('summarizes oversized change payloads and keeps small ones intact', () => {
    const small = change(1, { providerPullRequestId: '346', number: 346 });
    const bounded = applyExecutionContextBudget({
      changes: [small, change(2, inspectedPayload())],
      hasMore: false,
    });

    expect(bounded.changes[0]!.payload).toEqual(small.payload);
    const summarized = bounded.changes[1]!.payload;
    expect(JSON.stringify(summarized).length).toBeLessThan(EXECUTION_CONTEXT_PAYLOAD_MAX_CHARS);
    // 小字段留原样，巨型 snapshot 换成省略说明。
    expect(summarized.receipt).toEqual({
      inspectionId: 'insp-1',
      headOid: 'abc123',
      providerPullRequestId: '346',
    });
    expect(summarized.gateStatus).toBe('pending');
    expect(String(summarized.snapshot)).toMatch(/^\[已省略 \d+ 字符的对象\]$/);
    expect(bounded.truncation?.summarizedChangePayloads).toBe(1);
  });

  it('stops at the total budget and moves the cursor to the last returned change', () => {
    const changes = Array.from({ length: 421 }, (_, index) =>
      change(index + 1, { blob: 'q'.repeat(3_000) }),
    );

    const bounded = applyExecutionContextBudget({ changes, hasMore: false });

    expect(bounded.changes.length).toBeLessThan(changes.length);
    expect(JSON.stringify(bounded.changes).length).toBeLessThanOrEqual(EXECUTION_CONTEXT_MAX_CHARS);
    // 升序向前翻页：游标必须停在最后一条已返回的 change 上，下一页才不会出现空洞。
    expect(bounded.nextCursor).toBe(bounded.changes[bounded.changes.length - 1]!.seq);
    expect(bounded.hasMore).toBe(true);
    expect(bounded.truncation?.droppedChanges).toBe(changes.length - bounded.changes.length);
  });

  it('preserves the upstream cursor semantics when nothing is dropped', () => {
    const bounded = applyExecutionContextBudget({
      changes: [change(1, { a: 1 }), change(2, { b: 2 })],
      hasMore: true,
    });

    expect(bounded.changes).toHaveLength(2);
    expect(bounded.nextCursor).toBe('2');
    expect(bounded.hasMore).toBe(true);
    expect(bounded.truncation).toBeUndefined();
  });

  it('caps comments and executions to the most recent entries', () => {
    const comments = Array.from(
      { length: EXECUTION_CONTEXT_COMMENTS_LIMIT + 42 },
      (_, index) => ({ id: `c${index}`, body: `comment ${index}` }) as unknown as TaskBoardComment,
    );
    const executions = Array.from(
      { length: EXECUTION_CONTEXT_EXECUTIONS_LIMIT + 7 },
      (_, index) => ({ runId: `r${index}` }) as unknown as TaskBoardExecution,
    );

    const bounded = applyExecutionContextBudget({
      changes: [],
      comments,
      executions,
      hasMore: false,
    });

    expect(bounded.comments).toHaveLength(EXECUTION_CONTEXT_COMMENTS_LIMIT);
    expect(bounded.comments![bounded.comments!.length - 1]).toBe(comments[comments.length - 1]);
    expect(bounded.executions).toHaveLength(EXECUTION_CONTEXT_EXECUTIONS_LIMIT);
    expect(bounded.truncation?.comments).toEqual({
      returned: EXECUTION_CONTEXT_COMMENTS_LIMIT,
      total: comments.length,
    });
    expect(bounded.truncation?.executions).toEqual({
      returned: EXECUTION_CONTEXT_EXECUTIONS_LIMIT,
      total: executions.length,
    });
  });

  it('digests the oldest comment bodies once comments exceed their own budget', () => {
    const comments = Array.from({ length: 40 }, (_, index) => ({
      id: `c${index}`,
      taskId: 'task-1',
      body: `阶段报告 ${index}：${'详'.repeat(4_000)}`,
      authorType: 'agent',
      authorId: 'agent-1',
      authorName: 'agent',
      version: 1,
      createdAt: '2026-09-06T00:00:00.000Z',
      updatedAt: '2026-09-06T00:00:00.000Z',
    }) as unknown as TaskBoardComment);

    const bounded = applyExecutionContextBudget({
      changes: [],
      comments,
      commentTotal: comments.length,
      hasMore: false,
    });

    expect(JSON.stringify(bounded.comments).length).toBeLessThanOrEqual(EXECUTION_CONTEXT_COMMENTS_MAX_CHARS);
    // 最新一条必须留全文，被降级的只能是更旧的。
    expect(bounded.comments![bounded.comments!.length - 1]!.body).toBe(comments[comments.length - 1]!.body);
    expect(bounded.comments![0]!.body).toHaveLength(COMMENT_PREVIEW_CHARS);
    expect(bounded.comments![0]!.bodyTruncated).toBe(true);
    expect(bounded.truncation?.comments?.total).toBe(comments.length);
    expect(bounded.truncation?.comments?.digested).toBeGreaterThan(0);
  });

  it('keeps the newest comment bodies when the input is already mostly digest rows', () => {
    // execution.context 默认形状：SQL 已把除最近 keep 条外的评论截成 200 字目录行。
    // 若降级循环不保护尾部窗口，唯一 body>200 的「最新一条」反而会被砍掉。
    const digestRow = (index: number) => ({
      id: `c${index}`,
      taskId: 'task-1',
      sessionId: `session-${index}`,
      executionId: `execution-${index}`,
      executionPurpose: 'work',
      body: '详'.repeat(200),
      bodyChars: 4_000,
      bodyTruncated: true,
      ordinal: index + 1,
      authorType: 'agent',
      authorId: 'agent-1',
      authorName: 'agent',
      version: 1,
      createdAt: '2026-09-06T00:00:00.000Z',
      updatedAt: '2026-09-06T00:00:00.000Z',
    }) as unknown as TaskBoardComment;
    const fullRow = (index: number) => ({
      ...digestRow(index),
      body: '详'.repeat(4_000),
      bodyChars: 4_000,
      bodyTruncated: undefined,
    }) as unknown as TaskBoardComment;

    for (const total of [100, 150, 200]) {
      const comments = [
        ...Array.from({ length: total - 1 }, (_, index) => digestRow(index)),
        fullRow(total - 1),
      ];
      const bounded = applyExecutionContextBudget({
        changes: [], comments, commentTotal: total, keepFullComments: 1, hasMore: false,
      });
      const newest = bounded.comments![bounded.comments!.length - 1]!;
      expect(newest.id).toBe(`c${total - 1}`);
      expect(newest.body).toHaveLength(4_000);
      expect(newest.bodyTruncated).toBeUndefined();
      expect(JSON.stringify(bounded.comments).length)
        .toBeLessThanOrEqual(EXECUTION_CONTEXT_COMMENTS_MAX_CHARS + newest.body.length);
      expect(bounded.truncation?.comments?.total).toBe(total);
      // 目录行总量超预算时，只能丢最旧的，不能动最新一条。
      if (total >= 150) expect(bounded.truncation?.comments?.droppedByBudget).toBeGreaterThan(0);
    }

    // commentLimit=3 时，末尾三条都必须留全文。
    const comments = [
      ...Array.from({ length: 197 }, (_, index) => digestRow(index)),
      fullRow(197), fullRow(198), fullRow(199),
    ];
    const bounded = applyExecutionContextBudget({
      changes: [], comments, commentTotal: 200, keepFullComments: 3, hasMore: false,
    });
    expect(bounded.comments!.slice(-3).every((comment) => comment.body.length === 4_000)).toBe(true);
  });

  it('omits comments and executions entirely when they were not requested', () => {
    const bounded = applyExecutionContextBudget({ changes: [change(1, { a: 1 })], hasMore: false });
    expect(bounded.comments).toBeUndefined();
    expect(bounded.executions).toBeUndefined();
    expect(bounded.truncation).toBeUndefined();
  });
});
