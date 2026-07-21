import { describe, expect, it } from 'vitest';

import { buildContextProjection, extractUserMessageTrail, renderUserMessageTrail } from '../runtime/contextProjection.js';
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
  it('模型请求诊断事件不进入 replay 或 retrieval_augmented 上下文', () => {
    const diagnostic = {
      id: 'diagnostic-1',
      timestamp: '2026-01-01T00:00:00.000Z',
      type: 'model_request_finished',
      runId: 'run-x',
      sessionId: 'session-1',
      diagnostic: {
        type: 'finished',
        modelRequestId: 'private-model-request-id',
        attemptId: 'attempt-1',
        attempt: 1,
        outcome: 'eof_without_terminal',
        durationMs: 10,
      },
    } as PlatformEvent;
    const events = [event(1), diagnostic, event(2, 'assistant_message')];

    const full = buildContextProjection(events, { sessionId: 'session-1', runId: 'run-y' });
    expect(full.selectedEvents.map((item) => item.id)).toEqual(['event-1', 'event-2']);
    const retrieved = buildContextProjection(events, {
      sessionId: 'session-1',
      runId: 'run-y',
      policy: { type: 'retrieval_augmented', query: 'private-model-request-id', recentEvents: 0 },
    });
    expect(JSON.stringify(retrieved.messages)).not.toContain('private-model-request-id');
  });

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

  it('keeps context replay identical when replay-heavy runtime events are omitted', () => {
    const base: PlatformEvent[] = [
      {
        id: 'event-1',
        timestamp: '2026-01-01T00:00:01.000Z',
        type: 'user_message',
        runId: 'run-x',
        sessionId: 'session-1',
        content: 'run a command',
      },
      {
        id: 'event-2',
        timestamp: '2026-01-01T00:00:02.000Z',
        type: 'assistant_tool_calls',
        runId: 'run-x',
        sessionId: 'session-1',
        content: '',
        toolCalls: [{ id: 'call-1', name: 'Shell', arguments: '{"cmd":"echo ok"}' }],
      },
      {
        id: 'event-3',
        timestamp: '2026-01-01T00:00:03.000Z',
        type: 'tool_result',
        runId: 'run-x',
        sessionId: 'session-1',
        toolCallId: 'call-1',
        toolName: 'Shell',
        content: 'ok',
      },
      {
        id: 'event-4',
        timestamp: '2026-01-01T00:00:04.000Z',
        type: 'assistant_message',
        runId: 'run-x',
        sessionId: 'session-1',
        content: 'done',
      },
    ];
    const noisy: PlatformEvent[] = [
      base[0]!,
      {
        id: 'noise-1',
        timestamp: '2026-01-01T00:00:01.500Z',
        type: 'assistant_stream_event',
        runId: 'run-x',
        sessionId: 'session-1',
        blockType: 'text',
        phase: 'delta',
        content: 'ignored',
      },
      base[1]!,
      {
        id: 'noise-2',
        timestamp: '2026-01-01T00:00:02.500Z',
        type: 'tool_output_delta',
        runId: 'run-x',
        sessionId: 'session-1',
        invocationId: 'inv-1',
        toolCallId: 'call-1',
        content: 'chunk',
      },
      {
        id: 'noise-3',
        timestamp: '2026-01-01T00:00:02.600Z',
        type: 'tool_progress',
        runId: 'run-x',
        sessionId: 'session-1',
        invocationId: 'inv-1',
        toolCallId: 'call-1',
        content: '50%',
      },
      base[2]!,
      base[3]!,
    ];

    expect(buildContextProjection(noisy, { sessionId: 'session-1', runId: 'run-next' }).messages).toEqual(
      buildContextProjection(base, { sessionId: 'session-1', runId: 'run-next' }).messages,
    );
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

  it('caps recent tool results individually and all tool results cumulatively', () => {
    const messages: ModelChatMessage[] = Array.from({ length: 40 }, (_, i) => ({
      role: 'tool' as const,
      tool_call_id: `call-${i}`,
      content: 'X'.repeat(30_000),
    }));
    const truncated = truncateOldToolResults(messages);
    const toolChars = truncated.reduce((sum, message) => (
      message.role === 'tool' ? sum + message.content.length : sum
    ), 0);
    expect(toolChars).toBeLessThanOrEqual(96_000);
    const last = truncated.at(-1);
    expect(last?.role === 'tool' ? last.content.length : Infinity).toBeLessThanOrEqual(16_000);
    expect(truncated.every((message) => message.role !== 'tool' || message.content.length <= 16_000)).toBe(true);
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

  it('在 compaction/recent window 丢弃历史位置后恢复已加载 MCP 真实工具定义', () => {
    const loaded = {
      id: 'loaded-1',
      timestamp: '2026-01-01T00:00:01.000Z',
      type: 'mcp_tools_loaded',
      runId: 'run-1',
      sessionId: 'session-1',
      execution: 'server',
      paths: ['mcp_github.mcp__github__get_issue'],
      tools: [{
        id: 'mcp__github__get_issue',
        name: 'mcp__github__get_issue',
        description: '读取 issue',
        parameters: { type: 'object', properties: {} },
        deferLoading: true,
        mcpServer: {
          serverName: 'github', namespace: 'mcp_github', displayName: 'GitHub', description: 'GitHub',
        },
      }],
    } as PlatformEvent;
    const compacted = {
      id: 'compaction-mcp',
      timestamp: '2026-01-01T00:00:02.000Z',
      type: 'compaction',
      runId: 'run-compact',
      sessionId: 'session-1',
      summary: '已读取过 GitHub issue。',
      coveredEventCount: 1,
    } as PlatformEvent;
    const after = { ...event(3), content: '继续处理这个 issue' };

    const projection = buildContextProjection([loaded, compacted, after], {
      sessionId: 'session-1',
      runId: 'run-next',
    });
    expect(projection.messages.map((message) => message.role)).toEqual([
      'user', 'additional_tools', 'user',
    ]);
    expect(projection.messages[1]).toMatchObject({
      role: 'additional_tools',
      tools: [expect.objectContaining({ name: 'mcp__github__get_issue' })],
    });

    const recent = buildContextProjection([loaded, event(2), after], {
      sessionId: 'session-1',
      runId: 'run-next',
      policy: { type: 'recent_window', recentEvents: 1 },
    });
    expect(recent.messages.map((message) => message.role)).toEqual(['additional_tools', 'user']);
  });
});

describe('compaction 切分（/compact 真实现）', () => {
  // 真实形态：compact run 是独立 runId，不与普通消息 run 混用
  function compactionEvent(index: number, summary: string, cutoffEventId?: string): PlatformEvent {
    return {
      id: `compaction-${index}`,
      timestamp: new Date(2026, 0, 1, 0, 0, index).toISOString(),
      type: 'compaction',
      runId: `run-compact-${index}`,
      sessionId: 'session-1',
      summary,
      coveredEventCount: index,
      ...(cutoffEventId ? { cutoffEventId } : {}),
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

  it('v2 保留窗口：cutoffEventId 之前被摘要替代，之后原文重放且剔除 compact run 自身事件', () => {
    const compactRunUserMessage = {
      id: 'event-compact-cmd',
      timestamp: new Date(2026, 0, 1, 0, 0, 6).toISOString(),
      type: 'user_message',
      runId: 'run-compact-7',
      sessionId: 'session-1',
      content: '/compact',
      modelContent: '[系统命令] 用户请求压缩会话上下文（/compact）。',
    } as PlatformEvent;
    const events = [
      event(0),                          // 被压缩
      event(1, 'assistant_message'),     // 被压缩
      event(2),                          // cutoff：从这里开始保留
      event(3, 'assistant_message'),
      event(4),
      event(5, 'assistant_message'),
      compactRunUserMessage,             // compact run 替身：必须剔除
      compactionEvent(7, '早期摘要正文', 'event-2'),
      event(8),                          // 压缩后新消息
    ];
    const projection = buildContextProjection(events, { sessionId: 'session-1', runId: 'run-x' });

    // summary + 保留窗口 4 条 + 压缩后 1 条
    expect(projection.messages).toHaveLength(6);
    const summary = projection.messages[0]!;
    expect(summary.role).toBe('user');
    expect(summary.content).toContain('<context-summary>');
    expect(summary.content).toContain('早期摘要正文');
    // 用户消息轨迹：仅被压缩段的用户消息（event-0），不含保留窗口内的（event-2/4）
    expect(summary.content).toContain('<user-message-trail>');
    expect(summary.content).toContain('user_message-0');
    expect(summary.content).not.toContain('user_message-2');
    // 末尾三件套提醒
    expect(summary.content).toContain('SessionSearchEvents');
    expect(summary.content).toContain('SessionGetToolTrace');
    // 保留窗口原文重放
    expect(projection.messages[1]).toMatchObject({ role: 'user', content: 'user_message-2' });
    expect(projection.messages[4]).toMatchObject({ role: 'assistant', content: 'assistant_message-5' });
    expect(projection.messages[5]).toMatchObject({ role: 'user', content: 'user_message-8' });
    // compact run 替身不出现在任何投影消息中
    expect(projection.messages.some((m) => typeof m.content === 'string' && m.content.includes('/compact'))).toBe(false);
    expect(projection.messages.some((m) => typeof m.content === 'string' && m.content.includes('[系统命令]'))).toBe(false);
  });

  it('cutoffEventId 指向不存在的事件时退化为以 compaction 自身为切分点', () => {
    const events = [
      event(0),
      event(1, 'assistant_message'),
      compactionEvent(2, '摘要正文', 'event-missing'),
      event(3),
    ];
    const projection = buildContextProjection(events, { sessionId: 'session-1', runId: 'run-x' });

    expect(projection.messages).toHaveLength(2);
    expect(projection.messages[0]?.content).toContain('摘要正文');
    expect(projection.messages[1]).toMatchObject({ role: 'user', content: 'user_message-3' });
  });
});

describe('用户消息轨迹（抽取式，非 LLM 转述）', () => {
  it('extractUserMessageTrail 只取真实用户消息，剔除系统命令替身与空消息', () => {
    const events = [
      event(0),
      event(1, 'assistant_message'),
      {
        ...event(2),
        modelContent: '[系统命令] 用户请求压缩会话上下文（/compact）。',
      } as PlatformEvent,
      { ...event(3), content: '   ' } as PlatformEvent,
      event(4),
    ];
    const trail = extractUserMessageTrail(events);
    expect(trail.map((t) => t.content)).toEqual(['user_message-0', 'user_message-4']);
  });

  it('单条超长保头保尾截断，并标注省略字数', () => {
    const long = `${'头'.repeat(450)}${'尾'.repeat(150)}`; // 600 字符
    const rendered = renderUserMessageTrail([
      { timestamp: new Date(2026, 5, 1, 10, 30).toISOString(), content: long },
    ]);
    expect(rendered).toContain('<user-message-trail>');
    expect(rendered).toContain('[06-01 10:30]');
    expect(rendered).toContain('已省略 100 字'); // 600 - 400 - 100
    // 尾部保留
    expect(rendered).toContain('尾尾尾');
  });

  it('总量超预算降级为「首条 + 最近若干条」并标注省略条数', () => {
    const items = Array.from({ length: 40 }, (_, i) => ({
      timestamp: new Date(2026, 0, 1, 0, i).toISOString(),
      content: `消息${i}-${'x'.repeat(300)}`,
    }));
    const rendered = renderUserMessageTrail(items);
    expect(rendered.length).toBeLessThan(9500); // 8000 预算 + 包装文本余量
    expect(rendered).toContain('消息0-');       // 首条保留
    expect(rendered).toContain('消息39-');      // 最新保留
    expect(rendered).toMatch(/中间省略 \d+ 条用户消息/);
  });

  it('空轨迹渲染为空字符串（摘要块不出现空 trail 段）', () => {
    expect(renderUserMessageTrail([])).toBe('');
  });
});
