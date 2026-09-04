import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { AuthUser, LoginCredentials, SmsLoginCredentials } from "@/types/auth";
import type { BoundaryIdentity, IdentityEvent, IdentityState, PlatformCapability, TenantFeatureFlags, UserPreferences } from "@agent/shared";
import {
  AUTH_SESSION_KEY,
  AuthLifecycleTransaction,
  DEFAULT_TENANT_ID,
  INITIAL_IDENTITY_STATE,
  clearGroupsCache,
  createStorageJournalStore,
  fenceAuthSideEffects,
  identityReducer,
  isDebugModeAvailable,
  resetChatStore,
} from "@agent/shared";
import { setOnUnauthorized } from "@/lib/authFetch";
import { wsClient } from "@/lib/wsClient";
import { TOKEN_KEY, SESSION_STORAGE_KEY } from "@/lib/constants";
import { authPreload } from "@/lib/preload";
import { apiUrl } from '@/lib/apiBase';
import { clearSessionListCache } from "@/lib/sessionListCache";
import { clearAllMessageCache, setMessageCacheIdentity } from "@/lib/messageCache";
import { clearAllComposerAttachmentDrafts } from "@/lib/composerDraftStorage";
import { clearWebCacheV2Namespace } from "@/platform/webCacheAdapter";
import { tenantFeatureUpdatesFromEnvelope } from "./tenantFeatureEvents";
import { runLogoutToSavedAccountLifecycle, runSavedAccountLifecycle } from "./savedAccountLifecycle";
import {
  loginWithPassword,
  loginWithSmsCode,
  type AuthResponse,
} from "@/lib/authApi";
import {
  clearSavedAccounts,
  forgetSavedAccount,
  forgetSavedAccountByToken, // N-1 invalid-token cleanup
  getAccountKey,
  getSavedAccountAuth,
  readSavedAccounts,
  rememberSavedAccount,
  type SavedAccountSummary,
} from "@/lib/savedAccounts";

interface AuthContextValue {
  identity: BoundaryIdentity | null;
  user: AuthUser | null;
  isLoading: boolean;
  isAuthenticated: boolean;
  isAdmin: boolean;
  /**
   * 平台 admin = role==='admin' && tenantId===DEFAULT_TENANT_ID（pantheon）。
   * 仅平台 admin 可见跨组织管理入口（组织管理 tab）。
   * 后端 `requirePlatformAdmin` 是权威判定；前端只做入口可见性 gate。
   */
  isPlatformAdmin: boolean;
  /** @deprecated 兼容旧组件；现在与 isPlatformAdmin 相同。 */
  isSuperAdmin: boolean;
  /** @deprecated 平台管理员已全部可写，固定为 false。 */
  platformReadOnly: boolean;
  /** 平台能力判断；所有平台管理员均返回 true。 */
  canPlatform: (capability: PlatformCapability) => boolean;
  /** 鉴权功能是否启用（后端未开启时为 false，此时无需登录） */
  authEnabled: boolean;
  accounts: SavedAccountSummary[];
  login: (credentials: LoginCredentials) => Promise<void>;
  loginWithSms: (credentials: SmsLoginCredentials) => Promise<void>;
  activateAccount: (response: AuthResponse) => Promise<void>;
  switchAccount: (accountKey: string) => Promise<void>;
  logoutCurrentAccount: (nextAccountKey?: string) => Promise<void>;
  logoutAllAccounts: () => Promise<void>;
  logout: () => Promise<void>;
  /** 更新当前用户头像 URL + 版本号 */
  updateAvatar: (avatar: string | undefined, avatarVersion?: number) => void;
  /** 更新当前用户手机号验证状态 */
  updatePhone: (phone: string | undefined, phoneVerifiedAt?: string) => void;
  updatePreferences: (preferences: UserPreferences) => void;
  /** 本人调试模式保存后立即刷新服务端返回的有效值。 */
  updateDebugMode: (debugMode: boolean) => void;
  /** 组织策略保存后立即刷新当前用户的功能有效值。 */
  updateTenantFeatures: (features: TenantFeatureFlags, effectiveDebugMode?: boolean) => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);
const IDENTITY_META_KEY = "agentChat.identity.v1";

function readIdentityState(): IdentityState {
  try {
    const parsed = JSON.parse(localStorage.getItem(IDENTITY_META_KEY) || "null") as IdentityState | null;
    const generation = typeof parsed?.generation === "number" ? parsed.generation : 0;
    const identity = parsed?.identity && parsed.identity.generation === generation ? parsed.identity : null;
    return { generation, identity };
  } catch { return INITIAL_IDENTITY_STATE; }
}

function persistIdentityState(state: IdentityState): void {
  localStorage.setItem(IDENTITY_META_KEY, JSON.stringify(state));
}

function clearAccountScopedState(): void {
  // Identity boundary order: sending fence -> socket -> recovery/projections -> persistence.
  wsClient.freezeSending();
  wsClient.disconnect();
  wsClient.resetRecovery({ sessionId: null });
  resetChatStore();
  setMessageCacheIdentity(null);
  localStorage.removeItem(SESSION_STORAGE_KEY);
  clearWebCacheV2Namespace();
  clearSessionListCache();
  void clearAllMessageCache();
  void clearGroupsCache();
  void clearAllComposerAttachmentDrafts();
}

function unsubscribeCurrentBrowserPush(): Promise<void> {
  return import("@/lib/webPush")
    .then((webPush) => webPush.unsubscribeCurrentBrowserPush())
    .catch(() => undefined);
}

function normalizeAuthUser(user: AuthUser): AuthUser {
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    tenantId: user.tenantId,
    tenantName: user.tenantName,
    // 兼容旧客户端字段；平台管理员已不再按账号层级区分权限。
    isSuperAdmin: user.role === "admin" && user.tenantId === DEFAULT_TENANT_ID,
    platformCapabilities: user.platformCapabilities ?? [],
    platformCapabilityLimits: user.platformCapabilityLimits,
    realName: user.realName,
    position: user.position,
    phone: user.phone,
    phoneVerifiedAt: user.phoneVerifiedAt,
    avatar: user.avatar,
    avatarVersion: user.avatarVersion,
    debugMode: user.debugMode === true,
    tenantFeatures: user.tenantFeatures,
    preferences: user.preferences ?? {},
  };
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const identityRef = useRef<IdentityState>(readIdentityState());
  const [identityState, setIdentityState] = useState<IdentityState>(identityRef.current);
  const transitionIdentity = useCallback((event: IdentityEvent): BoundaryIdentity | null => {
    const next = identityReducer(identityRef.current, event);
    identityRef.current = next;
    persistIdentityState(next);
    setIdentityState(next);
    setMessageCacheIdentity(next.identity);
    return next.identity;
  }, []);
  const [isLoading, setIsLoading] = useState(true);
  const [authEnabled, setAuthEnabled] = useState(true);
  const [accounts, setAccounts] = useState<SavedAccountSummary[]>(readSavedAccounts);
  const lifecycle = useMemo(() => new AuthLifecycleTransaction(
    createStorageJournalStore({
      getItem: (key) => localStorage.getItem(key),
      setItem: (key, value) => localStorage.setItem(key, value),
      removeItem: (key) => localStorage.removeItem(key),
    }),
    {
      fenceGeneration: async () => {
        await fenceAuthSideEffects();
        wsClient.freezeSending();
        if (identityRef.current.identity) transitionIdentity({ type: 'logout' });
        setUser(null);
        const token = localStorage.getItem(TOKEN_KEY);
        if (token) void fetch(apiUrl('/api/auth/logout'), {
          method: 'POST', headers: { Authorization: `Bearer ${token}` },
        }).catch(() => undefined);
      },
      disconnectWs: () => wsClient.disconnect(),
      stopQueue: () => resetChatStore(),
      clearCursorEpoch: () => {
        wsClient.resetRecovery({ sessionId: null });
        localStorage.removeItem(SESSION_STORAGE_KEY);
      },
      clearCache: async () => { // includes every v2 namespace and N-1 sensitive cache
        setMessageCacheIdentity(null);
        clearWebCacheV2Namespace();
        await Promise.all([
          Promise.resolve(clearSessionListCache()),
          clearAllMessageCache(),
          clearGroupsCache(),
          clearAllComposerAttachmentDrafts(),
          unsubscribeCurrentBrowserPush(),
        ]);
        for (let index = localStorage.length - 1; index >= 0; index--) {
          const key = localStorage.key(index);
          if (key && (
            key.startsWith('agentChat.queue') || key.startsWith('agentChat.runtime')
            || key.startsWith('agentChat.interaction') || key.startsWith('agentChat.upload')
            || key.startsWith('agentChat.model.') || key.startsWith('agentChat.inputDraft')
          )) localStorage.removeItem(key);
        }
      },
      deleteToken: () => {
        localStorage.removeItem(TOKEN_KEY);
        localStorage.removeItem(AUTH_SESSION_KEY);
      },
    },
  ), [transitionIdentity]);

  const requestServerLogout = useCallback((): Promise<void> => {
    // Capture the valid token before teardown; await the server receipt only
    // after local sensitive state and the token are already cleared.
    const token = localStorage.getItem(TOKEN_KEY);
    if (!token) return Promise.resolve();
    return fetch(apiUrl('/api/auth/logout'), {
      method: 'POST', headers: { Authorization: `Bearer ${token}` },
    }).then(() => undefined).catch(() => undefined);
  }, []);

  const logoutAllAccounts = useCallback(async () => {
    const serverFence = requestServerLogout();
    await lifecycle.logout();
    clearSavedAccounts();
    setAccounts([]);
    await serverFence;
  }, [lifecycle, requestServerLogout]);

  const logoutCurrentAccount = useCallback(async (nextAccountKey?: string) => {
    const currentKey = user ? getAccountKey(user) : null;
    const remainingAccounts = currentKey ? forgetSavedAccount(currentKey) : readSavedAccounts();
    const targetAccount = nextAccountKey
      ? remainingAccounts.find((account) => account.key === nextAccountKey)
      : remainingAccounts[0];
    const nextAuth = targetAccount ? getSavedAccountAuth(targetAccount.key) : null;
    const serverFence = requestServerLogout();
    if (!nextAuth) {
      await lifecycle.logout();
      setAccounts(remainingAccounts);
      await serverFence;
      return;
    }
    const nextUser = normalizeAuthUser(nextAuth.user);
    await runLogoutToSavedAccountLifecycle(lifecycle, nextAuth.binding, serverFence, {
      fenceUntilCommit: () => {
        wsClient.freezeSending();
        clearAccountScopedState();
      },
      persistTokenAndBinding: (binding) => {
        localStorage.setItem(TOKEN_KEY, nextAuth.token);
        localStorage.setItem(AUTH_SESSION_KEY, JSON.stringify(binding));
      },
      installAuthenticatedState: () => {
        setAccounts(remainingAccounts);
        setUser(nextUser);
        transitionIdentity({
          type: 'principal-switched',
          principal: { userId: nextUser.id, tenantId: nextUser.tenantId },
        });
      },
      commitConnections: () => wsClient.unfreezeSending(),
      failClosed: () => {
        wsClient.freezeSending();
        wsClient.disconnect();
        localStorage.removeItem(TOKEN_KEY);
        localStorage.removeItem(AUTH_SESSION_KEY);
        setUser(null);
      },
    });
  }, [lifecycle, requestServerLogout, transitionIdentity, user]);

  const logout = useCallback(async () => {
    await logoutCurrentAccount();
  }, [logoutCurrentAccount]);

  // 当前 token 被服务端拒绝（401 / WS 鉴权失败）：只清掉这一个账号并回到登录页。
  // 不能复用 logoutCurrentAccount——它会静默激活列表里的下一个账号，用户会莫名其妙变成另一个身份。
  const expireCurrentAccount = useCallback(async () => {
    const invalidToken = localStorage.getItem(TOKEN_KEY);
    const currentKey = user ? getAccountKey(user) : null;
    await lifecycle.logout();
    const remainingAccounts = currentKey
      ? forgetSavedAccount(currentKey)
      : invalidToken ? forgetSavedAccountByToken(invalidToken) : readSavedAccounts();
    setAccounts(remainingAccounts);
  }, [lifecycle, user]);

  useEffect(() => {
    setOnUnauthorized(() => {
      void expireCurrentAccount();
    });
    wsClient.setOnAuthFailure(() => {
      void expireCurrentAccount();
    });
  }, [expireCurrentAccount]);

  // Recover any durable logout/delete journal before accepting cached auth.
  useEffect(() => {
    void (async () => {
      await lifecycle.resume();
      await lifecycle.failClosedIncompleteLogin({
        fenceUntilCommit: async () => { await fenceAuthSideEffects(); wsClient.freezeSending(); },
        persistTokenAndBinding: () => undefined,
        installAuthenticatedState: () => undefined,
        commitConnections: () => undefined,
        failClosed: () => {
          wsClient.disconnect();
          localStorage.removeItem(TOKEN_KEY);
          localStorage.removeItem(AUTH_SESSION_KEY);
          setUser(null);
        },
      });
      const result = await authPreload;
      if (result.status === 'authenticated') {
        const nextUser = normalizeAuthUser(result.user);
        const bindingRaw = localStorage.getItem(AUTH_SESSION_KEY);
        if (!bindingRaw) {
          localStorage.removeItem(TOKEN_KEY);
          clearAccountScopedState();
        } else {
          setUser(nextUser);
          transitionIdentity({ type: 'authenticated', principal: { userId: nextUser.id, tenantId: nextUser.tenantId } });
          const token = localStorage.getItem(TOKEN_KEY);
          if (token) {
            const binding = JSON.parse(bindingRaw) as { authEpoch: number; generation: number };
            setAccounts(rememberSavedAccount(token, nextUser, binding));
          }
          setAuthEnabled(true);
          wsClient.unfreezeSending();
        }
      } else if (result.status === 'no-auth') {
        setAuthEnabled(false);
      } else if (result.status === 'unauthenticated') {
        const invalidToken = localStorage.getItem(TOKEN_KEY);
        localStorage.removeItem(TOKEN_KEY);
        localStorage.removeItem(AUTH_SESSION_KEY);
        clearAccountScopedState();
        if (identityRef.current.identity) transitionIdentity({ type: 'token-invalidated' });
        if (invalidToken) setAccounts(forgetSavedAccountByToken(invalidToken));
      }
      setIsLoading(false);
    })();
  }, [lifecycle, transitionIdentity]);

  const activateAccount = useCallback(async (data: AuthResponse) => {
    const nextUser = normalizeAuthUser(data.user);
    const isSwitching = user !== null && getAccountKey(user) !== getAccountKey(nextUser);
    await lifecycle.login({ authEpoch: data.authEpoch, generation: data.generation }, {
      fenceUntilCommit: async () => {
        await fenceAuthSideEffects();
        wsClient.freezeSending();
        if (isSwitching) clearAccountScopedState();
      },
      persistTokenAndBinding: async (binding) => {
        localStorage.setItem(TOKEN_KEY, data.token);
        localStorage.setItem(AUTH_SESSION_KEY, JSON.stringify(binding));
      },
      installAuthenticatedState: () => {
        setAccounts(rememberSavedAccount(data.token, nextUser, { authEpoch: data.authEpoch, generation: data.generation }));
        setUser(nextUser);
        transitionIdentity({
          type: isSwitching ? 'principal-switched' : 'authenticated',
          principal: { userId: nextUser.id, tenantId: nextUser.tenantId },
        });
      },
      commitConnections: () => wsClient.unfreezeSending(),
      failClosed: () => {
        wsClient.freezeSending();
        wsClient.disconnect();
        localStorage.removeItem(TOKEN_KEY);
        localStorage.removeItem(AUTH_SESSION_KEY);
        setUser(null);
      },
    });
    if (isSwitching) window.location.replace('/');
  }, [lifecycle, transitionIdentity, user]);

  const login = useCallback(async (credentials: LoginCredentials) => {
    await activateAccount(await loginWithPassword(credentials)); // commits epoch before WS use
  }, [activateAccount]);

  const loginWithSms = useCallback(async (credentials: SmsLoginCredentials) => {
    await activateAccount(await loginWithSmsCode(credentials));
  }, [activateAccount]);

  const switchAccount = useCallback(async (accountKey: string) => {
    if (user && getAccountKey(user) === accountKey) return;
    const savedAuth = getSavedAccountAuth(accountKey);
    if (!savedAuth) {
      setAccounts(readSavedAccounts());
      return;
    }
    const nextUser = normalizeAuthUser(savedAuth.user);
    await runSavedAccountLifecycle(lifecycle, savedAuth.binding, {
      fenceUntilCommit: async () => {
        wsClient.freezeSending();
        await unsubscribeCurrentBrowserPush();
        clearAccountScopedState();
      },
      persistTokenAndBinding: (binding) => {
        localStorage.setItem(TOKEN_KEY, savedAuth.token);
        localStorage.setItem(AUTH_SESSION_KEY, JSON.stringify(binding));
      },
      installAuthenticatedState: () => {
        setUser(nextUser);
        transitionIdentity({
          type: user ? 'principal-switched' : 'authenticated',
          principal: { userId: nextUser.id, tenantId: nextUser.tenantId },
        });
      },
      commitConnections: () => wsClient.unfreezeSending(),
      failClosed: () => {
        wsClient.freezeSending();
        wsClient.disconnect();
        localStorage.removeItem(TOKEN_KEY);
        localStorage.removeItem(AUTH_SESSION_KEY);
        setUser(null);
      },
    });
    window.location.replace("/");
  }, [lifecycle, transitionIdentity, user]);

  const updateAvatar = useCallback((avatar: string | undefined, avatarVersion?: number) => {
    setUser((prev) => prev ? { ...prev, avatar, avatarVersion } : prev);
  }, []);

  const updatePhone = useCallback((phone: string | undefined, phoneVerifiedAt?: string) => {
    setUser((prev) => prev ? { ...prev, phone, phoneVerifiedAt } : prev);
  }, []);

  const updatePreferences = useCallback((preferences: UserPreferences) => {
    setUser((prev) => prev ? { ...prev, preferences: { ...(prev.preferences ?? {}), ...preferences } } : prev);
  }, []);

  const updateDebugMode = useCallback((debugMode: boolean) => {
    setUser((prev) => prev ? { ...prev, debugMode: debugMode === true } : prev);
  }, []);

  const updateTenantFeatures = useCallback((features: TenantFeatureFlags, effectiveDebugMode?: boolean) => {
    setUser((prev) => prev ? {
      ...prev,
      debugMode: effectiveDebugMode === undefined
        ? prev.debugMode === true && isDebugModeAvailable(prev.tenantId, features)
        : effectiveDebugMode === true,
      tenantFeatures: features,
    } : prev);
  }, []);

  useEffect(() => {
    return wsClient.onMessage((envelope) => {
      for (const update of tenantFeatureUpdatesFromEnvelope(envelope, user?.tenantId)) {
        updateTenantFeatures(update.tenantFeatures, update.debugMode);
      }
    });
  }, [updateTenantFeatures, user?.tenantId]);

  const canPlatform = useCallback((_capability: PlatformCapability) => (
    user?.role === "admin" && user.tenantId === DEFAULT_TENANT_ID
  ), [user]);

  const value = useMemo<AuthContextValue>(
    () => ({
      identity: identityState.identity,
      user,
      isLoading,
      isAuthenticated: user !== null,
      isAdmin: user?.role === "admin",
      isPlatformAdmin: user?.role === "admin" && user?.tenantId === DEFAULT_TENANT_ID,
      isSuperAdmin: user?.role === "admin" && user?.tenantId === DEFAULT_TENANT_ID,
      platformReadOnly: false,
      canPlatform,
      authEnabled,
      accounts,
      login,
      loginWithSms,
      activateAccount,
      switchAccount,
      logoutCurrentAccount,
      logoutAllAccounts,
      logout,
      updateAvatar,
      updatePhone,
      updatePreferences,
      updateDebugMode,
      updateTenantFeatures,
    }),
    [identityState.identity, user, isLoading, authEnabled, accounts, login, loginWithSms, activateAccount, switchAccount, logoutCurrentAccount, logoutAllAccounts, logout, updateAvatar, updatePhone, updatePreferences, updateDebugMode, updateTenantFeatures, canPlatform],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useAuth must be used within AuthProvider");
  }
  return context;
}
