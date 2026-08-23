import { describe, expect, it } from 'vitest';

import { estimateContextTokens } from '../runtime/contextBreakdown.js';
import {
  buildBoundedInitialCompactionMessages,
  planContextCheckpoint,
  planContinuousCheckpointInput,
} from '../runtime/contextCheckpoint.js';
import { buildContextProjection } from '../runtime/contextProjection.js';
import type { ContextCheckpointMetadata, PlatformEvent } from '../runtime/types.js';

const base = {
  timestamp: '2026-08-07T05:00:00.000Z',
  sessionId: 'session-1',
};

function user(id: string, content: string, runId = 'run-active'): PlatformEvent {
  return { ...base, id, type: 'user_message', runId, content } as PlatformEvent;
}

function checkpoint(
  id: string,
  metadata: ContextCheckpointMetadata,
  summary = '任务仍在进行',
): PlatformEvent {
  return {
    ...base,
    id,
    type: 'compaction',
    runId: metadata.sourceRunId ?? 'run-compact',
    summary,
    coveredEventCount: 1,
    inline: true,
    checkpoint: metadata,
  } as PlatformEvent;
}

function metadata(overrides: Partial<ContextCheckpointMetadata>): ContextCheckpointMetadata {
  return {
    version: 1,
    trigger: 'threshold',
    sourceRunId: 'run-active',
    targetTokens: 10_000,
    summaryBudgetTokens: 2_000,
    summaryObservedTokens: 10,
    rawTailBudgetTokens: 0,
    rawTailObservedTokens: 0,
    fixedTokens: 2_000,
    taskAnchors: [],
    ...overrides,
  };
}

function anchorBlock(events: PlatformEvent[], cap?: number): string {
  const projection = buildContextProjection(events, {
    sessionId: 'session-1',
    runId: 'run-active',
    ...(cap === undefined ? {} : { checkpointUserHistoryTokenCap: cap }),
  });
  const content = String(projection.messages[0]?.content ?? '');
  return content.match(/<active-task-messages>[\s\S]*?<\/active-task-messages>/u)?.[0] ?? '';
}

describe('context checkpoint 返工边界', () => {
  it('首条 anchor 超限时保留最新纠正，极低 cap 不突破上限', () => {
    const first = `初始目标：${'旧约束'.repeat(4_000)}`;
    const latest = '最新纠正：绝对不要部署';
    const events = [
      user('anchor-first', first),
      user('anchor-latest', latest),
      checkpoint('checkpoint-anchor', metadata({
        taskAnchors: [
          { eventId: 'anchor-first', timestamp: base.timestamp, text: first, originalChars: first.length },
          { eventId: 'anchor-latest', timestamp: base.timestamp, text: latest, originalChars: latest.length },
        ],
        summaryAudit: {
          model: 'test',
          promptDigest: 'digest',
          validation: { schemaVersion: 1, valid: true, presentSectionCount: 7, missingSections: [], maintenanceInstructionAttributedToUser: false },
          userHistoryTokenCap: 1_000,
        },
      })),
    ];

    const normal = anchorBlock(events);
    expect(normal).toContain('eventId=anchor-first');
    expect(normal).toContain('eventId=anchor-latest');
    expect(normal).toContain(latest);

    const tiny = anchorBlock(events, 80);
    expect(estimateContextTokens(tiny)).toBeLessThanOrEqual(80);
    expect(tiny).toContain('eventId=anchor-latest');
    expect(anchorBlock(events, 0)).toBe('');
  });

  it('checkpoint memory 在当前请求隐藏、resume 恢复，且不与较新 raw memory 重复', () => {
    const oldMemory = '长期约束：禁止公开发布';
    const cp = checkpoint('checkpoint-memory', metadata({
      memorySnapshot: `<memory_context>${oldMemory}</memory_context>`,
    }));
    const resumed = buildContextProjection([cp], { sessionId: 'session-1', runId: 'run-active' });
    const current = buildContextProjection([cp], {
      sessionId: 'session-1',
      runId: 'run-active',
      excludeMemoryContext: true,
    });
    expect(resumed.messages[0]?.content).toContain(oldMemory);
    expect(current.messages[0]?.content).not.toContain(oldMemory);

    const newer = {
      ...base,
      id: 'memory-new',
      type: 'memory_context',
      runId: 'run-next',
      content: '<memory_context>最新约束：允许内部预览</memory_context>',
    } as PlatformEvent;
    const withNewer = buildContextProjection([cp, newer], { sessionId: 'session-1', runId: 'run-next' });
    const combined = JSON.stringify(withNewer.messages);
    expect(combined).toContain('最新约束：允许内部预览');
    expect(combined).not.toContain(oldMemory);
  });

  it('跨模型连续压缩使用当前更小 cap 收缩旧 checkpoint', () => {
    const text = `旧大窗口任务：${'完整历史'.repeat(20_000)}`;
    const events = [
      user('anchor-old', text),
      checkpoint('checkpoint-old', metadata({
        targetTokens: 100_000,
        fixedTokens: 60_000,
        taskAnchors: [{ eventId: 'anchor-old', timestamp: base.timestamp, text, originalChars: text.length }],
        summaryAudit: {
          model: 'large-model',
          promptDigest: 'digest',
          validation: { schemaVersion: 1, valid: true, presentSectionCount: 7, missingSections: [], maintenanceInstructionAttributedToUser: false },
          userHistoryTokenCap: 60_000,
        },
      }), '旧摘要'),
    ];
    const anchors = anchorBlock(events, 1_000);
    expect(estimateContextTokens(anchors)).toBeLessThanOrEqual(1_000);
    expect(anchors).not.toContain(text);
  });

  it('连续压缩把旧 checkpoint 纳入摘要切片，避免重放超长 append-only 前缀', () => {
    const oldUserText = `旧用户轨迹：${'历史约束'.repeat(12_000)}`;
    const oldAssistantText = `超长旧输出：${'中间推理'.repeat(100_000)}`;
    const oldCheckpoint = { ...checkpoint('checkpoint-old-large', metadata({
      targetTokens: 100_000,
      fixedTokens: 60_000,
      taskAnchors: [{
        eventId: 'old-user',
        timestamp: base.timestamp,
        text: oldUserText,
        originalChars: oldUserText.length,
      }],
      summaryAudit: {
        model: 'large-model',
        promptDigest: 'digest',
        validation: { schemaVersion: 1, valid: true, presentSectionCount: 7, missingSections: [], maintenanceInstructionAttributedToUser: false },
        userHistoryTokenCap: 60_000,
      },
    }), `旧 checkpoint 摘要：${'摘要事实'.repeat(8_000)}`), cutoffEventId: 'old-user' } as PlatformEvent;
    const newerAssistantText = `checkpoint 后超长输出：${'新增结论'.repeat(80_000)}`;
    const events = [
      user('old-user', oldUserText),
      { ...base, id: 'old-assistant', type: 'assistant_message', runId: 'run-old', content: oldAssistantText } as PlatformEvent,
      oldCheckpoint,
      { ...base, id: 'newer-assistant', type: 'assistant_message', runId: 'run-active', content: newerAssistantText } as PlatformEvent,
      {
        ...base,
        id: 'large-mcp',
        type: 'mcp_tools_loaded',
        runId: 'run-active',
        execution: 'server',
        paths: ['mcp_large.tool'],
        tools: [{ id: 'large-tool', name: 'large-tool', description: '超长工具定义'.repeat(40_000), parameters: {} }],
      } as PlatformEvent,
      { ...user('latest-correction', '最新纠正必须保留'), runId: 'run-active' } as PlatformEvent,
    ];
    const plan = planContextCheckpoint({
      events,
      contextWindow: 16_000,
      thresholdTokens: 12_800,
      baseFixedTokens: 1_000,
      sourceRunId: 'run-active',
    });

    expect(plan.rawTailStartIndex).toBe(events.length);
    expect(plan.rawTailStartEventId).toBeUndefined();
    const compressedEvents = events.slice(0, plan.rawTailStartIndex);
    const preservingOldTail = buildContextProjection(compressedEvents, {
      sessionId: 'session-1',
      runId: 'run-active',
      checkpointUserHistoryTokenCap: plan.userHistoryTokenCap,
    });
    expect(estimateContextTokens(preservingOldTail.messages)).toBeGreaterThan(16_000);

    const payloadBudget = Math.max(
      0,
      16_000 - 1_000 - plan.userHistoryTokenCap - plan.summaryBudgetTokens - 1_024,
    );
    const continuousInput = planContinuousCheckpointInput(compressedEvents, payloadBudget);
    const projection = buildContextProjection(compressedEvents, {
      sessionId: 'session-1',
      runId: 'run-active',
      excludeMemoryContext: true,
      checkpointUserHistoryTokenCap: plan.userHistoryTokenCap,
      checkpointSummaryTokenCap: continuousInput.summaryTokenCap,
      checkpointRetainedStartIndex: continuousInput.retainedStartIndex,
      collapseCheckpointRawTail: true,
    });
    const serialized = JSON.stringify(projection.messages);
    expect(estimateContextTokens(projection.messages) + 1_000 + plan.summaryBudgetTokens).toBeLessThanOrEqual(16_000);
    expect(serialized).toContain('旧 checkpoint 摘要');
    expect(serialized).toContain('最新纠正必须保留');
    expect(serialized).not.toContain('超长旧输出');
    expect(serialized).not.toContain('checkpoint 后超长输出');
    expect(serialized).not.toContain('large-tool');
  });

  it('普通 checkpoint replay 不恢复未被 retained tool interaction 使用的超大 MCP schema', () => {
    const largeMcp = {
      ...base,
      id: 'normal-replay-large-mcp',
      type: 'mcp_tools_loaded',
      runId: 'run-old',
      execution: 'server',
      paths: ['mcp_large.unused'],
      tools: [{ id: 'unused', name: 'mcp_large.unused', description: '超大 schema'.repeat(80_000), parameters: {} }],
    } as PlatformEvent;
    const normalCheckpoint = checkpoint('normal-checkpoint', metadata({}), '已完成旧工具调查。');
    const projection = buildContextProjection([
      largeMcp,
      normalCheckpoint,
      { ...user('normal-latest', '继续处理，但不再调用旧工具'), runId: 'run-next' } as PlatformEvent,
    ], { sessionId: 'session-1', runId: 'run-next' });

    expect(estimateContextTokens(projection.messages)).toBeLessThan(2_000);
    expect(projection.messages.some((message) => message.role === 'additional_tools')).toBe(false);
    expect(JSON.stringify(projection.messages)).toContain('继续处理');

    const usedCall = {
      ...base,
      id: 'used-large-call',
      type: 'assistant_tool_calls',
      runId: 'run-next',
      content: '',
      toolCalls: [{ id: 'used-call-id', name: 'mcp_large.unused', arguments: '{}' }],
    } as PlatformEvent;
    const usedResult = {
      ...base,
      id: 'used-large-result',
      type: 'tool_result',
      runId: 'run-next',
      toolCallId: 'used-call-id',
      toolName: 'mcp_large.unused',
      content: '结果已消费',
    } as PlatformEvent;
    const usedProjection = buildContextProjection([
      largeMcp, normalCheckpoint, usedCall, usedResult,
    ], { sessionId: 'session-1', runId: 'run-next' });
    expect(estimateContextTokens(usedProjection.messages)).toBeLessThan(2_000);
    expect(usedProjection.messages.map((message) => message.role)).toEqual(['user']);
    expect(JSON.stringify(usedProjection.messages)).not.toContain('used-call-id');
  });

  it('首次压缩把单个超大原子输出降级为有界摘录并保留首条目标与最新纠正', () => {
    const events = [
      {
        ...user('initial-goal', '首条目标：分析所有方案'),
        runId: 'run-active',
        attachments: [{ attachmentId: 'attachment-1', originalName: '方案数据.xlsx' }],
      } as PlatformEvent,
      {
        ...base,
        id: 'huge-first-output',
        type: 'assistant_message',
        runId: 'run-active',
        content: `超长输出开头：${'中间结论'.repeat(120_000)}：超长输出结尾`,
      } as PlatformEvent,
      { ...user('latest-fix', '最新纠正：只保留 B 方案'), runId: 'run-active' } as PlatformEvent,
    ];
    expect(estimateContextTokens(buildContextProjection(events, {
      sessionId: 'session-1', runId: 'run-active',
    }).messages)).toBeGreaterThan(300_000);

    const bounded = buildBoundedInitialCompactionMessages(events, 8_000);
    const serialized = JSON.stringify(bounded);
    expect(estimateContextTokens(bounded)).toBeLessThanOrEqual(8_000);
    expect(serialized).toContain('首条目标');
    expect(serialized).toContain('attachment-1');
    expect(serialized).toContain('最新纠正');
    expect(serialized).toContain('超长输出开头');
    expect(serialized).toContain('超长输出结尾');
  });

  it('连续压缩同样收缩无 checkpoint 元数据的存量 compaction', () => {
    const legacyUser = user('legacy-user', `存量用户轨迹：${'旧约束'.repeat(20_000)}`);
    const legacyEvents = [
      legacyUser,
      { ...base, id: 'legacy-assistant', type: 'assistant_message', content: '旧输出'.repeat(100_000) } as PlatformEvent,
      {
        ...base,
        id: 'legacy-compaction',
        type: 'compaction',
        runId: 'run-compact',
        summary: `存量摘要：${'旧事实'.repeat(10_000)}`,
        cutoffEventId: 'legacy-user',
        coveredEventCount: 2,
      } as PlatformEvent,
      user('legacy-latest', '存量后的最新纠正'),
    ];
    const payloadBudget = 8_000;
    const continuousInput = planContinuousCheckpointInput(legacyEvents, payloadBudget);
    const projection = buildContextProjection(legacyEvents, {
      sessionId: 'session-1',
      runId: 'run-active',
      excludeMemoryContext: true,
      checkpointUserHistoryTokenCap: 2_000,
      checkpointSummaryTokenCap: continuousInput.summaryTokenCap,
      checkpointRetainedStartIndex: continuousInput.retainedStartIndex,
      collapseCheckpointRawTail: true,
    });
    const serialized = JSON.stringify(projection.messages);
    expect(estimateContextTokens(projection.messages)).toBeLessThanOrEqual(11_024);
    expect(serialized).toContain('存量摘要');
    expect(serialized).toContain('存量后的最新纠正');
    expect(serialized).not.toContain('旧输出旧输出');
  });
});
