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
