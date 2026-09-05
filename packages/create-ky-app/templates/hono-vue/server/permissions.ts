/**
 * §9.2 强制范式第 1 条：**声明式权限表**。
 *
 * 这一张表同时驱动三处，改权限只改这里：
 * 1. `GET /ky/v1/me` 的菜单树（`buildMe()` 按 `requiredPermission` 过滤）；
 * 2. 后端页面接口的鉴权（`requirePermission()`）；
 * 3. 前端路由守卫（前端读 `/me` 的菜单，不另写一份）。
 */
import { createHash } from 'node:crypto';

import type { PermissionMenu } from '@kaiyan/ky-app-server';

/** 权限点。新增页面时先在这里加一个点，再挂到菜单与接口上。 */
export const PERMISSIONS = {
  ordersRead: 'orders.read',
  ordersWrite: 'orders.write',
  rolesManage: 'settings.roles.manage',
} as const;

/** manifest `roles.adminRole`：组织管理员的保留系统角色。 */
export const ADMIN_ROLE = 'admin';

/** 业务角色 → 权限点。`admin` 是保留角色，由目录事件与 SAT `tadm` 双通道同步。 */
export const ROLE_PERMISSIONS: Readonly<Record<string, readonly string[]>> = {
  [ADMIN_ROLE]: [PERMISSIONS.ordersRead, PERMISSIONS.ordersWrite, PERMISSIONS.rolesManage],
  sales: [PERMISSIONS.ordersRead, PERMISSIONS.ordersWrite],
  viewer: [PERMISSIONS.ordersRead],
};

/** 可分配的业务角色（角色权限页展示用；`admin` 不在其中，它由平台侧同步）。 */
export const ASSIGNABLE_ROLES = ['sales', 'viewer'] as const;

/**
 * 菜单树。`settings.roles` 是契约要求组织管理员必备的入口（§4.2 / §9.2），
 * 缺了 `buildMe()` 会直接抛错，不会悄悄少一块。
 */
export const PERMISSION_TABLE: PermissionMenu[] = [
  {
    menuKey: 'orders',
    label: '订单',
    path: '/orders',
    icon: 'package',
    requiredPermission: PERMISSIONS.ordersRead,
  },
  {
    menuKey: 'settings',
    label: '设置',
    path: '/settings',
    icon: 'settings',
    children: [
      {
        menuKey: 'settings.roles',
        label: '角色权限',
        path: '/settings/roles',
        requiredPermission: PERMISSIONS.rolesManage,
      },
    ],
  },
];

/**
 * 角色 → 权限点集合。
 * 组织管理员（SAT `tadm=true` 或目录里的 `isTenantAdmin`）额外获得 `adminRole` 的权限。
 */
export function permissionsFor(roles: readonly string[], isTenantAdmin: boolean): Set<string> {
  const granted = new Set<string>();
  const effective = isTenantAdmin ? [...roles, ADMIN_ROLE] : roles;
  for (const role of effective) {
    for (const permission of ROLE_PERMISSIONS[role] ?? []) granted.add(permission);
  }
  return granted;
}

/** `/me.user.roles`：业务角色 ∪（管理员时的 adminRole）。 */
export function effectiveRoles(roles: readonly string[], isTenantAdmin: boolean): string[] {
  const set = new Set(roles);
  if (isTenantAdmin) set.add(ADMIN_ROLE);
  return [...set].sort((left, right) => left.localeCompare(right));
}

/**
 * §3.4 权限版本：权限点集合的稳定哈希。角色一变它就变，
 * 于是每个业务 API 响应里的 `X-KY-Perm-Version` 也随之变化。
 */
export function permVersionOf(roles: readonly string[], isTenantAdmin: boolean): string {
  const permissions = [...permissionsFor(roles, isTenantAdmin)].sort((left, right) =>
    left.localeCompare(right),
  );
  return `pv_${createHash('sha256').update(permissions.join('|'), 'utf8').digest('hex').slice(0, 12)}`;
}
