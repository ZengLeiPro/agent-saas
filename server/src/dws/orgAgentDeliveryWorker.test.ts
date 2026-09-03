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
}) {
  const store = {
    reconcileAllExpiredDeliveries: vi.fn().mockResolvedValue(0),
    claimNextDelivery: vi.fn().mockResolvedValue(input?.pending === false ? null : delivery),
    getBinding: vi.fn().mockResolvedValue({
      bindingId: 'binding-1',
      agentId: 'agent-1',
      activationState: 'active',
      enabled: true,
      policy: { enabled: true, liveDeny: input?.liveDeny ?? false, completion: 'announce' },
    }),
    markClaimedDeliveryDeadLetter: vi.fn().mockResolvedValue(undefined),
    markDeliverySent: vi.fn().mockResolvedValue(undefined),
    markDeliveryUnknown: vi.fn().mockResolvedValue(undefined),
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
        getForTenant: vi.fn().mockResolvedValue(account),
      } as unknown as AgentDwsAccountStore,
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
});
