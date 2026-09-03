import { describe, expect, it, vi } from 'vitest';

import { buildContextProjection } from '../runtime/contextProjection.js';
import { buildRuntimeReplayState } from '../runtime/replay.js';
import {
  buildMeasuredContextProjection,
  IncrementalRuntimeReplayLoader,
  logRuntimeModelRequest,
  selectCheckpointReplayWindow,
} from '../runtime/replayEventWindow.js';
import type { EventStore, PlatformEvent } from '../runtime/types.js';

const SESSION = 'session-replay-window';

function event(sequence: number, value: Record<string, unknown>): PlatformEvent {
  return {
    timestamp: `2026-09-04T00:00:${String(sequence).padStart(2, '0')}.000Z`,
    sessionId: SESSION,
    sequence,
    ...value,
  } as unknown as PlatformEvent;
}

function checkpointEvents(): PlatformEvent[] {
  return [
    event(1, {
      id: 'start-old',
      type: 'run_started',
      runId: 'run-old',
      model: 'm',
      channel: 'web',
    }),
    event(2, { id: 'user-old', type: 'user_message', runId: 'run-old', content: '旧用户目标' }),
    event(3, {
      id: 'assistant-old',
      type: 'assistant_message',
      runId: 'run-old',
      content: '旧回复',
    }),
    event(4, {
      id: 'catalog',
      type: 'mcp_tool_catalog_snapshot',
      runId: 'run-old',
      loadingMode: 'openai_responses_hosted',
      tools: [],
    }),
    event(5, {
      id: 'rewind-old',
      type: 'context_rewind',
      runId: 'run-old',
      reason: 'invalid_prompt_request_blocked',
      message: '自动回退上一工具交互并继续',
      sourceModelRequestId: 'request-old',
      sourceAttemptId: 'attempt-old',
      excludedEventIds: ['assistant-old'],
      excludedToolCallIds: [],
      excludedStartSequence: 3,
      excludedEndSequence: 3,
      createdAt: '2026-09-04T00:00:05.000Z',
      recoveryAttempt: 1,
    }),
    event(6, {
      id: 'tail-user',
      type: 'user_message',
      runId: 'run-active',
      content: '继续当前工作',
    }),
    event(7, {
      id: 'tail-assistant',
      type: 'assistant_message',
      runId: 'run-active',
      content: '正在继续',
    }),
    event(8, {
      id: 'checkpoint',
      type: 'compaction',
      runId: 'run-active',
      summary: '旧工作已完成一半。',
      coveredEventCount: 5,
      cutoffEventId: 'tail-user',
      inline: true,
      checkpoint: {
        version: 1,
        trigger: 'threshold',
        sourceRunId: 'run-active',
        targetTokens: 10_000,
        summaryBudgetTokens: 1_000,
        summaryObservedTokens: 20,
        rawTailBudgetTokens: 5_000,
        rawTailObservedTokens: 20,
        fixedTokens: 200,
        taskAnchors: [
          {
            eventId: 'user-old',
            timestamp: '2026-09-04T00:00:02.000Z',
            text: '旧用户目标',
            originalChars: 5,
          },
        ],
      },
    }),
  ];
}

describe('checkpoint replay window', () => {
  it('只保留 checkpoint 前的语义前缀和 cutoff 后尾部，模型投影与全量事件一致', () => {
    const full = checkpointEvents();
    const selected = selectCheckpointReplayWindow(full);

    expect(selected.events.map((item) => item.id)).toEqual([
      'user-old',
      'catalog',
      'rewind-old',
      'tail-user',
      'tail-assistant',
      'checkpoint',
    ]);
    expect(selected).toMatchObject({
      checkpointEventId: 'checkpoint',
      cutoffSequence: 6,
      prefixEventCount: 3,
      tailEventCount: 3,
    });
    expect(
      buildContextProjection(selected.events, { sessionId: SESSION, runId: 'run-next' }).messages,
    ).toEqual(buildContextProjection(full, { sessionId: SESSION, runId: 'run-next' }).messages);
  });

  it('最新 compaction 缺少 checkpoint 或 cutoff 不可解析时保持全量，禁止猜测截断', () => {
    const legacy = event(9, {
      id: 'legacy',
      type: 'compaction',
      runId: 'compact-run',
      summary: 'legacy',
      coveredEventCount: 8,
    });
    const missingCutoff = checkpointEvents().map((item) =>
      item.id === 'checkpoint' ? ({ ...item, cutoffEventId: 'missing' } as PlatformEvent) : item,
    );

    expect(selectCheckpointReplayWindow([...checkpointEvents(), legacy]).events).toHaveLength(9);
    expect(selectCheckpointReplayWindow(missingCutoff).events).toHaveLength(missingCutoff.length);
  });

  it('checkpoint 尾部保留未闭合工具与审批恢复事实', () => {
    const active = [
      ...checkpointEvents(),
      event(9, {
        id: 'active-call',
        type: 'assistant_tool_calls',
        runId: 'run-active',
        content: '',
        toolCalls: [{ id: 'shell-call', name: 'Shell', arguments: '{}' }],
      }),
      event(10, {
        id: 'active-invocation',
        type: 'tool_invocation_started',
        runId: 'run-active',
        invocationId: 'run-active:shell-call',
        toolCallId: 'shell-call',
        toolName: 'Shell',
        executionTarget: 'server-remote',
      }),
      event(11, {
        id: 'active-approval',
        type: 'approval_requested',
        runId: 'run-active',
        approvalId: 'approval-1',
        toolCallId: 'shell-call',
        toolId: 'Shell',
        toolName: 'Shell',
        input: {},
      }),
    ];
    const selected = selectCheckpointReplayWindow(active).events;

    expect(selected.slice(-3).map((item) => item.id)).toEqual([
      'active-call',
      'active-invocation',
      'active-approval',
    ]);
    expect(buildRuntimeReplayState(selected, [], SESSION).unclosedToolCalls).toEqual(
      buildRuntimeReplayState(active, [], SESSION).unclosedToolCalls,
    );
  });

  it('同一 run 后续只拉增量；出现新 checkpoint 后重建有界窗口', async () => {
    const initial = checkpointEvents();
    const delta = event(9, {
      id: 'delta',
      type: 'assistant_message',
      runId: 'run-active',
      content: '增量',
    });
    const compacted = [
      ...initial,
      delta,
      event(10, {
        id: 'checkpoint-2',
        type: 'compaction',
        runId: 'run-active',
        summary: '再次压缩',
        coveredEventCount: 8,
        cutoffEventId: 'delta',
        inline: true,
        checkpoint: {
          version: 1,
          trigger: 'threshold',
          sourceRunId: 'run-active',
          targetTokens: 10_000,
          summaryBudgetTokens: 1_000,
          summaryObservedTokens: 20,
          rawTailBudgetTokens: 5_000,
          rawTailObservedTokens: 20,
          fixedTokens: 200,
          taskAnchors: [],
        },
      }),
    ];
    const snapshots = [
      {
        events: selectCheckpointReplayWindow(initial).events,
        cursor: '8',
        stats: {
          strategy: 'checkpoint',
          totalEventCount: 8,
          selectedEventCount: 6,
          prefixEventCount: 3,
          tailEventCount: 3,
        },
      },
      {
        events: selectCheckpointReplayWindow(compacted).events,
        cursor: '10',
        stats: {
          strategy: 'checkpoint',
          totalEventCount: 10,
          selectedEventCount: 5,
          prefixEventCount: 3,
          tailEventCount: 2,
        },
      },
    ];
    expect(
      buildContextProjection(snapshots[1]!.events, { sessionId: SESSION, runId: 'run-next' })
        .messages,
    ).toEqual(
      buildContextProjection(compacted, { sessionId: SESSION, runId: 'run-next' }).messages,
    );
    const list = vi.fn(async (_tenantId, _sessionId, options) => {
      const snapshot = snapshots.shift()!;
      options.replayStats?.({ ...snapshot.stats, cursor: snapshot.cursor });
      return snapshot.events;
    });
    const listPage = vi
      .fn()
      .mockResolvedValueOnce({ events: [delta], hasMore: false })
      .mockResolvedValueOnce({ events: [compacted.at(-1)!], hasMore: false });
    const store = { list, listPage } as unknown as EventStore;
    const loader = new IncrementalRuntimeReplayLoader({
      eventStore: store,
      tenantId: 'tenant',
      sessionId: SESSION,
      runId: 'run-active',
      excludeTypes: [],
    });

    expect((await loader.load('start')).at(-1)?.id).toBe('checkpoint');
    expect((await loader.load('delta')).at(-1)?.id).toBe('delta');
    expect((await loader.load('compact')).at(-1)?.id).toBe('checkpoint-2');
    expect(list).toHaveBeenCalledTimes(2);
    expect(listPage).toHaveBeenCalledTimes(2);
  });

  it('把上下文投影和模型请求字节按同一 run 记录为可关联的阶段指标', () => {
    const info = vi.fn();
    const diagnostics = { sessionId: SESSION, runId: 'run-active', logger: { info } };
    const projection = buildMeasuredContextProjection(
      checkpointEvents(),
      {
        sessionId: SESSION,
        runId: 'run-active',
      },
      diagnostics,
    );
    logRuntimeModelRequest(diagnostics, {
      type: 'started',
      modelRequestId: 'request-1',
      attemptId: 'attempt-1',
      attempt: 1,
      clientRequestId: 'client-1',
      model: 'test-model',
      protocol: 'responses',
      responseMode: 'full',
      outputTransactionMode: 'irreversible_stream',
      maxOutputTokens: 1_000,
      requestBodyBytes: 12_345,
      toolsCount: 4,
      hasPreviousResponseId: false,
    });

    expect(projection.messages.length).toBeGreaterThan(0);
    expect(info).toHaveBeenCalledTimes(2);
    expect(info.mock.calls[0]![0]).toContain('[RuntimeReplayProjection]');
    expect(info.mock.calls[0]![0]).toContain('"projectionBytes":');
    expect(info.mock.calls[1]![0]).toContain('[RuntimeModelRequest]');
    expect(info.mock.calls[1]![0]).toContain('"requestBodyBytes":12345');
  });
});
