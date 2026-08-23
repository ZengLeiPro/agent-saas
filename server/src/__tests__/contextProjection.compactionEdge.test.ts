import { describe, expect, it } from 'vitest';

import { estimateContextTokens } from '../runtime/contextBreakdown.js';
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
});
