import { describe, expect, it, vi } from 'vitest';

import type { AgentDwsAccountRecord } from '../data/agentDwsAccounts/index.js';
import { InMemoryGovernanceAuditStore } from '../data/governance-audit/store.js';
import {
  DwsRequesterIdentityResolver,
  parseDwsRequesterDirectoryEntries,
} from './requesterIdentityResolver.js';

const account: AgentDwsAccountRecord = {
  accountId: 'account-a', tenantId: 'tenant-a', agentId: 'agent-a', displayName: '专家甲',
  loginId: 'login-a', profileId: 'corp-a:agent-staff', corpId: 'corp-a',
  dingtalkUserId: 'agent-staff', status: 'active', runtimeStatus: 'ready',
  eventKinds: ['at_me', 'all_direct'], revision: 1, createdAt: '2026-08-25T00:00:00.000Z',
  createdBy: 'admin-a', updatedAt: '2026-08-25T00:00:00.000Z', updatedBy: 'admin-a',
};
const alice = {
  id: 'user-a', username: 'alice', role: 'user' as const, tenantId: 'tenant-a',
  realName: '爱丽丝', dingtalkStaffId: 'staff-a', disabled: false,
  createdAt: '', createdBy: '', updatedAt: '',
};

function resolver(users: unknown[], content: string) {
  const invoke = vi.fn().mockResolvedValue({ status: 'success', content });
  const auditStore = new InMemoryGovernanceAuditStore();
  return {
    invoke,
    auditStore,
    resolver: new DwsRequesterIdentityResolver({
      agentCwd: '/workspace',
      userStore: { listAll: vi.fn().mockReturnValue(users) } as never,
      auditStore,
      resolveServerRemote: vi.fn().mockResolvedValue({ baseUrl: 'https://hand.test', authToken: 'token-a' }),
      createTransport: () => ({ invoke }),
    }),
  };
}

describe('DwsRequesterIdentityResolver', () => {
  it('用专家视角 contact 结果的 staffId + openDingTalkId 唯一解析同租户成员', async () => {
    const { resolver: subject, invoke, auditStore } = resolver([
      alice,
      { ...alice, id: 'disabled', username: 'disabled', dingtalkStaffId: 'staff-disabled', disabled: true },
      { ...alice, id: 'cross', username: 'cross', tenantId: 'tenant-b', dingtalkStaffId: 'staff-cross' },
    ], '[stdout]\n{"success":true,"result":[{"userId":"staff-a","openDingTalkId":"open-a"}]}\n[stderr]\n');

    await expect(subject.resolve(account, 'open-a', '爱丽丝')).resolves.toMatchObject({
      id: 'user-a', username: 'alice', tenantId: 'tenant-a', dingtalkStaffId: 'staff-a',
    });
    const request = invoke.mock.calls[0]![0];
    expect(request.input.command).toContain("'contact' 'user' 'get' '--ids' 'staff-a'");
    expect(request.input.command).toContain("'--profile' 'corp-a:agent-staff' '--format' 'json'");
    expect(request.context.workspace).toMatchObject({
      userId: 'account-a', tenantId: 'tenant-a', executionTarget: 'server-remote',
    });
    expect(auditStore.events.map(event => event.result)).toEqual([
      'intent', 'succeeded', 'intent', 'succeeded', 'succeeded',
    ]);
    expect(JSON.stringify(auditStore.events)).not.toContain('corp-a:agent-staff');
  });

  it('无匹配、跨 staffId 或平台成员映射重复时 fail closed', async () => {
    const noMatch = resolver([alice], '{"result":[{"userId":"staff-b","openDingTalkId":"open-a"}]}').resolver;
    await expect(noMatch.resolve(account, 'open-a')).resolves.toBeNull();

    const duplicate = resolver([
      alice,
      { ...alice, id: 'user-b', username: 'bob' },
    ], '{"result":[{"staffId":"staff-a","openDingtalkId":"open-a"}]}').resolver;
    await expect(duplicate.resolve(account, 'open-a')).resolves.toBeNull();

    const dwsAmbiguous = resolver([alice], JSON.stringify({ result: [
      { staffId: 'staff-a', openDingtalkId: 'open-a' },
      { staffId: 'external-staff', openDingtalkId: 'open-a' },
    ] })).resolver;
    await expect(dwsAmbiguous.resolve(account, 'open-a', '爱丽丝')).resolves.toBeNull();

    const selfEcho = resolver([
      { ...alice, id: 'agent-user', username: 'agent-user', dingtalkStaffId: 'agent-staff' },
    ], '{"result":[{"staffId":"agent-staff","openDingtalkId":"agent-open"}]}').resolver;
    await expect(selfEcho.resolve(account, 'agent-open')).resolves.toBeNull();
  });

  it('解析嵌套结果并拒绝无效 JSON', () => {
    expect(parseDwsRequesterDirectoryEntries('{"result":{"items":[{"staff_id":123,"open_dingtalk_id":"open-a"}]}}'))
      .toEqual([{ staffId: '123', openDingtalkId: 'open-a' }]);
    expect(() => parseDwsRequesterDirectoryEntries('not-json')).toThrow('未返回 JSON');
  });
});
