import { describe, expect, it, vi } from 'vitest';

import type { AgentDwsAccountRecord } from '../data/agentDwsAccounts/index.js';
import type { AgentDwsInboxRecord } from '../data/agentDwsMessages/index.js';
import type { DwsDeliveryIntent, OrgGroupAgentStore } from '../data/orgGroupAgents/index.js';
import {
  finalizeReplyDelivery, OrgAgentVisibleReplyService, settleFrontReply,
} from './orgAgentVisibleReply.js';

const account = {
  accountId: 'account-a',
  tenantId: 'tenant-a',
  agentId: 'agent-a',
  corpId: 'corp-a',
  dingtalkUserId: 'front-a',
  profileId: 'corp-a:front-a',
  identityUpdatedAt: '2026-09-03T00:00:00.000Z',
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
  payload: { accountIdentity: {
    profileId: 'corp-a:front-a', corpId: 'corp-a', dingtalkUserId: 'front-a',
  } },
  state: 'processing', attempt: 1, maxAttempts: 8, leaseFence: 1,
  createdAt: '2026-09-04T00:00:00.000Z',
  updatedAt: '2026-09-04T00:00:00.000Z',
} satisfies AgentDwsInboxRecord;
const delivery = {
  deliveryId: 'delivery-a',
  tenantId: 'tenant-a',
  accountId: 'account-a',
  accountIdentity: {
    profileId: 'corp-a:front-a', corpId: 'corp-a', dingtalkUserId: 'front-a',
    identityUpdatedAt: '2026-09-03T00:00:00.000Z',
  },
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
    markClaimedDeliveryDeadLetter: vi.fn().mockResolvedValue({
      ...delivery, deliveryState: 'dead_letter',
    }),
    releaseClaimedDeliveryForRetry: vi.fn().mockResolvedValue(delivery),
  } as unknown as OrgGroupAgentStore;
  const accountStore = { getForTenant: vi.fn().mockResolvedValue(account) };
  const sender = {
    send: vi.fn(async (
      _account: unknown,
      _event: unknown,
      _text: string,
      _key: string,
      onProviderStart?: () => Promise<void>,
    ) => {
      await onProviderStart?.();
      return { status: 'accepted' };
    }),
  };
  const service = new OrgAgentVisibleReplyService(
    { accountStore: accountStore as never, orgGroupAgentStore: store, sender },
    'worker-a',
    60_000,
    5,
  );
  return { accountStore, store, sender, service };
}

describe('OrgAgentVisibleReplyService delivery fences', () => {
  it('统一把 unknown/dead-letter 转成人工核对，并拒绝把 pending 当成功', async () => {
    const messageStore = { markReplyUnknown: vi.fn().mockResolvedValue(undefined) } as never;
    await expect(finalizeReplyDelivery(
      messageStore, 'worker-a', item, { ...delivery, deliveryState: 'unknown' },
    )).resolves.toBe(false);
    expect((messageStore as { markReplyUnknown: ReturnType<typeof vi.fn> }).markReplyUnknown)
      .toHaveBeenCalledWith(item.inboxId, 'worker-a', item.leaseFence);
    await expect(finalizeReplyDelivery(
      messageStore, 'worker-a', item, delivery,
    )).rejects.toThrow('AGENT_DWS_REPLY_DELIVERY_NOT_SENT:pending');
  });

  it('sender 跨越 transport 边界时持久化 provider phase 并在成功后记录 receipt', async () => {
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
    ).toBeLessThan(vi.mocked(test.store.markDeliverySent).mock.invocationCallOrder[0]!);
    expect(test.store.markDeliverySent).toHaveBeenCalledOnce();
  });

  it('direct intent 创建后账号切换为 B 时在 provider transport 前 fail-closed', async () => {
    const test = harness();
    test.accountStore.getForTenant.mockResolvedValueOnce({
      ...account, profileId: 'corp-b:front-b', corpId: 'corp-b', dingtalkUserId: 'front-b',
      identityUpdatedAt: '2026-09-05T00:00:00.000Z',
    });

    await expect(
      test.service.send(account, item, '旧身份正文', undefined, 'front_reply', 'replied'),
    ).resolves.toMatchObject({ deliveryState: 'dead_letter' });
    expect(test.store.markClaimedDeliveryDeadLetter).toHaveBeenCalledWith(
      'delivery-a', 'worker-a', 1, 'ORG_AGENT_DELIVERY_ACCOUNT_IDENTITY_STALE',
    );
    expect(test.store.markDeliveryProviderStarted).not.toHaveBeenCalled();
    expect(test.sender.send).not.toHaveBeenCalled();
  });

  it('releases before-provider failures without calling the channel', async () => {
    const test = harness();
    vi.mocked(test.store.markDeliveryProviderStarted).mockRejectedValueOnce(new Error('db down'));
    await expect(
      test.service.send(account, item, '完成', undefined, 'front_reply', 'replied'),
    ).rejects.toThrow('db down');
    expect(test.sender.send).toHaveBeenCalledOnce();
    expect(test.store.releaseClaimedDeliveryForRetry).toHaveBeenCalledWith(
      'delivery-a',
      'worker-a',
      1,
      expect.any(Error),
      1_000,
      5,
    );
  });

  it('sender 准备期间停用 binding 时 provider fence 阻断实际发送', async () => {
    const test = harness();
    const providerInvoke = vi.fn();
    vi.mocked(test.store.markDeliveryProviderStarted).mockRejectedValueOnce(
      new Error('DWS_DELIVERY_LEASE_LOST'),
    );
    vi.mocked(test.sender.send).mockImplementationOnce(async (
      _account, _event, _text, _key, onProviderStart,
    ) => {
      await onProviderStart?.();
      providerInvoke();
      return { status: 'accepted' };
    });

    await expect(
      test.service.send(account, item, '完成', undefined, 'front_reply', 'replied'),
    ).rejects.toThrow('DWS_DELIVERY_LEASE_LOST');
    expect(providerInvoke).not.toHaveBeenCalled();
    expect(test.store.markDeliveryUnknown).not.toHaveBeenCalled();
    expect(test.store.releaseClaimedDeliveryForRetry).toHaveBeenCalledOnce();
  });

  it('sender 本地准备失败时释放为 pending，不误记 provider unknown', async () => {
    const test = harness();
    vi.mocked(test.sender.send).mockRejectedValueOnce(new Error('resolve remote failed'));

    await expect(
      test.service.send(account, item, '完成', undefined, 'front_reply', 'replied'),
    ).rejects.toThrow('resolve remote failed');
    expect(test.store.markDeliveryProviderStarted).not.toHaveBeenCalled();
    expect(test.store.markDeliveryUnknown).not.toHaveBeenCalled();
    expect(test.store.releaseClaimedDeliveryForRetry).toHaveBeenCalledOnce();
  });

  it('provider 已开始后的歧义返回 unknown durable intent 供人工核对', async () => {
    const test = harness();
    vi.mocked(test.sender.send).mockImplementationOnce(async (
      _account,
      _event,
      _text,
      _key,
      onProviderStart,
    ) => {
      await onProviderStart?.();
      throw new Error('provider unavailable');
    });
    vi.mocked(test.store.markDeliveryUnknown).mockResolvedValueOnce({
      ...delivery, deliveryState: 'unknown', providerAttemptPhase: 'provider_started',
    });

    await expect(
      test.service.send(account, item, '完成', undefined, 'front_reply', 'replied'),
    ).resolves.toMatchObject({ deliveryState: 'unknown' });
    expect(test.store.markDeliveryUnknown).toHaveBeenCalledOnce();
    expect(test.store.releaseClaimedDeliveryForRetry).not.toHaveBeenCalled();
  });

  it('sends a final reply only when the deadline fallback won the first intent', async () => {
    const fallback = { ...delivery, source: 'system' as const, deliveryState: 'sent' as const };
    const sendNatural = vi.fn().mockResolvedValue(undefined);
    const sendFinal = vi.fn().mockResolvedValue(delivery);
    await settleFrontReply({ cancel: vi.fn().mockResolvedValue(fallback) }, sendNatural, sendFinal);
    expect(sendNatural).toHaveBeenCalledOnce();
    expect(sendFinal).toHaveBeenCalledOnce();
  });

  it('unknown fallback 不发送另一幂等键的 final reply', async () => {
    const fallback = { ...delivery, source: 'system' as const, deliveryState: 'unknown' as const };
    const sendFinal = vi.fn();
    await expect(settleFrontReply(
      { cancel: vi.fn().mockResolvedValue(fallback) },
      vi.fn().mockResolvedValue(fallback),
      sendFinal,
    )).resolves.toMatchObject({ deliveryState: 'unknown' });
    expect(sendFinal).not.toHaveBeenCalled();
  });

  it('does not send a second reply when the natural response owns the first intent', async () => {
    const sendFinal = vi.fn();
    await settleFrontReply(undefined, vi.fn().mockResolvedValue(delivery), sendFinal);
    expect(sendFinal).not.toHaveBeenCalled();
  });
});
