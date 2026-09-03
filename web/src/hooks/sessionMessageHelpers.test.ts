import { describe, expect, it } from 'vitest';
import { interactionKey } from '@agent/shared';
import type { MessageItem } from '@/components/types';
import { appendPendingInteractions } from './sessionMessageHelpers';

const questions = [
  {
    question: '继续吗？',
    header: '确认',
    options: [{ label: '继续', description: '' }],
    multiSelect: false,
  },
];

describe('appendPendingInteractions', () => {
  it('用权威快照补齐 versionless 卡片且同 ID 只保留一张', () => {
    const messages: MessageItem[] = [
      { id: 'live', type: 'ask_user', interactionId: 'ask-1', questions, status: 'pending' },
    ];
    const next = appendPendingInteractions(
      messages,
      [{ interactionId: 'ask-1', type: 'ask_user', version: 42, order: 42, questions }],
      'session-1',
    );
    expect(next.filter((message) => message.type === 'ask_user')).toEqual([
      expect.objectContaining({
        id: 'live',
        interactionId: 'ask-1',
        interactionVersion: 42,
        interactionOrder: 42,
      }),
    ]);
  });

  it('terminal tombstone 在历史 Answered 无 interactionId 时仍压制迟到 pending HTTP 快照', () => {
    const answered: MessageItem[] = [
      {
        id: 'done',
        type: 'ask_user',
        interactionId: '',
        questions,
        status: 'answered',
        answers: { '继续吗？': '继续' },
      },
    ];
    const pending = [
      { interactionId: 'ask-1', type: 'ask_user' as const, version: 1, order: 1, questions },
    ];
    expect(
      appendPendingInteractions(
        answered,
        pending,
        'session-1',
        new Set([interactionKey('session-1', 'ask-1')]),
      ),
    ).toEqual(answered);
  });

  it('权威空快照清除 pending 卡片与 waiting runtime status', () => {
    const messages: MessageItem[] = [
      {
        id: 'wait',
        type: 'runtime_status',
        status: 'waiting_user',
        content: '待补充',
        streaming: true,
      },
      { id: 'pending', type: 'ask_user', interactionId: 'ask-1', questions, status: 'pending' },
      { id: 'answer', type: 'text', content: '后续任务已完成' },
    ];
    expect(appendPendingInteractions(messages, [], 'session-1')).toEqual([
      { id: 'answer', type: 'text', content: '后续任务已完成' },
    ]);
  });

  it('HTTP 请求发出后新到的 WS interaction 不会被旧空快照清掉', () => {
    const messages: MessageItem[] = [
      {
        id: 'wait',
        type: 'runtime_status',
        status: 'waiting_user',
        content: '待补充',
        streaming: true,
      },
      { id: 'new', type: 'ask_user', interactionId: 'new-ask', questions, status: 'pending' },
    ];
    expect(
      appendPendingInteractions(messages, [], 'session-1', undefined, new Set(['new-ask'])),
    ).toEqual(messages);
  });
});
