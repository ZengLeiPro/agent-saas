import { describe, expect, it, vi } from 'vitest';

import type { AgentDwsAccountRecord } from '../data/agentDwsAccounts/index.js';
import type { AgentDwsInboxRecord } from '../data/agentDwsMessages/index.js';
import type { DwsDeliveryIntent, OrgGroupAgentStore } from '../data/orgGroupAgents/index.js';
import { OrgAgentVisibleReplyService, settleFrontReply } from './orgAgentVisibleReply.js';

const account = {
  accountId: 'account-a',
  tenantId: 'tenant-a',
  agentId: 'agent-a',
  corpId: 'corp-a',
  dingtalkUserId: 'front-a',
  profileId: 'corp-a:front-a',
  status: 'active',
} as AgentDwsAccountRecord;
const item = {
  inboxId: 'inbox-a',
  tenantId: 'tenant-a',
  accountId: 'account-a',
  eventId: 'event-a',
  eventType: 'user_im_message_receive_at',
  conversationId: 'group-a',
  content: '处理',
  payload: {},
} as AgentDwsInboxRecord;
const delivery = {
  deliveryId: 'delivery-a',
  tenantId: 'tenant-a',
  accountId: 'account-a',
  conversationId: 'group-a',
  source: 'command',
  deliveryKind: 'front_reply',
  disposition: 'replied',
  deliveryState: 'pending',
  destination: {
    provider: 'dingtalk',
    accountId: 'account-a',
    conversationId: 'group-a',
    kind: 'group',
  },
  content: '完成',
  idempotencyKey: 'key-a',
  attempt: 0,
  leaseFence: 0,
  providerAttemptPhase: 'legacy_unknown',
} as DwsDeliveryIntent;

function harness() {
  const store = {
    createDelivery: vi.fn().mockResolvedValue(delivery),
    claimDelivery: vi
      .fn()
      .mockResolvedValue({ ...delivery, deliveryState: 'sending', attempt: 1, leaseFence: 1 }),
    getDelivery: vi.fn(),
    markDeliveryProviderStarted: vi.fn().mockResolvedValue(delivery),
    markDeliverySent: vi.fn().mockResolvedValue(delivery),
    markDeliveryUnknown: vi.fn().mockResolvedValue(delivery),
    releaseClaimedDeliveryForRetry: vi.fn().mockResolvedValue(delivery),
  } as unknown as OrgGroupAgentStore;
  const sender = { send: vi.fn().mockResolvedValue({ status: 'accepted' }) };
  const service = new OrgAgentVisibleReplyService(
    { accountStore: {} as never, orgGroupAgentStore: store, sender },
    'worker-a',
    60_000,
    5,
  );
  return { store, sender, service };
}

describe('OrgAgentVisibleReplyService', () => {
  it('persists provider phase before sending and then records receipt', async () => {
    const test = harness();
    await test.service.send(account, item, '完成', undefined, 'front_reply', 'replied');
    expect(test.store.markDeliveryProviderStarted).toHaveBeenCalledWith(
      'delivery-a',
      'worker-a',
      1,
    );
    expect(test.sender.send).toHaveBeenCalledOnce();
    expect(
      vi.mocked(test.store.markDeliveryProviderStarted).mock.invocationCallOrder[0],
    ).toBeLessThan(test.sender.send.mock.invocationCallOrder[0]!);
    expect(test.store.markDeliverySent).toHaveBeenCalledOnce();
  });

  it('releases before-provider failures without calling the channel', async () => {
    const test = harness();
    vi.mocked(test.store.markDeliveryProviderStarted).mockRejectedValueOnce(new Error('db down'));
    await test.service.send(account, item, '完成', undefined, 'front_reply', 'replied');
    expect(test.sender.send).not.toHaveBeenCalled();
    expect(test.store.releaseClaimedDeliveryForRetry).toHaveBeenCalledWith(
      'delivery-a',
      'worker-a',
      1,
      expect.any(Error),
      1_000,
      5,
    );
  });

  it('sends a final reply only when the deadline fallback won the first intent', async () => {
    const fallback = { ...delivery, source: 'system' as const };
    const sendNatural = vi.fn().mockResolvedValue(undefined);
    const sendFinal = vi.fn().mockResolvedValue(delivery);
    await settleFrontReply({ cancel: vi.fn().mockResolvedValue(fallback) }, sendNatural, sendFinal);
    expect(sendNatural).toHaveBeenCalledOnce();
    expect(sendFinal).toHaveBeenCalledOnce();
  });

  it('does not send a second reply when the natural response owns the first intent', async () => {
    const sendFinal = vi.fn();
    await settleFrontReply(undefined, vi.fn().mockResolvedValue(delivery), sendFinal);
    expect(sendFinal).not.toHaveBeenCalled();
  });
});
