import { describe, expect, it, vi } from 'vitest';

import type { AgentRunDispatch } from '../agent/index.js';
import { DWS_INBOX_V1_IDENTITY_UNPROVABLE, type AgentDwsInboxRecord } from '../data/agentDwsMessages/index.js';
import { account, item, requester, setup } from './dwsPersonalMessageRouter.testHelpers.js';
describe('AgentDwsMessageRouter exact profile and inbox identity fencing', () => {
  it('processes different conversations concurrently up to the configured bound', async () => {
    const second = {
      ...item,
      inboxId: 'inbox-b',
      eventId: 'event-b',
      conversationId: 'cid-b',
      messageId: 'mid-b',
      content: '请整理明天的计划',
    };
    let active = 0;
    let maxActive = 0;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let started = 0;
    let bothStarted!: () => void;
    const startedPromise = new Promise<void>(resolve => { bothStarted = resolve; });
    const dispatch = vi.fn((message, _context, _options, hooks) => (async function* () {
      active += 1;
      maxActive = Math.max(maxActive, active);
      started += 1;
      if (started === 2) bothStarted();
      await gate;
      await hooks?.onResult?.({ resultText: `完成：${message.content}` });
      active -= 1;
      yield { type: 'session_init' as const, sessionId: message.chatId === 'cid-a' ? 'session-a' : 'session-cid-b' };
      yield { type: 'done' as const };
    })());
    const { router, messageStore } = setup({
      claimed: [item, second],
      dispatch,
      maxConcurrency: 2,
    });

    router.start();
    await startedPromise;
    expect(maxActive).toBe(2);
    release();
    await vi.waitFor(() => expect(messageStore.complete).toHaveBeenCalledTimes(2));
    await router.stop();
  });

  it('logs claim failures and retries without an unhandled rejection', async () => {
    const claimNext = vi.fn()
      .mockRejectedValueOnce(new Error('database unavailable'))
      .mockResolvedValueOnce(item)
      .mockResolvedValue(null);
    const logger = { info: vi.fn(), warn: vi.fn() };
    const { router, messageStore } = setup({ claimNext, logger, maxConcurrency: 1, pollMs: 10 });

    router.start();
    await vi.waitFor(() => expect(messageStore.complete).toHaveBeenCalledOnce());
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('database unavailable'));
    expect(claimNext.mock.calls.length).toBeGreaterThanOrEqual(2);
    await router.stop();
  });

  it('releases a claim that resolves during stop without dispatching or consuming retries', async () => {
    let resolveClaim!: (claimed: AgentDwsInboxRecord) => void;
    const pendingClaim = new Promise<AgentDwsInboxRecord>(resolve => { resolveClaim = resolve; });
    const claimNext = vi.fn().mockReturnValueOnce(pendingClaim).mockResolvedValue(null);
    const { router, messageStore, dispatch, sender } = setup({ claimNext, maxConcurrency: 1 });

    router.start();
    await vi.waitFor(() => expect(claimNext).toHaveBeenCalledOnce());
    let stopSettled = false;
    const stopping = router.stop().then(() => { stopSettled = true; });
    await Promise.resolve();
    expect(stopSettled).toBe(false);

    resolveClaim(item);
    await stopping;

    expect(messageStore.releaseClaim).toHaveBeenCalledWith('inbox-a', expect.any(String), item.leaseFence);
    expect(dispatch).not.toHaveBeenCalled();
    expect(sender.send).not.toHaveBeenCalled();
    expect(messageStore.fail).not.toHaveBeenCalled();
    expect(messageStore.defer).not.toHaveBeenCalled();
  });

  it('aborts and waits for all active work on stop without consuming retries', async () => {
    let started!: () => void;
    const startedPromise = new Promise<void>(resolve => { started = resolve; });
    const dispatch = vi.fn((_message, _context, options) => (async function* () {
      started();
      await new Promise<void>(resolve => {
        if (options.abortController?.signal.aborted) resolve();
        else options.abortController?.signal.addEventListener('abort', () => resolve(), { once: true });
      });
      yield { type: 'done' as const };
    })());
    const { router, messageStore } = setup({ dispatch, maxConcurrency: 1 });

    router.start();
    await startedPromise;
    await router.stop();

    expect(messageStore.fail).not.toHaveBeenCalled();
    expect(messageStore.defer).not.toHaveBeenCalled();
  });

  it('ingests normalized text events before runtime dispatch', async () => {
    const { router, messageStore } = setup();
    messageStore.ingest.mockResolvedValue({ record: item, created: true });

    await expect(router.ingest(account, {
      type: item.eventType,
      eventId: item.eventId,
      conversationId: item.conversationId,
      messageId: item.messageId,
      senderOpenDingtalkId: item.senderOpenDingtalkId,
      content: item.content,
      timestamp: 1_786_668_000_000,
      raw: { event_id: item.eventId },
    })).resolves.toBe(true);

    expect(messageStore.ingest).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: 'tenant-a', accountId: 'account-a', conversationId: 'cid-a', content: item.content,
    }), {
      schemaVersion: 2,
      source: 'dws_personal_stream',
      eventType: item.eventType,
      accountIdentity: {
        profileId: 'corp-a:agent-self',
        corpId: 'corp-a',
        dingtalkUserId: 'agent-self',
      },
      routing: {},
    });
    await router.stop();
  });

  it('binds a stable Session, dispatches the org Agent, and successfully sends one identity-fenced durable reply', async () => {
    const { router, messageStore, dispatch, sender, authorizeRequester } = setup();

    await expect(router.runOnce()).resolves.toBe(true);

    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ channel: 'dingtalk', chatId: 'cid-a', content: item.content }),
      expect.objectContaining({
        channel: 'dingtalk', resumeSessionId: 'session-a',
        sessionOwner: expect.objectContaining({ id: 'user-a', tenantId: 'tenant-a' }),
      }),
      expect.objectContaining({
        orgAgentId: 'agent-a', resumeSessionId: 'session-a',
        model: 'model-a', modelRef: 'group/model-a',
        modelConnection: { apiKey: 'test-key', baseUrl: 'https://model.test/v1' },
        modelProviderOptions: { protocol: 'responses' },
        runtimeRunId: expect.stringMatching(/^agent-dws-run-/),
      }),
      expect.any(Object),
    );
    expect(messageStore.getOrCreateBinding).toHaveBeenCalledWith(
      'tenant-a', 'account-a', 'cid-a', 'user-a', expect.stringMatching(/^agent-dws-session-/), undefined,
    );
    expect(authorizeRequester.mock.invocationCallOrder[0]!).toBeLessThan(
      messageStore.getOrCreateBinding.mock.invocationCallOrder[0]!,
    );
    expect(messageStore.markDispatchStarted).toHaveBeenCalledWith(
      'inbox-a', expect.stringMatching(/^agent-dws-router:/), 1, 'session-a',
      expect.stringMatching(/^agent-dws-run-/),
      {
        id: 'user-a', username: 'alice', role: 'user', tenantId: 'tenant-a',
        dingtalkStaffId: 'sender-a',
      },
    );
    expect(messageStore.saveDispatchResult).toHaveBeenCalledWith(
      'inbox-a', expect.stringMatching(/^agent-dws-router:/), 1, '今天已完成三项工作。',
    );
    expect(sender.send).toHaveBeenCalledWith(
      account,
      expect.objectContaining({ eventId: 'event-a', conversationId: 'cid-a' }),
      '今天已完成三项工作。',
      expect.stringMatching(/^agent-dws-reply-/), expect.any(Function),
    );
    expect(messageStore.complete).toHaveBeenCalledOnce();
  });
  it('非 v1 行缺少入站账号身份快照时仍 fail closed，不执行也不回复', async () => {
    const { router, dispatch, sender, messageStore } = setup({
      claimed: { ...item, payload: {} },
    });

    await expect(router.runOnce()).resolves.toBe(false);

    expect(dispatch).not.toHaveBeenCalled();
    expect(sender.send).not.toHaveBeenCalled();
    expect(messageStore.fail).toHaveBeenCalledWith(
      'inbox-a', expect.stringMatching(/^agent-dws-router:/), 1,
      expect.objectContaining({ message: expect.stringContaining('identity is missing') }),
    );
  });
  it('v2 已持久化回复在崩溃重领后不重复 dispatch，并继续发送与完成', async () => {
    const recovered = {
      ...item,
      state: 'reply_pending' as const,
      attempt: 2,
      sessionId: 'session-a',
      runId: 'run-a',
      responseText: '崩溃前已持久化回复',
      payload: { ...item.payload, schemaVersion: 2 },
    };
    const { router, messageStore, dispatch, sender } = setup({ claimed: recovered });

    await expect(router.runOnce()).resolves.toBe(true);

    expect(dispatch).not.toHaveBeenCalled();
    expect(messageStore.saveDispatchResult).not.toHaveBeenCalled();
    expect(messageStore.markReplyAttemptStarted).toHaveBeenCalledOnce();
    expect(sender.send).toHaveBeenCalledWith(
      account, expect.objectContaining({ eventId: item.eventId }), '崩溃前已持久化回复',
      expect.any(String), expect.any(Function),
    );
    expect(messageStore.complete).toHaveBeenCalledOnce();
  });

  it.each([
    ['pending', { state: 'processing' as const, attempt: 1 }],
    ['retry_wait', { state: 'processing' as const, attempt: 3 }],
    ['reply_pending', {
      state: 'reply_pending' as const,
      attempt: 3,
      sessionId: 'session-a',
      runId: 'run-a',
      responseText: '旧版本已持久化回复',
    }],
  ])('旧 v1 %s 行可证明身份未变时补 pin 后由新版本处理', async (_legacyState, claimedPatch) => {
    const legacy = {
      ...item,
      ...claimedPatch,
      payload: { schemaVersion: 1, source: 'dws_personal_stream' },
    };
    const { router, messageStore, dispatch, sender } = setup({ claimed: legacy });

    await expect(router.runOnce()).resolves.toBe(true);

    expect(messageStore.pinLegacyIdentityOrTerminate).toHaveBeenCalledWith(
      'inbox-a', expect.stringMatching(/^agent-dws-router:/), 1,
      {
        profileId: account.profileId,
        corpId: account.corpId,
        dingtalkUserId: account.dingtalkUserId,
      },
    );
    expect(messageStore.fail).not.toHaveBeenCalled();
    expect(messageStore.complete).toHaveBeenCalledOnce();
    expect(sender.send).toHaveBeenCalledOnce();
    if (_legacyState === 'reply_pending') expect(dispatch).not.toHaveBeenCalled();
    else expect(dispatch).toHaveBeenCalledOnce();
  });

  it.each([
    ['pending', { state: 'processing' as const, attempt: 1 }],
    ['retry_wait', { state: 'processing' as const, attempt: 3 }],
    ['reply_pending', {
      state: 'reply_pending' as const,
      attempt: 3,
      responseText: '旧版本已持久化回复',
    }],
  ])('旧 v1 %s 行身份不可证明时一次终结，重复 run 幂等跳过', async (_legacyState, claimedPatch) => {
    const logger = { info: vi.fn(), warn: vi.fn() };
    const legacy = {
      ...item,
      ...claimedPatch,
      payload: { schemaVersion: 1, source: 'dws_personal_stream' },
    };
    const { router, messageStore, dispatch, sender } = setup({
      claimed: legacy,
      legacyIdentityUnprovable: true,
      logger,
    });

    await expect(router.runOnce()).resolves.toBe(true);
    await expect(router.runOnce()).resolves.toBe(false);

    expect(messageStore.pinLegacyIdentityOrTerminate).toHaveBeenCalledOnce();
    expect(messageStore.fail).not.toHaveBeenCalled();
    expect(messageStore.complete).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
    expect(sender.send).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledOnce();
    expect(JSON.parse(String(logger.warn.mock.calls[0]?.[0]))).toMatchObject({
      level: 'warn',
      code: DWS_INBOX_V1_IDENTITY_UNPROVABLE,
      inboxId: 'inbox-a',
      tenantId: 'tenant-a',
      accountId: 'account-a',
    });
  });

  it('账号在 dispatch 期间重授权时拒绝用旧快照或新账号发送回复', async () => {
    const changedAccount = {
      ...account,
      profileId: 'corp-a:agent-other',
      dingtalkUserId: 'agent-other',
      identityUpdatedAt: '2026-08-15T00:00:00.000Z',
      revision: account.revision + 1,
    };
    const { router, accountStore, sender, messageStore } = setup();
    vi.mocked(accountStore.getForTenant)
      .mockResolvedValueOnce(account)
      .mockResolvedValueOnce(changedAccount);

    await expect(router.runOnce()).resolves.toBe(false);

    expect(sender.send).not.toHaveBeenCalled();
    expect(messageStore.complete).not.toHaveBeenCalled();
    expect(messageStore.fail).toHaveBeenCalledWith(
      'inbox-a', expect.stringMatching(/^agent-dws-router:/), 1,
      expect.objectContaining({ message: 'Agent DWS account identity changed before reply' }),
    );
  });

  it('background completion keeps the pinned account identity and reuses the parent Session', async () => {
    const completion = {
      ...item,
      eventId: 'background-task-completion:bg-1',
      content: '<task-notification><task-id>T-1234ABCD</task-id><status>completed</status></task-notification>',
      payload: {
        ...item.payload,
        source: 'background_task_completion',
        backgroundTaskId: 'bg-1',
      },
    };
    const dispatch: AgentRunDispatch = vi.fn((_message, _context, _options, hooks) => (async function* () {
      await hooks?.onResult?.({ resultText: '任务 T-1234ABCD 已完成。' });
      yield { type: 'done' as const };
    })());
    const { router, sender } = setup({ claimed: completion, dispatch });

    await expect(router.runOnce()).resolves.toBe(true);

    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining('<task-notification>'),
        metadata: expect.objectContaining({ source: 'agent_dws_background_completion' }),
      }),
      expect.objectContaining({
        resumeSessionId: 'session-a',
        systemContext: expect.stringContaining('不是用户的新请求'),
      }),
      expect.objectContaining({ orgAgentId: 'agent-a', dispatcherCompletion: true }),
      expect.any(Object),
    );
    expect(sender.send).toHaveBeenCalledWith(
      account,
      expect.objectContaining({ eventId: 'background-task-completion:bg-1' }),
      '任务 T-1234ABCD 已完成。',
      expect.any(String), expect.any(Function),
    );
  });

  it('rejects interactive approvals instead of leaving DingTalk runs waiting forever', async () => {
    let interactionResponse: { allow?: boolean; message?: string } | undefined;
    const dispatch: AgentRunDispatch = vi.fn((
      _message, _context, _options, hooks,
    ) => (async function* () {
      interactionResponse = await hooks?.onInteraction?.({
        type: 'permission_request',
        interactionId: 'approval-a',
        sessionId: 'session-a',
        runId: 'run-a',
        toolCallId: 'call-a',
        toolId: 'Shell',
        toolName: 'Shell',
        displayName: 'Run Shell',
        toolInput: { command: 'pwd' },
      });
      await hooks?.onResult?.({ resultText: '已说明无法执行。' });
      yield { type: 'done' as const };
    })());
    const { router, sender, auditToolPolicyRejection } = setup({ dispatch });

    await expect(router.runOnce()).resolves.toBe(true);

    expect(interactionResponse).toEqual({
      allow: false,
      message: expect.stringContaining('工具审批'),
    });
    expect(auditToolPolicyRejection).toHaveBeenCalledWith(expect.objectContaining({
      runId: expect.stringMatching(/^agent-dws-run-/), toolName: 'Shell',
    }));
    expect(sender.send).toHaveBeenCalledWith(
      account, expect.any(Object), '已说明无法执行。', expect.any(String), expect.any(Function),
    );
  });

  it('persists a terminal rejection when requester identity is missing', async () => {
    const { senderOpenDingtalkId: _sender, ...claimed } = item;
    const { router, messageStore, auditRequesterRejection, dispatch } = setup({ claimed });

    await expect(router.runOnce()).resolves.toBe(true);

    expect(auditRequesterRejection).toHaveBeenCalledWith(expect.objectContaining({
      eventId: 'event-a', reason: 'REQUESTER_IDENTITY_MISSING',
    }));
    expect(messageStore.reject).toHaveBeenCalledWith(
      'inbox-a', expect.any(String), 1, 'REQUESTER_IDENTITY_MISSING',
    );
    expect(messageStore.complete).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('fails closed before binding when sender cannot map to a unique requester', async () => {
    const { router, messageStore, dispatch, auditRequesterRejection } = setup({ resolveRequester: null });

    await expect(router.runOnce()).resolves.toBe(true);

    expect(messageStore.getOrCreateBinding).not.toHaveBeenCalled();
    expect(messageStore.reject).toHaveBeenCalledWith(
      'inbox-a', expect.any(String), 1, 'REQUESTER_IDENTITY_UNMAPPED_OR_AMBIGUOUS',
    );
    expect(messageStore.complete).not.toHaveBeenCalled();
    expect(messageStore.fail).not.toHaveBeenCalled();
    expect(auditRequesterRejection).toHaveBeenCalledWith(expect.objectContaining({
      eventId: 'event-a', reason: 'REQUESTER_IDENTITY_UNMAPPED_OR_AMBIGUOUS',
    }));
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('rejects audience or Assignment denial before requester binding side effects', async () => {
    const { router, messageStore, dispatch, authorizeRequester, auditRequesterRejection } = setup({
      requesterAllowed: false,
    });

    await expect(router.runOnce()).resolves.toBe(true);

    expect(authorizeRequester).toHaveBeenCalledWith(expect.objectContaining({
      account, requester, sessionId: expect.stringMatching(/^agent-dws-session-/),
    }));
    expect(messageStore.getOrCreateBinding).not.toHaveBeenCalled();
    expect(auditRequesterRejection).toHaveBeenCalledWith(expect.objectContaining({
      requester, reason: 'ASSIGNMENT_DENIED',
    }));
    expect(messageStore.markDispatchStarted).not.toHaveBeenCalled();
    expect(messageStore.reject).toHaveBeenCalledWith(
      'inbox-a', expect.any(String), 1, 'ASSIGNMENT_DENIED',
    );
    expect(messageStore.complete).not.toHaveBeenCalled();
    expect(messageStore.fail).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('terminates a direct-message self echo rejected by requester resolution', async () => {
    const claimed = {
      ...item,
      eventType: 'user_im_message_receive_o2o_all',
      senderOpenDingtalkId: 'agent-self',
      content: '重连通过',
    };
    const { router, messageStore, dispatch, sender } = setup({
      claimed,
      resolveRequester: null,
    });

    await expect(router.runOnce()).resolves.toBe(true);

    expect(messageStore.getOrCreateBinding).not.toHaveBeenCalled();
    expect(messageStore.complete).toHaveBeenCalledOnce();
    expect(messageStore.markDispatchStarted).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
    expect(sender.send).not.toHaveBeenCalled();
  });

  it('retries reply delivery without dispatching the Agent again', async () => {
    const claimed = { ...item, attempt: 2, runId: 'run-a', responseText: '已生成的回复' };
    const { router, dispatch, sender } = setup({ claimed });

    await expect(router.runOnce()).resolves.toBe(true);

    expect(dispatch).not.toHaveBeenCalled();
    expect(sender.send).toHaveBeenCalledWith(
      account, expect.any(Object), '已生成的回复', expect.stringMatching(/^agent-dws-reply-/),
      expect.any(Function),
    );
  });

  it('recovers completed run output after a process crash instead of rerunning side effects', async () => {
    const claimed = { ...item, attempt: 2, runId: 'run-a' };
    const { router, dispatch, messageStore, sender } = setup({
      claimed,
      existingRun: { runId: 'run-a', sessionId: 'session-a', status: 'completed' },
      recoveredEvents: [{
        id: 'e1', timestamp: item.createdAt, type: 'assistant_message', runId: 'run-a',
        sessionId: 'session-a', content: '从 EventStore 恢复的回复',
      }],
    });

    await expect(router.runOnce()).resolves.toBe(true);

    expect(dispatch).not.toHaveBeenCalled();
    expect(messageStore.saveDispatchResult).toHaveBeenCalledWith(
      'inbox-a', expect.any(String), 1, '从 EventStore 恢复的回复',
    );
    expect(sender.send).toHaveBeenCalledWith(
      account, expect.any(Object), '从 EventStore 恢复的回复', expect.any(String), expect.any(Function),
    );
  });

  it('fails closed before dispatch when the tenant has no default model', async () => {
    const { router, messageStore, dispatch, sender } = setup({
      resolveDefaultModel: () => null,
    });

    await expect(router.runOnce()).resolves.toBe(false);

    expect(dispatch).not.toHaveBeenCalled();
    expect(sender.send).not.toHaveBeenCalled();
    expect(messageStore.fail).toHaveBeenCalledWith(
      'inbox-a', expect.any(String), 1, expect.objectContaining({
        message: expect.stringContaining('没有可用的默认模型'),
      }),
    );
  });

  it('persists the concrete runtime error for inbox diagnostics', async () => {
    const dispatch = vi.fn(() => (async function* () {
      yield { type: 'error' as const, error: '该企业专家已被停用或删除，请联系组织管理员' };
    })());
    const { router, messageStore, sender } = setup({ dispatch });

    await expect(router.runOnce()).resolves.toBe(false);

    expect(sender.send).not.toHaveBeenCalled();
    expect(messageStore.fail).toHaveBeenCalledWith(
      'inbox-a', expect.any(String), 1, expect.objectContaining({
        message: expect.stringContaining('该企业专家已被停用或删除'),
      }),
    );
  });

  it('does not rerun a previous failed run', async () => {
    const claimed = { ...item, attempt: 2, runId: 'run-a' };
    const { router, dispatch, messageStore, sender } = setup({
      claimed,
      existingRun: { runId: 'run-a', sessionId: 'session-a', status: 'failed' },
    });

    await expect(router.runOnce()).resolves.toBe(false);

    expect(dispatch).not.toHaveBeenCalled();
    expect(sender.send).not.toHaveBeenCalled();
    expect(messageStore.fail).toHaveBeenCalledWith(
      'inbox-a', expect.any(String), 1, expect.objectContaining({
        message: expect.stringContaining('failed'),
      }),
    );
  });

  it('defers an active recovered run without consuming retry attempts', async () => {
    const claimed = { ...item, attempt: 2, runId: 'run-a' };
    const { router, dispatch, messageStore, sender } = setup({
      claimed,
      existingRun: { runId: 'run-a', sessionId: 'session-a', status: 'running' },
    });

    await expect(router.runOnce()).resolves.toBe(false);

    expect(dispatch).not.toHaveBeenCalled();
    expect(sender.send).not.toHaveBeenCalled();
    expect(messageStore.defer).toHaveBeenCalledWith(
      'inbox-a', expect.any(String), 1, 30_000, expect.stringContaining('running'),
    );
    expect(messageStore.fail).not.toHaveBeenCalled();
  });

  it('does not blindly resend a normal reply after the DWS 24-hour idempotency window', async () => {
    const claimed = {
      ...item,
      attempt: 2,
      runId: 'run-a',
      responseText: '已生成的回复',
      replyStartedAt: new Date(Date.parse(item.updatedAt) - 24 * 60 * 60 * 1_000).toISOString(),
    };
    const { router, messageStore, sender } = setup({ claimed });

    await expect(router.runOnce()).resolves.toBe(false);

    expect(sender.send).not.toHaveBeenCalled();
    expect(messageStore.fail).toHaveBeenCalledWith(
      'inbox-a', expect.any(String), 1, expect.objectContaining({
        message: expect.stringContaining('idempotency window expired'),
      }),
    );
  });

  it('rejects malformed events before the durable inbox', async () => {
    const { router, messageStore } = setup();
    await expect(router.ingest(account, {
      type: item.eventType,
      eventId: item.eventId,
      content: '',
      raw: {},
    })).resolves.toBe(false);
    expect(messageStore.ingest).not.toHaveBeenCalled();
    await router.stop();
  });
});
