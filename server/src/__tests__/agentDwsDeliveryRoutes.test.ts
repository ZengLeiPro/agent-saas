import type { Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createAgentDwsAccountsRouter } from '../routes/agentDwsAccounts.js';
import {
  FakeAccountStore,
  listenForAgentDwsAccountRoutes as listen,
  makeAccount,
} from './agentDwsAccountsRoutes.fixtures.js';

describe('Agent DWS delivery recovery routes', () => {
  let server: Server | undefined;
  afterEach(async () => {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  });

  it('私聊 unknown 可按当前账号身份与固定会话核对，不依赖群 bindingId', async () => {
    const store = new FakeAccountStore();
    store.records.push(
      makeAccount({
        status: 'active',
        profileId: 'corp-a:ding-a',
        corpId: 'corp-a',
        dingtalkUserId: 'ding-a',
      }),
    );
    const directDelivery = {
      deliveryId: 'delivery-direct',
      tenantId: 'tenant-a',
      inboxId: 'inbox-direct',
      accountId: 'adws-1',
      accountIdentity: {
        profileId: 'corp-a:ding-a',
        corpId: 'corp-a',
        dingtalkUserId: 'ding-a',
        identityUpdatedAt: '2026-08-12T00:00:00.000Z',
      },
      conversationId: 'direct-conversation-a',
      source: 'command' as const,
      deliveryKind: 'front_reply' as const,
      disposition: 'replied' as const,
      deliveryState: 'unknown' as const,
      destination: {
        provider: 'dingtalk' as const,
        accountId: 'adws-1',
        conversationId: 'direct-conversation-a',
        kind: 'direct' as const,
        peerOpenId: 'peer-open-a',
      },
      content: '私聊最终正文',
      idempotencyKey: 'stable-direct-key',
      attempt: 1,
      leaseFence: 2,
      providerAttemptPhase: 'provider_started' as const,
      createdAt: '2026-09-08T00:00:00.000Z',
      updatedAt: '2026-09-08T00:00:01.000Z',
    };
    const reconcileDelivery = vi.fn(async () => ({
      ...directDelivery,
      deliveryState: 'pending' as const,
    }));
    const orgGroupAgentStore = {
      getDelivery: vi.fn(async () => directDelivery),
      getBindingById: vi.fn(async () => null),
      reconcileDelivery,
    } as unknown as NonNullable<
      Parameters<typeof createAgentDwsAccountsRouter>[0]['orgGroupAgentStore']
    >;
    const opened = await listen({ store, orgGroupAgentStore });
    server = opened.server;
    const response = await fetch(
      `${opened.baseUrl}/api/agent-dws-accounts/adws-1/deliveries/delivery-direct/reconcile`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          outcome: 'confirmed_not_sent',
          reason: 'provider log confirmed no message',
          evidence: { ticket: 'ticket-a' },
        }),
      },
    );
    expect(response.status).toBe(200);
    expect(orgGroupAgentStore.getBindingById).not.toHaveBeenCalled();
    expect(reconcileDelivery).toHaveBeenCalledWith({
      tenantId: 'tenant-a',
      deliveryId: 'delivery-direct',
      actorId: 'alice',
      reason: 'provider log confirmed no message',
      evidence: { ticket: 'ticket-a' },
      outcome: 'confirmed_not_sent',
    });
  });

  it('账号级诊断只返回当前身份的脱敏 direct unknown', async () => {
    const store = new FakeAccountStore();
    store.records.push(
      makeAccount({
        status: 'active',
        profileId: 'corp-a:ding-a',
        corpId: 'corp-a',
        dingtalkUserId: 'ding-a',
      }),
    );
    const currentIdentity = {
      profileId: 'corp-a:ding-a',
      corpId: 'corp-a',
      dingtalkUserId: 'ding-a',
      identityUpdatedAt: '2026-08-12T00:00:00.000Z',
    };
    const listDeliveries = vi.fn(async () => [
      {
        deliveryId: 'delivery-current',
        tenantId: 'tenant-a',
        inboxId: 'inbox-a',
        accountId: 'adws-1',
        accountIdentity: currentIdentity,
        conversationId: 'direct-a',
        source: 'command',
        deliveryKind: 'front_reply',
        disposition: 'replied',
        deliveryState: 'unknown',
        destination: {
          provider: 'dingtalk',
          accountId: 'adws-1',
          conversationId: 'direct-a',
          kind: 'direct',
          peerOpenId: 'secret-peer-a',
        },
        content: '不能出现在诊断响应中的正文',
        idempotencyKey: 'secret-key',
        attempt: 1,
        leaseFence: 2,
        providerAttemptPhase: 'provider_started',
        lastError: 'HTTP 500 provider body secret-token',
        createdAt: '2026-09-08T00:00:00.000Z',
        updatedAt: '2026-09-08T00:00:01.000Z',
      },
      {
        deliveryId: 'delivery-stale',
        tenantId: 'tenant-a',
        accountId: 'adws-1',
        accountIdentity: { ...currentIdentity, dingtalkUserId: 'old-user' },
        conversationId: 'direct-old',
        source: 'command',
        deliveryKind: 'front_reply',
        disposition: 'replied',
        deliveryState: 'unknown',
        destination: {
          provider: 'dingtalk',
          accountId: 'adws-1',
          conversationId: 'direct-old',
          kind: 'direct',
          peerOpenId: 'old-peer',
        },
        content: '旧身份正文',
        idempotencyKey: 'old-key',
        attempt: 1,
        leaseFence: 1,
        providerAttemptPhase: 'provider_started',
        createdAt: '2026-09-01T00:00:00.000Z',
        updatedAt: '2026-09-01T00:00:01.000Z',
      },
    ]);
    const opened = await listen({ store, orgGroupAgentStore: { listDeliveries } as never });
    server = opened.server;
    const response = await fetch(
      `${opened.baseUrl}/api/agent-dws-accounts/adws-1/deliveries?limit=20`,
    );
    const body = (await response.json()) as { deliveries: Array<Record<string, unknown>> };
    expect(response.status).toBe(200);
    expect(body.deliveries).toEqual([
      expect.objectContaining({
        deliveryId: 'delivery-current',
        channelKind: 'direct',
        deliveryState: 'unknown',
      }),
    ]);
    for (const secret of [
      '不能出现在诊断响应中的正文',
      'secret-peer-a',
      'secret-key',
      'secret-token',
      'delivery-stale',
    ])
      expect(JSON.stringify(body)).not.toContain(secret);
    expect(body.deliveries[0]).not.toHaveProperty('lastErrorCode');
    expect(listDeliveries).toHaveBeenCalledWith('tenant-a', 'adws-1', 20);
  });

  it('私聊核对在账号身份或目标会话不匹配时 fail closed', async () => {
    const store = new FakeAccountStore();
    store.records.push(
      makeAccount({
        status: 'active',
        profileId: 'corp-a:ding-a',
        corpId: 'corp-a',
        dingtalkUserId: 'ding-a',
      }),
    );
    const reconcileDelivery = vi.fn();
    const orgGroupAgentStore = {
      getDelivery: vi.fn(async () => ({
        deliveryId: 'delivery-direct',
        tenantId: 'tenant-a',
        accountId: 'adws-1',
        accountIdentity: {
          profileId: 'corp-old:ding-old',
          corpId: 'corp-old',
          dingtalkUserId: 'ding-old',
          identityUpdatedAt: '2026-08-01T00:00:00.000Z',
        },
        conversationId: 'direct-a',
        source: 'command',
        deliveryKind: 'front_reply',
        disposition: 'replied',
        deliveryState: 'unknown',
        destination: {
          provider: 'dingtalk',
          accountId: 'adws-1',
          conversationId: 'other-direct',
          kind: 'direct',
          peerOpenId: 'peer-a',
        },
        content: '正文',
        idempotencyKey: 'stable',
        attempt: 1,
        leaseFence: 1,
        providerAttemptPhase: 'provider_started',
        createdAt: '2026-09-08T00:00:00.000Z',
        updatedAt: '2026-09-08T00:00:01.000Z',
      })),
      getBindingById: vi.fn(async () => null),
      reconcileDelivery,
    } as unknown as NonNullable<
      Parameters<typeof createAgentDwsAccountsRouter>[0]['orgGroupAgentStore']
    >;
    const opened = await listen({ store, orgGroupAgentStore });
    server = opened.server;
    const response = await fetch(
      `${opened.baseUrl}/api/agent-dws-accounts/adws-1/deliveries/delivery-direct/reconcile`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ outcome: 'confirmed_sent', reason: 'checked', evidence: {} }),
      },
    );
    expect(response.status).toBe(404);
    expect(reconcileDelivery).not.toHaveBeenCalled();
  });
});
