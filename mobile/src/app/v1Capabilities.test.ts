/**
 * M00-01：V1 能力清单（capability manifest）纯函数测试。
 *
 * 覆盖方案要求：
 *   - 深链 allowlist：生产档位白名单放行、延期/未分类路由 fail closed；
 *   - 生产菜单快照：生产 Tab = 对话/设置；
 *   - 档位解析：__DEV__ / EXPO_PUBLIC_V1_PROFILE / 未知值 fail closed。
 */
import { describe, expect, it } from 'vitest';
import {
  V1_ALLOWED_ROUTES,
  V1_CAPABILITY_MANIFEST_VERSION,
  V1_DEFERRED_ROUTES,
  V1_DELETED_ROUTES,
  V1_PRODUCTION_TABS,
  classifyV1Route,
  getV1VisibleTabs,
  isV1RouteAllowed,
  isV1SegmentsAllowed,
  resolveV1BuildProfile,
  resolveV1GateDecision,
} from './v1Capabilities';

const ALL_TABS = ['chat', 'files', 'settings'];

describe('V1 capability manifest 基础不变量', () => {
  it('清单版本存在且 Tab 快照为 对话/设置', () => {
    expect(V1_CAPABILITY_MANIFEST_VERSION).toBe(1);
    expect([...V1_PRODUCTION_TABS]).toEqual(['chat', 'settings']);
  });

  it('allowlist 与延期清单无重叠，且延期理由全部非空', () => {
    for (const route of V1_ALLOWED_ROUTES) {
      expect(V1_DEFERRED_ROUTES[route]).toBeUndefined();
    }
    for (const [route, reason] of Object.entries(V1_DEFERRED_ROUTES)) {
      expect(reason.trim().length, `${route} 理由不得为空`).toBeGreaterThan(0);
    }
  });

  it('已删除路由（墓碑）与 allowlist / 延期清单无重叠，且生产仍拒绝', () => {
    const deleted = Object.keys(V1_DELETED_ROUTES);
    expect(deleted).toContain('webview-spike');
    for (const route of deleted) {
      expect(V1_ALLOWED_ROUTES.includes(route)).toBe(false);
      expect(V1_DEFERRED_ROUTES[route]).toBeUndefined();
      // 墓碑路由不再存在，重新出现即为未分类 -> 生产 fail closed。
      expect(classifyV1Route(route)).toBe('unclassified');
      expect(isV1RouteAllowed(route, 'production')).toBe(false);
    }
  });

  it('路由 pattern 形态合法（无前导/尾随斜杠、无空段）', () => {
    for (const route of [...V1_ALLOWED_ROUTES, ...Object.keys(V1_DEFERRED_ROUTES)]) {
      expect(route.startsWith('/'), route).toBe(false);
      expect(route.endsWith('/'), route).toBe(false);
      expect(route.includes('//'), route).toBe(false);
    }
  });
});

describe('classifyV1Route', () => {
  it('分类 allowlist 路由为 allowed', () => {
    expect(classifyV1Route('login')).toBe('allowed');
    expect(classifyV1Route('(tabs)/chat')).toBe('allowed');
    expect(classifyV1Route('chat/[sessionId]')).toBe('allowed');
    expect(classifyV1Route('(tabs)/chat/group/[groupKey]')).toBe('allowed');
    expect(classifyV1Route('')).toBe('allowed'); // app/index.tsx
    expect(classifyV1Route('+not-found')).toBe('allowed');
  });

  it('分类延期路由为 deferred', () => {
    expect(classifyV1Route('(tabs)/files')).toBe('deferred');
    expect(classifyV1Route('cron')).toBe('deferred');
    expect(classifyV1Route('settings/users')).toBe('deferred');
    expect(classifyV1Route('settings/all-agents')).toBe('deferred');
    expect(classifyV1Route('chat/html-preview')).toBe('deferred');
    expect(classifyV1Route('settings/connections')).toBe('deferred');
    expect(classifyV1Route('oauth/callback')).toBe('deferred');
  });

  it('未分类路由返回 unclassified（fail closed 依据）', () => {
    expect(classifyV1Route('brand-new-page')).toBe('unclassified');
    expect(classifyV1Route('settings/users/extra')).toBe('unclassified');
  });
});

describe('resolveV1BuildProfile', () => {
  it('__DEV__ 优先解析为 development', () => {
    expect(resolveV1BuildProfile({ dev: true })).toBe('development');
    expect(resolveV1BuildProfile({ dev: true, profileEnv: 'production' })).toBe(
      'development',
    );
  });

  it('显式 env 按值解析（大小写不敏感）', () => {
    expect(resolveV1BuildProfile({ profileEnv: 'production' })).toBe('production');
    expect(resolveV1BuildProfile({ profileEnv: 'preview' })).toBe('preview');
    expect(resolveV1BuildProfile({ profileEnv: 'Preview' })).toBe('preview');
    expect(resolveV1BuildProfile({ profileEnv: 'development' })).toBe('development');
  });

  it('缺失/未知 env fail closed 为 production', () => {
    expect(resolveV1BuildProfile({})).toBe('production');
    expect(resolveV1BuildProfile({ profileEnv: undefined })).toBe('production');
    expect(resolveV1BuildProfile({ profileEnv: '' })).toBe('production');
    expect(resolveV1BuildProfile({ profileEnv: 'staging' })).toBe('production');
    expect(resolveV1BuildProfile({ profileEnv: '  ' })).toBe('production');
  });
});

describe('isV1RouteAllowed / isV1SegmentsAllowed（深链 allowlist）', () => {
  it('生产：allowlist 路由放行', () => {
    expect(isV1RouteAllowed('login', 'production')).toBe(true);
    expect(isV1RouteAllowed('(tabs)/settings', 'production')).toBe(true);
    expect(isV1RouteAllowed('share-target', 'production')).toBe(true);
    expect(isV1RouteAllowed('change-password', 'production')).toBe(true);
  });

  it('生产：全部延期路由与未分类路由 fail closed', () => {
    for (const route of Object.keys(V1_DEFERRED_ROUTES)) {
      expect(isV1RouteAllowed(route, 'production'), route).toBe(false);
    }
    expect(isV1RouteAllowed('unknown-route', 'production')).toBe(false);
    expect(isV1RouteAllowed('settings/users', 'production')).toBe(false);
    expect(isV1RouteAllowed('cron-form', 'production')).toBe(false);
  });

  it('development / preview 不裁剪', () => {
    for (const profile of ['development', 'preview'] as const) {
      expect(isV1RouteAllowed('(tabs)/files', profile)).toBe(true);
      expect(isV1RouteAllowed('settings/users', profile)).toBe(true);
      expect(isV1RouteAllowed('unknown-route', profile)).toBe(true);
    }
  });

  it('段数组按 useSegments 约定拼接判断（含路由组与动态段名）', () => {
    expect(isV1SegmentsAllowed(['(tabs)', 'chat'], 'production')).toBe(true);
    expect(isV1SegmentsAllowed(['(tabs)', 'chat', 'group', '[groupKey]'], 'production')).toBe(true);
    expect(isV1SegmentsAllowed(['chat', '[sessionId]'], 'production')).toBe(true);
    expect(isV1SegmentsAllowed([], 'production')).toBe(true); // app/index.tsx
    expect(isV1SegmentsAllowed(['settings', 'users'], 'production')).toBe(false);
    expect(isV1SegmentsAllowed(['cron'], 'production')).toBe(false);
    expect(isV1SegmentsAllowed(['webview-spike'], 'production')).toBe(false);
    expect(isV1SegmentsAllowed(['settings', 'users'], 'preview')).toBe(true);
  });
});

describe('getV1VisibleTabs（生产菜单快照）', () => {
  it('生产只保留 对话/设置，移除文件 Tab', () => {
    expect(getV1VisibleTabs('production', ALL_TABS)).toEqual(['chat', 'settings']);
  });

  it('development / preview 保留全部 Tab', () => {
    expect(getV1VisibleTabs('development', ALL_TABS)).toEqual(ALL_TABS);
    expect(getV1VisibleTabs('preview', ALL_TABS)).toEqual(ALL_TABS);
  });
});

describe('resolveV1GateDecision（根路由门禁决策，M00-01 返工）', () => {
  const deferredRoutes: string[][] = [
    ['oauth', 'callback'],
    ['chat', 'html-preview'],
    ['settings', 'connections'],
    ['cron'],
    ['settings', 'users'],
    ['webview-spike'], // 墓碑路由
    ['brand-new-page'], // 未分类路由
  ];

  it('production + 延期/未分类路由：不挂载（含鉴权 loading），按登录态重定向', () => {
    for (const segments of deferredRoutes) {
      // 鉴权 loading 中同样阻断（Review 指出的旧缺口）
      expect(resolveV1GateDecision({
        profile: 'production', segments, authLoading: true, hasUser: false,
      })).toEqual({ mountRoute: false, redirectTo: '/login' });
      // 已登录 -> 对话 Tab
      expect(resolveV1GateDecision({
        profile: 'production', segments, authLoading: false, hasUser: true,
      })).toEqual({ mountRoute: false, redirectTo: '/(tabs)/chat' });
      // 未登录 -> 登录页
      expect(resolveV1GateDecision({
        profile: 'production', segments, authLoading: false, hasUser: false,
      })).toEqual({ mountRoute: false, redirectTo: '/login' });
      // loading 中已缓存的旧登录态同样拒绝挂载
      expect(resolveV1GateDecision({
        profile: 'production', segments, authLoading: true, hasUser: true,
      })).toEqual({ mountRoute: false, redirectTo: '/(tabs)/chat' });
    }
  });

  it('production + 允许路由：挂载，loading 时不重定向', () => {
    expect(resolveV1GateDecision({
      profile: 'production', segments: ['(tabs)', 'chat'], authLoading: true, hasUser: false,
    })).toEqual({ mountRoute: true, redirectTo: null });
    expect(resolveV1GateDecision({
      profile: 'production', segments: ['login'], authLoading: true, hasUser: true,
    })).toEqual({ mountRoute: true, redirectTo: null });
  });

  it('production + 允许路由：loading 结束后按原 AuthGate 规则重定向', () => {
    expect(resolveV1GateDecision({
      profile: 'production', segments: ['(tabs)', 'chat'], authLoading: false, hasUser: false,
    })).toEqual({ mountRoute: true, redirectTo: '/login' });
    expect(resolveV1GateDecision({
      profile: 'production', segments: ['login'], authLoading: false, hasUser: true,
    })).toEqual({ mountRoute: true, redirectTo: '/(tabs)/chat' });
    expect(resolveV1GateDecision({
      profile: 'production', segments: ['(tabs)', 'chat'], authLoading: false, hasUser: true,
    })).toEqual({ mountRoute: true, redirectTo: null });
    expect(resolveV1GateDecision({
      profile: 'production', segments: ['login'], authLoading: false, hasUser: false,
    })).toEqual({ mountRoute: true, redirectTo: null });
  });

  it('非生产档位：任何路由都挂载且不做路由拒绝重定向', () => {
    for (const segments of deferredRoutes) {
      expect(resolveV1GateDecision({
        profile: 'preview', segments, authLoading: false, hasUser: true,
      })).toEqual({ mountRoute: true, redirectTo: null });
      expect(resolveV1GateDecision({
        profile: 'development', segments, authLoading: true, hasUser: false,
      })).toEqual({ mountRoute: true, redirectTo: null });
    }
  });
});
