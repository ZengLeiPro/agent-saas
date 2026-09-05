/** §4.2 / §9.3-8 `/me` 组装：声明式权限表过滤、landing、adminRole 必备菜单、兜底态角色。 */
import { describe, expect, it } from 'vitest';

import { MeBuildError, buildMe, firstLeafPath, localModeUserRoles } from './build.js';
import type { PermissionMenu } from './build.js';
import { TEST_MANIFEST } from '../__tests__/helpers.js';

const TABLE: PermissionMenu[] = [
  { menuKey: 'orders', label: '订单', path: '/orders', requiredPermission: 'orders.read' },
  {
    menuKey: 'settings',
    label: '设置',
    path: '/settings',
    children: [
      {
        menuKey: 'settings.roles',
        label: '角色权限',
        path: '/settings/roles',
        requiredPermission: 'settings.roles.manage',
      },
      {
        menuKey: 'settings.profile',
        label: '个人资料',
        path: '/settings/profile',
        requiredPermission: 'settings.profile.read',
      },
    ],
  },
];

const CAPABILITIES = [
  { id: 'order.search', enabled: true },
  { id: 'order.create', enabled: true },
];

function build(input: {
  permissions: string[];
  isTenantAdmin?: boolean;
  roles?: string[];
  table?: PermissionMenu[];
}) {
  return buildMe({
    permissionTable: input.table ?? TABLE,
    user: {
      id: 'u_1',
      displayName: '张三',
      roles: input.roles ?? [],
      isTenantAdmin: input.isTenantAdmin ?? false,
    },
    permissions: input.permissions,
    capabilities: CAPABILITIES,
    permVersion: 'pv_1',
    manifest: TEST_MANIFEST,
  });
}

describe('buildMe', () => {
  it('无任何业务角色的用户：menus 为空、landing 为 null', () => {
    const me = build({ permissions: [] });
    expect(me.menus).toEqual([]);
    expect(me.landing).toBeNull();
    expect(me.contractVersion).toBe(1);
  });

  it('按权限点过滤，landing = 第一个叶子', () => {
    const me = build({ permissions: ['orders.read', 'settings.profile.read'] });
    expect(me.menus.map((menu) => menu.key)).toEqual(['orders', 'settings']);
    expect(me.menus[1].children?.map((child) => child.key)).toEqual(['settings.profile']);
    expect(me.landing).toBe('/orders');
  });

  it('父节点没有可见子时整体隐藏', () => {
    const me = build({ permissions: ['orders.read'] });
    expect(me.menus.map((menu) => menu.key)).toEqual(['orders']);
  });

  it('父节点自身的权限不满足时整棵子树隐藏', () => {
    const table: PermissionMenu[] = [
      {
        menuKey: 'admin',
        label: '管理',
        path: '/admin',
        requiredPermission: 'admin.enter',
        children: [{ menuKey: 'admin.users', label: '用户', path: '/admin/users' }],
      },
    ];
    expect(build({ permissions: [], table }).menus).toEqual([]);
    expect(build({ permissions: ['admin.enter'], table }).menus).toHaveLength(1);
  });

  it('adminRole 用户的 menus 必须含 settings.roles，缺了直接报错', () => {
    const me = build({
      permissions: ['orders.read', 'settings.roles.manage'],
      isTenantAdmin: true,
      roles: ['admin'],
    });
    expect(me.user.isTenantAdmin).toBe(true);
    expect(me.menus[1].children?.[0].key).toBe('settings.roles');

    expect(() => build({ permissions: ['orders.read'], isTenantAdmin: true })).toThrowError(
      MeBuildError,
    );
  });

  it('capabilities 不在 manifest 中时自检拦下', () => {
    expect(() =>
      buildMe({
        permissionTable: TABLE,
        user: { id: 'u_1', displayName: '张三', roles: [], isTenantAdmin: false },
        permissions: [],
        capabilities: [{ id: 'not.in.manifest', enabled: true }],
        permVersion: 'pv_1',
        manifest: TEST_MANIFEST,
      }),
    ).toThrowError(MeBuildError);
  });

  it('菜单 path 非法时自检拦下（§5.2 共用规范化函数）', () => {
    const table: PermissionMenu[] = [{ menuKey: 'bad', label: '坏', path: '/a/../b' }];
    expect(() => build({ permissions: [], table })).toThrowError(MeBuildError);
  });
});

describe('firstLeafPath', () => {
  it('深度优先取第一个叶子', () => {
    expect(
      firstLeafPath([
        { key: 'a', label: 'a', path: '/a', children: [{ key: 'b', label: 'b', path: '/a/b' }] },
      ]),
    ).toBe('/a/b');
    expect(firstLeafPath([])).toBeNull();
  });
});

describe('兜底态角色（§3.2）', () => {
  it('local_admin = 本地业务角色 ∪ adminRole 且 isTenantAdmin=true', () => {
    expect(localModeUserRoles('local_admin', ['sales'], 'admin')).toEqual({
      roles: ['sales', 'admin'],
      isTenantAdmin: true,
    });
    expect(localModeUserRoles('local_admin', ['admin'], 'admin').roles).toEqual(['admin']);
  });

  it('local_user 只有本地业务角色', () => {
    expect(localModeUserRoles('local_user', ['sales'], 'admin')).toEqual({
      roles: ['sales'],
      isTenantAdmin: false,
    });
  });
});
