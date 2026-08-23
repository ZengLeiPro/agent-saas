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

  it('inbox 诊断只读当前租户账号并不返回消息正文', async () => {
    const store = new FakeAccountStore();
    store.records.push(makeAccount());
    const listForAccount = vi.fn(async () => [{
      inboxId: 'inbox-1', tenantId: 'tenant-a', accountId: 'adws-1', eventId: 'event-1',
      eventType: 'user_im_message_receive_o2o_all', conversationId: 'cid-1', messageId: 'msg-1',
      senderOpenDingtalkId: 'sender-1', content: '敏感消息正文', payload: {}, state: 'retry_wait' as const,
      sessionId: 'session-1', runId: 'run-1', responseText: '敏感回复正文', attempt: 2, maxAttempts: 8,
      leaseFence: 2, nextAttemptAt: '2026-08-14T07:10:00.000Z', lastError: 'dispatch failed',
      createdAt: '2026-08-14T07:06:43.000Z', updatedAt: '2026-08-14T07:06:44.000Z',
    }]);
    const opened = await listen({ store, messageStore: { listForAccount } });
    server = opened.server;

    const response = await fetch(`${opened.baseUrl}/api/agent-dws-accounts/adws-1/inbox?limit=10`);
    expect(response.status).toBe(200);
    expect(listForAccount).toHaveBeenCalledWith('tenant-a', 'adws-1', 10);
    const body = await response.json() as { items: Array<Record<string, unknown>> };
    expect(body.items[0]).toMatchObject({ state: 'retry_wait', attempt: 2, lastError: 'dispatch failed' });
    expect(body.items[0]).not.toHaveProperty('content');
    expect(body.items[0]).not.toHaveProperty('responseText');
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

  it('治理审计未装配时拒绝写入', async () => {
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
});

function makeAccount(overrides: Partial<AgentDwsAccountRecord> = {}): AgentDwsAccountRecord {
  return {
    accountId: 'adws-1', tenantId: 'tenant-a', agentId: 'oa-sales',
    displayName: '销售数字员工', loginId: 'sales-agent-001',
    status: 'draft', runtimeStatus: 'stopped', eventKinds: ['at_me', 'all_direct'],
    revision: 1, createdAt: '2026-08-13T00:00:00.000Z', createdBy: 'admin-a',
    updatedAt: '2026-08-13T00:00:00.000Z', updatedBy: 'admin-a',
    ...overrides,
  };
}
