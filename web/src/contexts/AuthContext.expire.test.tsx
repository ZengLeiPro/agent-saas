import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AUTH_LIFECYCLE_JOURNAL_KEY, AUTH_SESSION_KEY } from '@agent/shared';
import { TOKEN_KEY } from '@/lib/constants';

// 当前 token 被服务端拒绝时，只能清掉这一个账号并回到登录页；
// 绝不能静默激活列表里的下一个账号（曾出现：iOS 登录让 Web token 失效 → Web 自动变成平台管理员）。
const onUnauthorized = { current: null as (() => void) | null };
const onWsAuthFailure = { current: null as (() => void) | null };

vi.mock('@/lib/authFetch', () => ({
  setOnUnauthorized: (fn: () => void) => {
    onUnauthorized.current = fn;
  },
}));
vi.mock('@/lib/wsClient', () => ({
  wsClient: {
    freezeSending: vi.fn(),
    unfreezeSending: vi.fn(),
    disconnect: vi.fn(),
    resetRecovery: vi.fn(),
    setOnAuthFailure: (fn: () => void) => {
      onWsAuthFailure.current = fn;
    },
    onMessage: () => () => undefined,
  },
}));
vi.mock('@/lib/preload', () => ({
  authPreload: Promise.resolve({
    status: 'authenticated',
    user: { id: 'me', username: 'zenglei', role: 'admin', tenantId: 'kaiyan' },
  }),
}));
vi.mock('@/lib/messageCache', () => ({
  clearAllMessageCache: vi.fn(async () => undefined),
  setMessageCacheIdentity: vi.fn(),
}));
vi.mock('@/lib/sessionListCache', () => ({ clearSessionListCache: vi.fn() }));
vi.mock('@/lib/composerDraftStorage', () => ({
  clearAllComposerAttachmentDrafts: vi.fn(async () => undefined),
}));
vi.mock('@/platform/webCacheAdapter', () => ({ clearWebCacheV2Namespace: vi.fn() }));
vi.mock('@/lib/webPush', () => ({ unsubscribeCurrentBrowserPush: vi.fn(async () => undefined) }));
vi.mock('@agent/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent/shared')>()),
  clearGroupsCache: vi.fn(async () => undefined),
  resetChatStore: vi.fn(),
}));

import { AuthProvider, useAuth } from './AuthContext';
import { getSavedAccountToken, readSavedAccounts } from '@/lib/savedAccounts';

function Probe() {
  const { user, accounts, isLoading } = useAuth();
  return (
    <div>
      <span data-testid="user">{isLoading ? 'loading' : (user?.username ?? 'anonymous')}</span>
      <span data-testid="accounts">{accounts.map((account) => account.key).join(',')}</span>
    </div>
  );
}

describe('AuthContext 当前 token 失效', () => {
  const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }));

  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    // 身份按 tab 隔离：两处都铺，等价于「这个 tab 已登录，且它是新 tab 的默认账号」
    for (const storage of [localStorage, sessionStorage]) {
      storage.setItem(TOKEN_KEY, 'token-me');
      storage.setItem(AUTH_SESSION_KEY, JSON.stringify({ authEpoch: 1, generation: 2 }));
    }
    localStorage.setItem(
      'agentChat.savedAccounts.v1',
      JSON.stringify([
        {
          key: 'kaiyan:me',
          token: 'token-me',
          binding: { authEpoch: 1, generation: 2 },
          user: { id: 'me', username: 'zenglei', role: 'admin', tenantId: 'kaiyan' },
        },
        {
          key: 'pantheon:admin',
          token: 'token-admin',
          binding: { authEpoch: 1, generation: 1 },
          user: { id: 'admin', username: 'admin', role: 'admin', tenantId: 'pantheon' },
        },
      ]),
    );
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    fetchMock.mockClear();
  });

  it('401 只清掉当前账号并回到登录页，不会静默切到另一个已保存账号', async () => {
    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('user').textContent).toBe('zenglei'));
    expect(screen.getByTestId('accounts').textContent).toBe('kaiyan:me,pantheon:admin');

    await act(async () => {
      onUnauthorized.current?.();
    });

    await waitFor(() => expect(screen.getByTestId('user').textContent).toBe('anonymous'));
    await waitFor(() => expect(screen.getByTestId('accounts').textContent).toBe('pantheon:admin'));
    expect(sessionStorage.getItem(TOKEN_KEY)).toBeNull();
    expect(sessionStorage.getItem(AUTH_SESSION_KEY)).toBeNull();
    expect(localStorage.getItem(TOKEN_KEY)).toBeNull();
    expect(localStorage.getItem(AUTH_SESSION_KEY)).toBeNull();
    expect(readSavedAccounts().map((account) => account.key)).toEqual(['pantheon:admin']);
    // 另一个账号的凭据原样保留，用户可以主动选择它登录，但不会被替他决定
    expect(getSavedAccountToken('pantheon:admin')).toBe('token-admin');
    // 退出事务必须跑到提交（日志清空），否则残留步骤会在下个用例里继续回放
    await waitFor(() => expect(sessionStorage.getItem(AUTH_LIFECYCLE_JOURNAL_KEY)).toBeNull());
  });

  it('WS 鉴权失败走同一条路径', async () => {
    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('user').textContent).toBe('zenglei'));

    await act(async () => {
      onWsAuthFailure.current?.();
    });

    await waitFor(() => expect(screen.getByTestId('user').textContent).toBe('anonymous'));
    await waitFor(() => expect(screen.getByTestId('accounts').textContent).toBe('pantheon:admin'));
    await waitFor(() => expect(sessionStorage.getItem(AUTH_LIFECYCLE_JOURNAL_KEY)).toBeNull());
  });
});
