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
  createdAt: '2026-09-04T00:00:00.000Z', createdBy: 'admin-a',
  updatedAt: '2026-09-04T00:00:00.000Z', updatedBy: 'admin-a',
};
const binding = {
  bindingId: 'binding-a', tenantId: 'tenant-a', accountId: 'adws-1', agentId: 'oa-sales',
  conversationId: 'group-a', channelKind: 'group' as const, activationState: 'active' as const,
  enabled: true, conversationSpaceId: 'space-a', serviceSessionId: 'service-a',
  workspaceId: 'ws_tenant-a__agent_oa-sales', revision: 1,
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
}): Promise<{ server: Server; baseUrl: string }> {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { user: typeof USER }).user = USER;
    next();
  });
  app.use('/api', createAgentDwsAccountsRouter({
    accountStore: { getForTenant: vi.fn(async (tenantId, accountId) => (
      tenantId === account.tenantId && accountId === account.accountId ? account : null
    )) } as never,
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
    conversationId: 'group-observed', content: '@开开', payload: {}, state: 'completed' as const,
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
  });

  it('管理员只能从当前账号已观测的群创建 shadow binding', async () => {
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
      orgGroupAgentStore: { ensureShadowBinding },
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
      channelKind: 'group', workspaceId: expect.any(String),
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
      'tenant-a', 'adws-1', 'group-not-observed',
    );
  });

  it('组织智能体不可用时仍允许管理员紧急停用群绑定', async () => {
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
