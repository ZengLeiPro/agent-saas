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

describe('公开工具活动摘要恢复', () => {
  it('publicActivityOnly 跳过交互工具的历史恢复，保留为普通安全工具行', () => {
    const messages = mapSessionDetailToMessages({
      sessionId: 's-public-tool',
      stats: { lines: 2, parsedLines: 2, parseErrors: 0 },
      blocks: [
        {
          id: 'tool-call',
          kind: 'tool_use',
          title: '工具调用: AskUserQuestion',
          defaultOpen: false,
          content: '',
          toolName: 'AskUserQuestion',
          toolId: 'shared-tool-1',
          publicActivityOnly: true,
          presentation: { title: '工具调用: AskUserQuestion' },
        },
        {
          id: 'tool-result',
          kind: 'tool_result',
          title: '工具结果',
          defaultOpen: false,
          content: '',
          toolName: 'AskUserQuestion',
          toolId: 'shared-tool-1',
          publicActivityOnly: true,
        },
      ],
    });

    expect(messages).toEqual([expect.objectContaining({
      type: 'tool_use',
      toolName: 'AskUserQuestion',
      toolInput: '',
      result: '',
      resultReady: true,
    })]);
  });
});

describe('最终输出历史恢复', () => {
  it('把 Session API 的 runId/finalOutput 透传到 text 消息', () => {
    const messages = mapSessionDetailToMessages({
      sessionId: 's-final',
      stats: { lines: 1, parsedLines: 1, parseErrors: 0 },
      blocks: [{
        id: 'final-block',
        kind: 'text',
        title: '输出',
        defaultOpen: true,
        content: '最终回答',
        runId: 'run-final',
        finalOutput: true,
      }],
    });

    expect(messages).toEqual([expect.objectContaining({
      type: 'text',
      content: '最终回答',
      runId: 'run-final',
      finalOutput: true,
    })]);
  });
});

describe('工具运行归属恢复', () => {
  it('把 tool_use 的 runId 透传到消息投影', () => {
    const messages = mapSessionDetailToMessages({
      sessionId: 's-tool-run',
      stats: { lines: 1, parsedLines: 1, parseErrors: 0 },
      blocks: [{
        id: 'todo-block',
        kind: 'tool_use',
        title: 'TodoWrite',
        defaultOpen: false,
        content: '{"todos":[]}',
        toolName: 'TodoWrite',
        toolId: 'todo-1',
        runId: 'run-business-1',
      }],
    });

    expect(messages).toEqual([expect.objectContaining({
      type: 'tool_use',
      toolName: 'TodoWrite',
      runId: 'run-business-1',
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

describe('Artifact 交付历史恢复', () => {
  const deliveryResult = {
    id: 'artifact-result',
    kind: 'tool_result' as const,
    title: '结果',
    defaultOpen: false,
    content: JSON.stringify({
      action: 'deliver',
      artifactId: 'artifact-1',
      kind: 'file',
      fileName: '交付结果.docx',
      sizeBytes: 2048,
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    }),
    toolName: 'Artifact',
    toolId: 'call-artifact',
  };

  it('tool metadata 缺失时从 deliver 结果恢复文件卡片', () => {
    const messages = mapSessionDetailToMessages({
      sessionId: 's-artifact',
      stats: { lines: 2, parsedLines: 2, parseErrors: 0 },
      blocks: [
        {
          id: 'artifact-call',
          kind: 'tool_use',
          title: 'Artifact',
          defaultOpen: false,
          content: JSON.stringify({ action: 'deliver', artifact_id: 'artifact-1' }),
          toolName: 'Artifact',
          toolId: 'call-artifact',
        },
        deliveryResult,
      ],
    });

    expect(messages).toEqual([expect.objectContaining({
      type: 'file_download',
      artifactId: 'artifact-1',
      artifactKind: 'file',
      fileName: '交付结果.docx',
      fileSize: 2048,
    })]);
  });

  it('分页历史缺少 tool_use 时仍从孤儿 deliver 结果恢复文件卡片', () => {
    const messages = mapSessionDetailToMessages({
      sessionId: 's-artifact',
      stats: { lines: 1, parsedLines: 1, parseErrors: 0 },
      mode: 'before',
      blocks: [deliveryResult],
    });

    expect(messages).toEqual([expect.objectContaining({
      type: 'file_download',
      artifactId: 'artifact-1',
      fileName: '交付结果.docx',
    })]);
  });
});
