import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MessageItem } from '@/components/types';
import { hydrateInteractionVersion } from './interactionResponseVersion';

const authFetchMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/authFetch', () => ({ authFetch: authFetchMock }));

const questions = [
  {
    question: '继续吗？',
    header: '确认',
    options: [{ label: '继续', description: '' }],
    multiSelect: false,
  },
];

describe('hydrateInteractionVersion', () => {
  beforeEach(() => authFetchMock.mockReset());

  it('首次点击时从权威 pending 接口补齐 version 并立即返回', async () => {
    const messages: MessageItem[] = [
      { id: 'live', type: 'ask_user', interactionId: 'ask-1', questions, status: 'pending' },
    ];
    authFetchMock.mockResolvedValue(
      new Response(JSON.stringify([{ interactionId: 'ask-1', version: 42, order: 42 }]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const setMessages = vi.fn();

    await expect(
      hydrateInteractionVersion('session-1', 'ask-1', () => messages, setMessages),
    ).resolves.toBe(42);
    expect(authFetchMock).toHaveBeenCalledWith(
      '/api/chat/interactions/pending?sessionId=session-1',
    );
    expect(setMessages).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          interactionId: 'ask-1',
          interactionVersion: 42,
          interactionOrder: 42,
        }),
      ],
      { scrollToBottom: false },
    );
  });

  it('已有 version 时不请求接口', async () => {
    const messages: MessageItem[] = [
      {
        id: 'live',
        type: 'ask_user',
        interactionId: 'ask-1',
        interactionVersion: 7,
        questions,
        status: 'pending',
      },
    ];
    await expect(
      hydrateInteractionVersion('session-1', 'ask-1', () => messages, vi.fn()),
    ).resolves.toBe(7);
    expect(authFetchMock).not.toHaveBeenCalled();
  });

  it('pending 请求期间到达的新消息不会被 version 回写覆盖', async () => {
    let currentMessages: MessageItem[] = [
      { id: 'live', type: 'ask_user', interactionId: 'ask-1', questions, status: 'pending' },
    ];
    authFetchMock.mockImplementation(async () => {
      currentMessages = [
        ...currentMessages,
        { id: 'new-ws-message', type: 'text', content: '新消息' },
      ];
      return new Response(JSON.stringify([{ interactionId: 'ask-1', version: 9, order: 9 }]), {
        status: 200,
      });
    });
    const setMessages = vi.fn((messages: MessageItem[]) => {
      currentMessages = messages;
    });

    await expect(
      hydrateInteractionVersion('session-1', 'ask-1', () => currentMessages, setMessages),
    ).resolves.toBe(9);
    expect(currentMessages).toContainEqual(
      expect.objectContaining({ id: 'new-ws-message', content: '新消息' }),
    );
  });
});
