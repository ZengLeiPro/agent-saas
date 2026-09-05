import express from 'express';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { InMemoryGovernanceAuditStore } from '../data/governance-audit/index.js';
import type { AgentDwsAccountStore } from '../data/agentDwsAccounts/index.js';
import type {
  OrgAgentChannelBinding,
  OrgGroupAgentStore,
} from '../data/orgGroupAgents/index.js';
import { createAgentDwsAccountsRouter } from '../routes/agentDwsAccounts.js';

const USER = { sub: 'admin-a', username: 'alice', role: 'admin', tenantId: 'tenant-a' } as const;

function binding(legacyResource: boolean): OrgAgentChannelBinding {
  return {
    bindingId: 'binding-a', tenantId: 'tenant-a', accountId: 'adws-1', agentId: 'oa-sales',
    conversationId: 'group-live-deny', channelKind: 'group', conversationSpaceId: 'space-a',
    serviceSessionId: 'org-agent-service:binding-a', workspaceId: 'tenant-a/.agent-oa-sales',
    activationState: 'active', enabled: true,
    accountIdentity: {
      profileId: 'corp-a:ding-a', corpId: 'corp-a', dingtalkUserId: 'ding-a',
      identityUpdatedAt: '2026-08-12T00:00:00.000Z',
    },
    policy: {
      enabled: true, membership: 'members', guest: 'deny', taskVisibility: 'conversation',
      completion: 'reply_to_work_conversation', liveDeny: false,
    },
    effectiveConfig: {
      identity: {}, instructions: { system: '' },
      knowledge: { contextEnabled: false, sourceIds: [] },
      capabilities: legacyResource
        ? { skillIds: [], toolNames: ['DwsBusiness'], dwsResourceIds: ['drive:legacy-folder'] }
        : { skillIds: [], toolNames: [], dwsResourceIds: [] },
      memory: { readAgent: true, readConversation: true, adminWriteConversation: true },
      access: { triggerRoles: [], approvalRoles: [] },
      speech: { proactive: false, requireMention: true },
    },
    revision: 1, createdAt: '2026-09-04T00:00:00.000Z',
    updatedAt: '2026-09-04T00:00:00.000Z',
  };
}

async function listen(input: {
  agentEnabled: boolean;
  runtimeReady: boolean;
  legacyResource: boolean;
}) {
  const current = binding(input.legacyResource);
  const updateBinding = vi.fn(async (
    patch: Parameters<OrgGroupAgentStore['updateBinding']>[0],
  ) => ({ ...current, ...patch }));
  const accountStore = {
    getForTenant: vi.fn().mockResolvedValue({
      accountId: 'adws-1', tenantId: 'tenant-a', agentId: 'oa-sales',
      displayName: '销售数字员工', loginId: 'sales-agent-001', status: 'active',
      runtimeStatus: 'ready', eventKinds: ['at_me'], revision: 1,
      profileId: 'corp-a:ding-a', corpId: 'corp-a', dingtalkUserId: 'ding-a',
      identityUpdatedAt: '2026-08-12T00:00:00.000Z',
      createdAt: '2026-08-13T00:00:00.000Z', createdBy: 'admin-a',
      updatedAt: '2026-08-13T00:00:00.000Z', updatedBy: 'admin-a',
    }),
  } as unknown as AgentDwsAccountStore;
  const runtimeCheck = vi.fn(() => input.runtimeReady);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { user: typeof USER }).user = USER;
    next();
  });
  app.use('/api', createAgentDwsAccountsRouter({
    accountStore,
    auditStore: new InMemoryGovernanceAuditStore(),
    orgGroupAgentStore: {
      getBinding: vi.fn().mockResolvedValue(current),
      updateBinding,
    } as unknown as OrgGroupAgentStore,
    orgAgentStore: { get: vi.fn(() => ({
      id: 'oa-sales', tenantId: 'tenant-a', enabled: input.agentEnabled,
      allowedSkills: [], allowedKnowledge: [], runtime: { executionMode: 'dispatcher' },
    })) } as never,
    isOrgAgentRuntimeV2Ready: runtimeCheck,
  }));
  const server = await new Promise<Server>(resolve => {
    const next = app.listen(0, '127.0.0.1', () => resolve(next));
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return { server, baseUrl: `http://127.0.0.1:${port}`, runtimeCheck, updateBinding };
}

function liveDenyBody(legacyResource: boolean) {
  return {
    conversationId: 'group-live-deny', expectedRevision: 1, enabled: true,
    policy: {
      enabled: true, membership: 'members', guest: 'deny', taskVisibility: 'conversation',
      completion: 'reply_to_work_conversation', liveDeny: true,
    },
    effectiveConfig: {
      identity: {}, knowledge: { contextEnabled: false, sourceIds: [] },
      capabilities: { skillIds: [], toolNames: legacyResource ? ['DwsBusiness'] : [] },
      access: { triggerRoles: [], approvalRoles: [] },
      speech: { proactive: false, requireMention: true },
    },
  };
}

describe('Agent DWS 群配置 liveDeny 紧急止血', () => {
  let server: Server | undefined;
  afterEach(async () => {
    if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
    server = undefined;
  });

  it.each([
    { obstacle: 'Agent disabled', agentEnabled: false, runtimeReady: true, legacyResource: false },
    { obstacle: 'Runtime unavailable', agentEnabled: true, runtimeReady: false, legacyResource: false },
    { obstacle: 'legacy DWS resource', agentEnabled: true, runtimeReady: true, legacyResource: true },
  ])('跳过完整激活门禁：$obstacle', async (scenario) => {
    const opened = await listen(scenario);
    server = opened.server;
    const response = await fetch(
      `${opened.baseUrl}/api/agent-dws-accounts/adws-1/group-workspace`,
      {
        method: 'PATCH', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(liveDenyBody(scenario.legacyResource)),
      },
    );

    expect(response.status).toBe(200);
    expect(opened.updateBinding).toHaveBeenCalledWith(expect.objectContaining({
      enabled: true,
      policy: expect.objectContaining({ liveDeny: true }),
    }));
    expect(opened.runtimeCheck).not.toHaveBeenCalled();
  });
});
