import { describe, expect, it, vi } from 'vitest';

import type { AgentDwsAccountRecord, AgentDwsAccountStore } from '../../data/agentDwsAccounts/index.js';
import type { ToolInvocationRequest } from '../../runtime/handProtocol.js';
import type { ContextStore } from '../store/index.js';
import { DwsContextRuntime, DwsRemoteJsonExecutor } from './dwsContextRuntime.js';

const account: AgentDwsAccountRecord = {
  accountId: 'account-a',
  tenantId: 'tenant-a',
  agentId: 'agent-a',
  displayName: '销售 Agent',
  loginId: 'login-a',
  profileId: 'profile-a',
  status: 'active',
  runtimeStatus: 'ready',
  eventKinds: ['at_me'],
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
  profileId: 'profile-a',
  operation: 'chat.list' as const,
};

describe('DwsContextRuntime', () => {
  it('consults durable retry state and does not start a new window before nextRetryAt', async () => {
    const invoke = vi.fn(async (_request: ToolInvocationRequest) => ({
      status: 'success' as const,
      content: '{"items":[]}',
    }));
    const contextStore = {
      getSource: vi.fn(async () => ({ sourceId: 'existing' })),
      getCollection: vi.fn(async () => ({ collectionId: 'existing' })),
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
    });
    expect(JSON.stringify(request)).not.toContain('remote-secret');
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
