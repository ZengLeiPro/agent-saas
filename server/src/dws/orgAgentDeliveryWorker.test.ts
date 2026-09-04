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
  createdAt: '2026-09-04T00:00:00.000Z',
  createdBy: 'admin',
  updatedAt: '2026-09-04T00:00:00.000Z',
  updatedBy: 'admin',
};

const delivery: DwsDeliveryIntent = {
  deliveryId: 'delivery-1',
  tenantId: 'tenant-1',
  accountId: 'account-1',
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
    claimNextDelivery: vi.fn().mockResolvedValue(
      input?.pending === false ? null : (input?.claimedDelivery ?? delivery),
    ),
    getBinding: vi.fn().mockResolvedValue({
      bindingId: 'binding-1',
      agentId: 'agent-1',
      activationState: 'active',
      enabled: true,
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
    createDelivery: vi.fn().mockImplementation(async value => ({ ...delivery, ...value,
      deliveryId: 'policy-notice', deliveryState: 'pending' })),
    getWorkOrder: vi.fn().mockResolvedValue({
      workOrderId: 'work-current', currentAttemptNo: 2, state: 'completed',
    }),
    listWorkAttempts: vi.fn().mockResolvedValue([{ attemptId: 'attempt-current',
      attemptNo: 2, status: 'completed' }]),
  } as unknown as OrgGroupAgentStore;
  const sender = {
    send: vi.fn().mockResolvedValue(input?.receipt ?? { status: 'accepted', acceptedAt: 'now' }),
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
        get: vi.fn().mockReturnValue({ id: 'agent-1', tenantId: 'tenant-1',
          enabled: input?.agentEnabled ?? true }),
      },
      sender,
      workerId: 'worker-1',
      leaseTtlMs: 1_000,
    },
  };
}

describe('deliverNextOrgAgentIntent', () => {
  it('returns false without a pending intent', async () => {
    const test = harness({ pending: false });
    await expect(deliverNextOrgAgentIntent(test.options)).resolves.toBe(false);
    expect(test.sender.send).not.toHaveBeenCalled();
  });

  it('sends a claimed intent and persists its receipt', async () => {
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

  it('marks provider receipt ambiguity unknown and never retries it automatically', async () => {
    const test = harness({ receipt: undefined });
    test.sender.send.mockResolvedValueOnce(undefined);
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
      'delivery-1', 'worker-1', 7, expect.objectContaining({ message: 'database unavailable' }),
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
      'delivery-1', 'worker-1', 7, 'ORG_AGENT_DELIVERY_ACCOUNT_UNAVAILABLE',
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
    expect(test.store.createDelivery).toHaveBeenCalledWith(expect.objectContaining({
      source: 'system',
      deliveryKind: 'system_notice',
      content: '任务已结束，但当前群策略不允许披露结果，请联系管理员。',
    }));
    expect(test.store.markClaimedDeliveryDeadLetter).toHaveBeenCalledWith(
      'delivery-1', 'worker-1', 7, 'ORG_AGENT_CHANNEL_LIVE_DENY',
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
      'delivery-1', 'worker-1', 7, 'ORG_AGENT_CHANNEL_LIVE_DENY',
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
      'delivery-1', 'worker-1', 7, 'ORG_AGENT_DELIVERY_STALE_ATTEMPT',
    );
    expect(test.sender.send).not.toHaveBeenCalled();
  });
});
