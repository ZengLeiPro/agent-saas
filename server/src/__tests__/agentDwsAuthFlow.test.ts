import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AgentDwsAuthFlowService } from '../dws/agentAuthFlow.js';
import type { DwsAuthSessionRecord, DwsAuthSessionStore } from '../dws/authStore.js';
import type { AgentDwsAccountRecord, AgentDwsAccountStore } from '../data/agentDwsAccounts/index.js';
import { resolveAgentConnectorCwd } from '../workspace/resolver.js';

const account: AgentDwsAccountRecord = {
  accountId: 'adws-1', tenantId: 'tenant-a', agentId: 'oa-sales',
  displayName: '销售数字员工', loginId: 'sales-agent-001',
  status: 'authorizing', runtimeStatus: 'stopped', eventKinds: ['at_me'], revision: 7,
  createdAt: '2026-08-13T00:00:00.000Z', createdBy: 'admin-a',
  updatedAt: '2026-08-13T00:00:00.000Z', updatedBy: 'admin-a',
};

const session: DwsAuthSessionRecord = {
  sessionId: 'auth-1', tenantId: account.tenantId, userId: account.accountId,
  username: account.displayName, status: 'starting', expiresAt: '2099-01-01T00:00:00.000Z',
  createdAt: '2026-08-13T00:00:00.000Z', updatedAt: '2026-08-13T00:00:00.000Z',
};

function authStore(): DwsAuthSessionStore {
  return {
    createOrReuse: vi.fn(async () => ({ record: session, created: true })),
    markAwaitingUser: vi.fn(async () => undefined),
    markConnected: vi.fn(async () => undefined),
    markFailed: vi.fn(async () => undefined),
    getLatestForUser: vi.fn(async () => session),
  };
}

function accountStore(): AgentDwsAccountStore {
  return {
    init: vi.fn(async () => undefined), listForTenant: vi.fn(async () => [account]),
    listRunnable: vi.fn(async () => []), getForTenant: vi.fn(async () => account),
    deleteForTenant: vi.fn(async () => 1),
    create: vi.fn(async () => account), markAuthorizing: vi.fn(async () => account),
    markAuthorized: vi.fn(async () => ({ ...account, status: 'active' as const, revision: 8 })),
    markAuthorizationFailed: vi.fn(async () => undefined), setEnabled: vi.fn(async () => account),
    claimRuntimeLease: vi.fn(async () => true), renewRuntimeLease: vi.fn(async () => true),
    releaseRuntimeLease: vi.fn(async () => undefined), revokeRuntimeLease: vi.fn(async () => undefined),
    updateRuntimeStatus: vi.fn(async () => undefined), markEvent: vi.fn(async () => true),
  };
}

async function waitForCall(mock: ReturnType<typeof vi.fn>): Promise<void> {
  for (let index = 0; index < 50; index += 1) {
    if (mock.mock.calls.length > 0) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('expected mock call');
}

describe('AgentDwsAuthFlowService', () => {
  let root: string | undefined;
  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
    root = undefined;
  });

  it('用发起授权时的 tenant/account/revision CAS 写入授权终态', async () => {
    root = await mkdtemp(join(tmpdir(), 'agent-dws-auth-'));
    const agentCwd = join(root, 'workspaces');
    const profileDir = join(
      resolveAgentConnectorCwd(agentCwd, account.tenantId, account.agentId, 'dws'),
      '.dws/config',
    );
    await mkdir(profileDir, { recursive: true });
    await writeFile(join(profileDir, 'profiles.json'), JSON.stringify({
      profiles: [{ corpId: 'corp-a', corpName: '示例企业', userId: 'ding-user-a', userName: '销售数字员工' }],
    }));
    const accounts = accountStore();
    const auth = authStore();
    const service = new AgentDwsAuthFlowService({
      agentCwd,
      authSessionStore: auth,
      accountStore: accounts,
      runner: { login: vi.fn(async () => undefined) },
    });

    await service.start(account);
    await waitForCall(accounts.markAuthorized as ReturnType<typeof vi.fn>);
    expect(accounts.markAuthorized).toHaveBeenCalledWith(
      'tenant-a', 'adws-1', 7,
      expect.objectContaining({ profileId: 'corp-a', dingtalkUserId: 'ding-user-a' }),
      'system:agent-dws-auth',
    );
    expect(auth.markConnected).toHaveBeenCalled();
    await service.stop();
  });

  it('授权失败也只按原 revision 标记，避免覆盖后发流程', async () => {
    root = await mkdtemp(join(tmpdir(), 'agent-dws-auth-'));
    const accounts = accountStore();
    const auth = authStore();
    const service = new AgentDwsAuthFlowService({
      agentCwd: join(root, 'workspaces'),
      authSessionStore: auth,
      accountStore: accounts,
      runner: { login: vi.fn(async () => { throw new Error('Bearer secret-token'); }) },
    });

    await service.start(account);
    await waitForCall(accounts.markAuthorizationFailed as ReturnType<typeof vi.fn>);
    expect(accounts.markAuthorizationFailed).toHaveBeenCalledWith(
      'tenant-a', 'adws-1', 7, 'Bearer [REDACTED]', 'system:agent-dws-auth',
    );
    await service.stop();
  });
});
