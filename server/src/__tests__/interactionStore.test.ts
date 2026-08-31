import { describe, expect, it, vi } from 'vitest';

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

  it('discard 会拒绝并移除交互，不遗留永久 pending Promise', async () => {
    const interactionId = 'discard-terminal-approval-1';
    const promise = interactionStore.create(interactionId, 'permission_request', {
      sessionId: 'session-discard-1',
      runId: 'run-terminal-1',
      toolId: 'Shell',
      toolName: 'Shell',
    });

    expect(interactionStore.discard(interactionId, 'source run terminal')).toBe(true);
    await expect(promise).rejects.toThrow('source run terminal');
    expect(interactionStore.get(interactionId)).toBeUndefined();
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

describe('M20-05 interaction timeout outcome', () => {
  it('reports an explicit expired outcome before rejecting the waiter', async () => {
    vi.useFakeTimers();
    try {
      const onExpired = vi.fn();
      const promise = interactionStore.create('expires-visible', 'ask_user', { sessionId: 'session-expired', onExpired });
      const rejection = expect(promise).rejects.toThrow('Interaction timed out');
      await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
      await rejection;
      expect(onExpired).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'session-expired', type: 'ask_user' }));
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('M20-05 interaction response idempotency', () => {
  it('executes the waiter side effect once after an ACK loss and classifies retries', async () => {
    const interactionId = 'ack-loss-once';
    let sideEffects = 0;
    const promise = interactionStore.create(interactionId, 'permission_request', { sessionId: 'session-idempotent' })
      .then((response) => { sideEffects += 1; return response; });

    expect(interactionStore.resolve(interactionId, { allow: true })).toBe(true);
    interactionStore.recordCompleted('session-idempotent', interactionId, 'request-stable', { allow: true });
    await expect(promise).resolves.toEqual({ allow: true });

    // Lost ACK retry uses the same request and canonical response; no waiter is resolved twice.
    expect(interactionStore.classifyCompleted('session-idempotent', interactionId, { allow: true })).toBe('duplicate');
    expect(interactionStore.resolve(interactionId, { allow: true })).toBe(false);
    expect(sideEffects).toBe(1);
    // A different answer for the same interaction is a protocol conflict.
    expect(interactionStore.classifyCompleted('session-idempotent', interactionId, { allow: false })).toBe('conflict');
  });
});

describe('M20-07 active interaction session index', () => {
  it('updates O(1) summary immediately on request and terminal resolution', async () => {
    const promise = interactionStore.create('indexed-interaction', 'ask_user', { sessionId: 'indexed-session' });
    expect(interactionStore.getActiveInteraction('indexed-session')).toMatchObject({
      interactionId: 'indexed-interaction', type: 'ask_user',
    });
    expect(interactionStore.resolve('indexed-interaction', { answers: {} })).toBe(true);
    await expect(promise).resolves.toEqual({ answers: {} });
    expect(interactionStore.getActiveInteraction('indexed-session')).toBeUndefined();
  });
});
