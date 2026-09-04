import express from 'express';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { InMemoryGovernanceAuditStore } from '../data/governance-audit/index.js';
import type {
  AgentDwsAccountRecord,
  AgentDwsAccountStore,
  CreateAgentDwsAccountInput,
} from '../data/agentDwsAccounts/index.js';
import type { AgentDwsMessageStore } from '../data/agentDwsMessages/index.js';
import type { OrgAgentChannelBinding } from '../data/orgGroupAgents/index.js';
import { createAgentDwsAccountsRouter } from '../routes/agentDwsAccounts.js';
import type { AgentDwsAuthFlowServiceLike } from '../dws/agentAuthFlow.js';

const USER = { sub: 'admin-a', username: 'alice', role: 'admin', tenantId: 'tenant-a' } as const;

class FakeAccountStore implements AgentDwsAccountStore {
  records: AgentDwsAccountRecord[] = [];
  init = vi.fn(async () => undefined);
  listRunnable = vi.fn(async () => this.records.filter(record => record.status === 'active'));
  listForTenant = vi.fn(async (tenantId: string) => this.records.filter(record => record.tenantId === tenantId));
  getForTenant = vi.fn(async (tenantId: string, accountId: string) => (
    this.records.find(record => record.tenantId === tenantId && record.accountId === accountId) ?? null
  ));
  deleteForTenant = vi.fn(async (tenantId: string) => {
    const before = this.records.length;
    this.records = this.records.filter(record => record.tenantId !== tenantId);
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
  markAuthorizing = vi.fn(async (tenantId: string, accountId: string, expectedRevision: number) => {
    const record = await this.required(tenantId, accountId);
    expect(expectedRevision).toBe(record.revision);
    Object.assign(record, { status: 'authorizing', revision: record.revision + 1 });
    return record;
  });
  markAuthorized = vi.fn();
  markAuthorizationFailed = vi.fn(async () => undefined);
  setEnabled = vi.fn(async (tenantId: string, accountId: string, enabled: boolean, expectedRevision: number) => {
    const record = await this.required(tenantId, accountId);
    expect(expectedRevision).toBe(record.revision);
    Object.assign(record, { status: enabled ? (record.profileId ? 'active' : 'draft') : 'paused', revision: record.revision + 1 });
    return record;
  });
  setContextPolicy = vi.fn(async (
    tenantId: string,
    accountId: string,
    policy: NonNullable<AgentDwsAccountRecord['contextPolicy']>,
    expectedRevision: number,
  ) => {
    const record = await this.required(tenantId, accountId);
    expect(expectedRevision).toBe(record.revision);
    Object.assign(record, { contextPolicy: policy, revision: record.revision + 1 });
    return record;
  });
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

async function listen(options: {
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
    (req as unknown as { user: typeof USER }).user = USER;
    next();
  });
  app.use('/api', createAgentDwsAccountsRouter({
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
    ...(options.onContextPolicyUpdated ? { onContextPolicyUpdated: options.onContextPolicyUpdated } : {}),
    ...(options.onEnabledChanged ? { onEnabledChanged: options.onEnabledChanged } : {}),
  }));
  return new Promise(resolve => {
    const server = app.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({ server, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

describe('Agent DWS accounts routes', () => {
  let server: Server | undefined;
  afterEach(async () => {
    if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
    server = undefined;
  });

  it('只返回当前组织账号并遮蔽 loginId', async () => {
    const store = new FakeAccountStore();
    store.records.push(makeAccount({ loginId: 'sales-agent-001' }));
    store.records.push(makeAccount({ accountId: 'adws-other', tenantId: 'tenant-b', loginId: 'other-agent' }));
    const opened = await listen({ store });
    server = opened.server;

    const response = await fetch(`${opened.baseUrl}/api/agent-dws-accounts?tenantId=tenant-b`);
    expect(response.status).toBe(200);
    expect(store.listForTenant).toHaveBeenCalledWith('tenant-a');
    const body = await response.json() as { accounts: Array<Record<string, unknown>> };
    expect(body.accounts).toHaveLength(1);
    expect(body.accounts[0]).toMatchObject({ loginIdMasked: 'sa***01', tenantId: 'tenant-a' });
    expect(body.accounts[0]).not.toHaveProperty('loginId');
  });

  it('为已授权账号生成与完整命令参数绑定的委托资源 ID', async () => {
    const store = new FakeAccountStore();
    store.records.push(makeAccount({
      status: 'active', corpId: 'corp-a', dingtalkUserId: 'ding-a', profileId: 'corp-a:ding-a',
    }));
    const opened = await listen({ store });
    server = opened.server;

    const response = await fetch(`${opened.baseUrl}/api/agent-dws-accounts/adws-1/delegation-resource`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ args: ['calendar', 'event', 'list'] }),
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      accountId: 'adws-1', args: ['calendar', 'event', 'list'],
      resourceId: expect.stringMatching(/^dws-delegation:adws-1:[0-9a-f]{64}$/),
    });
  });

  it('创建账号时强制当前租户并写入 intent/terminal 审计', async () => {
    const store = new FakeAccountStore();
    const audit = new InMemoryGovernanceAuditStore();
    const opened = await listen({ store, audit });
    server = opened.server;

    const response = await fetch(`${opened.baseUrl}/api/agent-dws-accounts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        tenantId: 'tenant-a',
        agentId: 'oa-sales',
        displayName: '销售数字员工',
        loginId: 'sales-agent-001',
        eventKinds: ['at_me', 'all_direct'],
      }),
    });
    expect(response.status).toBe(201);
    expect(store.create).toHaveBeenCalledWith(expect.objectContaining({ tenantId: 'tenant-a', createdBy: USER.sub }));
    expect(audit.events.map(event => event.result)).toEqual(['intent', 'succeeded']);
  });

  it('以 CAS 更新聊天上下文策略、写审计并调用资源镜像回调', async () => {
    const store = new FakeAccountStore();
    store.records.push(makeAccount({ revision: 5 }));
    const audit = new InMemoryGovernanceAuditStore();
    const onContextPolicyUpdated = vi.fn(async () => undefined);
    const opened = await listen({ store, audit, onContextPolicyUpdated });
    server = opened.server;

    const response = await fetch(`${opened.baseUrl}/api/agent-dws-accounts/adws-1/context-policy`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        expectedRevision: 5,
        historical: { mode: 'selected', conversationIds: ['cid-a', 'cid-b'], lookbackDays: 14 },
        realtime: { mode: 'all', conversationIds: [] },
      }),
    });

    expect(response.status).toBe(200);
    expect(store.setContextPolicy).toHaveBeenCalledWith(
      'tenant-a',
      'adws-1',
      expect.objectContaining({
        historical: { mode: 'selected', conversationIds: ['cid-a', 'cid-b'], lookbackDays: 14 },
        realtime: { mode: 'all', conversationIds: [] },
        wiki: { enabled: false },
        minutes: { enabled: false, lookbackDays: 30 },
        realtimeEffectiveAt: { all: expect.any(String) },
      }),
      5,
      USER.sub,
    );
    expect(onContextPolicyUpdated).toHaveBeenCalledWith(expect.objectContaining({ revision: 6 }));
    expect(audit.events.map(event => event.result)).toEqual(['intent', 'succeeded']);
    const body = await response.json() as { account: Record<string, unknown> };
    expect(body.account.contextPolicy).toEqual(expect.objectContaining({
      historical: { mode: 'selected', conversationIds: ['cid-a', 'cid-b'], lookbackDays: 14 },
      realtime: { mode: 'all', conversationIds: [] },
      wiki: { enabled: false },
      minutes: { enabled: false, lookbackDays: 30 },
      realtimeEffectiveAt: { all: expect.any(String) },
    }));
  });

  it('严格拒绝重复、越界或与 mode 不一致的会话范围', async () => {
    const store = new FakeAccountStore();
    store.records.push(makeAccount());
    const opened = await listen({ store });
    server = opened.server;

    const invalidPolicies = [
      {
        expectedRevision: 1,
        historical: { mode: 'selected', conversationIds: ['cid-a', 'cid-a'], lookbackDays: 30 },
        realtime: { mode: 'none', conversationIds: [] },
      },
      {
        expectedRevision: 1,
        historical: { mode: 'all', conversationIds: ['cid-a'], lookbackDays: 30 },
        realtime: { mode: 'none', conversationIds: [] },
      },
      {
        expectedRevision: 1,
        historical: { mode: 'none', conversationIds: [], lookbackDays: 366 },
        realtime: { mode: 'selected', conversationIds: [] },
      },
    ];
    for (const body of invalidPolicies) {
      const response = await fetch(`${opened.baseUrl}/api/agent-dws-accounts/adws-1/context-policy`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
      expect(response.status).toBe(400);
    }
    expect(store.setContextPolicy).not.toHaveBeenCalled();
  });

  it('发起授权时使用账号 revision，授权码只来自 auth session', async () => {
    const store = new FakeAccountStore();
    store.records.push(makeAccount({ revision: 3 }));
    const authFlowService: AgentDwsAuthFlowServiceLike = {
      start: vi.fn(async account => ({
        sessionId: 'auth-1', tenantId: account.tenantId, userId: account.accountId,
        username: account.displayName, status: 'awaiting_user' as const,
        authorizationUrl: 'https://login.dingtalk.com/oauth2/device/verify.htm?user_code=ABCD-EFGH',
        userCode: 'ABCD-EFGH', expiresAt: '2099-01-01T00:00:00.000Z',
        createdAt: '2026-08-13T00:00:00.000Z', updatedAt: '2026-08-13T00:00:00.000Z',
      })),
      getLatest: vi.fn(async () => null),
      cancel: vi.fn(async () => undefined),
      stop: vi.fn(),
    };
    const opened = await listen({ store, authFlowService });
    server = opened.server;

    const response = await fetch(`${opened.baseUrl}/api/agent-dws-accounts/adws-1/authorize`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ expectedRevision: 3 }),
    });
    expect(response.status).toBe(202);
    expect(store.markAuthorizing).toHaveBeenCalledWith('tenant-a', 'adws-1', 3, USER.sub);
    const body = await response.json() as { account: Record<string, unknown>; session: Record<string, unknown> };
    expect(body.account).not.toHaveProperty('loginId');
    expect(body.session).toMatchObject({ status: 'awaiting_user', userCode: 'ABCD-EFGH' });
  });

  it('暂停账号时先终止未完成的 Agent OAuth', async () => {
    const store = new FakeAccountStore();
    store.records.push(makeAccount({ status: 'authorizing', revision: 4 }));
    const cancel = vi.fn(async () => undefined);
    const onEnabledChanged = vi.fn(async () => undefined);
    const opened = await listen({
      store,
      authFlowService: { start: vi.fn(), getLatest: vi.fn(), cancel, stop: vi.fn() },
      onEnabledChanged,
    });
    server = opened.server;

    const response = await fetch(`${opened.baseUrl}/api/agent-dws-accounts/adws-1`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ expectedRevision: 4, enabled: false }),
    });
    expect(response.status).toBe(200);
    expect(cancel).toHaveBeenCalledWith('tenant-a', 'adws-1');
    expect(onEnabledChanged).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: 'adws-1', status: 'paused' }),
      false,
    );
  });

  it('授权启动失败时标记可能已变更，并且不泄露底层错误', async () => {
    const store = new FakeAccountStore();
    store.records.push(makeAccount({ revision: 2 }));
    const opened = await listen({
      store,
      authFlowService: {
        start: vi.fn(async () => { throw new Error('Bearer top-secret-token'); }),
        getLatest: vi.fn(async () => null),
        cancel: vi.fn(async () => undefined),
        stop: vi.fn(),
      },
    });
    server = opened.server;

    const response = await fetch(`${opened.baseUrl}/api/agent-dws-accounts/adws-1/authorize`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ expectedRevision: 2 }),
    });
    expect(response.status).toBe(503);
    const body = await response.json() as Record<string, unknown>;
    expect(body).toMatchObject({ code: 'AGENT_DWS_AUTH_START_FAILED', changed: true });
    expect(JSON.stringify(body)).not.toContain('top-secret-token');
    expect(store.markAuthorizationFailed).toHaveBeenCalledWith(
      'tenant-a', 'adws-1', 3, 'authorization_start_failed', 'system:agent-dws-auth',
    );
  });

  it('治理审计未装配时拒绝账号写入', async () => {
    const store = new FakeAccountStore();
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as unknown as { user: typeof USER }).user = USER;
      next();
    });
    app.use('/api', createAgentDwsAccountsRouter({ accountStore: store }));
    const opened = await new Promise<{ server: Server; baseUrl: string }>(resolve => {
      const nextServer = app.listen(0, '127.0.0.1', () => {
        const address = nextServer.address();
        resolve({ server: nextServer, baseUrl: `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}` });
      });
    });
    server = opened.server;
    const response = await fetch(`${opened.baseUrl}/api/agent-dws-accounts`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agentId: 'oa-sales', displayName: '销售数字员工', loginId: 'sales-agent-001' }),
    });
    expect(response.status).toBe(503);
    expect(store.create).not.toHaveBeenCalled();
  });

  it('活动 Runtime Worker 未声明群任务协议 v2 时安全拒绝激活群绑定', async () => {
    const store = new FakeAccountStore();
    store.records.push(makeAccount({
      status: 'active',
      profileId: 'corp-a:ding-a', corpId: 'corp-a', dingtalkUserId: 'ding-a',
    }));
    const updateBinding = vi.fn();
    const currentBinding = makeGroupBinding({ conversationId: 'group-a' });
    const opened = await listen({
      store,
      orgGroupAgentStore: {
        updateBinding,
        getBinding: vi.fn().mockResolvedValue(currentBinding),
      } as never,
      orgAgentStore: { get: vi.fn(() => ({
        id: 'oa-sales', tenantId: 'tenant-a', enabled: true, allowedSkills: [], allowedKnowledge: [],
        runtime: { executionMode: 'dispatcher' },
      })) } as never,
      isOrgAgentRuntimeV2Ready: () => false,
    });
    server = opened.server;

    const response = await fetch(`${opened.baseUrl}/api/agent-dws-accounts/adws-1/group-workspace`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        conversationId: 'group-a', expectedRevision: 1, enabled: true,
        policy: {
          enabled: true, membership: 'members', guest: 'deny', taskVisibility: 'conversation',
          completion: 'reply_to_work_conversation', liveDeny: false,
        },
        effectiveConfig: {
          identity: {}, knowledge: { contextEnabled: false, sourceIds: [] },
          capabilities: { skillIds: [], toolNames: [] },
          access: { triggerRoles: [], approvalRoles: [] },
          speech: { proactive: false, requireMention: true },
        },
      }),
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: '启用群聊前，活动 Runtime Worker 必须支持组织群任务协议 v2',
    });
    expect(updateBinding).not.toHaveBeenCalled();
  });

  it('群工作台返回任务尝试但不暴露投递 provider receipt，并通过审计取消任务', async () => {
    const store = new FakeAccountStore();
    store.records.push(
      makeAccount({
        status: 'active',
        profileId: 'corp-a:ding-a',
        corpId: 'corp-a',
        dingtalkUserId: 'ding-a',
      }),
    );
    const binding = {
      bindingId: 'binding-a',
      tenantId: 'tenant-a',
      accountId: 'adws-1',
      agentId: 'oa-sales',
      conversationId: 'cid-a',
      channelKind: 'group',
      activationState: 'active',
      enabled: true,
      accountIdentity: {
        profileId: 'corp-a:ding-a', corpId: 'corp-a', dingtalkUserId: 'ding-a',
        identityUpdatedAt: '2026-08-12T00:00:00.000Z',
      },
      revision: 2,
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
        knowledge: { contextEnabled: false, sourceIds: [] },
        capabilities: { skillIds: [], toolNames: [] },
        access: { triggerRoles: [], approvalRoles: [] },
        speech: { proactive: false, requireMention: true },
      },
    };
    const work = {
      workOrderId: 'work-a',
      tenantId: 'tenant-a',
      agentId: 'oa-sales',
      bindingId: 'binding-a',
      workConversationId: 'wc-a',
      idempotencyKey: 'key-a',
      title: '汇总',
      state: 'running',
      currentAttemptNo: 1,
      visibility: 'conversation',
      createdByActor: {},
      policySnapshot: {},
      cancelPolicy: {},
      version: 3,
      shortId: 'W-ABCDEF123456',
      control: { revision: 1, supplements: [], workerType: 'general' },
      createdAt: '2026-09-04T00:00:00.000Z',
      updatedAt: '2026-09-04T00:00:00.000Z',
    };
    const workConversation = {
      workConversationId: 'wc-a',
      tenantId: 'tenant-a',
      bindingId: 'binding-a',
      rootKey: 'root-a',
      sessionId: 'session-a',
      state: 'active',
      createdAt: work.createdAt,
      updatedAt: work.updatedAt,
    };
    const orgGroupAgentStore = {
      listBindings: vi.fn(async () => [binding]),
      listDeliveries: vi.fn(async () => [
        {
          deliveryId: 'delivery-a',
          tenantId: 'tenant-a',
          accountId: 'adws-1',
          conversationId: 'cid-a',
          bindingId: 'binding-a',
          source: 'command',
          deliveryKind: 'front_reply',
          disposition: 'replied',
          deliveryState: 'unknown',
          destination: { kind: 'group' },
          content: '结果',
          providerReceipt: { secret: 'never' },
          idempotencyKey: 'key',
          attempt: 1,
          leaseFence: 1,
          createdAt: work.createdAt,
          updatedAt: work.updatedAt,
        },
        {
          deliveryId: 'delivery-private',
          tenantId: 'tenant-a',
          accountId: 'adws-1',
          conversationId: 'cid-a',
          bindingId: 'binding-a',
          source: 'background_completion',
          deliveryKind: 'task_completion',
          disposition: 'replied',
          deliveryState: 'sent',
          destination: { kind: 'direct', peerOpenId: 'private-open-id' },
          content: '仅发起人结果',
          providerReceipt: { messageId: 'private-message' },
          idempotencyKey: 'private-key',
          attempt: 1,
          leaseFence: 1,
          createdAt: work.createdAt,
          updatedAt: work.updatedAt,
        },
      ]),
      loadGroupWorkspace: vi.fn(async () => ({
        conversations: [workConversation], workOrders: [work], attempts: [{
          attemptId: 'attempt-a',
          tenantId: 'tenant-a',
          workOrderId: 'work-a',
          attemptNo: 1,
          runtimeRunId: 'run-a',
          status: 'running',
          taskWorkspaceId: 'task-ws',
          sandboxScopeId: 'scope',
          mountSubPath: 'task',
          sharedReadOnlySubPath: 'shared',
          publishState: 'pending',
          createdAt: work.createdAt,
          updatedAt: work.updatedAt,
        }], memories: [],
      })),
      getWorkOrder: vi.fn(async () => work),
      getBindingById: vi.fn(async () => binding),
    } as unknown as NonNullable<
      Parameters<typeof createAgentDwsAccountsRouter>[0]['orgGroupAgentStore']
    >;
    const cancelWorkOrder = vi.fn(async () => null);
    const publishWorkOrderArtifacts = vi.fn(async () => ({ attemptId: 'attempt-a', publishState: 'published' }));
    const messageStore = { listForAccount: vi.fn(async () => [{
      inboxId: 'inbox-group-b', tenantId: 'tenant-a', accountId: 'adws-1',
      eventId: 'event-group-b', eventType: 'user_im_message_receive_at',
      conversationId: 'cid-b', content: '@开开', payload: {
        accountIdentity: {
          profileId: 'corp-a:ding-a', corpId: 'corp-a', dingtalkUserId: 'ding-a',
        },
      }, state: 'completed' as const,
      attempt: 1, maxAttempts: 8, leaseFence: 1,
      eventTimestamp: '2026-09-04T01:00:00.000Z',
      createdAt: '2026-09-04T01:00:00.000Z', updatedAt: '2026-09-04T01:00:00.000Z',
    }]) };
    const opened = await listen({ store, messageStore, orgGroupAgentStore, orgAgentStore: { get: vi.fn(() => ({
      id: 'oa-sales', tenantId: 'tenant-a', enabled: true, allowedSkills: [], allowedKnowledge: [],
      runtime: { executionMode: 'dispatcher' },
    })) } as never, backgroundTasks: { cancelWorkOrder, publishWorkOrderArtifacts } as never });
    server = opened.server;

    const view = await fetch(`${opened.baseUrl}/api/agent-dws-accounts/adws-1/group-workspace`);
    expect(view.status).toBe(200);
    const body = await view.json() as Record<string, unknown>;
    expect(JSON.stringify(body)).toContain('attempt-a');
    expect(JSON.stringify(body)).toContain('delivery-private');
    expect(body).toMatchObject({ observedGroups: [{
      conversationId: 'cid-b', lastEventAt: '2026-09-04T01:00:00.000Z', bindingId: null,
    }] });
    expect(JSON.stringify(body)).not.toContain('never');
    expect(JSON.stringify(body)).not.toContain('private-open-id');
    expect((body as { bindings: Array<{ effectiveConfigComputation: {
      channelCeiling: { toolNames: string[] };
    } }> }).bindings[0]!.effectiveConfigComputation.channelCeiling.toolNames)
      .toContain('DwsBusiness');

    const response = await fetch(`${opened.baseUrl}/api/agent-dws-accounts/adws-1/group-workspace/work-orders/work-a/action`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'cancel', expectedVersion: 3 }),
    });
    expect(response.status).toBe(200);
    expect(cancelWorkOrder).toHaveBeenCalledWith('tenant-a', 'work-a', 3);

    const publish = await fetch(`${opened.baseUrl}/api/agent-dws-accounts/adws-1/group-workspace/work-orders/work-a/action`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'publish', expectedVersion: 3 }),
    });
    expect(publish.status).toBe(200);
    expect(publishWorkOrderArtifacts).toHaveBeenCalledWith('tenant-a', 'work-a', 3);
  });

  it('群 Context 目录只开放已分配的 chat collection，不展示 wiki/minutes 伪能力', async () => {
    const store = new FakeAccountStore();
    store.records.push(makeAccount({
      status: 'active',
      profileId: 'corp-a:ding-a', corpId: 'corp-a', dingtalkUserId: 'ding-a',
    }));
    const binding = makeGroupBinding({ revision: 2 });
    const orgGroupAgentStore = {
      listBindings: vi.fn(async () => [binding]),
      listDeliveries: vi.fn(async () => []),
      loadGroupWorkspace: vi.fn(async () => ({
        conversations: [], workOrders: [], attempts: [], memories: [],
      })),
    } as never;
    const assignmentStore = {
      listEffectiveResourceIds: vi.fn(async () => [
        { resourceId: 'wiki-only' },
        { resourceId: 'chat-enabled' },
      ]),
    } as never;
    const contextStore = {
      listCollections: vi.fn(async () => [
        { collectionId: 'wiki-only', sourceId: 'source-wiki', externalKey: 'wiki', status: 'active' },
        { collectionId: 'chat-enabled', sourceId: 'source-chat', externalKey: 'chat', status: 'active' },
      ]),
      listSources: vi.fn(async () => [
        { sourceId: 'source-wiki', kind: 'dws', status: 'active', config: { accountId: 'adws-1', profileId: 'corp-a:ding-a' } },
        { sourceId: 'source-chat', kind: 'dws', status: 'active', config: { accountId: 'adws-1', profileId: 'corp-a:ding-a' } },
      ]),
    } as never;
    const opened = await listen({
      store, orgGroupAgentStore, assignmentStore, contextStore,
      orgAgentStore: { get: vi.fn(() => ({
        id: 'oa-sales', tenantId: 'tenant-a', enabled: true, allowedSkills: [], allowedKnowledge: [],
        runtime: { executionMode: 'dispatcher' },
      })) } as never,
    });
    server = opened.server;

    const response = await fetch(`${opened.baseUrl}/api/agent-dws-accounts/adws-1/group-workspace`);
    expect(response.status).toBe(200);
    const body = await response.json() as { bindings: Array<{ effectiveConfigComputation: {
      publishedAgent: { sourceIds: string[] };
      channelCeiling: { contextSourceIds: string[]; contextDirectoryAvailable: boolean };
    } }> };
    expect(body.bindings[0]!.effectiveConfigComputation.publishedAgent.sourceIds)
      .toEqual(['source-chat', 'source-wiki']);
    expect(body.bindings[0]!.effectiveConfigComputation.channelCeiling.contextSourceIds)
      .toEqual(['source-chat']);
    expect(body.bindings[0]!.effectiveConfigComputation.channelCeiling.contextDirectoryAvailable)
      .toBe(true);
  });
  it('review 控制会保留待发布成果，并以新控制版本创建后续 attempt', async () => {
    const store = new FakeAccountStore();
    store.records.push(makeAccount({ status: 'active', profileId: 'corp-a:ding-a', corpId: 'corp-a', dingtalkUserId: 'ding-a' }));
    const binding = makeGroupBinding();
    const work = {
      workOrderId: 'work-a', shortId: 'W-ABCDEF123456', tenantId: 'tenant-a', agentId: 'oa-sales', bindingId: 'binding-a',
      workConversationId: 'wc-a', idempotencyKey: 'key-a', title: '汇总', state: 'completed', currentAttemptNo: 1,
      visibility: 'conversation', createdByActor: {}, policySnapshot: {}, cancelPolicy: {}, version: 3,
      control: { revision: 1, supplements: [], workerType: 'general' },
      createdAt: '2026-09-04T00:00:00.000Z', updatedAt: '2026-09-04T00:00:00.000Z',
    };
    const orgGroupAgentStore = {
      getWorkOrder: vi.fn(async () => work), getBindingById: vi.fn(async () => binding),
    } as unknown as NonNullable<Parameters<typeof createAgentDwsAccountsRouter>[0]['orgGroupAgentStore']>;
    const retryWorkOrder = vi.fn(async () => ({ runId: 'retry-a' }));
    const opened = await listen({ store, orgGroupAgentStore, backgroundTasks: { retryWorkOrder } as never });
    server = opened.server;

    const response = await fetch(`${opened.baseUrl}/api/agent-dws-accounts/adws-1/group-workspace/work-orders/work-a/action`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'review', expectedVersion: 3, text: '请复核缺失项' }),
    });

    expect(response.status).toBe(200);
    expect(retryWorkOrder).toHaveBeenCalledWith('tenant-a', 'work-a', 3, expect.objectContaining({
      allowPendingArtifacts: true,
      supersedePendingCompletion: true,
      control: expect.objectContaining({ revision: 2,
        supplements: [expect.objectContaining({ kind: 'review', text: '请复核缺失项' })] }),
    }));
  });
  it('撤销群内源记忆时把源 ID 和版本交给原子派生撤权入口', async () => {
    const store = new FakeAccountStore();
    store.records.push(makeAccount({
      status: 'active', profileId: 'corp-a:ding-a', corpId: 'corp-a', dingtalkUserId: 'ding-a',
    }));
    const memory = {
      memoryId: 'conversation-memory-a', tenantId: 'tenant-a', agentId: 'oa-sales',
      bindingId: 'binding-a', workConversationId: 'conversation-a', memoryScope: 'conversation',
      status: 'active', content: { fact: '群内事实' }, provenance: { messageId: 'message-a' },
      policyRevision: 1, version: 4, createdAt: '2026-09-04T00:00:00.000Z',
      updatedAt: '2026-09-04T00:00:00.000Z',
    };
    const changeMemoryStatus = vi.fn(async () => ({
      ...memory, status: 'revoked', version: 5, revokedAt: '2026-09-04T01:00:00.000Z',
    }));
    const orgGroupAgentStore = {
      getMemory: vi.fn(async () => memory),
      getBindingById: vi.fn(async () => makeGroupBinding()),
      changeMemoryStatus,
    } as unknown as NonNullable<Parameters<typeof createAgentDwsAccountsRouter>[0]['orgGroupAgentStore']>;
    const opened = await listen({ store, orgGroupAgentStore });
    server = opened.server;

    const response = await fetch(
      `${opened.baseUrl}/api/agent-dws-accounts/adws-1/group-workspace/memories/conversation-memory-a`,
      { method: 'PATCH', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ expectedVersion: 4, status: 'revoked' }) },
    );

    expect(response.status).toBe(200);
    expect(changeMemoryStatus).toHaveBeenCalledWith({
      tenantId: 'tenant-a', memoryId: 'conversation-memory-a',
      expectedVersion: 4, status: 'revoked',
    });
  });
  it('群配置未开放管理员写入时拒绝创建群记忆', async () => {
    const store = new FakeAccountStore();
    store.records.push(makeAccount({
      status: 'active', profileId: 'corp-a:ding-a', corpId: 'corp-a', dingtalkUserId: 'ding-a',
    }));
    const createMemory = vi.fn();
    const orgGroupAgentStore = {
      getBindingById: vi.fn(async () => makeGroupBinding({
        revision: 2,
        effectiveConfig: {
          ...makeGroupBinding().effectiveConfig,
          memory: { adminWriteConversation: false, readAgent: true, readConversation: true },
        },
      })),
      createMemory,
    } as unknown as NonNullable<
      Parameters<typeof createAgentDwsAccountsRouter>[0]['orgGroupAgentStore']
    >;
    const opened = await listen({ store, orgGroupAgentStore });
    server = opened.server;

    const response = await fetch(
      `${opened.baseUrl}/api/agent-dws-accounts/adws-1/group-workspace/memories`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          bindingId: 'binding-a',
          workConversationId: 'conversation-a',
          memoryScope: 'conversation',
          content: { text: '群内事实' },
          provenance: { source: 'admin_workspace' },
          policyRevision: 2,
        }),
      },
    );

    expect(response.status).toBe(403);
    expect(createMemory).not.toHaveBeenCalled();
  });
});

function makeAccount(overrides: Partial<AgentDwsAccountRecord> = {}): AgentDwsAccountRecord {
  return {
    accountId: 'adws-1', tenantId: 'tenant-a', agentId: 'oa-sales',
    displayName: '销售数字员工', loginId: 'sales-agent-001',
    status: 'draft', runtimeStatus: 'stopped', eventKinds: ['at_me', 'all_direct'],
    revision: 1, identityUpdatedAt: '2026-08-12T00:00:00.000Z',
    createdAt: '2026-08-13T00:00:00.000Z', createdBy: 'admin-a',
    updatedAt: '2026-08-13T00:00:00.000Z', updatedBy: 'admin-a',
    ...overrides,
  };
}

function makeGroupBinding(
  overrides: Partial<OrgAgentChannelBinding> = {},
): OrgAgentChannelBinding {
  return {
    bindingId: 'binding-a', tenantId: 'tenant-a', accountId: 'adws-1', agentId: 'oa-sales',
    conversationId: 'cid-a', channelKind: 'group', conversationSpaceId: 'space-a',
    serviceSessionId: 'org-agent-service:binding-a',
    workspaceId: 'tenant-a/.agent-oa-sales', activationState: 'active', enabled: true,
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
      capabilities: { skillIds: [], toolNames: [], dwsResourceIds: [] },
      memory: { readAgent: true, readConversation: true, adminWriteConversation: true },
      access: { triggerRoles: [], approvalRoles: [] },
      speech: { proactive: false, requireMention: true },
    },
    revision: 1, createdAt: '2026-09-04T00:00:00.000Z',
    updatedAt: '2026-09-04T00:00:00.000Z', ...overrides,
  };
}
