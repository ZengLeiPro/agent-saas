import { describe, expect, it } from 'vitest';

import { buildContextProjection, extractUserMessageTrail, renderUserMessageTrail } from '../runtime/contextProjection.js';
import { MODEL_TOOL_RESULT_MAX_CHARS } from '../runtime/replayEventBounds.js';
import type { PlatformEvent } from '../runtime/types.js';

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

  it('工具结果首次投影后保持稳定，追加事件不改写历史前缀', () => {
    const toolResult = (index: number): PlatformEvent => ({
      id: `tool-result-${index}`,
      timestamp: new Date(2026, 0, 1, 0, 0, index).toISOString(),
      type: 'tool_result',
      runId: 'run-tools',
      sessionId: 'session-1',
      toolCallId: `call-${index}`,
      toolName: 'Shell',
      content: `${index}:${'X'.repeat(30_000)}`,
    });
    const firstEvents = [toolResult(0)];
    const firstProjection = buildContextProjection(firstEvents, {
      sessionId: 'session-1',
      runId: 'run-tools',
    });
    const extendedProjection = buildContextProjection([
      ...firstEvents,
      ...Array.from({ length: 20 }, (_, index) => toolResult(index + 1)),
    ], {
      sessionId: 'session-1',
      runId: 'run-tools',
    });

    expect(firstProjection.messages[0]?.role).toBe('tool');
    expect(firstProjection.messages[0]?.role === 'tool'
      ? firstProjection.messages[0].content.length
      : Infinity).toBe(MODEL_TOOL_RESULT_MAX_CHARS);
    expect(extendedProjection.messages.slice(0, firstProjection.messages.length))
      .toEqual(firstProjection.messages);
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
    expect(summary.content).toContain('SessionContext(action="search")');
    expect(summary.content).toContain('SessionContext(action="trace")');
    // 保留窗口原文重放
    expect(projection.messages[1]).toMatchObject({ role: 'user', content: 'user_message-2' });
    expect(projection.messages[4]).toMatchObject({ role: 'assistant', content: 'assistant_message-5' });
    expect(projection.messages[5]).toMatchObject({ role: 'user', content: 'user_message-8' });
    // compact run 替身不出现在任何投影消息中
    expect(projection.messages.some((m) => typeof m.content === 'string' && m.content.includes('/compact'))).toBe(false);
    expect(projection.messages.some((m) => typeof m.content === 'string' && m.content.includes('[系统命令]'))).toBe(false);
  });

  it('内联自动压缩保留与 compaction 同 run 的最近一轮业务原文', () => {
    const currentUser = { ...event(2), runId: 'run-inline' } as PlatformEvent;
    const currentAssistant = { ...event(3, 'assistant_message'), runId: 'run-inline' } as PlatformEvent;
    const inlineCompaction = {
      ...compactionEvent(4, '较早历史摘要', 'event-2'),
      runId: 'run-inline',
      inline: true,
    } as PlatformEvent;
    const projection = buildContextProjection([
      event(0),
      event(1, 'assistant_message'),
      currentUser,
      currentAssistant,
      inlineCompaction,
    ], { sessionId: 'session-1', runId: 'run-inline' });

    expect(projection.messages).toHaveLength(3);
    expect(projection.messages[0]?.content).toContain('较早历史摘要');
    expect(projection.messages[1]).toMatchObject({ role: 'user', content: 'user_message-2' });
    expect(projection.messages[2]).toMatchObject({ role: 'assistant', content: 'assistant_message-3' });
  });

  it('checkpoint 在 source run 未终态时激活续跑，终态后保留为 historical 因果记录', () => {
    const checkpoint = {
      id: 'checkpoint-1',
      timestamp: '2026-08-07T05:00:03.000Z',
      type: 'compaction',
      runId: 'run-active',
      sessionId: 'session-1',
      summary: '已经读取配置，下一步修改代码。',
      coveredEventCount: 2,
      inline: true,
      checkpoint: {
        version: 1,
        trigger: 'threshold',
        sourceRunId: 'run-active',
        targetTokens: 40_000,
        summaryBudgetTokens: 8_000,
        summaryObservedTokens: 100,
        rawTailBudgetTokens: 20_000,
        rawTailObservedTokens: 0,
        fixedTokens: 12_000,
        taskAnchors: [{
          eventId: 'event-0',
          timestamp: '2026-08-07T05:00:00.000Z',
          text: '修复配置问题',
          originalChars: 6,
        }],
      },
    } as PlatformEvent;
    const active = buildContextProjection([
      { ...event(0), runId: 'run-active', content: '修复配置问题' } as PlatformEvent,
      event(1, 'assistant_message'),
      checkpoint,
    ], { sessionId: 'session-1', runId: 'run-active' });
    expect(active.messages[0]?.content).toContain('state="active"');
    expect(active.messages[0]?.content).toContain('<resume-policy>');
    expect(active.messages[0]?.content).toContain('修复配置问题');

    const historical = buildContextProjection([
      { ...event(0), runId: 'run-active', content: '修复配置问题' } as PlatformEvent,
      event(1, 'assistant_message'),
      checkpoint,
      {
        id: 'finish-1',
        timestamp: '2026-08-07T05:00:04.000Z',
        type: 'run_finished',
        runId: 'run-active',
        sessionId: 'session-1',
        subtype: 'success',
        numTurns: 3,
      } as PlatformEvent,
    ], { sessionId: 'session-1', runId: 'run-next' });
    expect(historical.messages[0]?.content).toContain('state="historical"');
    expect(historical.messages[0]?.content).not.toContain('<resume-policy>');
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

  it('单条超长保头保尾截断，并保留 eventId、原文字数和检索说明', () => {
    const long = `${'头'.repeat(450)}${'尾'.repeat(150)}`; // 600 字符
    const trail = extractUserMessageTrail([{ ...event(9), content: long } as PlatformEvent]);
    const rendered = renderUserMessageTrail(trail);
    expect(rendered).toContain('<user-message-trail>');
    expect(rendered).toContain('eventId=event-9');
    expect(rendered).toContain('原文 600 字');
    expect(rendered).toContain('已省略 100 字');
    expect(rendered).toContain('尾尾尾');
  });

  it('消息总量很大时仍逐条列出，不静默省略中间用户消息', () => {
    const events = Array.from({ length: 40 }, (_, i) => ({
      ...event(i),
      content: `消息${i}-${'x'.repeat(300)}`,
    } as PlatformEvent));
    const rendered = renderUserMessageTrail(extractUserMessageTrail(events));
    for (let i = 0; i < 40; i += 1) {
      expect(rendered).toContain(`eventId=event-${i}`);
      expect(rendered).toContain(`消息${i}-`);
    }
    expect(rendered).not.toContain('中间省略');
  });

  it('空轨迹渲染为空字符串（摘要块不出现空 trail 段）', () => {
    expect(renderUserMessageTrail([])).toBe('');
  });
});
