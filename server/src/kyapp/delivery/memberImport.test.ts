import { describe, expect, it, vi } from 'vitest';

import { KyAppMemberImporter } from './memberImport.js';

function user(id: string, phone: string, tenantId: string, disabled = false) {
  return { id, username: phone, phone, tenantId, disabled, role: 'user' };
}

describe('KyAppMemberImporter', () => {
  it('重复 CSV、跨组织手机号与停用用户逐行拒绝，正常行写工号和部门层级', async () => {
    const created = user('u-new', '13800138000', 't1');
    const users = {
      findAllByPhone: (phone: string) =>
        phone === '13900139000'
          ? [user('u-other', phone, 't2')]
          : phone === '13700137000'
            ? [user('u-disabled', phone, 't1', true)]
            : [],
      create: vi.fn().mockResolvedValue(created),
    };
    const memberships = {
      getMembership: vi.fn().mockResolvedValue(null),
      createMembership: vi.fn().mockResolvedValue({}),
    };
    const groups = {
      listGroups: vi.fn().mockResolvedValue([]),
      listMembers: vi.fn().mockResolvedValue([]),
      upsertProjection: vi.fn().mockResolvedValue({}),
    };
    const directory = { setEmployeeNo: vi.fn().mockResolvedValue(undefined) };
    const importer = new KyAppMemberImporter({ users, memberships, groups, directory } as never);
    const result = await importer.import('t1', 'admin', [
      {
        row: 2,
        name: '张三',
        phone: '13800138000',
        departmentPath: '总部/销售',
        employeeNo: 'E001',
      },
      { row: 3, name: '重复', phone: '13800138000', departmentPath: '总部' },
      { row: 4, name: '跨组织', phone: '13900139000', departmentPath: '总部' },
      { row: 5, name: '停用', phone: '13700137000', departmentPath: '总部' },
    ]);
    expect(result).toMatchObject({ total: 4, created: 1, rejected: 3 });
    expect(result.rows.map((item) => item.code)).toEqual([
      undefined,
      'duplicate_phone',
      'cross_tenant_phone',
      'disabled_user',
    ]);
    expect(directory.setEmployeeNo).toHaveBeenCalledWith('t1', 'u-new', 'E001');
    expect(groups.upsertProjection).toHaveBeenCalledTimes(2);
  });

  it('同组织有效用户重复导入幂等，不重复建账号和成员', async () => {
    const existing = user('u1', '13800138000', 't1');
    const create = vi.fn();
    const createMembership = vi.fn();
    const importer = new KyAppMemberImporter({
      users: { findAllByPhone: () => [existing], create },
      memberships: { getMembership: async () => ({ version: 1 }), createMembership },
      groups: {
        listGroups: async () => [],
        listMembers: async () => [],
        upsertProjection: async () => ({}),
      },
      directory: { setEmployeeNo: async () => undefined },
    } as never);
    expect(
      await importer.import('t1', 'admin', [
        { row: 2, name: '张三', phone: '13800138000', departmentPath: '总部' },
      ]),
    ).toMatchObject({ created: 0, existing: 1, rejected: 0 });
    expect(create).not.toHaveBeenCalled();
    expect(createMembership).not.toHaveBeenCalled();
  });

  it('重复导入改变部门时移除旧 CSV 组归属，但保留组内未导入成员', async () => {
    const existing = user('u1', '13800138000', 't1');
    const upsertProjection = vi.fn().mockResolvedValue({});
    const oldGroup = {
      groupId: 'csv_old',
      source: 'governance',
      displayName: '旧部门',
      status: 'active',
    };
    const importer = new KyAppMemberImporter({
      users: { findAllByPhone: () => [existing], create: vi.fn() },
      memberships: { getMembership: async () => ({ version: 1 }), createMembership: vi.fn() },
      groups: {
        listGroups: async () => [oldGroup],
        listMembers: async (_tenantId: string, groupId: string) =>
          groupId === 'csv_old' ? [{ userId: 'u1' }, { userId: 'u-other' }] : [],
        upsertProjection,
      },
      directory: { setEmployeeNo: async () => undefined },
    } as never);

    await importer.import('t1', 'admin', [
      { row: 2, name: '张三', phone: '13800138000', departmentPath: '新部门' },
    ]);

    expect(upsertProjection).toHaveBeenCalledWith(
      expect.objectContaining({ groupId: 'csv_old', memberUserIds: ['u-other'] }),
    );
  });
});
