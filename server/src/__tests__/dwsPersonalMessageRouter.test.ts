import { describe, expect, it, vi } from 'vitest';

import type { AgentRunDispatch } from '../agent/index.js';
import type { AgentDwsAccountRecord, AgentDwsAccountStore } from '../data/agentDwsAccounts/index.js';
import type {
  AgentDwsInboxRecord,
  AgentDwsMessageStore,
} from '../data/agentDwsMessages/index.js';
import {
  AgentDwsMessageRouter,
  type AgentDwsDefaultModelResolution,
} from '../dws/personalMessageRouter.js';
import type { DwsPersonalMessageSenderLike } from '../dws/personalMessageSender.js';

const account: AgentDwsAccountRecord = {
  accountId: 'account-a',
  tenantId: 'tenant-a',
  agentId: 'agent-a',
  displayName: '开开',
  loginId: '17300000000',
  profileId: 'corp-a',
  status: 'active',
  runtimeStatus: 'ready',
  eventKinds: ['at_me', 'all_direct'],
  revision: 2,
  createdAt: '2026-08-14T00:00:00.000Z',
  createdBy: 'admin-a',
  updatedAt: '2026-08-14T00:00:00.000Z',
  updatedBy: 'admin-a',
};

const item: AgentDwsInboxRecord = {
  inboxId: 'inbox-a',
  tenantId: 'tenant-a',
  accountId: 'account-a',
  eventId: 'event-a',
  eventType: 'user_im_message_receive_at',
  conversationId: 'cid-a',
  messageId: 'mid-a',
  senderOpenDingtalkId: 'sender-a',
  content: '请汇总今天的进展',
  payload: {},
  state: 'processing',
  attempt: 1,
  maxAttempts: 8,
  leaseOwner: 'worker-a',
  leaseFence: 1,
  leaseExpiresAt: '2026-08-14T01:00:00.000Z',
  createdAt: '2026-08-14T00:00:00.000Z',
  updatedAt: '2026-08-14T00:00:00.000Z',
};

function setup(input: {
  claimed?: AgentDwsInboxRecord;
  dispatch?: AgentRunDispatch;
  existingRun?: { runId: string; sessionId: string; status: string } | null;
  recoveredEvents?: Array<Record<string, unknown>>;
  bindingPeerOpenDingtalkId?: string;
  resolveDefaultModel?: (tenantId: string) => AgentDwsDefaultModelResolution | null;
} = {}) {
  const claimed = input.claimed ?? item;
  const messageStore = {
    init: vi.fn(),
    ingest: vi.fn(),
    listForAccount: vi.fn().mockResolvedValue([]),
    claimNext: vi.fn().mockResolvedValue(claimed),
    renewLease: vi.fn().mockResolvedValue(true),
    getOrCreateBinding: vi.fn().mockResolvedValue({
      bindingId: 'binding-a', tenantId: 'tenant-a', accountId: 'account-a',
      conversationId: 'cid-a', sessionId: 'session-a',
      ...(input.bindingPeerOpenDingtalkId ? { peerOpenDingtalkId: input.bindingPeerOpenDingtalkId } : {}),
      createdAt: item.createdAt, updatedAt: item.updatedAt,
    }),
    markDispatchStarted: vi.fn().mockImplementation(async (
      _inboxId: string, _owner: string, _fence: number, sessionId: string, runId: string,
    ) => ({ ...claimed, sessionId, runId })),
    saveDispatchResult: vi.fn().mockImplementation(async (
      _inboxId: string, _owner: string, _fence: number, responseText: string,
    ) => ({ ...claimed, state: 'reply_pending', responseText })),
    markReplyAttemptStarted: vi.fn().mockResolvedValue({
      ...claimed,
      state: 'reply_pending',
      replyStartedAt: claimed.replyStartedAt ?? new Date().toISOString(),
    }),
    defer: vi.fn().mockResolvedValue({ ...claimed, state: 'retry_wait' }),
    complete: vi.fn().mockResolvedValue({ ...claimed, state: 'completed' }),
    fail: vi.fn().mockResolvedValue({ ...claimed, state: 'retry_wait' }),
    deleteForTenant: vi.fn(),
  } satisfies AgentDwsMessageStore;
  const accountStore = {
    getForTenant: vi.fn().mockResolvedValue(account),
  } as unknown as AgentDwsAccountStore;
  const sender = { send: vi.fn().mockResolvedValue(undefined) } satisfies DwsPersonalMessageSenderLike;
  const dispatch = input.dispatch ?? vi.fn((
    _message, _context, _options, hooks,
  ) => (async function* () {
    await hooks?.onResult?.({ resultText: '今天已完成三项工作。' });
    yield { type: 'session_init' as const, sessionId: 'session-a' };
    yield { type: 'text_delta' as const, content: '今天已完成三项工作。' };
    yield { type: 'done' as const };
  })());
  const router = new AgentDwsMessageRouter({
    agentCwd: '/workspace',
    messageStore,
    accountStore,
    dispatch,
    resolveDefaultModel: input.resolveDefaultModel ?? vi.fn(() => ({
      ref: 'group/model-a',
      model: 'model-a',
      connection: { apiKey: 'test-key', baseUrl: 'https://model.test/v1' },
      providerOptions: { protocol: 'responses' as const },
    })),
    sender,
    ...(input.existingRun !== undefined ? {
      runStore: { get: vi.fn().mockResolvedValue(input.existingRun) },
    } : {}),
    ...(input.recoveredEvents ? {
      eventStore: { listByRun: vi.fn().mockResolvedValue(input.recoveredEvents) },
    } : {}),
    pollMs: 60_000,
    leaseTtlMs: 60_000,
    leaseRenewMs: 30_000,
  });
  return { router, messageStore, accountStore, dispatch, sender };
}

describe('AgentDwsMessageRouter', () => {
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
      schemaVersion: 1,
      source: 'dws_personal_stream',
      eventType: item.eventType,
    });
    await router.stop();
  });

  it('binds a stable Session, dispatches the org Agent, and sends one durable reply', async () => {
    const { router, messageStore, dispatch, sender } = setup();

    await expect(router.runOnce()).resolves.toBe(true);

    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ channel: 'dingtalk', chatId: 'cid-a', content: item.content }),
      expect.objectContaining({
        channel: 'dingtalk', resumeSessionId: 'session-a',
        sessionOwner: expect.objectContaining({ id: 'account-a', tenantId: 'tenant-a' }),
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
    expect(messageStore.saveDispatchResult).toHaveBeenCalledWith(
      'inbox-a', expect.stringMatching(/^agent-dws-router:/), 1, '今天已完成三项工作。',
    );
    expect(sender.send).toHaveBeenCalledWith(
      account,
      expect.objectContaining({ eventId: 'event-a', conversationId: 'cid-a' }),
      '今天已完成三项工作。',
      expect.stringMatching(/^agent-dws-reply-/),
    );
    expect(messageStore.complete).toHaveBeenCalledOnce();
  });

  it('ignores a direct-message self echo when its sender differs from the bound peer', async () => {
    const claimed = {
      ...item,
      eventType: 'user_im_message_receive_o2o_all',
      senderOpenDingtalkId: 'agent-self',
      content: '重连通过',
    };
    const { router, messageStore, dispatch, sender } = setup({
      claimed,
      bindingPeerOpenDingtalkId: 'human-peer',
    });

    await expect(router.runOnce()).resolves.toBe(true);

    expect(messageStore.getOrCreateBinding).toHaveBeenCalledWith(
      'tenant-a', 'account-a', 'cid-a', expect.stringMatching(/^agent-dws-session-/), 'agent-self',
    );
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
      account, expect.any(Object), '从 EventStore 恢复的回复', expect.any(String),
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

  it('does not blindly resend after the DWS 24-hour idempotency window', async () => {
    const claimed = {
      ...item,
      attempt: 2,
      runId: 'run-a',
      responseText: '已生成的回复',
      replyStartedAt: new Date(Date.now() - 24 * 60 * 60 * 1_000).toISOString(),
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
