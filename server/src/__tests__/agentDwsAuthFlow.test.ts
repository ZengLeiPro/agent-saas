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
  displayName: '销售数字员工', loginId: 'sales-agent-001', corpId: 'corp-a',
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
    setContextPolicy: vi.fn(async () => account),
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

  it('重授权先失效旧身份资源，再接受有新鲜证据的 currentProfile', async () => {
    root = await mkdtemp(join(tmpdir(), 'agent-dws-auth-'));
    const agentCwd = join(root, 'workspaces');
    const profileDir = join(
      resolveAgentConnectorCwd(agentCwd, account.tenantId, account.agentId, 'dws'),
      '.dws/config',
    );
    const profileFile = join(profileDir, 'profiles.json');
    await mkdir(profileDir, { recursive: true });
    await writeFile(profileFile, JSON.stringify({
      version: 3,
      currentProfile: 'corp-a:ding-user-a',
      orgCurrentProfiles: { 'corp-a': 'corp-a:ding-user-a' },
      profiles: [
        { name: 'old', corpId: 'corp-a', corpName: '示例企业', userId: 'ding-user-old', userName: '旧账号' },
        {
          name: 'new', corpId: 'corp-a', corpName: '示例企业', userId: 'ding-user-a',
          userName: '销售数字员工', updatedAt: '2026-08-29T00:00:00.000Z',
        },
      ],
    }));
    const accounts = accountStore();
    const auth = authStore();
    const onBeforeAccountIdentityChange = vi.fn(async () => undefined);
    const service = new AgentDwsAuthFlowService({
      agentCwd,
      authSessionStore: auth,
      accountStore: accounts,
      onBeforeAccountIdentityChange,
      runner: {
        login: vi.fn(async () => {
          await writeFile(profileFile, JSON.stringify({
            version: 3,
            currentProfile: 'corp-a:ding-user-a',
            orgCurrentProfiles: { 'corp-a': 'corp-a:ding-user-a' },
            profiles: [
              { name: 'old', corpId: 'corp-a', userId: 'ding-user-old' },
              {
                name: 'new', corpId: 'corp-a', userId: 'ding-user-a',
                updatedAt: '2026-08-30T00:00:00.000Z',
              },
            ],
          }));
        }),
      },
    });

    await service.start({
      ...account,
      profileId: 'corp-a:ding-user-old',
      corpId: 'corp-a',
      dingtalkUserId: 'ding-user-old',
    });
    await waitForCall(accounts.markAuthorized as ReturnType<typeof vi.fn>);
    expect(onBeforeAccountIdentityChange).toHaveBeenCalledWith(expect.objectContaining({
      profileId: 'corp-a:ding-user-old',
      dingtalkUserId: 'ding-user-old',
    }));
    expect(onBeforeAccountIdentityChange.mock.invocationCallOrder[0])
      .toBeLessThan((accounts.markAuthorized as ReturnType<typeof vi.fn>)
        .mock.invocationCallOrder[0]!);
    expect(accounts.markAuthorized).toHaveBeenCalledWith(
      'tenant-a', 'adws-1', 7,
      expect.objectContaining({
        profileId: 'corp-a:ding-user-a', corpId: 'corp-a', dingtalkUserId: 'ding-user-a',
      }),
      'system:agent-dws-auth',
    );
    expect(auth.markConnected).toHaveBeenCalled();
    await service.stop();
  });

  it('login 未改变既有 currentProfile 的任何授权证据时拒绝沿用旧账号', async () => {
    root = await mkdtemp(join(tmpdir(), 'agent-dws-auth-'));
    const agentCwd = join(root, 'workspaces');
    const profileDir = join(
      resolveAgentConnectorCwd(agentCwd, account.tenantId, account.agentId, 'dws'),
      '.dws/config',
    );
    await mkdir(profileDir, { recursive: true });
    await writeFile(join(profileDir, 'profiles.json'), JSON.stringify({
      version: 3,
      currentProfile: 'corp-a:ding-user-old',
      profiles: [{
        name: 'old', corpId: 'corp-a', userId: 'ding-user-old',
        updatedAt: '2026-08-29T00:00:00.000Z',
      }],
    }));
    const accounts = accountStore();
    const service = new AgentDwsAuthFlowService({
      agentCwd,
      authSessionStore: authStore(),
      accountStore: accounts,
      runner: { login: vi.fn(async () => undefined) },
    });

    await service.start(account);
    await waitForCall(accounts.markAuthorizationFailed as ReturnType<typeof vi.fn>);
    expect(accounts.markAuthorized).not.toHaveBeenCalled();
    expect(accounts.markAuthorizationFailed).toHaveBeenCalledWith(
      'tenant-a', 'adws-1', 7,
      expect.stringContaining('缺少新鲜授权证据'),
      'system:agent-dws-auth',
    );
    await service.stop();
  });

  it('同组织多账号没有 currentProfile 或 fresh evidence 时失败，不静默选择旧账号', async () => {
    root = await mkdtemp(join(tmpdir(), 'agent-dws-auth-'));
    const agentCwd = join(root, 'workspaces');
    const profileDir = join(
      resolveAgentConnectorCwd(agentCwd, account.tenantId, account.agentId, 'dws'),
      '.dws/config',
    );
    await mkdir(profileDir, { recursive: true });
    await writeFile(join(profileDir, 'profiles.json'), JSON.stringify({
      version: 3,
      profiles: [
        { name: 'old', corpId: 'corp-a', userId: 'ding-user-old' },
        { name: 'new', corpId: 'corp-a', userId: 'ding-user-new' },
      ],
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
    await waitForCall(accounts.markAuthorizationFailed as ReturnType<typeof vi.fn>);
    expect(accounts.markAuthorized).not.toHaveBeenCalled();
    expect(accounts.markAuthorizationFailed).toHaveBeenCalledWith(
      'tenant-a', 'adws-1', 7,
      expect.stringContaining('没有唯一 current profile'),
      'system:agent-dws-auth',
    );
    await service.stop();
  });

  it('没有 currentProfile 时只接受授权后唯一新增的精确账号', async () => {
    root = await mkdtemp(join(tmpdir(), 'agent-dws-auth-'));
    const agentCwd = join(root, 'workspaces');
    const profileDir = join(
      resolveAgentConnectorCwd(agentCwd, account.tenantId, account.agentId, 'dws'),
      '.dws/config',
    );
    const profileFile = join(profileDir, 'profiles.json');
    await mkdir(profileDir, { recursive: true });
    await writeFile(profileFile, JSON.stringify({
      version: 3,
      profiles: [{ name: 'old', corpId: 'corp-a', userId: 'ding-user-old' }],
    }));
    const accounts = accountStore();
    const service = new AgentDwsAuthFlowService({
      agentCwd,
      authSessionStore: authStore(),
      accountStore: accounts,
      runner: {
        login: vi.fn(async () => {
          await writeFile(profileFile, JSON.stringify({
            version: 3,
            profiles: [
              { name: 'old', corpId: 'corp-a', userId: 'ding-user-old' },
              { name: 'new', corpId: 'corp-a', userId: 'ding-user-new' },
            ],
          }));
        }),
      },
    });

    await service.start(account);
    await waitForCall(accounts.markAuthorized as ReturnType<typeof vi.fn>);
    expect(accounts.markAuthorized).toHaveBeenCalledWith(
      'tenant-a', 'adws-1', 7,
      expect.objectContaining({ profileId: 'corp-a:ding-user-new', dingtalkUserId: 'ding-user-new' }),
      'system:agent-dws-auth',
    );
    await service.stop();
  });

  it.each([
    ['旧账号', 'corp-a:ding-user-old'],
    ['新账号', 'corp-a:ding-user-new'],
  ])('旧、新账号同时 fresh 且 current 指向%s时拒绝歧义授权', async (_label, currentProfile) => {
    root = await mkdtemp(join(tmpdir(), 'agent-dws-auth-'));
    const agentCwd = join(root, 'workspaces');
    const profileDir = join(
      resolveAgentConnectorCwd(agentCwd, account.tenantId, account.agentId, 'dws'),
      '.dws/config',
    );
    const profileFile = join(profileDir, 'profiles.json');
    await mkdir(profileDir, { recursive: true });
    await writeFile(profileFile, JSON.stringify({
      version: 3,
      currentProfile: 'corp-a:ding-user-old',
      profiles: [{
        name: 'old', corpId: 'corp-a', userId: 'ding-user-old',
        updatedAt: '2026-08-29T00:00:00.000Z',
      }],
    }));
    const accounts = accountStore();
    const service = new AgentDwsAuthFlowService({
      agentCwd,
      authSessionStore: authStore(),
      accountStore: accounts,
      runner: {
        login: vi.fn(async () => {
          await writeFile(profileFile, JSON.stringify({
            version: 3,
            currentProfile,
            profiles: [
              {
                name: 'old', corpId: 'corp-a', userId: 'ding-user-old',
                updatedAt: '2026-08-30T00:00:00.000Z',
              },
              { name: 'new', corpId: 'corp-a', userId: 'ding-user-new' },
            ],
          }));
        }),
      },
    });

    await service.start(account);
    await waitForCall(accounts.markAuthorizationFailed as ReturnType<typeof vi.fn>);
    expect(accounts.markAuthorized).not.toHaveBeenCalled();
    expect(accounts.markAuthorizationFailed).toHaveBeenCalledWith(
      'tenant-a', 'adws-1', 7,
      expect.stringContaining('多个新鲜钉钉账号'),
      'system:agent-dws-auth',
    );
    await service.stop();
  });

  it('currentProfile 与唯一新增账号证据冲突时失败，不沿用旧账号', async () => {
    root = await mkdtemp(join(tmpdir(), 'agent-dws-auth-'));
    const agentCwd = join(root, 'workspaces');
    const profileDir = join(
      resolveAgentConnectorCwd(agentCwd, account.tenantId, account.agentId, 'dws'),
      '.dws/config',
    );
    const profileFile = join(profileDir, 'profiles.json');
    await mkdir(profileDir, { recursive: true });
    await writeFile(profileFile, JSON.stringify({
      version: 3,
      currentProfile: 'corp-a:ding-user-old',
      profiles: [{ name: 'old', corpId: 'corp-a', userId: 'ding-user-old' }],
    }));
    const accounts = accountStore();
    const service = new AgentDwsAuthFlowService({
      agentCwd,
      authSessionStore: authStore(),
      accountStore: accounts,
      runner: {
        login: vi.fn(async () => {
          await writeFile(profileFile, JSON.stringify({
            version: 3,
            currentProfile: 'corp-a:ding-user-old',
            profiles: [
              { name: 'old', corpId: 'corp-a', userId: 'ding-user-old' },
              { name: 'new', corpId: 'corp-a', userId: 'ding-user-new' },
            ],
          }));
        }),
      },
    });

    await service.start(account);
    await waitForCall(accounts.markAuthorizationFailed as ReturnType<typeof vi.fn>);
    expect(accounts.markAuthorized).not.toHaveBeenCalled();
    expect(accounts.markAuthorizationFailed).toHaveBeenCalledWith(
      'tenant-a', 'adws-1', 7,
      expect.stringContaining('current profile 与新增账号证据冲突'),
      'system:agent-dws-auth',
    );
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
