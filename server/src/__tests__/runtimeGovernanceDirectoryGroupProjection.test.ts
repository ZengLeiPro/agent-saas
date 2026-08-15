import { describe, expect, it, vi } from 'vitest';

import { resolveLegacyAssignmentAudience } from '../app/runtimeGovernanceStores.js';

const users = {
  'user-1': { tenantId: 'tenant-a', username: 'alice' },
  'user-2': { tenantId: 'tenant-a', username: 'bob' },
  'user-3': { tenantId: 'tenant-a', username: 'charlie' },
};

const findUserById = (userId: string) => users[userId as keyof typeof users];

function directoryGroups(groups: Record<string, string[]>) {
  return {
    getAssignmentSnapshot: vi.fn(async (_tenantId: string, groupId: string) => {
      const memberUserIds = groups[groupId];
      return memberUserIds ? { memberUserIds, fresh: true } : null;
    }),
  };
}

describe('Assignment directory_group legacy audience projection', () => {
  it('全员 allow 与组 deny 合并直接用户、去重后投影为 deny_users', async () => {
    const groups = directoryGroups({ 'dept-sales': ['user-1', 'user-2'] });

    await expect(resolveLegacyAssignmentAudience({
      tenantId: 'tenant-a',
      assignments: [
        { assigneeType: 'everyone', effect: 'allow' },
        { assigneeType: 'directory_group', assigneeId: 'dept-sales', effect: 'deny' },
        { assigneeType: 'user', assigneeId: 'user-2', effect: 'deny' },
        { assigneeType: 'user', assigneeId: 'user-3', effect: 'deny' },
      ],
      directoryGroups: groups,
      findUserById,
    })).resolves.toEqual({
      exposure: 'deny_users',
      usernames: ['alice', 'bob', 'charlie'],
      departmentIds: ['dept-sales'],
    });
    expect(groups.getAssignmentSnapshot).toHaveBeenCalledWith('tenant-a', 'dept-sales');
  });

  it('指定组 allow 展开 active memberUserIds，且 deny 覆盖重叠成员', async () => {
    await expect(resolveLegacyAssignmentAudience({
      tenantId: 'tenant-a',
      assignments: [
        { assigneeType: 'directory_group', assigneeId: 'dept-sales', effect: 'allow' },
        { assigneeType: 'user', assigneeId: 'user-1', effect: 'allow' },
        { assigneeType: 'user', assigneeId: 'user-2', effect: 'deny' },
      ],
      directoryGroups: directoryGroups({ 'dept-sales': ['user-1', 'user-2'] }),
      findUserById,
    })).resolves.toEqual({
      exposure: 'allow_users',
      usernames: ['alice'],
      departmentIds: ['dept-sales'],
    });
  });

  it('everyone deny 保持 deny 优先，显式 allow 不会重新开放用户', async () => {
    await expect(resolveLegacyAssignmentAudience({
      tenantId: 'tenant-a',
      assignments: [
        { assigneeType: 'everyone', effect: 'deny' },
        { assigneeType: 'directory_group', assigneeId: 'dept-sales', effect: 'allow' },
      ],
      directoryGroups: directoryGroups({ 'dept-sales': ['user-1'] }),
      findUserById,
    })).resolves.toEqual({
      exposure: 'allow_users',
      usernames: [],
      departmentIds: ['dept-sales'],
    });
  });

  it('组 authority 缺失、组不存在或成员身份无法解析时 fail closed', async () => {
    const assignment = { assigneeType: 'directory_group' as const, assigneeId: 'dept-sales', effect: 'allow' as const };

    await expect(resolveLegacyAssignmentAudience({
      tenantId: 'tenant-a', assignments: [assignment], findUserById,
    })).rejects.toThrow('GOVERNANCE_PROJECTION_DIRECTORY_GROUP_AUTHORITY_UNAVAILABLE');

    await expect(resolveLegacyAssignmentAudience({
      tenantId: 'tenant-a', assignments: [assignment],
      directoryGroups: directoryGroups({}), findUserById,
    })).rejects.toThrow('GOVERNANCE_PROJECTION_DIRECTORY_GROUP_UNRESOLVED');

    await expect(resolveLegacyAssignmentAudience({
      tenantId: 'tenant-a', assignments: [assignment],
      directoryGroups: directoryGroups({ 'dept-sales': ['missing-user'] }), findUserById,
    })).rejects.toThrow('GOVERNANCE_PROJECTION_IDENTITY_UNRESOLVED');
  });

  it('agent assignee 仍被拒绝', async () => {
    const groups = directoryGroups({});
    await expect(resolveLegacyAssignmentAudience({
      tenantId: 'tenant-a',
      assignments: [{ assigneeType: 'agent', assigneeId: 'agent-1', effect: 'allow' }],
      directoryGroups: groups,
      findUserById,
    })).rejects.toThrow('GOVERNANCE_PROJECTION_UNSUPPORTED_ASSIGNEE');
    expect(groups.getAssignmentSnapshot).not.toHaveBeenCalled();
  });
});
