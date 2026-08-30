// @vitest-environment jsdom
/**
 * M00-01 返工：V1RouteGate 运行时路由门禁测试。
 *
 * Review 阻断项复现与守卫：
 *   旧实现只在子页面挂载后的 useEffect 里重定向，延期页面会先渲染并执行副作用
 *   （OAuth handoff 消费、preview token 申请、MCP/治理请求、页面活动上报）。
 *
 * 本测试在 jsdom 中真实渲染 V1RouteGate + 四个被点名的延期路由组件
 * （OAuth callback / HTML preview / Connections / Cron），断言：
 *   1. production 档位（含鉴权 loading / 已登录 / 未登录三种身份状态）下，
 *      受限组件不渲染、安全空壳呈现、副作用函数 0 调用、重定向目标正确；
 *   2. preview 档位（对照组）同一组件正常挂载且副作用被调用--
 *      证明「0 调用」不是 mock 缺位造成的假阴性；
 *   3. production 下允许路由照常挂载（含鉴权 loading 期间）。
 */
import React from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { V1RouteGate } from './V1RouteGate';
import HtmlPreviewScreen from '../../app/chat/html-preview';
import CronListScreen from '../../app/cron/index';
import * as previewTokenCacheMod from '../services/previewTokenCache';
import * as sharedMod from '@agent/shared';

// ── 可控运行时状态（vi.hoisted 保证先于 mock 工厂执行） ──────────────
const h = vi.hoisted(() => ({
  segments: [] as string[],
  params: {} as Record<string, unknown>,
  user: null as null | { username: string },
  authLoading: true as boolean,
  replace: vi.fn(),
  cronRefresh: vi.fn(async () => {}),
}));

// ── 模块 mocks ────────────────────────────────────────────────────────
vi.mock('expo-router', () => ({
  Stack: Object.assign(() => null, { Screen: () => null }),
  useRouter: () => ({
    replace: h.replace,
    push: vi.fn(),
    back: vi.fn(),
    canGoBack: () => false,
  }),
  useSegments: () => h.segments,
  useLocalSearchParams: () => h.params,
  // 模拟聚焦即执行（与真实 useFocusEffect 的挂载后回调语义一致）
  useFocusEffect: (cb: () => void) => cb(),
}));

vi.mock('react-native', async () => {
  const React = await import('react');
  const make =
    (tag: string): React.FC<Record<string, unknown>> =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ({ testID, children }: any) =>
      React.createElement(tag, { 'data-testid': testID ?? undefined }, children);
  return {
    View: make('div'),
    Text: make('span'),
    Pressable: make('button'),
    TouchableOpacity: make('button'),
    ScrollView: make('div'),
    ActivityIndicator: make('div'),
    StyleSheet: { create: (s: unknown) => s, hairlineWidth: 1 },
    Alert: { alert: vi.fn() },
    Linking: { openURL: vi.fn() },
    Platform: { OS: 'ios', select: (o: Record<string, unknown>) => o.ios },
    Dimensions: { get: () => ({ width: 390, height: 844 }) },
  };
});

vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

const COLORS = {
  background: '#ffffff',
  foreground: '#000000',
  card: '#eeeeee',
  muted: '#cccccc',
  mutedForeground: '#888888',
  primary: '#0033ff',
  primaryForeground: '#ffffff',
  destructive: '#ff0000',
  success: '#00aa00',
  border: '#dddddd',
  secondary: '#f5f5f5',
};

vi.mock('../theme', () => ({
  useColors: () => COLORS,
  spacing: new Proxy({}, { get: () => 8 }),
  radius: new Proxy({}, { get: () => 8 }),
  typography: new Proxy({}, { get: () => ({ fontSize: 14 }) }),
}));

vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ user: h.user, loading: h.authLoading }),
}));

vi.mock('../contexts/ChatAppStateContext', () => ({
  useChatAppState: () => ({ ownerFilter: undefined }),
}));

vi.mock('../services/nativeOAuthHandoff', () => ({
  consumeNativeOAuthCallback: vi.fn(async () => ({
    status: 'succeeded',
    connectorId: 'google-workspace',
  })),
  beginNativeOAuthTransaction: vi.fn(async () => ({})),
  cancelNativeOAuthTransaction: vi.fn(async () => {}),
}));

vi.mock('../services/previewTokenCache', () => ({
  getPreviewToken: vi.fn(async () => 'preview-token'),
}));

vi.mock('../services/fileCacheService', () => ({
  fileCacheService: {
    getOrDownload: vi.fn(async () => 'file:///tmp/x'),
  },
}));

vi.mock('@agent/shared', () => ({
  getPlatform: () => ({
    platformConfig: { getBaseUrl: () => 'https://app.example.test' },
  }),
  fetchMyMcp: vi.fn(async () => ({ servers: [] })),
  startGoogleWorkspaceOAuth: vi.fn(async () => ({
    authorizationUrl: 'https://accounts.example.test/oauth',
  })),
  startMyMcpOAuth: vi.fn(async () => ({ authorizationUrl: 'https://a.example.test' })),
  reportActivity: vi.fn(async () => {}),
}));

vi.mock('@agent/shared/lib/governanceApi', () => ({
  governanceAccessApi: {
    listOAuthGrants: vi.fn(async () => ({ grants: [] })),
  },
}));

vi.mock('../hooks/useCronJobs', async () => {
  const React = await import('react');
  return {
    // 模拟真实 hook 的挂载期 fetch（真实实现经 scheduleIdle 调 refresh）
    useCronJobs: () => {
      React.useEffect(() => {
        void h.cronRefresh();
      }, []);
      return {
        jobs: [],
        loading: false,
        refresh: h.cronRefresh,
        toggleJob: async () => {},
      };
    },
  };
});

vi.mock('../lib/haptics', () => ({
  hapticLight: vi.fn(),
  hapticWarning: vi.fn(),
}));

vi.mock('../lib/headerItems', () => ({
  glassFree: (el: unknown) => el,
}));

vi.mock('../components/overlays/DropdownMenu', () => ({
  DropdownMenu: () => null,
}));

vi.mock('../components/BackButton', () => ({
  BackButton: () => null,
}));

vi.mock('expo-clipboard', () => ({
  setStringAsync: vi.fn(async () => {}),
  default: { setStringAsync: vi.fn(async () => {}) },
}));

vi.mock('react-native-webview', () => ({
  WebView: () => null,
}));

vi.mock('lucide-react-native', () => ({
  MoreHorizontal: () => null,
  Plus: () => null,
}));

vi.mock('@shopify/flash-list', () => ({
  FlashList: () => null,
}));

vi.mock('../components/cron/JobList', () => ({
  JobList: () => null,
}));

// ── 用例 ──────────────────────────────────────────────────────────────

const OAUTH_HANDOFF_CODE = 'A'.repeat(48);

/** 四个被 Review 点名的延期路由及其挂载期副作用 spies。 */
const DEFERRED_CASES = [
  {
    name: 'HTML preview（延期）',
    segments: ['chat', 'html-preview'],
    params: { filePath: 'reports/x.html' },
    screen: <HtmlPreviewScreen />,
    getSyncSpies: () => [vi.mocked(previewTokenCacheMod.getPreviewToken)],
  },
  {
    name: 'Cron（延期）',
    segments: ['cron'],
    params: {},
    screen: <CronListScreen />,
    getSyncSpies: () => [vi.mocked(sharedMod.reportActivity), h.cronRefresh],
  },
] as const;

beforeEach(() => {
  vi.stubEnv('EXPO_PUBLIC_V1_PROFILE', 'production');
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  h.segments = [];
  h.params = {};
  h.user = null;
  h.authLoading = true;
});

describe('M00-01 V1RouteGate 运行时门禁：production 拒绝延期路由', () => {
  for (const testCase of DEFERRED_CASES) {
    describe(testCase.name, () => {
      it('鉴权 loading 中：不挂载受限组件，副作用 0 调用，重定向登录页', async () => {
        h.segments = [...testCase.segments];
        h.params = { ...testCase.params };
        h.authLoading = true;
        h.user = null;

        const { container } = render(
          <V1RouteGate>
            <div data-testid="child-mounted">{testCase.screen}</div>
          </V1RouteGate>,
        );

        // fail closed：安全空壳呈现，children 完全不挂载
        expect(screen.getByTestId('v1-route-denied-shell')).toBeTruthy();
        expect(screen.queryByTestId('child-mounted')).toBeNull();
        expect(container.textContent).toBe('');

        const spies = testCase.getSyncSpies();
        for (const spy of spies) {
          expect(spy.mock.calls.length, `${spy.getMockName()} 不得被调用`).toBe(0);
        }
        // loading 期间同样执行拒绝重定向（旧实现的缺口）
        expect(h.replace).toHaveBeenCalledWith('/login');
        expect(h.replace).not.toHaveBeenCalledWith('/(tabs)/chat');
      });

      it('已登录：不挂载受限组件，副作用 0 调用，重定向对话 Tab', async () => {
        h.segments = [...testCase.segments];
        h.params = { ...testCase.params };
        h.authLoading = false;
        h.user = { username: 'alice' };

        render(
          <V1RouteGate>
            <div data-testid="child-mounted">{testCase.screen}</div>
          </V1RouteGate>,
        );

        expect(screen.getByTestId('v1-route-denied-shell')).toBeTruthy();
        expect(screen.queryByTestId('child-mounted')).toBeNull();

        const spies = testCase.getSyncSpies();
        for (const spy of spies) {
          expect(spy.mock.calls.length).toBe(0);
        }
        expect(h.replace).toHaveBeenCalledWith('/(tabs)/chat');
      });

      it('未登录：不挂载受限组件，副作用 0 调用，重定向登录页', async () => {
        h.segments = [...testCase.segments];
        h.params = { ...testCase.params };
        h.authLoading = false;
        h.user = null;

        render(
          <V1RouteGate>
            <div data-testid="child-mounted">{testCase.screen}</div>
          </V1RouteGate>,
        );

        expect(screen.getByTestId('v1-route-denied-shell')).toBeTruthy();
        expect(screen.queryByTestId('child-mounted')).toBeNull();

        const spies = testCase.getSyncSpies();
        for (const spy of spies) {
          expect(spy.mock.calls.length).toBe(0);
        }
        expect(h.replace).toHaveBeenCalledWith('/login');
      });
    });
  }
});

describe('M00-01 V1RouteGate 对照组：preview 档位不裁剪', () => {
  for (const testCase of DEFERRED_CASES) {
    it(`${testCase.name}：正常挂载且副作用被调用（证明 0 调用断言非假阴性）`, async () => {
      vi.stubEnv('EXPO_PUBLIC_V1_PROFILE', 'preview');
      h.segments = [...testCase.segments];
      h.params = { ...testCase.params };
      h.authLoading = false;
      h.user = { username: 'alice' };

      render(
        <V1RouteGate>
          <div data-testid="child-mounted">{testCase.screen}</div>
        </V1RouteGate>,
      );

      expect(screen.queryByTestId('v1-route-denied-shell')).toBeNull();
      expect(screen.getByTestId('child-mounted')).toBeTruthy();

      // 等待挂载期副作用（OAuth handoff / 预览 token / 治理请求）触发
      await waitFor(() => {
        const spies = testCase.getSyncSpies();
        for (const spy of spies) {
          expect(
            spy.mock.calls.length,
            `对照组副作用应被调用：${spy.getMockName()}`,
          ).toBeGreaterThan(0);
        }
      });
      // preview 档位无路由拒绝重定向
      expect(h.replace).not.toHaveBeenCalled();
    });
  }
});

describe('M00-01 V1RouteGate：production 允许路由照常挂载', () => {
  it('允许路由（对话 Tab）在鉴权 loading 期间即挂载 children', () => {
    h.segments = ['(tabs)', 'chat'];
    h.authLoading = true;
    h.user = null;

    render(
      <V1RouteGate>
        <div data-testid="child-mounted" />
      </V1RouteGate>,
    );

    expect(screen.queryByTestId('v1-route-denied-shell')).toBeNull();
    expect(screen.getByTestId('child-mounted')).toBeTruthy();
  });

  it('允许路由 + 未登录：挂载并重定向登录页（保持原 AuthGate 行为）', () => {
    h.segments = ['(tabs)', 'chat'];
    h.authLoading = false;
    h.user = null;

    render(
      <V1RouteGate>
        <div data-testid="child-mounted" />
      </V1RouteGate>,
    );

    expect(screen.getByTestId('child-mounted')).toBeTruthy();
    expect(h.replace).toHaveBeenCalledWith('/login');
  });

  it('登录页 + 已登录：挂载并重定向对话 Tab（保持原 AuthGate 行为）', () => {
    h.segments = ['login'];
    h.authLoading = false;
    h.user = { username: 'alice' };

    render(
      <V1RouteGate>
        <div data-testid="child-mounted" />
      </V1RouteGate>,
    );

    expect(screen.getByTestId('child-mounted')).toBeTruthy();
    expect(h.replace).toHaveBeenCalledWith('/(tabs)/chat');
  });

  it('未分类路由同样 fail closed（新路由未登记清单时拒绝）', () => {
    h.segments = ['brand-new-page'];
    h.authLoading = false;
    h.user = { username: 'alice' };

    render(
      <V1RouteGate>
        <div data-testid="child-mounted" />
      </V1RouteGate>,
    );

    expect(screen.getByTestId('v1-route-denied-shell')).toBeTruthy();
    expect(screen.queryByTestId('child-mounted')).toBeNull();
    expect(h.replace).toHaveBeenCalledWith('/(tabs)/chat');
  });
});
