/**
 * 极简路由：一个响应式当前路径 + 一张静态路由表。
 *
 * §9.2 要求「`pathPrefixes` 与路由守卫同源」，这里的可见性判定直接读 `/ky/v1/me`
 * 返回的菜单树，不另写一份权限规则。
 */
import { ref } from 'vue';

import type { MenuItem } from '@kaiyan/ky-app-contract/browser';

export const ROUTES = ['/', '/orders', '/settings', '/settings/roles', '/local-login'] as const;
export type RoutePath = (typeof ROUTES)[number];

export const currentPath = ref<string>('/');
export const menus = ref<MenuItem[]>([]);
export const landing = ref<string | null>(null);

/** 去掉 query/hash 与结尾斜杠（§5.2 的规范化口径）。 */
export function cleanPath(path: string): string {
  const withoutQuery = path.split('?')[0].split('#')[0];
  const trimmed = withoutQuery.replace(/\/+$/u, '');
  return trimmed === '' ? '/' : trimmed;
}

export function isKnownRoute(path: string): boolean {
  return (ROUTES as readonly string[]).includes(cleanPath(path));
}

/** 菜单树里是否存在这个 path（父节点也算，用于 `/settings`）。 */
export function isVisible(path: string, items: MenuItem[] = menus.value): boolean {
  return items.some(
    (item) => item.path === path || (item.children !== undefined && isVisible(path, item.children)),
  );
}

export function setPath(path: string): void {
  currentPath.value = cleanPath(path);
}
