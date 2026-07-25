import { describe, expect, it } from 'vitest';

import type { ApiSessionDetail } from '../types/session';
import { mapSessionDetailToMessages } from './sessionsApi';

function createAskUserDetail(result: string): ApiSessionDetail {
  return {
    sessionId: 'session-ask-user',
    stats: { lines: 2, parsedLines: 2, parseErrors: 0 },
    blocks: [
      {
        id: 'ask-user-call',
        kind: 'tool_use',
        title: '工具调用: AskUserQuestion',
        defaultOpen: false,
        content: JSON.stringify({
          questions: [
            {
              question: '选哪个方案？',
              header: '方案',
              options: [],
              multiSelect: false,
            },
            {
              question: '需要哪些能力？',
              header: '能力',
              options: [],
              multiSelect: true,
            },
          ],
        }),
        toolName: 'AskUserQuestion',
        toolId: 'call-ask-user',
      },
      {
        id: 'ask-user-result',
        kind: 'tool_result',
        title: '结果',
        defaultOpen: false,
        content: result,
        toolName: 'AskUserQuestion',
        toolId: 'call-ask-user',
      },
    ],
  };
}

describe('AskUserQuestion history restore', () => {
  it('restores single-select and multi-select answers from raw runtime JSON results', () => {
    const detail = createAskUserDetail(JSON.stringify({
      answers: {
        '选哪个方案？': '方案 A',
        '需要哪些能力？': ['知识库', '定时任务'],
      },
      schemaNote: 'For questions with multiSelect=true, the answer may be a comma-separated list.',
    }));

    expect(mapSessionDetailToMessages(detail)).toEqual([expect.objectContaining({
      type: 'ask_user',
      status: 'answered',
      answers: {
        '选哪个方案？': '方案 A',
        '需要哪些能力？': ['知识库', '定时任务'],
      },
    })]);
  });

  it('keeps restoring legacy SDK text results', () => {
    const detail = createAskUserDetail(
      'User has answered your questions: "选哪个方案？"="方案 B", "需要哪些能力？"="知识库, 搜索". You can now continue.',
    );

    expect(mapSessionDetailToMessages(detail)).toEqual([expect.objectContaining({
      type: 'ask_user',
      answers: {
        '选哪个方案？': '方案 B',
        '需要哪些能力？': '知识库, 搜索',
      },
    })]);
  });
});

describe('子 Agent 摘要', () => {
  function agentBlocks(subagent?: Record<string, unknown>) {
    return {
      sessionId: 's',
      stats: { lines: 2, parsedLines: 2, parseErrors: 0 },
      blocks: [
        {
          id: 'b1', kind: 'tool_use' as const, title: 'Agent', defaultOpen: false,
          content: JSON.stringify({ description: '核对三处金额' }),
          toolName: 'Agent', toolId: 't1', executionStatus: 'completed' as const,
          ...(subagent ? { subagent: subagent as never } : {}),
        },
        {
          id: 'b2', kind: 'tool_result' as const, title: '', defaultOpen: false,
          content: 'done', toolName: 'Agent', toolId: 't1',
        },
      ],
    };
  }

  it('聚合值齐全时产出摘要，客户视图也能看到子任务做了什么', () => {
    const [message] = mapSessionDetailToMessages(agentBlocks({
      description: '核对三处金额', status: 'completed', childSessionId: 'c1', childRunId: 'r1',
      model: 'opus', durationMs: 42_000, totalTokens: 18_500, toolUseCount: 12, turnCount: 4,
    }) as never);
    expect(message.type).toBe('subagent');
    const presentation = (message as { presentation?: { title: string; detail?: unknown[]; status?: string } }).presentation;
    expect(presentation?.title).toBe('核对三处金额');
    expect(presentation?.detail).toContainEqual({ tree: '├', k: '工具调用', v: '12 次' });
    expect(presentation?.detail).toContainEqual({ tree: '├', k: 'Token', v: '18,500' });
    expect(presentation?.detail).toContainEqual({ tree: '└', k: '耗时', v: '42.0 s' });
    expect(presentation?.status).toBe('ok');
  });

  it('失败的子任务标 warn 并带上错误原因', () => {
    const [message] = mapSessionDetailToMessages(agentBlocks({
      description: 'x', status: 'failed', childSessionId: 'c', childRunId: 'r',
      durationMs: 100, errorMessage: '子任务超出轮次上限',
    }) as never);
    const presentation = (message as { presentation?: { status?: string; detail?: unknown[] } }).presentation;
    expect(presentation?.status).toBe('warn');
    expect(presentation?.detail).toContainEqual({ indent: 0, text: '⚠ 子任务超出轮次上限' });
  });

  it('没有任何聚合值时不产出空摘要', () => {
    const [message] = mapSessionDetailToMessages(agentBlocks() as never);
    expect((message as { presentation?: unknown }).presentation).toBeUndefined();
  });
});
