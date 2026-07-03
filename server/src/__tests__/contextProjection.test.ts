import { describe, expect, it } from 'vitest';

import { buildContextProjection } from '../runtime/contextProjection.js';
import { truncateOldToolResults } from '../runtime/legacyTranscriptProjection.js';
import type { ModelChatMessage, PlatformEvent } from '../runtime/types.js';

function event(index: number, type: 'user_message' | 'assistant_message' = 'user_message'): PlatformEvent {
  return {
    id: `event-${index}`,
    timestamp: new Date(2026, 0, 1, 0, 0, index).toISOString(),
    type,
    runId: `run-${Math.floor(index / 10)}`,
    sessionId: 'session-1',
    content: `${type}-${index}`,
  } as PlatformEvent;
}

describe('context projection', () => {
  it('replays fixed memory context before the first user message', () => {
    const memory = {
      id: 'memory-1',
      timestamp: new Date(2026, 0, 1, 0, 0, 0).toISOString(),
      type: 'memory_context',
      runId: 'run-0',
      sessionId: 'session-1',
      content: '<memory-context>\n[长期记忆]\n记住 A\n</memory-context>',
    } as PlatformEvent;
    const projection = buildContextProjection([memory, event(1)], { sessionId: 'session-1', runId: 'run-x' });

    expect(projection.messages[0]).toEqual({ role: 'user', content: '<memory-context>\n[长期记忆]\n记住 A\n</memory-context>' });
    expect(projection.messages[1]).toMatchObject({ role: 'user', content: 'user_message-1' });
  });

  it('defaults to full replay without creating a summary system message', () => {
    const events = Array.from({ length: 130 }, (_, index) => event(index, index % 2 ? 'assistant_message' : 'user_message'));
    const projection = buildContextProjection(events, { sessionId: 'session-1', runId: 'run-default' });

    expect(projection.policy).toBe('full_replay');
    expect(projection.summaryEvent).toBeUndefined();
    expect(projection.messages).toHaveLength(130);
    expect(projection.messages[0]).toMatchObject({ role: 'user', content: 'user_message-0' });
    expect(projection.messages.at(-1)).toMatchObject({ role: 'assistant', content: 'assistant_message-129' });
  });

  it('supports full replay, recent windows, and manual slices', () => {
    const events = [event(0), event(1, 'assistant_message'), event(2)];

    expect(buildContextProjection(events, { sessionId: 'session-1', runId: 'run-x', policy: { type: 'full_replay' } }).messages)
      .toHaveLength(3);
    expect(buildContextProjection(events, { sessionId: 'session-1', runId: 'run-x', policy: { type: 'recent_window', recentEvents: 1 } }).selectedEvents.map((e) => e.id))
      .toEqual(['event-2']);
    expect(buildContextProjection(events, { sessionId: 'session-1', runId: 'run-x', policy: { type: 'manual_slice', start: 1, end: 3 } }).selectedEvents.map((e) => e.id))
      .toEqual(['event-1', 'event-2']);
  });

  it('truncates older tool results while keeping the most recent ones intact (O2)', () => {
    const big = 'X'.repeat(8000);
    const messages: ModelChatMessage[] = [];
    // 10 个 tool 消息，每条 8000 字符。
    for (let i = 0; i < 10; i++) {
      messages.push({ role: 'tool', tool_call_id: `call-${i}`, content: big });
    }

    const truncated = truncateOldToolResults(messages, { maxChars: 4000, keepRecent: 3 });

    // 倒数 3 条保留原文；前 7 条被截断
    expect(truncated.slice(-3).every((m) => m.role === 'tool' && m.content.length === 8000)).toBe(true);
    expect(truncated.slice(0, -3).every((m) => m.role === 'tool' && m.content.length < 8000 && m.content.includes('已截断'))).toBe(true);
    expect(truncated.slice(0, -3).every((m) => m.role === 'tool' && m.content.includes('call-'))).toBe(true);
  });

  it('truncation is disabled when explicit option says so', () => {
    const big = 'X'.repeat(8000);
    const messages: ModelChatMessage[] = Array.from({ length: 10 }, (_, i) => ({
      role: 'tool' as const,
      tool_call_id: `call-${i}`,
      content: big,
    }));
    const passthrough = truncateOldToolResults(messages, { enabled: false });
    expect(passthrough).toBe(messages); // 引用相等：未做任何 map
  });

  it('supports retrieval augmented slices with a query summary and recent context', () => {
    const events = [event(0), event(1), { ...event(2), content: 'needle in history' }, event(3)];
    const projection = buildContextProjection(events, {
      sessionId: 'session-1',
      runId: 'run-rag',
      policy: { type: 'retrieval_augmented', query: 'needle', recentEvents: 1 },
    });

    expect(projection.messages[0]).toMatchObject({ role: 'user' });
    expect(projection.messages[0]?.content).toContain('needle');
    expect(projection.selectedEvents.map((e) => e.id)).toEqual(['event-2', 'event-3']);
  });
});

describe('compaction 切分（/compact 真实现）', () => {
  function compactionEvent(index: number, summary: string): PlatformEvent {
    return {
      id: `compaction-${index}`,
      timestamp: new Date(2026, 0, 1, 0, 0, index).toISOString(),
      type: 'compaction',
      runId: `run-${Math.floor(index / 10)}`,
      sessionId: 'session-1',
      summary,
      coveredEventCount: index,
    } as PlatformEvent;
  }

  it('以最后一条 compaction 为切分点：之前事件被 summary 替代，之后事件正常重放', () => {
    const events = [
      event(0),
      event(1, 'assistant_message'),
      compactionEvent(2, '早期历史摘要：用户在讨论 A 方案。'),
      event(3),
      event(4, 'assistant_message'),
    ];
    const projection = buildContextProjection(events, { sessionId: 'session-1', runId: 'run-x' });

    expect(projection.messages).toHaveLength(3);
    expect(projection.messages[0]).toMatchObject({ role: 'user' });
    expect(projection.messages[0]?.content).toContain('<context-summary>');
    expect(projection.messages[0]?.content).toContain('早期历史摘要：用户在讨论 A 方案。');
    expect(projection.messages[1]).toMatchObject({ role: 'user', content: 'user_message-3' });
    expect(projection.messages[2]).toMatchObject({ role: 'assistant', content: 'assistant_message-4' });
    // selectedEvents 不含切分点之前的事件
    expect(projection.selectedEvents.map((e) => e.id)).toEqual(['event-3', 'event-4']);
  });

  it('多条 compaction 只认最后一条', () => {
    const events = [
      event(0),
      compactionEvent(1, '第一次摘要'),
      event(2),
      compactionEvent(3, '第二次摘要'),
      event(4),
    ];
    const projection = buildContextProjection(events, { sessionId: 'session-1', runId: 'run-x' });

    expect(projection.messages).toHaveLength(2);
    expect(projection.messages[0]?.content).toContain('第二次摘要');
    expect(projection.messages[0]?.content).not.toContain('第一次摘要');
    expect(projection.messages[1]).toMatchObject({ role: 'user', content: 'user_message-4' });
  });

  it('compaction 之后无新事件时，投影只剩 summary message', () => {
    const events = [event(0), event(1, 'assistant_message'), compactionEvent(2, '全部历史的摘要')];
    const projection = buildContextProjection(events, { sessionId: 'session-1', runId: 'run-x' });

    expect(projection.messages).toHaveLength(1);
    expect(projection.messages[0]?.content).toContain('全部历史的摘要');
    expect(projection.selectedEvents).toHaveLength(0);
  });

  it('recent_window 在切分后的事件集上取窗口，summary 始终在最前', () => {
    const events = [
      event(0),
      compactionEvent(1, '窗口测试摘要'),
      event(2),
      event(3, 'assistant_message'),
      event(4),
    ];
    const projection = buildContextProjection(events, {
      sessionId: 'session-1',
      runId: 'run-x',
      policy: { type: 'recent_window', recentEvents: 1 },
    });

    expect(projection.messages).toHaveLength(2);
    expect(projection.messages[0]?.content).toContain('窗口测试摘要');
    expect(projection.messages[1]).toMatchObject({ role: 'user', content: 'user_message-4' });
    expect(projection.selectedEvents.map((e) => e.id)).toEqual(['event-4']);
  });
});
