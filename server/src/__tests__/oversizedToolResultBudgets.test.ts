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
import {
  EXECUTION_CONTEXT_COMMENTS_LIMIT,
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

  it('omits comments and executions entirely when they were not requested', () => {
    const bounded = applyExecutionContextBudget({ changes: [change(1, { a: 1 })], hasMore: false });
    expect(bounded.comments).toBeUndefined();
    expect(bounded.executions).toBeUndefined();
    expect(bounded.truncation).toBeUndefined();
  });
});
