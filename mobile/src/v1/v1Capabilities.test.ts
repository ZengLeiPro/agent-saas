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

// P3-3c 后 `app/(tabs)/_layout.tsx` 只剩两个 Tab（文件中心改 Stack 路由）；
// 这里保留一个假想的第三 Tab，用来证明生产裁剪确实在过滤而不是恰好相等。
const ALL_TABS = ['chat', 'settings', 'unlisted-tab'];

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
    expect(deleted).toContain('chat/html-preview');
    // 09-04 拍板：管理类页面物理删除后的墓碑
    expect(deleted).toContain('settings/users');
    expect(deleted).toContain('user-form');
    expect(deleted).toContain('settings/audit-log');
    expect(deleted).toContain('settings/all-agents');
    expect(deleted).toContain('settings/agent-profile/[username]');
    expect(deleted).toContain('settings/skills-admin');
    expect(deleted).toContain('settings/skills-tenant-admin');
    // P3-3a：技能与连接管理并入能力中心后，旧路由物理删除
    expect(deleted).toContain('settings/skills');
    expect(deleted).toContain('settings/connections');
    // P3-3c：文件中心迁出 Tab 后，旧 Tab 路由记墓碑
    expect(deleted).toContain('(tabs)/files');
    expect(deleted).toContain('(tabs)/files/browse');
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

  it('P3-3d 后延期清单已清空：曾经的延期路由全部 allowed', () => {
    // 延期清单本身保留（未来新页面仍可先登记理由），但当前必须为空
    expect(Object.keys(V1_DEFERRED_ROUTES)).toEqual([]);
    for (const route of ['memory-browser', 'persona-editor', 'settings/my-permissions']) {
      expect(classifyV1Route(route), route).toBe('allowed');
    }
    expect(classifyV1Route('chat/html-preview')).toBe('unclassified');
    expect(classifyV1Route('oauth/callback')).toBe('allowed');
    // P3-3a：旧技能/连接页已删除，重新出现即为未分类（生产 fail closed）
    expect(classifyV1Route('settings/skills')).toBe('unclassified');
    expect(classifyV1Route('settings/connections')).toBe('unclassified');
    // 09-04 已物理删除的管理类路由：落回 unclassified（生产 fail closed）
    expect(classifyV1Route('settings/users')).toBe('unclassified');
    expect(classifyV1Route('settings/all-agents')).toBe('unclassified');
  });

  it('P3-3b：任务中心（含文本编辑器）已从延期转为 allowed', () => {
    for (const route of ['cron', 'cron/[jobId]', 'cron-form', 'text-editor']) {
      expect(classifyV1Route(route), route).toBe('allowed');
      expect(V1_DEFERRED_ROUTES[route], `${route} 不应再留在延期清单`).toBeUndefined();
    }
  });

  it('P3-3d：设置 8 分区的 Stack 路由全部 allowed', () => {
    for (const route of [
      'settings/account-security',
      'settings/my-agent',
      'settings/chat-model',
      'settings/appearance-layout',
      'settings/files-storage',
      'settings/my-permissions',
      // 「连接与授权」落能力中心连接器 Tab；「回收站」是页内浮层，无独立路由
      'capabilities/connectors',
    ]) {
      expect(classifyV1Route(route), route).toBe('allowed');
      expect(isV1RouteAllowed(route, 'production'), route).toBe(true);
    }
    // 分区 ID 不等于路由：不存在 `settings/connections` / `settings/trash`
    expect(classifyV1Route('settings/connections')).toBe('unclassified');
    expect(classifyV1Route('settings/trash')).toBe('unclassified');
  });

  it('P3-3c：文件中心三条 Stack 路由 allowed，旧 Tab 路由落墓碑', () => {
    for (const route of ['files', 'files/browse', 'files/preview']) {
      expect(classifyV1Route(route), route).toBe('allowed');
      expect(V1_DEFERRED_ROUTES[route], `${route} 不应留在延期清单`).toBeUndefined();
    }
    // 旧 Tab 路由重新出现即为未分类 -> 生产 fail closed
    expect(classifyV1Route('(tabs)/files')).toBe('unclassified');
    expect(classifyV1Route('(tabs)/files/browse')).toBe('unclassified');
    expect(isV1RouteAllowed('(tabs)/files', 'production')).toBe(false);
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
    // P3-3a 能力中心四 Tab 与入口
    expect(isV1RouteAllowed('capabilities', 'production')).toBe(true);
    expect(isV1RouteAllowed('capabilities/workflows', 'production')).toBe(true);
    expect(isV1RouteAllowed('capabilities/skills', 'production')).toBe(true);
    expect(isV1RouteAllowed('capabilities/connectors', 'production')).toBe(true);
    expect(isV1RouteAllowed('capabilities/experts', 'production')).toBe(true);
    // P3-3b 任务中心三条路由 + 文本编辑器
    expect(isV1RouteAllowed('cron', 'production')).toBe(true);
    expect(isV1RouteAllowed('cron/[jobId]', 'production')).toBe(true);
    expect(isV1RouteAllowed('cron-form', 'production')).toBe(true);
    expect(isV1RouteAllowed('text-editor', 'production')).toBe(true);
    // P3-3c 文件中心三条路由
    expect(isV1RouteAllowed('files', 'production')).toBe(true);
    expect(isV1RouteAllowed('files/browse', 'production')).toBe(true);
    expect(isV1RouteAllowed('files/preview', 'production')).toBe(true);
  });

  it('生产：全部延期路由与未分类路由 fail closed', () => {
    for (const route of Object.keys(V1_DEFERRED_ROUTES)) {
      expect(isV1RouteAllowed(route, 'production'), route).toBe(false);
    }
    expect(isV1RouteAllowed('unknown-route', 'production')).toBe(false);
    expect(isV1RouteAllowed('settings/users', 'production')).toBe(false);
    expect(isV1RouteAllowed('settings/connections', 'production')).toBe(false);
    expect(isV1RouteAllowed('settings/skills', 'production')).toBe(false);
    expect(isV1RouteAllowed('settings/unregistered-page', 'production')).toBe(false);
    for (const route of Object.keys(V1_DELETED_ROUTES)) {
      expect(isV1RouteAllowed(route, 'production'), route).toBe(false);
    }
  });

  it('development / preview 不裁剪', () => {
    for (const profile of ['development', 'preview'] as const) {
      expect(isV1RouteAllowed('(tabs)/files', profile)).toBe(true);
      expect(isV1RouteAllowed('brand-new-page', profile)).toBe(true);
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
    expect(isV1SegmentsAllowed(['settings', 'connections'], 'production')).toBe(false);
    expect(isV1SegmentsAllowed(['capabilities', 'workflows'], 'production')).toBe(true);
    expect(isV1SegmentsAllowed(['capabilities'], 'production')).toBe(true);
    expect(isV1SegmentsAllowed(['cron'], 'production')).toBe(true);
    expect(isV1SegmentsAllowed(['cron', '[jobId]'], 'production')).toBe(true);
    expect(isV1SegmentsAllowed(['files'], 'production')).toBe(true);
    expect(isV1SegmentsAllowed(['files', 'preview'], 'production')).toBe(true);
    // 旧 Tab 深链 fail closed
    expect(isV1SegmentsAllowed(['(tabs)', 'files'], 'production')).toBe(false);
    // P3-3d：memory-browser / 设置 8 分区已放行
    expect(isV1SegmentsAllowed(['memory-browser'], 'production')).toBe(true);
    expect(isV1SegmentsAllowed(['persona-editor'], 'production')).toBe(true);
    expect(isV1SegmentsAllowed(['settings', 'my-permissions'], 'production')).toBe(true);
    expect(isV1SegmentsAllowed(['settings', 'account-security'], 'production')).toBe(true);
    expect(isV1SegmentsAllowed(['webview-spike'], 'production')).toBe(false);
    expect(isV1SegmentsAllowed(['settings', 'users'], 'preview')).toBe(true);
  });
});

describe('getV1VisibleTabs（生产菜单快照）', () => {
  it('生产只保留 对话/设置（文件中心不再是 Tab）', () => {
    expect(getV1VisibleTabs('production', ALL_TABS)).toEqual(['chat', 'settings']);
    expect([...V1_PRODUCTION_TABS]).not.toContain('files');
  });

  it('development / preview 保留全部 Tab', () => {
    expect(getV1VisibleTabs('development', ALL_TABS)).toEqual(ALL_TABS);
    expect(getV1VisibleTabs('preview', ALL_TABS)).toEqual(ALL_TABS);
  });
});

describe('resolveV1GateDecision（根路由门禁决策，M00-01 返工）', () => {
  // P3-3d 后延期清单为空，这里的样本全部来自墓碑 / 未分类路由
  const deferredRoutes: string[][] = [
    ['chat', 'html-preview'],
    ['settings', 'users'],
    ['settings', 'connections'],
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
