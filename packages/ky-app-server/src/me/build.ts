/**
 * §4.2 / §9.2 `GET /ky/v1/me`：由**声明式权限表**过滤出菜单树。
 *
 * 同一张 `{menuKey, path, requiredPermission, children}` 表同时驱动 `/me` 与路由守卫，
 * 保证「深链可达的每个页面接口在无权用户下 403」与菜单可见性同源。
 * 输出前过一遍 contract 的 `validateMe()` 自检（附录 C schema + 语义）。
 */
import {
  ADMIN_REQUIRED_MENU_KEY,
  validateMe,
  type LocalAct,
  type Manifest,
  type MeCapability,
  type MeResponse,
  type MenuItem,
} from '@kaiyan/ky-app-contract';

/** 声明式权限表的一个节点。 */
export interface PermissionMenu {
  /** 全树唯一，对应附录 C 的 `menu.key`。 */
  menuKey: string;
  label: string;
  path: string;
  icon?: string;
  /** 需要的权限点；缺省表示所有已登录用户可见。 */
  requiredPermission?: string;
  badge?: { count?: number };
  children?: PermissionMenu[];
}

export interface BuildMeUser {
  id: string;
  displayName: string;
  roles: string[];
  isTenantAdmin: boolean;
}

export interface BuildMeInput {
  permissionTable: PermissionMenu[];
  user: BuildMeUser;
  /** 该用户已授予的权限点。 */
  permissions: Iterable<string>;
  capabilities: MeCapability[];
  permVersion: string;
  /** 传入后额外校验 `capabilities[].id` ∈ manifest。 */
  manifest?: Manifest;
}

export class MeBuildError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MeBuildError';
  }
}

function toMenuItem(node: PermissionMenu, children: MenuItem[]): MenuItem {
  return {
    key: node.menuKey,
    label: node.label,
    path: node.path,
    ...(node.icon === undefined ? {} : { icon: node.icon }),
    ...(node.badge === undefined ? {} : { badge: node.badge }),
    ...(children.length === 0 ? {} : { children }),
  };
}

/**
 * 过滤规则：
 * - 节点自身的 `requiredPermission` 不满足 → 整棵子树不可见；
 * - 有 `children` 的节点必须至少有一个可见子，否则自身也不可见（附录 C「父必有 ≥ 1 子」）；
 * - 叶子节点满足权限即可见。
 */
function filterMenus(nodes: PermissionMenu[], granted: ReadonlySet<string>): MenuItem[] {
  const result: MenuItem[] = [];
  for (const node of nodes) {
    if (node.requiredPermission !== undefined && !granted.has(node.requiredPermission)) continue;
    const declaredChildren = node.children ?? [];
    if (declaredChildren.length === 0) {
      result.push(toMenuItem(node, []));
      continue;
    }
    const children = filterMenus(declaredChildren, granted);
    if (children.length === 0) continue;
    result.push(toMenuItem(node, children));
  }
  return result;
}

/** 深度优先取第一个叶子的 `path`；菜单为空返回 null（附录 C）。 */
export function firstLeafPath(menus: MenuItem[]): string | null {
  for (const menu of menus) {
    if (menu.children === undefined || menu.children.length === 0) return menu.path;
    const nested = firstLeafPath(menu.children);
    if (nested !== null) return nested;
  }
  return null;
}

function hasKey(menus: MenuItem[], key: string): boolean {
  return menus.some(
    (menu) => menu.key === key || (menu.children !== undefined && hasKey(menu.children, key)),
  );
}

/** 组装 `/me` 响应。 */
export function buildMe(input: BuildMeInput): MeResponse {
  const granted = new Set(input.permissions);
  const menus = filterMenus(input.permissionTable, granted);

  // §4.2 / §9.2：`adminRole` 用户的 menus 必须含 key `settings.roles`。
  // 权限表里没有这一项属于配置错误，装载期就应该失败，不能让线上悄悄少一块。
  if (input.user.isTenantAdmin && !hasKey(menus, ADMIN_REQUIRED_MENU_KEY)) {
    throw new MeBuildError(
      `组织管理员的菜单必须含 ${ADMIN_REQUIRED_MENU_KEY}，请检查声明式权限表与该用户的权限点`,
    );
  }

  const me: MeResponse = {
    contractVersion: 1,
    user: {
      id: input.user.id,
      displayName: input.user.displayName,
      roles: [...input.user.roles],
      isTenantAdmin: input.user.isTenantAdmin,
    },
    landing: firstLeafPath(menus),
    menus,
    capabilities: input.capabilities.map((capability) => ({ ...capability })),
    permVersion: input.permVersion,
  };

  const check = validateMe(me, input.manifest);
  if (!check.ok) {
    throw new MeBuildError(`/me 自检未通过：${check.errors.join('；')}`);
  }
  return me;
}

/**
 * §3.2 兜底态的角色规则：
 * `local_admin` → 本地业务角色 ∪ {adminRole}、`isTenantAdmin=true`（菜单含 `settings.roles`）；
 * `local_user` → 本地业务角色、`isTenantAdmin=false`。
 */
export function localModeUserRoles(
  act: LocalAct,
  localRoles: readonly string[],
  adminRole: string,
): { roles: string[]; isTenantAdmin: boolean } {
  if (act === 'local_admin') {
    const roles = localRoles.includes(adminRole) ? [...localRoles] : [...localRoles, adminRole];
    return { roles, isTenantAdmin: true };
  }
  return { roles: [...localRoles], isTenantAdmin: false };
}
