import type { PlatformEvent } from '../../runtime/types.js';

export const toolPresentationProjectionFixture = {
  id: 'fixture-tool-result',
  timestamp: '2026-08-30T12:00:00.000Z',
  type: 'tool_result',
  sessionId: 'fixture-session',
  runId: 'fixture-run',
  toolCallId: 'fixture-tool-call',
  toolName: 'Shell',
  content: '{"secret":"SERVER_RAW_SENTINEL"}',
  isError: false,
  presentation: { title: '完成发布核验', status: 'ok', detail: ['4 项检查通过'] },
} satisfies Extract<PlatformEvent, { type: 'tool_result' }>;

export const businessStepProjectionFixture = {
  id: 'fixture-tool-calls',
  timestamp: '2026-08-30T12:00:01.000Z',
  type: 'assistant_tool_calls',
  sessionId: 'fixture-session',
  runId: 'fixture-run',
  content: '',
  toolCalls: [
    {
      id: 'fixture-todo-write',
      name: 'TodoWrite',
      arguments: JSON.stringify({
        todos: [
          {
            kind: 'business',
            content: '核对发布结果',
            status: 'completed',
            outcome: { text: '全部通过', tone: 'ok' },
            display: [
              {
                type: 'checklist',
                title: '发布检查',
                items: [{ label: '健康检查', status: 'pass' }],
              },
            ],
            evidenceRefs: ['release-42'],
          },
        ],
      }),
    },
  ],
} satisfies Extract<PlatformEvent, { type: 'assistant_tool_calls' }>;
