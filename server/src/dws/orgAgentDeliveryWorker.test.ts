import { describe, expect, it, vi } from 'vitest';

import type {
  AgentDwsAccountRecord,
  AgentDwsAccountStore,
} from '../data/agentDwsAccounts/index.js';
import type { DwsDeliveryIntent, OrgGroupAgentStore } from '../data/orgGroupAgents/index.js';
import { deliverNextOrgAgentIntent } from './orgAgentDeliveryWorker.js';

const account: AgentDwsAccountRecord = {
  accountId: 'account-1',
  tenantId: 'tenant-1',
  agentId: 'agent-1',
  displayName: '采购 Agent',
  loginId: 'agent',
  corpId: 'corp-1',
  dingtalkUserId: 'user-1',
  profileId: 'corp-1:user-1',
  status: 'active',
  runtimeStatus: 'ready',
  eventKinds: ['at_me'],
  revision: 1,
  identityUpdatedAt: '2026-09-03T00:00:00.000Z',
  createdAt: '2026-09-04T00:00:00.000Z',
  createdBy: 'admin',
  updatedAt: '2026-09-04T00:00:00.000Z',
  updatedBy: 'admin',
};

const delivery: DwsDeliveryIntent = {
  deliveryId: 'delivery-1',
  tenantId: 'tenant-1',
  accountId: 'account-1',
  accountIdentity: {
    profileId: 'corp-1:user-1', corpId: 'corp-1', dingtalkUserId: 'user-1',
    identityUpdatedAt: '2026-09-03T00:00:00.000Z',
  },
  conversationId: 'group-1',
  agentId: 'agent-1',
  bindingId: 'binding-1',
  conversationSpaceId: 'space-1',
  workConversationId: 'wc-1',
  policyRevision: 2,
  providerAttemptPhase: 'legacy_unknown',
  visibility: 'conversation',
  source: 'command',
  deliveryKind: 'front_reply',
  disposition: 'replied',
  destination: {
    provider: 'dingtalk',
    accountId: 'account-1',
    conversationId: 'group-1',
    kind: 'group',
  },
  content: '处理完成',
  idempotencyKey: 'delivery-key',
  deliveryState: 'sending',
  attempt: 1,
  leaseFence: 7,
  createdAt: '2026-09-04T00:00:00.000Z',
  updatedAt: '2026-09-04T00:00:00.000Z',
};

function harness(input?: {
  pending?: boolean;
  receipt?: Record<string, unknown>;
  liveDeny?: boolean;
  agentEnabled?: boolean;
  claimedDelivery?: DwsDeliveryIntent;
  completionPolicy?: 'reply_to_work_conversation' | 'silent';
  accountStatus?: AgentDwsAccountRecord['status'];
}) {
  const store = {
    reconcileAllExpiredDeliveries: vi.fn().mockResolvedValue(0),
    claimNextDelivery: vi
      .fn()
      .mockResolvedValue(input?.pending === false ? null : (input?.claimedDelivery ?? delivery)),
    getBinding: vi.fn().mockResolvedValue({
      bindingId: 'binding-1',
      agentId: 'agent-1',
      activationState: 'active',
      enabled: true,
      accountIdentity: {
        profileId: 'corp-1:user-1', corpId: 'corp-1', dingtalkUserId: 'user-1',
        identityUpdatedAt: '2026-09-03T00:00:00.000Z',
      },
      policy: {
        enabled: true,
        liveDeny: input?.liveDeny ?? false,
        completion: input?.completionPolicy ?? 'reply_to_work_conversation',
      },
    }),
    markClaimedDeliveryDeadLetter: vi.fn().mockResolvedValue(undefined),
    markDeliveryProviderStarted: vi.fn().mockResolvedValue({
      ...(input?.claimedDelivery ?? delivery),
      providerStartedAt: '2026-09-04T00:00:01.000Z',
    }),
    releaseClaimedDeliveryForRetry: vi.fn().mockResolvedValue(undefined),
    markDeliverySent: vi.fn().mockResolvedValue(undefined),
    markDeliveryUnknown: vi.fn().mockResolvedValue(undefined),
    createDelivery: vi
      .fn()
      .mockImplementation(async (value) => ({
        ...delivery,
        ...value,
        deliveryId: 'policy-notice',
        deliveryState: 'pending',
      })),
    getWorkOrder: vi.fn().mockResolvedValue({
      workOrderId: 'work-current',
      agentId: 'agent-1',
      bindingId: 'binding-1',
      workConversationId: 'wc-1',
      currentAttemptNo: 2,
      state: 'completed',
    }),
    getWorkConversation: vi.fn().mockResolvedValue({
      workConversationId: 'wc-1',
      bindingId: 'binding-1',
    }),
    listWorkAttempts: vi
      .fn()
      .mockResolvedValue([
        {
          attemptId: 'attempt-current',
          workOrderId: 'work-current',
          attemptNo: 2,
          status: 'completed',
        },
      ]),
  } as unknown as OrgGroupAgentStore;
  const sender = {
    send: vi.fn(async (
      _account: unknown,
      _event: unknown,
      _text: string,
      _key: string,
      onProviderStart?: () => Promise<void>,
    ): Promise<Record<string, unknown> | undefined> => {
      await onProviderStart?.();
      return input?.receipt ?? { status: 'accepted', acceptedAt: 'now' };
    }),
  };
  return {
    store,
    sender,
    options: {
      store,
      accountStore: {
        getForTenant: vi.fn().mockResolvedValue({
          ...account,
          status: input?.accountStatus ?? account.status,
        }),
      } as unknown as AgentDwsAccountStore,
      agentStore: {
        get: vi
          .fn()
          .mockReturnValue({
            id: 'agent-1',
            tenantId: 'tenant-1',
            enabled: input?.agentEnabled ?? true,
          }),
      },
      sender,
      workerId: 'worker-1',
      leaseTtlMs: 1_000,
    },
  };
}

describe('deliverNextOrgAgentIntent provider fences', () => {
  it('没有待投递 intent 时返回 false', async () => {
    const test = harness({ pending: false });
    await expect(deliverNextOrgAgentIntent(test.options)).resolves.toBe(false);
    expect(test.sender.send).not.toHaveBeenCalled();
  });

  it('sends a claimed intent and persists its receipt after provider start', async () => {
    const test = harness();
    await expect(deliverNextOrgAgentIntent(test.options)).resolves.toBe(true);
    expect(test.sender.send).toHaveBeenCalledWith(
      account,
      expect.objectContaining({
        type: 'user_im_message_receive_at',
        conversationId: 'group-1',
        eventId: 'delivery-1',
      }),
      '处理完成',
      'delivery-key',
      expect.any(Function),
    );
    expect(test.store.markDeliverySent).toHaveBeenCalledWith(
      'delivery-1',
      'worker-1',
      7,
      expect.objectContaining({ status: 'accepted' }),
    );
    expect(test.store.markDeliveryProviderStarted).toHaveBeenCalledWith(
      'delivery-1',
      'worker-1',
      7,
    );
  });

  it('retries deterministic sender preparation failures before provider transport', async () => {
    const test = harness();
    test.sender.send.mockRejectedValueOnce(new Error('workspace mount unavailable'));

    await expect(deliverNextOrgAgentIntent(test.options)).resolves.toBe(true);

    expect(test.store.markDeliveryProviderStarted).not.toHaveBeenCalled();
    expect(test.store.markDeliveryUnknown).not.toHaveBeenCalled();
    expect(test.store.releaseClaimedDeliveryForRetry).toHaveBeenCalledWith(
      'delivery-1',
      'worker-1',
      7,
      expect.any(Error),
      1_000,
      5,
    );
  });

  it('sender 准备期间 liveDeny 生效时 provider fence 阻断实际发送', async () => {
    const test = harness();
    const providerInvoke = vi.fn();
    vi.mocked(test.store.markDeliveryProviderStarted).mockRejectedValueOnce(
      new Error('DWS_DELIVERY_LEASE_LOST'),
    );
    test.sender.send.mockImplementationOnce(async (
      _account, _event, _text, _key, onProviderStart,
    ) => {
      await onProviderStart?.();
      providerInvoke();
      return { status: 'accepted' };
    });

    await expect(deliverNextOrgAgentIntent(test.options)).resolves.toBe(true);

    expect(providerInvoke).not.toHaveBeenCalled();
    expect(test.store.markDeliveryUnknown).not.toHaveBeenCalled();
    expect(test.store.releaseClaimedDeliveryForRetry).toHaveBeenCalledOnce();
  });

  it('marks provider receipt ambiguity unknown and excludes automatic retry', async () => {
    const test = harness({ receipt: undefined });
    test.sender.send.mockImplementationOnce(async (
      _account,
      _event,
      _text,
      _key,
      onProviderStart,
    ) => {
      await onProviderStart?.();
      return undefined;
    });
    await expect(deliverNextOrgAgentIntent(test.options)).resolves.toBe(true);
    expect(test.store.markDeliveryUnknown).toHaveBeenCalledWith(
      'delivery-1',
      'worker-1',
      7,
      expect.any(Error),
    );
    expect(test.store.claimNextDelivery).toHaveBeenCalledTimes(1);
  });

  it('moves an accepted provider send to unknown when receipt persistence fails', async () => {
    const test = harness();
    vi.mocked(test.store.markDeliverySent).mockRejectedValueOnce(new Error('database unavailable'));

    await expect(deliverNextOrgAgentIntent(test.options)).resolves.toBe(true);

    expect(test.sender.send).toHaveBeenCalledOnce();
    expect(test.store.markDeliveryUnknown).toHaveBeenCalledWith(
      'delivery-1',
      'worker-1',
      7,
      expect.objectContaining({ message: 'database unavailable' }),
    );
  });

  it('fails closed when the pinned DWS account is revoked before completion delivery', async () => {
    const completion = {
      ...delivery,
      deliveryKind: 'task_completion' as const,
      source: 'background_completion' as const,
      sourceWorkOrderId: 'work-current',
      sourceAttemptId: 'attempt-current',
    };
    const test = harness({ accountStatus: 'paused', claimedDelivery: completion });

    await expect(deliverNextOrgAgentIntent(test.options)).resolves.toBe(true);

    expect(test.store.markClaimedDeliveryDeadLetter).toHaveBeenCalledWith(
      'delivery-1',
      'worker-1',
      7,
      'ORG_AGENT_DELIVERY_ACCOUNT_UNAVAILABLE',
    );
    expect(test.sender.send).not.toHaveBeenCalled();
  });

  it('releases a claimed intent for retry when preflight fails before provider start', async () => {
    const test = harness();
    vi.mocked(test.options.accountStore.getForTenant).mockRejectedValueOnce(
      new Error('account database unavailable'),
    );

    await expect(deliverNextOrgAgentIntent(test.options)).resolves.toBe(true);

    expect(test.sender.send).not.toHaveBeenCalled();
    expect(test.store.markDeliveryProviderStarted).not.toHaveBeenCalled();
    expect(test.store.releaseClaimedDeliveryForRetry).toHaveBeenCalledWith(
      'delivery-1',
      'worker-1',
      7,
      expect.objectContaining({ message: 'account database unavailable' }),
      1_000,
      5,
    );
    expect(test.store.markDeliveryUnknown).not.toHaveBeenCalled();
  });

  it.each([
    [
      'work order',
      (test: ReturnType<typeof harness>) =>
        vi
          .mocked(test.store.getWorkOrder)
          .mockRejectedValueOnce(new Error('work database unavailable')),
    ],
    [
      'attempt',
      (test: ReturnType<typeof harness>) =>
        vi
          .mocked(test.store.listWorkAttempts)
          .mockRejectedValueOnce(new Error('attempt database unavailable')),
    ],
    [
      'binding',
      (test: ReturnType<typeof harness>) =>
        vi
          .mocked(test.store.getBinding)
          .mockRejectedValueOnce(new Error('binding database unavailable')),
    ],
    [
      'agent',
      (test: ReturnType<typeof harness>) =>
        vi.mocked(test.options.agentStore.get).mockImplementationOnce(() => {
          throw new Error('agent database unavailable');
        }),
    ],
  ])('releases completion delivery when %s preflight fails', async (_label, fail) => {
    const completion = {
      ...delivery,
      deliveryKind: 'task_completion' as const,
      source: 'background_completion' as const,
      sourceWorkOrderId: 'work-current',
      sourceAttemptId: 'attempt-current',
    };
    const test = harness({ claimedDelivery: completion });
    fail(test);

    await expect(deliverNextOrgAgentIntent(test.options)).resolves.toBe(true);

    expect(test.sender.send).not.toHaveBeenCalled();
    expect(test.store.releaseClaimedDeliveryForRetry).toHaveBeenCalledOnce();
    expect(test.store.markDeliveryUnknown).not.toHaveBeenCalled();
  });

  it('releases requester-only completion when ACL preflight fails', async () => {
    const completion = {
      ...delivery,
      deliveryKind: 'task_completion' as const,
      source: 'background_completion' as const,
      sourceWorkOrderId: 'work-current',
      sourceAttemptId: 'attempt-current',
      visibility: 'requester_only' as const,
    };
    const test = harness({ claimedDelivery: completion });
    vi.mocked(test.store.getWorkOrder).mockResolvedValueOnce({
      workOrderId: 'work-current',
      agentId: 'agent-1',
      bindingId: 'binding-1',
      workConversationId: 'wc-1',
      currentAttemptNo: 2,
      state: 'completed',
      createdByActor: { mappedUserId: 'member-1' },
    } as never);
    const authorizeCompletionRequester = vi
      .fn()
      .mockRejectedValueOnce(new Error('ACL database unavailable'));

    await expect(
      deliverNextOrgAgentIntent({
        ...test.options,
        authorizeCompletionRequester,
      }),
    ).resolves.toBe(true);

    expect(test.sender.send).not.toHaveBeenCalled();
    expect(test.store.releaseClaimedDeliveryForRetry).toHaveBeenCalledOnce();
    expect(test.store.markDeliveryUnknown).not.toHaveBeenCalled();
  });

  it('Direct delivery 固定于身份 A 后，账号换绑 B 会 dead-letter 且不发送旧正文', async () => {
    const direct = {
      ...delivery,
      agentId: undefined,
      bindingId: undefined,
      conversationId: 'direct-1',
      destination: {
        provider: 'dingtalk' as const, accountId: 'account-1',
        conversationId: 'direct-1', kind: 'direct' as const, peerOpenId: 'open-a',
      },
      accountIdentity: {
        profileId: 'corp-old:user-old', corpId: 'corp-old', dingtalkUserId: 'user-old',
        identityUpdatedAt: '2026-09-01T00:00:00.000Z',
      },
    };
    const test = harness({ claimedDelivery: direct });

    await expect(deliverNextOrgAgentIntent(test.options)).resolves.toBe(true);

    expect(test.sender.send).not.toHaveBeenCalled();
    expect(test.store.markClaimedDeliveryDeadLetter).toHaveBeenCalledWith(
      'delivery-1', 'worker-1', 7, 'ORG_AGENT_DELIVERY_ACCOUNT_IDENTITY_STALE',
    );
  });

  it('账号身份切换后不会用旧 binding 投递，而是 dead-letter', async () => {
    const test = harness();
    const currentBinding = await test.store.getBinding('tenant-1', 'account-1', 'group-1');
    vi.mocked(test.store.getBinding).mockResolvedValueOnce({
      ...currentBinding!,
      accountIdentity: {
        profileId: 'corp-old:user-old', corpId: 'corp-old', dingtalkUserId: 'user-old',
        identityUpdatedAt: '2026-09-01T00:00:00.000Z',
      },
    });

    await expect(deliverNextOrgAgentIntent(test.options)).resolves.toBe(true);

    expect(test.sender.send).not.toHaveBeenCalled();
    expect(test.store.markClaimedDeliveryDeadLetter).toHaveBeenCalledWith(
      'delivery-1', 'worker-1', 7, 'ORG_AGENT_CHANNEL_LIVE_DENY',
    );
  });

  it('dead-letters a claimed intent when the live binding denies delivery', async () => {
    const test = harness({ liveDeny: true });
    await expect(deliverNextOrgAgentIntent(test.options)).resolves.toBe(true);
    expect(test.store.markClaimedDeliveryDeadLetter).toHaveBeenCalledWith(
      'delivery-1',
      'worker-1',
      7,
      'ORG_AGENT_CHANNEL_LIVE_DENY',
    );
    expect(test.sender.send).not.toHaveBeenCalled();
  });

  it('emits one durable redacted notice when completion content is denied but destination is live', async () => {
    const completion = {
      ...delivery,
      deliveryKind: 'task_completion' as const,
      source: 'background_completion' as const,
      sourceWorkOrderId: 'work-current',
      sourceAttemptId: 'attempt-current',
    };
    const test = harness({ liveDeny: true, claimedDelivery: completion });
    await expect(deliverNextOrgAgentIntent(test.options)).resolves.toBe(true);
    expect(test.store.createDelivery).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'system',
        deliveryKind: 'system_notice',
        content: '任务已结束，但当前群策略不允许披露结果，请联系管理员。',
      }),
    );
    expect(test.store.markClaimedDeliveryDeadLetter).toHaveBeenCalledWith(
      'delivery-1',
      'worker-1',
      7,
      'ORG_AGENT_CHANNEL_LIVE_DENY',
    );
    expect(test.sender.send).not.toHaveBeenCalled();
  });

  it('keeps an explicitly silent completion fully silent', async () => {
    const completion = {
      ...delivery,
      deliveryKind: 'task_completion' as const,
      source: 'background_completion' as const,
      sourceWorkOrderId: 'work-current',
      sourceAttemptId: 'attempt-current',
    };
    const test = harness({ completionPolicy: 'silent', claimedDelivery: completion });
    await expect(deliverNextOrgAgentIntent(test.options)).resolves.toBe(true);

    expect(test.store.createDelivery).not.toHaveBeenCalled();
    expect(test.store.markClaimedDeliveryDeadLetter).toHaveBeenCalledWith(
      delivery.deliveryId,
      'worker-1',
      7,
      'ORG_AGENT_COMPLETION_SILENT',
    );
    expect(test.sender.send).not.toHaveBeenCalled();
  });

  it('uses the same redacted completion path when the Agent is disabled after creation', async () => {
    const completion = {
      ...delivery,
      deliveryKind: 'task_completion' as const,
      source: 'background_completion' as const,
      sourceWorkOrderId: 'work-current',
      sourceAttemptId: 'attempt-current',
    };
    const test = harness({ agentEnabled: false, claimedDelivery: completion });
    await expect(deliverNextOrgAgentIntent(test.options)).resolves.toBe(true);
    expect(test.store.createDelivery).toHaveBeenCalledOnce();
    expect(test.store.markClaimedDeliveryDeadLetter).toHaveBeenCalledWith(
      'delivery-1',
      'worker-1',
      7,
      'ORG_AGENT_CHANNEL_LIVE_DENY',
    );
    expect(test.sender.send).not.toHaveBeenCalled();
  });

  it('dead-letters a completion from a stale attempt after retry', async () => {
    const stale = {
      ...delivery,
      deliveryKind: 'task_completion' as const,
      source: 'background_completion' as const,
      sourceWorkOrderId: 'work-current',
      sourceAttemptId: 'attempt-old',
    };
    const test = harness({ claimedDelivery: stale });
    await expect(deliverNextOrgAgentIntent(test.options)).resolves.toBe(true);
    expect(test.store.markClaimedDeliveryDeadLetter).toHaveBeenCalledWith(
      'delivery-1',
      'worker-1',
      7,
      'ORG_AGENT_DELIVERY_STALE_ATTEMPT',
    );
    expect(test.sender.send).not.toHaveBeenCalled();
  });

  it('dead-letters a completion whose WorkOrder belongs to another WorkConversation', async () => {
    const completion = {
      ...delivery,
      deliveryKind: 'task_completion' as const,
      source: 'background_completion' as const,
      sourceWorkOrderId: 'work-current',
      sourceAttemptId: 'attempt-current',
    };
    const test = harness({ claimedDelivery: completion });
    vi.mocked(test.store.getWorkOrder).mockResolvedValueOnce({
      workOrderId: 'work-current',
      agentId: 'agent-1',
      bindingId: 'binding-1',
      workConversationId: 'wc-2',
      currentAttemptNo: 2,
      state: 'completed',
    } as never);

    await expect(deliverNextOrgAgentIntent(test.options)).resolves.toBe(true);

    expect(test.store.markClaimedDeliveryDeadLetter).toHaveBeenCalledWith(
      'delivery-1',
      'worker-1',
      7,
      'ORG_AGENT_DELIVERY_STALE_ATTEMPT',
    );
    expect(test.sender.send).not.toHaveBeenCalled();
  });
});
