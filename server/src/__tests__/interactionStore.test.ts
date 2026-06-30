import { describe, expect, it } from 'vitest';

import { interactionStore } from '../channels/web/interactionStore.js';

describe('interactionStore disconnect behavior', () => {
  it('rejects ordinary permission_request on disconnect', async () => {
    const interactionId = 'perm-disconnect-1';
    const promise = interactionStore.create(interactionId, 'permission_request', {
      sessionId: 'session-1',
      userId: 'admin-1',
      toolName: 'Write',
    });

    interactionStore.rejectOnDisconnect(new Set([interactionId]), 'closed');

    await expect(promise).rejects.toThrow('closed');
    expect(interactionStore.getPendingInteractions('session-1')).toEqual([]);
  });

  it('keeps ask_user and plan mode permission_request pending for reconnect replay', async () => {
    const askId = 'ask-survive-1';
    const planId = 'plan-survive-1';
    const askPromise = interactionStore.create(askId, 'ask_user', {
      sessionId: 'session-2',
      userId: 'admin-1',
      questions: [
        {
          question: '选哪个？',
          header: '选择',
          options: [{ label: 'A', description: '选 A' }],
          multiSelect: false,
        },
      ],
    });
    const planPromise = interactionStore.create(planId, 'permission_request', {
      sessionId: 'session-2',
      userId: 'admin-1',
      toolName: 'ExitPlanMode',
      planContent: '计划正文',
    });

    interactionStore.rejectOnDisconnect(new Set([askId, planId]), 'closed');

    expect(interactionStore.getPendingInteractions('session-2')).toEqual([
      {
        interactionId: askId,
        type: 'ask_user',
        questions: [
          {
            question: '选哪个？',
            header: '选择',
            options: [{ label: 'A', description: '选 A' }],
            multiSelect: false,
          },
        ],
        toolName: undefined,
        planContent: undefined,
      },
      {
        interactionId: planId,
        type: 'permission_request',
        questions: undefined,
        toolName: 'ExitPlanMode',
        planContent: '计划正文',
      },
    ]);

    expect(interactionStore.resolve(askId, { answers: { choice: 'A' } })).toBe(true);
    expect(interactionStore.resolve(planId, { allow: true })).toBe(true);
    await expect(askPromise).resolves.toEqual({ answers: { choice: 'A' } });
    await expect(planPromise).resolves.toEqual({ allow: true });
  });

  it('keeps persisted platform approval pending on disconnect', async () => {
    const interactionId = 'platform-approval-survive-1';
    const promise = interactionStore.create(interactionId, 'permission_request', {
      sessionId: 'session-3',
      userId: 'admin-1',
      toolId: 'Write',
      toolName: 'Write',
      displayName: 'Write File',
      toolInput: { path: 'assets/20260607/probe.txt', content: 'ok' },
    });

    interactionStore.rejectOnDisconnect(new Set([interactionId]), 'closed');

    expect(interactionStore.getPendingInteractions('session-3')).toEqual([
      {
        interactionId,
        type: 'permission_request',
        questions: undefined,
        toolId: 'Write',
        toolName: 'Write',
        displayName: 'Write File',
        toolInput: { path: 'assets/20260607/probe.txt', content: 'ok' },
        planContent: undefined,
      },
    ]);

    expect(interactionStore.resolve(interactionId, { allow: true })).toBe(true);
    await expect(promise).resolves.toEqual({ allow: true });
  });
});
