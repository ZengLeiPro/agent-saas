import { describe, expect, it, vi } from 'vitest';

import type { AgentDwsAccountRecord } from '../data/agentDwsAccounts/index.js';
import { parseEventLine } from './personalEventGateway.js';
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
  it('用交互式专家视角 contact 结果的 staffId + openDingTalkId 唯一解析同租户成员', async () => {
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
      workload: { class: 'interactive' },
    });
    expect(auditStore.events.map(event => event.result)).toEqual([
      'intent', 'succeeded', 'intent', 'succeeded', 'succeeded',
    ]);
    expect(JSON.stringify(auditStore.events)).not.toContain('corp-a:agent-staff');
  });

  it('staffId 无匹配、跨映射或平台成员重复时 fail closed', async () => {
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

  it('使用 canonical sender 触发姓名交叉查询并对冲突目录映射 fail closed', async () => {
    const event = parseEventLine(JSON.stringify({
      event_id: 'event-a', type: 'user_im_message_receive_o2o_all', sender: '爱丽丝',
      sender_open_dingtalk_id: 'open-a', content: 'hi',
    }));
    const invoke = vi.fn(async (request: { input: { command: string } }) => ({
      status: 'success' as const,
      content: request.input.command.includes("'search'")
        ? '{"result":[{"staffId":"external-staff","openDingtalkId":"open-a"}]}'
        : '{"result":[{"staffId":"staff-a","openDingtalkId":"open-a"}]}',
    }));
    const subject = new DwsRequesterIdentityResolver({
      agentCwd: '/workspace',
      userStore: { listAll: vi.fn().mockReturnValue([alice]) } as never,
      auditStore: new InMemoryGovernanceAuditStore(),
      resolveServerRemote: vi.fn().mockResolvedValue({ baseUrl: 'https://hand.test', authToken: 'token-a' }),
      createTransport: () => ({ invoke }) as never,
    });

    await expect(subject.resolve(account, event!.senderOpenDingtalkId!, event!.senderName)).resolves.toBeNull();
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(invoke.mock.calls[1]![0].input.command).toContain("'search' '--query' '爱丽丝'");
  });

  it('tenant 用户缺少 staffId 时用 DWS openDingTalkId + 已验证手机号精确解析', async () => {
    const user = {
      ...alice,
      dingtalkStaffId: undefined,
      phone: '13800138000',
      phoneVerifiedAt: '2026-08-25T00:00:00.000Z',
    };
    const invoke = vi.fn().mockResolvedValue({
      status: 'success',
      content: '{"result":[{"staffId":"staff-a","openDingTalkId":"open-a","mobile":"+86 138-0013-8000"}]}',
    });
    const reload = vi.fn();
    const subject = new DwsRequesterIdentityResolver({
      agentCwd: '/workspace',
      userStore: { listAll: vi.fn().mockReturnValue([user]), reload } as never,
      auditStore: new InMemoryGovernanceAuditStore(),
      resolveServerRemote: vi.fn().mockResolvedValue({ baseUrl: 'https://hand.test', authToken: 'token-a' }),
      createTransport: () => ({ invoke }) as never,
    });

    await expect(subject.resolve(account, 'open-a', '爱丽丝')).resolves.toMatchObject({
      id: 'user-a', tenantId: 'tenant-a', dingtalkStaffId: 'staff-a',
    });
    expect(reload).toHaveBeenCalledOnce();
    expect(invoke.mock.calls[0]![0].input.command).toContain("'search' '--query' '爱丽丝'");
  });

  it('已有 staffId 与同手机号目录结果冲突时始终保持 fail-closed', async () => {
    const user = {
      ...alice,
      dingtalkStaffId: 'staff-old',
      phone: '13800138000',
      phoneVerifiedAt: '2026-08-25T00:00:00.000Z',
    };
    const directory = '{"result":[{"staffId":"staff-other","openDingTalkId":"open-a","mobile":"13800138000"}]}';

    await expect(resolver([user], directory).resolver.resolveOutcome(account, 'open-a', '爱丽丝'))
      .resolves.toMatchObject({ status: 'unmapped', reason: 'REQUESTER_IDENTITY_UNMAPPED' });
    await expect(resolver([
      user,
      { ...user, id: 'user-b', username: 'bob', dingtalkStaffId: undefined },
    ], directory).resolver.resolveOutcome(account, 'open-a', '爱丽丝'))
      .resolves.toMatchObject({ status: 'unmapped', reason: 'REQUESTER_IDENTITY_UNMAPPED' });
  });

  it('未验证手机号、重复手机号和跨租户手机号都不能建立身份', async () => {
    const directory = '{"result":[{"staffId":"staff-a","openDingTalkId":"open-a","mobile":"13800138000"}]}';
    const unverified = { ...alice, dingtalkStaffId: undefined, phone: '13800138000' };
    await expect(resolver([unverified], directory).resolver.resolve(account, 'open-a', '爱丽丝'))
      .resolves.toBeNull();

    const verified = { ...unverified, phoneVerifiedAt: '2026-08-25T00:00:00.000Z' };
    await expect(resolver([
      verified,
      { ...verified, id: 'user-b', username: 'bob' },
    ], directory).resolver.resolve(account, 'open-a', '爱丽丝')).resolves.toBeNull();
    await expect(resolver([
      { ...verified, tenantId: 'tenant-b' },
    ], directory).resolver.resolve(account, 'open-a', '爱丽丝')).resolves.toBeNull();
  });

  it('解析嵌套结果、手机号并拒绝无效 JSON', () => {
    expect(parseDwsRequesterDirectoryEntries('{"result":{"items":[{"staff_id":123,"open_dingtalk_id":"open-a","mobile":"13800138000"}]}}'))
      .toEqual([{ staffId: '123', openDingtalkId: 'open-a', mobile: '13800138000' }]);
    expect(() => parseDwsRequesterDirectoryEntries('not-json')).toThrow('未返回 JSON');
  });
});
