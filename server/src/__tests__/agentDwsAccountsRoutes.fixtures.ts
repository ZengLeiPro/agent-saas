import express from 'express';
import type { Server } from 'node:http';
import { expect, vi } from 'vitest';

import { InMemoryGovernanceAuditStore } from '../data/governance-audit/index.js';
import type {
  AgentDwsAccountRecord,
  AgentDwsAccountStore,
  AgentDwsAuthorizationMode,
  CreateAgentDwsAccountInput,
} from '../data/agentDwsAccounts/index.js';
import type { AgentDwsMessageStore } from '../data/agentDwsMessages/index.js';
import type { OrgAgentChannelBinding } from '../data/orgGroupAgents/index.js';
import type { AgentDwsAuthFlowServiceLike } from '../dws/agentAuthFlow.js';
import { createAgentDwsAccountsRouter } from '../routes/agentDwsAccounts.js';

export const ROUTE_TEST_USER = {
  sub: 'admin-a',
  username: 'alice',
  role: 'admin',
  tenantId: 'tenant-a',
} as const;

export class FakeAccountStore implements AgentDwsAccountStore {
  records: AgentDwsAccountRecord[] = [];
  init = vi.fn(async () => undefined);
  listRunnable = vi.fn(async () => this.records.filter((record) => record.status === 'active'));
  listForTenant = vi.fn(async (tenantId: string) =>
    this.records.filter((record) => record.tenantId === tenantId),
  );
  getForTenant = vi.fn(
    async (tenantId: string, accountId: string) =>
      this.records.find(
        (record) => record.tenantId === tenantId && record.accountId === accountId,
      ) ?? null,
  );
  deleteForTenant = vi.fn(async (tenantId: string) => {
    const before = this.records.length;
    this.records = this.records.filter((record) => record.tenantId !== tenantId);
    return before - this.records.length;
  });
  create = vi.fn(async (input: CreateAgentDwsAccountInput) => {
    const record = makeAccount({
      tenantId: input.tenantId,
      agentId: input.agentId,
      displayName: input.displayName,
      loginId: input.loginId,
      eventKinds: input.eventKinds,
    });
    this.records.push(record);
    return record;
  });
  markAuthorizing = vi.fn(
    async (
      tenantId: string,
      accountId: string,
      expectedRevision: number,
      _updatedBy: string,
      _mode: AgentDwsAuthorizationMode = 'reauthorize',
    ) => {
      const record = await this.required(tenantId, accountId);
      expect(expectedRevision).toBe(record.revision);
      Object.assign(record, { status: 'authorizing', revision: record.revision + 1 });
      return record;
    },
  );
  markAuthorized = vi.fn();
  markAuthorizationFailed = vi.fn(async () => undefined);
  setEnabled = vi.fn(
    async (tenantId: string, accountId: string, enabled: boolean, expectedRevision: number) => {
      const record = await this.required(tenantId, accountId);
      expect(expectedRevision).toBe(record.revision);
      Object.assign(record, {
        status: enabled ? (record.profileId ? 'active' : 'draft') : 'paused',
        revision: record.revision + 1,
      });
      return record;
    },
  );
  setContextPolicy = vi.fn(
    async (
      tenantId: string,
      accountId: string,
      policy: NonNullable<AgentDwsAccountRecord['contextPolicy']>,
      expectedRevision: number,
    ) => {
      const record = await this.required(tenantId, accountId);
      expect(expectedRevision).toBe(record.revision);
      Object.assign(record, { contextPolicy: policy, revision: record.revision + 1 });
      return record;
    },
  );
  claimRuntimeLease = vi.fn(async () => true);
  renewRuntimeLease = vi.fn(async () => true);
  releaseRuntimeLease = vi.fn(async () => undefined);
  revokeRuntimeLease = vi.fn(async () => undefined);
  updateRuntimeStatus = vi.fn(async () => undefined);
  markEvent = vi.fn(async () => true);

  private async required(tenantId: string, accountId: string) {
    const record = await this.getForTenant(tenantId, accountId);
    if (!record) throw new Error('missing');
    return record;
  }
}

export async function listenForAgentDwsAccountRoutes(options: {
  store: FakeAccountStore;
  messageStore?: Pick<AgentDwsMessageStore, 'listForAccount'>;
  authFlowService?: AgentDwsAuthFlowServiceLike;
  audit?: InMemoryGovernanceAuditStore;
  onContextPolicyUpdated?: (account: AgentDwsAccountRecord) => void | Promise<void>;
  onEnabledChanged?: (account: AgentDwsAccountRecord, enabled: boolean) => void | Promise<void>;
  orgGroupAgentStore?: Parameters<typeof createAgentDwsAccountsRouter>[0]['orgGroupAgentStore'];
  orgAgentStore?: Parameters<typeof createAgentDwsAccountsRouter>[0]['orgAgentStore'];
  backgroundTasks?: Parameters<typeof createAgentDwsAccountsRouter>[0]['backgroundTasks'];
  assignmentStore?: Parameters<typeof createAgentDwsAccountsRouter>[0]['assignmentStore'];
  contextStore?: Parameters<typeof createAgentDwsAccountsRouter>[0]['contextStore'];
  isOrgAgentRuntimeV2Ready?: () => boolean;
}): Promise<{ server: Server; baseUrl: string }> {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { user: typeof ROUTE_TEST_USER }).user = ROUTE_TEST_USER;
    next();
  });
  app.use(
    '/api',
    createAgentDwsAccountsRouter({
      accountStore: options.store,
      messageStore: options.messageStore,
      authFlowService: options.authFlowService,
      auditStore: options.audit ?? new InMemoryGovernanceAuditStore(),
      orgGroupAgentStore: options.orgGroupAgentStore,
      orgAgentStore: options.orgAgentStore,
      backgroundTasks: options.backgroundTasks,
      assignmentStore: options.assignmentStore,
      contextStore: options.contextStore,
      isOrgAgentRuntimeV2Ready: options.isOrgAgentRuntimeV2Ready ?? (() => true),
      ...(options.onContextPolicyUpdated
        ? { onContextPolicyUpdated: options.onContextPolicyUpdated }
        : {}),
      ...(options.onEnabledChanged ? { onEnabledChanged: options.onEnabledChanged } : {}),
    }),
  );
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({ server, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

export function makeAccount(overrides: Partial<AgentDwsAccountRecord> = {}): AgentDwsAccountRecord {
  return {
    accountId: 'adws-1',
    tenantId: 'tenant-a',
    agentId: 'oa-sales',
    displayName: '销售数字员工',
    loginId: 'sales-agent-001',
    status: 'draft',
    runtimeStatus: 'stopped',
    eventKinds: ['at_me', 'all_direct'],
    revision: 1,
    identityUpdatedAt: '2026-08-12T00:00:00.000Z',
    createdAt: '2026-08-13T00:00:00.000Z',
    createdBy: 'admin-a',
    updatedAt: '2026-08-13T00:00:00.000Z',
    updatedBy: 'admin-a',
    ...overrides,
  };
}

export function makeGroupBinding(
  overrides: Partial<OrgAgentChannelBinding> = {},
): OrgAgentChannelBinding {
  return {
    bindingId: 'binding-a',
    tenantId: 'tenant-a',
    accountId: 'adws-1',
    agentId: 'oa-sales',
    conversationId: 'cid-a',
    channelKind: 'group',
    conversationSpaceId: 'space-a',
    serviceSessionId: 'org-agent-service:binding-a',
    workspaceId: 'tenant-a/.agent-oa-sales',
    activationState: 'active',
    enabled: true,
    accountIdentity: {
      profileId: 'corp-a:ding-a',
      corpId: 'corp-a',
      dingtalkUserId: 'ding-a',
      identityUpdatedAt: '2026-08-12T00:00:00.000Z',
    },
    policy: {
      enabled: true,
      membership: 'members',
      guest: 'deny',
      taskVisibility: 'conversation',
      completion: 'reply_to_work_conversation',
      liveDeny: false,
    },
    effectiveConfig: {
      identity: {},
      instructions: { system: '' },
      knowledge: { contextEnabled: false, sourceIds: [] },
      capabilities: { skillIds: [], toolNames: [], dwsResourceIds: [] },
      memory: { readAgent: true, readConversation: true, adminWriteConversation: true },
      access: { triggerRoles: [], approvalRoles: [] },
      speech: { proactive: false, requireMention: true },
    },
    revision: 1,
    createdAt: '2026-09-04T00:00:00.000Z',
    updatedAt: '2026-09-04T00:00:00.000Z',
    ...overrides,
  };
}
