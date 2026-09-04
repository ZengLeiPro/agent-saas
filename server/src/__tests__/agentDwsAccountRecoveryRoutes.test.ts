import express from 'express';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { InMemoryGovernanceAuditStore } from '../data/governance-audit/index.js';
import type { AgentDwsAccountRecord } from '../data/agentDwsAccounts/index.js';
import { createAgentDwsAccountsRouter } from '../routes/agentDwsAccounts.js';

const USER = { sub: 'admin-a', username: 'alice', role: 'admin', tenantId: 'tenant-a' } as const;
const account: AgentDwsAccountRecord = {
  accountId: 'adws-1', tenantId: 'tenant-a', agentId: 'oa-sales', displayName: '开开',
  loginId: 'agent-login', status: 'active', runtimeStatus: 'ready', eventKinds: ['at_me'],
  profileId: 'corp-a:ding-a', corpId: 'corp-a', dingtalkUserId: 'ding-a', revision: 1,
  identityUpdatedAt: '2026-09-03T00:00:00.000Z',
  createdAt: '2026-09-04T00:00:00.000Z', createdBy: 'admin-a',
  updatedAt: '2026-09-04T00:00:00.000Z', updatedBy: 'admin-a',
};
const binding = {
  bindingId: 'binding-a', tenantId: 'tenant-a', accountId: 'adws-1', agentId: 'oa-sales',
  conversationId: 'group-a', channelKind: 'group' as const, activationState: 'active' as const,
  enabled: true, conversationSpaceId: 'space-a', serviceSessionId: 'service-a',
  workspaceId: 'ws_tenant-a__agent_oa-sales', revision: 1,
  accountIdentity: {
    profileId: 'corp-a:ding-a', corpId: 'corp-a', dingtalkUserId: 'ding-a',
    identityUpdatedAt: '2026-09-03T00:00:00.000Z',
  },
  policy: {
    enabled: true, membership: 'members' as const, guest: 'deny' as const,
    taskVisibility: 'conversation' as const, completion: 'reply_to_work_conversation' as const,
    liveDeny: false,
  },
  effectiveConfig: {
    identity: {}, instructions: { system: '' }, knowledge: { contextEnabled: false, sourceIds: [] },
    capabilities: { skillIds: [], toolNames: [], dwsResourceIds: [] },
    memory: { readAgent: true, readConversation: true, adminWriteConversation: false },
    access: { triggerRoles: [], approvalRoles: [] },
    speech: { proactive: false, requireMention: true },
  },
  createdAt: '2026-09-04T00:00:00.000Z', updatedAt: '2026-09-04T00:00:00.000Z',
};

async function listen(options: {
  messageStore: {
    listForAccount: ReturnType<typeof vi.fn>;
    hasObservedGroup?: ReturnType<typeof vi.fn>;
  };
  orgGroupAgentStore?: Record<string, unknown>;
  orgAgentStore?: Record<string, unknown>;
  account?: AgentDwsAccountRecord;
}): Promise<{ server: Server; baseUrl: string }> {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { user: typeof USER }).user = USER;
    next();
  });
  app.use('/api', createAgentDwsAccountsRouter({
    accountStore: { getForTenant: vi.fn(async (tenantId, accountId) => {
      const current = options.account ?? account;
      return tenantId === current.tenantId && accountId === current.accountId ? current : null;
    }) } as never,
    messageStore: options.messageStore as never,
    orgGroupAgentStore: options.orgGroupAgentStore as never,
    orgAgentStore: options.orgAgentStore as never,
    auditStore: new InMemoryGovernanceAuditStore(),
  }));
  return await new Promise(resolve => {
    const server = app.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({ server, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

function observedInbox() {
  return {
    inboxId: 'inbox-observed', tenantId: 'tenant-a', accountId: 'adws-1',
    eventId: 'event-observed', eventType: 'user_im_message_receive_at',
    conversationId: 'group-observed', content: '@开开', payload: {
      accountIdentity: { profileId: 'corp-a:ding-a', corpId: 'corp-a', dingtalkUserId: 'ding-a' },
    }, state: 'completed' as const,
    attempt: 1, maxAttempts: 8, leaseFence: 1,
    createdAt: '2026-09-04T00:00:00.000Z', updatedAt: '2026-09-04T00:00:00.000Z',
  };
}

function disablePayload() {
  return {
    conversationId: 'group-a', expectedRevision: 1, enabled: false,
    policy: { ...binding.policy, enabled: false, liveDeny: true },
    effectiveConfig: binding.effectiveConfig,
  };
}

describe('Agent DWS recovery routes', () => {
  let server: Server | undefined;
  afterEach(async () => {
    if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
    server = undefined;
  });

  it('inbox 诊断公开结构化拒绝终态但不返回消息正文', async () => {
    const listForAccount = vi.fn(async () => [{
      ...observedInbox(), eventType: 'user_im_message_receive_o2o_all', conversationId: 'cid-1',
      replyKind: 'access_rejection' as const, disposition: 'rejected' as const,
      rejectionReasonCode: 'ASSIGNMENT_DENIED',
      responseText: '敏感拒绝正文', lastError: null,
    }]);
    const opened = await listen({ messageStore: { listForAccount } });
    server = opened.server;

    const response = await fetch(`${opened.baseUrl}/api/agent-dws-accounts/adws-1/inbox?limit=10`);
    expect(response.status).toBe(200);
    const body = await response.json() as { items: Array<Record<string, unknown>> };
    expect(body.items[0]).toMatchObject({
      state: 'completed', replyKind: 'access_rejection', disposition: 'rejected',
      rejectionReasonCode: 'ASSIGNMENT_DENIED',
      sessionId: null, runId: null,
    });
    expect(body.items[0]).not.toHaveProperty('content');
    expect(body.items[0]).not.toHaveProperty('responseText');
    expect(listForAccount).toHaveBeenCalledWith(
      'tenant-a', 'adws-1', 10, expect.objectContaining({
        profileId: 'corp-a:ding-a', identityUpdatedAt: '2026-09-03T00:00:00.000Z',
      }),
    );
  });

  it('管理员只能用当前精确身份的群观测创建 shadow binding', async () => {
    const listForAccount = vi.fn(async () => [observedInbox()]);
    const hasObservedGroup = vi.fn(async (
      _tenantId: string, _accountId: string, conversationId: string,
    ) => conversationId === 'group-observed');
    const ensureShadowBinding = vi.fn(async (input: { conversationId: string }) => ({
      ...binding, bindingId: 'binding-observed', conversationId: input.conversationId,
      activationState: 'shadow' as const, enabled: false,
    }));
    const opened = await listen({
      messageStore: { listForAccount, hasObservedGroup },
      orgGroupAgentStore: { ensureShadowBinding, getBinding: vi.fn(async () => null) },
    });
    server = opened.server;

    const created = await fetch(
      `${opened.baseUrl}/api/agent-dws-accounts/adws-1/group-workspace/bindings`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
        conversationId: 'group-observed',
      }) },
    );
    expect(created.status).toBe(201);
    expect(ensureShadowBinding).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: 'tenant-a', accountId: 'adws-1', conversationId: 'group-observed',
      channelKind: 'group', workspaceId: expect.any(String), accountIdentity: {
        profileId: 'corp-a:ding-a', corpId: 'corp-a', dingtalkUserId: 'ding-a',
        identityUpdatedAt: '2026-09-03T00:00:00.000Z',
      },
    }));

    const unknown = await fetch(
      `${opened.baseUrl}/api/agent-dws-accounts/adws-1/group-workspace/bindings`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
        conversationId: 'group-not-observed',
      }) },
    );
    expect(unknown.status).toBe(404);
    expect(ensureShadowBinding).toHaveBeenCalledTimes(1);
    expect(hasObservedGroup).toHaveBeenCalledWith(
      'tenant-a', 'adws-1', 'group-not-observed', expect.objectContaining({
        profileId: 'corp-a:ding-a', identityUpdatedAt: '2026-09-03T00:00:00.000Z',
      }),
    );
  });

  it('N 版本在当前身份纪元创建的全 NULL binding 可被 N+1 安全接管', async () => {
    const legacyNullBinding = {
      ...binding,
      bindingId: 'binding-null',
      conversationId: 'group-observed',
      accountIdentity: undefined,
      createdAt: '2026-09-04T00:00:00.000Z',
    };
    const adopted = {
      ...legacyNullBinding,
      accountIdentity: binding.accountIdentity,
    };
    const ensureShadowBinding = vi.fn().mockResolvedValue(adopted);
    const opened = await listen({
      messageStore: {
        listForAccount: vi.fn(async () => [observedInbox()]),
        hasObservedGroup: vi.fn(async () => true),
      },
      orgGroupAgentStore: {
        getBinding: vi.fn(async () => legacyNullBinding),
        ensureShadowBinding,
      },
    });
    server = opened.server;

    const response = await fetch(
      `${opened.baseUrl}/api/agent-dws-accounts/adws-1/group-workspace/bindings`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
        conversationId: 'group-observed',
      }) },
    );

    expect(response.status).toBe(201);
    expect(ensureShadowBinding).toHaveBeenCalledWith(expect.objectContaining({
      conversationId: 'group-observed',
      accountIdentity: binding.accountIdentity,
    }));
  });

  it('早于当前身份纪元的全 NULL binding 不可被新身份接管', async () => {
    const reboundAccount: AgentDwsAccountRecord = {
      ...account,
      profileId: 'corp-b:ding-b', corpId: 'corp-b', dingtalkUserId: 'ding-b',
      identityUpdatedAt: '2026-09-05T00:00:00.000Z', revision: 2,
    };
    const ensureShadowBinding = vi.fn();
    const opened = await listen({
      account: reboundAccount,
      messageStore: {
        listForAccount: vi.fn(async () => []),
        hasObservedGroup: vi.fn(async () => true),
      },
      orgGroupAgentStore: {
        getBinding: vi.fn(async () => ({ ...binding, accountIdentity: undefined })),
        ensureShadowBinding,
      },
    });
    server = opened.server;

    const response = await fetch(
      `${opened.baseUrl}/api/agent-dws-accounts/adws-1/group-workspace/bindings`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
        conversationId: 'group-a',
      }) },
    );

    expect(response.status).toBe(409);
    expect(ensureShadowBinding).not.toHaveBeenCalled();
  });

  it('账号从身份 A 换绑 B 后不展示或授权 A 的群观测与 binding', async () => {
    const reboundAccount: AgentDwsAccountRecord = {
      ...account,
      profileId: 'corp-b:ding-b', corpId: 'corp-b', dingtalkUserId: 'ding-b',
      identityUpdatedAt: '2026-09-05T00:00:00.000Z', revision: 2,
    };
    const listForAccount = vi.fn(async () => [observedInbox()]);
    const hasObservedGroup = vi.fn(async (
      _tenantId: string,
      _accountId: string,
      _conversationId: string,
      identity: { profileId: string },
    ) => identity.profileId === 'corp-a:ding-a');
    const opened = await listen({
      account: reboundAccount,
      messageStore: { listForAccount, hasObservedGroup },
      orgGroupAgentStore: {
        listBindings: vi.fn(async () => [binding]),
        listDeliveries: vi.fn(async () => [{
          deliveryId: 'delivery-old', tenantId: 'tenant-a', accountId: 'adws-1',
          conversationId: 'group-a', bindingId: 'binding-a', source: 'command',
          deliveryKind: 'front_reply', disposition: 'replied', deliveryState: 'sent',
          content: '旧身份群回复', attempt: 1, leaseFence: 1,
          createdAt: '2026-09-04T00:00:00.000Z', updatedAt: '2026-09-04T00:00:00.000Z',
        }]),
        loadGroupWorkspace: vi.fn(async () => ({
          conversations: [], workOrders: [], attempts: [], memories: [],
        })),
        getBinding: vi.fn(async () => binding),
      },
      orgAgentStore: { get: vi.fn(() => null) },
    });
    server = opened.server;

    const workspaceResponse = await fetch(
      `${opened.baseUrl}/api/agent-dws-accounts/adws-1/group-workspace`,
    );
    expect(workspaceResponse.status).toBe(200);
    const workspaceBody = await workspaceResponse.json() as {
      bindings: unknown[];
      deliveries: unknown[];
      observedGroups: unknown[];
    };
    expect(workspaceBody.bindings).toEqual([]);
    expect(workspaceBody.deliveries).toEqual([]);
    expect(workspaceBody.observedGroups).toEqual([]);
    expect(listForAccount).toHaveBeenCalledWith(
      'tenant-a', 'adws-1', 100, expect.objectContaining({
        profileId: 'corp-b:ding-b', identityUpdatedAt: '2026-09-05T00:00:00.000Z',
      }),
    );

    const created = await fetch(
      `${opened.baseUrl}/api/agent-dws-accounts/adws-1/group-workspace/bindings`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
        conversationId: 'group-observed',
      }) },
    );
    expect(created.status).toBe(404);
    expect(await created.json()).toMatchObject({ error: expect.stringContaining('当前账号') });
    expect(hasObservedGroup).toHaveBeenCalledWith(
      'tenant-a', 'adws-1', 'group-observed', expect.objectContaining({ profileId: 'corp-b:ding-b' }),
    );

    const update = await fetch(
      `${opened.baseUrl}/api/agent-dws-accounts/adws-1/group-workspace`,
      { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(
        disablePayload(),
      ) },
    );
    expect(update.status).toBe(409);
    expect(await update.json()).toMatchObject({ error: expect.stringContaining('旧授权身份') });
  });

  it('当前身份 binding 在组织智能体不可用时仍允许管理员紧急停用', async () => {
    const updateBinding = vi.fn(async () => ({
      ...binding, activationState: 'disabled' as const, enabled: false, revision: 2,
    }));
    const opened = await listen({
      messageStore: { listForAccount: vi.fn(async () => []) },
      orgGroupAgentStore: { getBinding: vi.fn(async () => binding), updateBinding },
      orgAgentStore: { get: vi.fn(() => null) },
    });
    server = opened.server;

    const response = await fetch(`${opened.baseUrl}/api/agent-dws-accounts/adws-1/group-workspace`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(disablePayload()),
    });
    expect(response.status).toBe(200);
    expect(updateBinding).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: 'tenant-a', accountId: 'adws-1', conversationId: 'group-a', enabled: false,
    }));
  });
});
