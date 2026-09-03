import { describe, expect, it, vi } from 'vitest';

import type { AgentDwsAccountRecord, AgentDwsAccountStore } from '../../data/agentDwsAccounts/index.js';
import type { OrgAgentChannelBinding, OrgAgentWorkConversation } from '../../data/orgGroupAgents/index.js';
import type { ToolInvocationRequest } from '../../runtime/handProtocol.js';
import type { ContextStore } from '../store/index.js';
import { defaultPartitionIdentity } from './contextStoreAdapter.js';
import { DwsContextRuntime, DwsRemoteJsonExecutor } from './dwsContextRuntime.js';

const account: AgentDwsAccountRecord = {
  accountId: 'account-a',
  tenantId: 'tenant-a',
  agentId: 'agent-a',
  displayName: '销售 Agent',
  loginId: 'login-a',
  corpId: 'corp-a',
  dingtalkUserId: 'user-a',
  profileId: 'corp-a:user-a',
  status: 'active',
  runtimeStatus: 'ready',
  eventKinds: ['at_me'],
  contextPolicy: {
    historical: { mode: 'all', conversationIds: [], lookbackDays: 30 },
    realtime: { mode: 'all', conversationIds: [] },
  },
  revision: 1,
  createdAt: '2026-08-22T00:00:00.000Z',
  createdBy: 'admin-a',
  updatedAt: '2026-08-22T00:00:00.000Z',
  updatedBy: 'admin-a',
};

function accountStore(record: AgentDwsAccountRecord | null = account): AgentDwsAccountStore {
  return {
    getForTenant: vi.fn(async () => record),
  } as unknown as AgentDwsAccountStore;
}

const context = {
  tenantId: 'tenant-a',
  accountId: 'account-a',
  profileId: 'corp-a:user-a',
  operation: 'chat.list' as const,
};

describe('DwsContextRuntime', () => {
  it('materializes active group ownership only for an enabled Context source and an already pinned work conversation', async () => {
    const key = {
      tenantId: 'tenant-a', accountId: 'account-a', profileId: 'corp-a:user-a', source: 'chat' as const,
    };
    const sourceId = defaultPartitionIdentity(key).sourceId;
    const binding = (overrides: Partial<OrgAgentChannelBinding> = {}): OrgAgentChannelBinding => ({
      bindingId: 'binding-a', tenantId: 'tenant-a', accountId: 'account-a', agentId: 'agent-a',
      conversationId: 'group-a', channelKind: 'group', activationState: 'active', enabled: true,
      conversationSpaceId: 'space-a', serviceSessionId: 'service-a', workspaceId: 'workspace-a',
      policy: { enabled: true, membership: 'members', guest: 'deny', taskVisibility: 'conversation',
        completion: 'reply_to_work_conversation', liveDeny: false },
      effectiveConfig: { identity: {}, knowledge: { contextEnabled: true, sourceIds: [sourceId] },
        capabilities: { skillIds: [], toolNames: ['ContextSearch', 'ContextGet'] },
        access: { triggerRoles: [], approvalRoles: [] }, speech: { proactive: false, requireMention: true } },
      revision: 7, createdAt: '2026-09-04T00:00:00.000Z', updatedAt: '2026-09-04T00:00:00.000Z',
      ...overrides,
    });
    const conversation: OrgAgentWorkConversation = {
      workConversationId: 'work-a', tenantId: 'tenant-a', bindingId: 'binding-a', rootKey: 'root-a',
      rootMessageId: 'message-a', sessionId: 'session-a', state: 'active',
      createdAt: '2026-09-04T00:00:00.000Z', updatedAt: '2026-09-04T00:00:00.000Z',
    };
    const getBinding = vi.fn(async () => binding());
    const findWorkConversationByMessage = vi.fn(async (): Promise<OrgAgentWorkConversation | null> => conversation);
    const runtime = new DwsContextRuntime({
      agentCwd: '/workspace/agent', accountStore: accountStore(), contextStore: {} as ContextStore,
      orgGroupAgentStore: { getBinding, findWorkConversationByMessage },
      resolveServerRemote: async () => ({ baseUrl: 'https://hand.test', authToken: 'secret' }),
    });
    const resolve = (runtime as unknown as {
      resolveOrgAgentRecordMetadata(
        input: typeof key,
        item: { source: 'chat'; sourceId: string; conversationId?: string },
      ): Promise<Record<string, string | number> | undefined>;
    }).resolveOrgAgentRecordMetadata.bind(runtime);

    await expect(resolve(key, { source: 'chat', sourceId: 'message-a', conversationId: 'group-a' }))
      .resolves.toEqual({
        agentId: 'agent-a', bindingId: 'binding-a', conversationSpaceId: 'space-a',
        workConversationId: 'work-a', policyRevision: 7, visibility: 'conversation',
        orgAgentContextScope: 'work_conversation',
      });
    expect(findWorkConversationByMessage).toHaveBeenLastCalledWith({
      tenantId: 'tenant-a', bindingId: 'binding-a', accountId: 'account-a',
      conversationId: 'group-a', messageIds: ['message-a'],
    });

    getBinding.mockResolvedValueOnce(binding({
      effectiveConfig: { ...binding().effectiveConfig, knowledge: { contextEnabled: false, sourceIds: [sourceId] } },
    }));
    await expect(resolve(key, { source: 'chat', sourceId: 'message-a', conversationId: 'group-a' }))
      .resolves.toBeUndefined();

    getBinding.mockResolvedValueOnce(binding({
      effectiveConfig: { ...binding().effectiveConfig, knowledge: { contextEnabled: true, sourceIds: ['other-source'] } },
    }));
    await expect(resolve(key, { source: 'chat', sourceId: 'message-a', conversationId: 'group-a' }))
      .resolves.toBeUndefined();

    findWorkConversationByMessage.mockResolvedValueOnce(null);
    await expect(resolve(key, { source: 'chat', sourceId: 'message-a', conversationId: 'group-a' }))
      .resolves.toEqual({
        agentId: 'agent-a', bindingId: 'binding-a', conversationSpaceId: 'space-a',
        policyRevision: 7, visibility: 'conversation', orgAgentContextScope: 'group',
      });

    const withoutGroupStore = new DwsContextRuntime({
      agentCwd: '/workspace/agent', accountStore: accountStore(), contextStore: {} as ContextStore,
      resolveServerRemote: async () => ({ baseUrl: 'https://hand.test', authToken: 'secret' }),
    });
    const resolveWithoutGroupStore = (withoutGroupStore as unknown as {
      resolveOrgAgentRecordMetadata(
        input: typeof key,
        item: { source: 'chat'; sourceId: string; conversationId?: string },
      ): Promise<Record<string, string | number> | undefined>;
    }).resolveOrgAgentRecordMetadata.bind(withoutGroupStore);
    await expect(resolveWithoutGroupStore(key, { source: 'chat', sourceId: 'message-a', conversationId: 'group-a' }))
      .resolves.toBeUndefined();
  });

  it('consults durable retry state and does not start a new window before nextRetryAt', async () => {
    const invoke = vi.fn(async (_request: ToolInvocationRequest) => ({
      status: 'success' as const,
      content: '{"items":[]}',
    }));
    const contextStore = {
      getSource: vi.fn(async () => ({ sourceId: 'existing', config: {}, revision: 1 })),
      updateSource: vi.fn(async (input: Record<string, unknown>) => ({ config: input.config, revision: 2 })),
      getCollection: vi.fn(async () => ({ collectionId: 'existing', metadata: {}, revision: 1 })),
      updateCollection: vi.fn(async (input: Record<string, unknown>) => ({ metadata: input.metadata, revision: 2 })),
      getPartition: vi.fn(async () => ({
        tenantId: 'tenant-a',
        sourceId: 'source-a',
        collectionId: 'collection-a',
        partitionKey: 'chat',
        status: 'retry_wait',
        windowStart: '2026-08-22T00:00:00.000Z',
        windowEnd: '2026-08-22T01:00:00.000Z',
        nextRetryAt: '2026-08-22T02:00:00.000Z',
        retryCount: 1,
        leaseFence: 1,
        truncated: false,
        refused: false,
        updatedAt: '2026-08-22T01:00:00.000Z',
      })),
    } as unknown as ContextStore;
    const runtime = new DwsContextRuntime({
      agentCwd: '/workspace/agent',
      accountStore: accountStore(),
      contextStore,
      clock: () => new Date('2026-08-22T01:30:00.000Z'),
      resolveServerRemote: async () => ({ baseUrl: 'https://hand.test', authToken: 'secret' }),
      transportFactory: () => ({ invoke }),
    });

    await runtime.syncAccount(account, ['chat']);

    expect(contextStore.getPartition).toHaveBeenCalledTimes(1);
    expect(invoke).not.toHaveBeenCalled();
  });

  it('periodically syncs selected history and keeps realtime-only targets durable without historical lookback', async () => {
    const contextStore = {
      getSource: vi.fn(async () => ({ sourceId: 'existing', config: {}, revision: 1 })),
      updateSource: vi.fn(async (input: Record<string, unknown>) => ({ config: input.config, revision: 2 })),
      getCollection: vi.fn(async () => ({ collectionId: 'existing', metadata: {}, revision: 1 })),
      updateCollection: vi.fn(async (input: Record<string, unknown>) => ({ metadata: input.metadata, revision: 2 })),
      getPartition: vi.fn(async () => ({
        tenantId: 'tenant-a', sourceId: 'source-a', collectionId: 'collection-a', partitionKey: 'chat',
        status: 'retry_wait', windowStart: '2026-08-22T00:00:00.000Z',
        windowEnd: '2026-08-22T01:00:00.000Z', nextRetryAt: '2026-08-22T02:00:00.000Z',
        retryCount: 1, leaseFence: 1, truncated: false, refused: false,
        updatedAt: '2026-08-22T01:00:00.000Z',
      })),
    } as unknown as ContextStore;
    let current = account;
    const store = accountStore();
    vi.mocked(store.getForTenant).mockImplementation(async () => current);
    const runtime = new DwsContextRuntime({
      agentCwd: '/workspace/agent', accountStore: store, contextStore,
      clock: () => new Date('2026-08-22T01:30:00.000Z'),
      resolveServerRemote: async () => ({ baseUrl: 'https://hand.test', authToken: 'secret' }),
    });

    current = {
      ...account,
      contextPolicy: {
        historical: { mode: 'selected', conversationIds: ['cid-a', 'cid-b'], lookbackDays: 7 },
        realtime: { mode: 'none', conversationIds: [] },
      },
    };
    await runtime.syncAccount(current, ['chat']);
    expect(contextStore.getPartition).toHaveBeenCalledTimes(1);

    vi.mocked(contextStore.getPartition).mockClear();
    current = {
      ...account,
      contextPolicy: {
        historical: { mode: 'none', conversationIds: [], lookbackDays: 7 },
        realtime: { mode: 'all', conversationIds: [] },
      },
    };
    await runtime.syncAccount(current, ['chat']);
    expect(contextStore.getPartition).toHaveBeenCalledTimes(1);

    vi.mocked(contextStore.getPartition).mockClear();
    current = {
      ...account,
      contextPolicy: {
        historical: { mode: 'none', conversationIds: [], lookbackDays: 7 },
        realtime: { mode: 'none', conversationIds: [] },
      },
    };
    await runtime.syncAccount(current, ['minutes', 'wiki']);
    expect(contextStore.getPartition).not.toHaveBeenCalled();

    current = {
      ...account,
      contextPolicy: {
        historical: { mode: 'none', conversationIds: [], lookbackDays: 7 },
        realtime: { mode: 'none', conversationIds: [] },
        wiki: { enabled: true },
        minutes: { enabled: true, lookbackDays: 14 },
      },
    };
    await runtime.syncAccount(current, ['minutes', 'wiki']);
    expect(contextStore.getPartition).toHaveBeenCalledTimes(2);
  });

  it('filters event wakes with a freshly loaded realtime policy and scopes allowed wakes to the conversation', async () => {
    const current = {
      ...account,
      contextPolicy: {
        historical: { mode: 'none' as const, conversationIds: [], lookbackDays: 30 },
        realtime: { mode: 'selected' as const, conversationIds: ['cid-allowed'] },
      },
    };
    const contextStore = {
      getSource: vi.fn(async () => ({ sourceId: 'existing', config: {}, revision: 1 })),
      updateSource: vi.fn(async (input: Record<string, unknown>) => ({ config: input.config, revision: 2 })),
      getCollection: vi.fn(async () => ({ collectionId: 'existing', metadata: {}, revision: 1 })),
      updateCollection: vi.fn(async (input: Record<string, unknown>) => ({ metadata: input.metadata, revision: 2 })),
      getPartition: vi.fn(async () => ({
        tenantId: 'tenant-a', sourceId: 'source-a', collectionId: 'collection-a', partitionKey: 'chat',
        status: 'retry_wait', windowStart: '2026-08-22T00:00:00.000Z',
        windowEnd: '2026-08-22T01:00:00.000Z', nextRetryAt: '2026-08-22T02:00:00.000Z',
        retryCount: 1, leaseFence: 1, truncated: false, refused: false,
        updatedAt: '2026-08-22T01:00:00.000Z',
      })),
    } as unknown as ContextStore;
    const store = accountStore(current);
    const runtime = new DwsContextRuntime({
      agentCwd: '/workspace/agent', accountStore: store, contextStore,
      clock: () => new Date('2026-08-22T01:30:00.000Z'),
      resolveServerRemote: async () => ({ baseUrl: 'https://hand.test', authToken: 'secret' }),
    });

    await runtime.wake(account, {
      type: 'user_im_message_receive_at', eventId: 'event-denied', conversationId: 'cid-denied', raw: {},
    });
    expect(contextStore.getPartition).not.toHaveBeenCalled();

    await runtime.wake(account, {
      type: 'user_im_message_receive_at', eventId: 'event-allowed', conversationId: 'cid-allowed',
      timestamp: Date.parse('2026-08-22T01:29:00.000Z'), raw: {},
    });
    expect(store.getForTenant).toHaveBeenCalledTimes(3);
    const identity = defaultPartitionIdentity({
      tenantId: 'tenant-a', accountId: 'account-a', profileId: 'corp-a:user-a',
      source: 'chat', conversationIds: ['cid-allowed'],
    });
    expect(contextStore.getPartition).toHaveBeenCalledWith(
      'tenant-a', identity.sourceId, identity.collectionId, identity.partitionKey,
    );
  });

  it('mirrors policy and disables all resources before account identity replacement', async () => {
    const sourceRecord = { config: { accountId: 'account-a', profileId: 'corp-a:user-a' }, revision: 1 };
    const collectionRecord = { metadata: { keep: true }, revision: 1 };
    const updateSource = vi.fn(async (input: Record<string, unknown>) => ({
      ...sourceRecord, config: input.config, revision: 2,
    }));
    const updateCollection = vi.fn(async (input: Record<string, unknown>) => ({
      ...collectionRecord, metadata: input.metadata, revision: 2,
    }));
    const resetRefusedPartitions = vi.fn(async () => 1);
    const resetPartitionsForPolicyChange = vi.fn(async () => 1);
    const contextStore = {
      getSource: vi.fn(async () => sourceRecord), updateSource,
      getCollection: vi.fn(async () => collectionRecord), updateCollection,
      resetRefusedPartitions, resetPartitionsForPolicyChange,
    } as unknown as ContextStore;
    const selected = {
      ...account,
      contextPolicy: {
        historical: { mode: 'selected' as const, conversationIds: ['cid-a'], lookbackDays: 14 },
        realtime: { mode: 'none' as const, conversationIds: [] },
      },
    };
    const runtime = new DwsContextRuntime({
      agentCwd: '/workspace/agent', accountStore: accountStore(selected), contextStore,
      resolveServerRemote: async () => ({ baseUrl: 'https://hand.test', authToken: 'secret' }),
    });

    await runtime.onContextPolicyUpdated(selected);

    expect(updateSource).toHaveBeenCalledWith(expect.objectContaining({
      config: expect.objectContaining({
        contextPolicy: expect.objectContaining({
          historical: selected.contextPolicy.historical,
          realtime: selected.contextPolicy.realtime,
        }),
      }),
    }));
    expect(resetPartitionsForPolicyChange).toHaveBeenCalledWith(
      'tenant-a', expect.stringMatching(/^dws-/), expect.stringMatching(/^dws-chat-/),
    );
    expect(updateCollection).toHaveBeenCalledWith(expect.objectContaining({
      metadata: expect.objectContaining({
        keep: true,
        contextPolicy: expect.objectContaining({
          historical: selected.contextPolicy.historical,
          realtime: selected.contextPolicy.realtime,
        }),
        historicalLearning: expect.objectContaining({ mode: 'selected', lookbackDays: 14 }),
        realtimeListening: expect.objectContaining({ mode: 'none', enabled: false }),
      }),
    }));

    await runtime.onAccountEnabledChanged({ ...selected, status: 'paused' }, false);
    expect(updateSource).toHaveBeenCalledWith(expect.objectContaining({ status: 'disabled' }));
    expect(updateCollection).toHaveBeenCalledWith(expect.objectContaining({ status: 'disabled' }));

    updateSource.mockClear();
    updateCollection.mockClear();
    resetPartitionsForPolicyChange.mockClear();
    await runtime.invalidateAccountIdentity(selected);
    expect(updateSource).toHaveBeenCalledWith(expect.objectContaining({ status: 'disabled' }));
    expect(updateCollection).toHaveBeenCalledWith(expect.objectContaining({ status: 'disabled' }));
    expect(resetPartitionsForPolicyChange).toHaveBeenCalledTimes(3);
  });
});

describe('DwsRemoteJsonExecutor', () => {
  it('runs quoted argv in the isolated Agent DWS connector workspace and parses JSON', async () => {
    const invoke = vi.fn(async (_request: ToolInvocationRequest) => ({
      status: 'success' as const,
      content: '{"items":[]}',
    }));
    const executor = new DwsRemoteJsonExecutor({
      agentCwd: '/workspace/agent',
      accountStore: accountStore(),
      resolveServerRemote: async () => ({ baseUrl: 'https://hand.test', authToken: 'remote-secret' }),
      transportFactory: () => ({ invoke }),
    });

    await expect(executor.json(
      ['dws', 'chat', 'message', 'list-all', '--cursor', `x'; touch /tmp/pwn; echo '`],
      { context },
    )).resolves.toEqual({ items: [] });

    const request = invoke.mock.calls[0]![0];
    expect(request.toolName).toBe('Shell');
    expect(request.input).toMatchObject({ timeoutMs: 120_000 });
    expect((request.input as { command: string }).command).toContain(`'x'"'"'; touch /tmp/pwn; echo '"'"''`);
    expect(request.context.workspace).toMatchObject({
      tenantId: 'tenant-a',
      userId: 'account-a',
      executionTarget: 'server-remote',
      workload: { class: 'cron' },
    });
    expect(JSON.stringify(request)).not.toContain('remote-secret');
  });

  it('serializes cron workload through the real HTTP transport wire', async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(
      `data: ${JSON.stringify({
        type: 'completed', response: { status: 'success', content: '{"items":[]}' },
      })}\n\n`,
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    ));
    vi.stubGlobal('fetch', fetchMock);
    try {
      const executor = new DwsRemoteJsonExecutor({
        agentCwd: '/workspace/agent',
        accountStore: accountStore(),
        resolveServerRemote: async () => ({ baseUrl: 'https://hand.test', authToken: 'remote-secret' }),
      });

      await expect(executor.json(['dws', 'chat', 'message', 'list-all'], { context }))
        .resolves.toEqual({ items: [] });
      expect(String(fetchMock.mock.calls[0]![0])).toBe('https://hand.test/execute-stream');
      const init = fetchMock.mock.calls[0]![1] as RequestInit;
      const wire = JSON.parse(String(init.body)) as ToolInvocationRequest;
      expect(wire.context.workspace.workload).toEqual({ class: 'cron' });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('fails closed when tenant/account/profile no longer resolves to the active account', async () => {
    const invoke = vi.fn();
    const executor = new DwsRemoteJsonExecutor({
      agentCwd: '/workspace/agent',
      accountStore: accountStore({ ...account, profileId: 'other-profile' }),
      resolveServerRemote: async () => ({ baseUrl: 'https://hand.test', authToken: 'secret' }),
      transportFactory: () => ({ invoke }),
    });

    await expect(executor.json(['dws', '--format', 'json'], { context }))
      .rejects.toThrow('unavailable or unauthorized');
    expect(invoke).not.toHaveBeenCalled();
  });

  it('redacts remote and injected secrets from transport failures', async () => {
    const invoke = vi.fn(async (_request: ToolInvocationRequest) => ({
      status: 'error' as const,
      error: 'Bearer remote-secret access_token=env-secret',
    }));
    const executor = new DwsRemoteJsonExecutor({
      agentCwd: '/workspace/agent',
      accountStore: accountStore(),
      resolveServerRemote: async () => ({ baseUrl: 'https://hand.test', authToken: 'remote-secret' }),
      transportFactory: () => ({ invoke }),
    });

    const error = await executor.json(['dws', '--format', 'json'], {
      context,
      env: { DWS_TOKEN: 'env-secret' },
    }).catch(cause => cause);
    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).not.toContain('remote-secret');
    expect(message).not.toContain('env-secret');
    expect(message).toContain('[REDACTED]');
  });
});
