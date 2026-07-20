import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import type { AuthUser, LoginCredentials, SmsLoginCredentials } from "@/types/auth";
import type { PlatformCapability, UserPreferences } from "@agent/shared";
import { DEFAULT_TENANT_ID, clearGroupsCache } from "@agent/shared";
import { setOnUnauthorized } from "@/lib/authFetch";
import { wsClient } from "@/lib/wsClient";
import { TOKEN_KEY, SESSION_STORAGE_KEY, INPUT_DRAFT_KEY } from "@/lib/constants";
import { authPreload } from "@/lib/preload";
import { clearSessionListCache } from "@/lib/sessionListCache";
import { clearAllMessageCache } from "@/lib/messageCache";
import { clearUnreadAiReplyCache } from "@/lib/unreadAiReplies";
import {
  loginWithPassword,
  loginWithSmsCode,
  type AuthResponse,
} from "@/lib/authApi";
import {
  clearSavedAccounts,
  forgetSavedAccount,
  forgetSavedAccountByToken,
  getAccountKey,
  getSavedAccountToken,
  readSavedAccounts,
  rememberSavedAccount,
  type SavedAccountSummary,
} from "@/lib/savedAccounts";

interface AuthContextValue {
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
  /** 平台超级管理员（默认仅 @admin，来自 /api/auth/me）；权威判定在服务端。 */
  isSuperAdmin: boolean;
  /**
   * 平台全局配置只读：非超级平台管理员即使拥有客户运营能力，也不能修改
   * Secret、模型、价格、工具开关与其他平台级配置。
   */
  platformReadOnly: boolean;
  /** 平台运营能力判断；超级管理员始终返回 true。 */
  canPlatform: (capability: PlatformCapability) => boolean;
  /** 鉴权功能是否启用（后端未开启时为 false，此时无需登录） */
  authEnabled: boolean;
  accounts: SavedAccountSummary[];
  login: (credentials: LoginCredentials) => Promise<void>;
  loginWithSms: (credentials: SmsLoginCredentials) => Promise<void>;
  activateAccount: (response: AuthResponse) => void;
  switchAccount: (accountKey: string) => void;
  logoutCurrentAccount: (nextAccountKey?: string) => void;
  logoutAllAccounts: () => void;
  logout: () => void;
  /** 更新当前用户头像 URL + 版本号 */
  updateAvatar: (avatar: string | undefined, avatarVersion?: number) => void;
  /** 更新当前用户手机号验证状态 */
  updatePhone: (phone: string | undefined, phoneVerifiedAt?: string) => void;
  updatePreferences: (preferences: UserPreferences) => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

function clearAccountScopedState(): void {
  localStorage.removeItem(SESSION_STORAGE_KEY);
  localStorage.removeItem(INPUT_DRAFT_KEY);
  clearSessionListCache();
  clearUnreadAiReplyCache();
  void clearAllMessageCache();
  void clearGroupsCache();
}

function normalizeAuthUser(user: AuthUser): AuthUser {
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    tenantId: user.tenantId,
    // 2026-07-18 平台管理员分层治理：后端 /auth/me 与登录响应下发 isSuperAdmin，
    // 前端 platformReadOnly 判定必须依赖此字段——漏掉会导致 @admin 也被误判为只读。
    isSuperAdmin: user.isSuperAdmin === true,
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
  const [isLoading, setIsLoading] = useState(true);
  const [authEnabled, setAuthEnabled] = useState(true);
  const [accounts, setAccounts] = useState<SavedAccountSummary[]>(readSavedAccounts);

  const logoutAllAccounts = useCallback(() => {
    localStorage.removeItem(TOKEN_KEY);
    clearSavedAccounts();
    clearAccountScopedState();
    setAccounts([]);
    setUser(null);
  }, []);

  const logoutCurrentAccount = useCallback((nextAccountKey?: string) => {
    const currentKey = user ? getAccountKey(user) : null;
    const remainingAccounts = currentKey
      ? forgetSavedAccount(currentKey)
      : readSavedAccounts();
    const targetAccount = nextAccountKey
      ? remainingAccounts.find((account) => account.key === nextAccountKey)
      : remainingAccounts[0];

    setAccounts(remainingAccounts);
    clearAccountScopedState();

    if (targetAccount) {
      const token = getSavedAccountToken(targetAccount.key);
      if (token) {
        localStorage.setItem(TOKEN_KEY, token);
        window.location.replace("/");
        return;
      }
    }

    localStorage.removeItem(TOKEN_KEY);
    setUser(null);
  }, [user]);

  const logout = useCallback(() => {
    logoutCurrentAccount();
  }, [logoutCurrentAccount]);

  // 注册 401 回调
  useEffect(() => {
    setOnUnauthorized(() => {
      logout();
    });
    wsClient.setOnAuthFailure(() => {
      logout();
    });
  }, [logout]);

  // 启动时校验 token — 消费模块级预加载结果
  useEffect(() => {
    authPreload.then((result) => {
      if (result.status === "authenticated") {
        const nextUser = normalizeAuthUser(result.user);
        setUser(nextUser);
        const token = localStorage.getItem(TOKEN_KEY);
        if (token) setAccounts(rememberSavedAccount(token, nextUser));
        setAuthEnabled(true);
      } else if (result.status === "no-auth") {
        setAuthEnabled(false);
      } else if (result.status === "unauthenticated") {
        const invalidToken = localStorage.getItem(TOKEN_KEY);
        localStorage.removeItem(TOKEN_KEY);
        if (invalidToken) setAccounts(forgetSavedAccountByToken(invalidToken));
      }
      // "error" 状态：保持默认即可
      setIsLoading(false);
    });
  }, []);

  const activateAccount = useCallback((data: AuthResponse) => {
    const nextUser = normalizeAuthUser(data.user);
    const isSwitching = user !== null && getAccountKey(user) !== getAccountKey(nextUser);
    localStorage.setItem(TOKEN_KEY, data.token);
    setAccounts(rememberSavedAccount(data.token, nextUser));
    setUser(nextUser);
    if (isSwitching) {
      clearAccountScopedState();
      window.location.replace("/");
    }
  }, [user]);

  const login = useCallback(async (credentials: LoginCredentials) => {
    activateAccount(await loginWithPassword(credentials));
  }, [activateAccount]);

  const loginWithSms = useCallback(async (credentials: SmsLoginCredentials) => {
    activateAccount(await loginWithSmsCode(credentials));
  }, [activateAccount]);

  const switchAccount = useCallback((accountKey: string) => {
    if (user && getAccountKey(user) === accountKey) return;
    const token = getSavedAccountToken(accountKey);
    if (!token) {
      setAccounts(readSavedAccounts());
      return;
    }
    localStorage.setItem(TOKEN_KEY, token);
    clearAccountScopedState();
    window.location.replace("/");
  }, [user]);

  const updateAvatar = useCallback((avatar: string | undefined, avatarVersion?: number) => {
    setUser((prev) => prev ? { ...prev, avatar, avatarVersion } : prev);
  }, []);

  const updatePhone = useCallback((phone: string | undefined, phoneVerifiedAt?: string) => {
    setUser((prev) => prev ? { ...prev, phone, phoneVerifiedAt } : prev);
  }, []);

  const updatePreferences = useCallback((preferences: UserPreferences) => {
    setUser((prev) => prev ? { ...prev, preferences: { ...(prev.preferences ?? {}), ...preferences } } : prev);
  }, []);

  const canPlatform = useCallback((capability: PlatformCapability) => {
    if (user?.role !== "admin" || user.tenantId !== DEFAULT_TENANT_ID) return false;
    if (user.isSuperAdmin === true) return true;
    return (user.platformCapabilities ?? []).includes(capability);
  }, [user]);

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      isLoading,
      isAuthenticated: user !== null,
      isAdmin: user?.role === "admin",
      isPlatformAdmin: user?.role === "admin" && user?.tenantId === DEFAULT_TENANT_ID,
      isSuperAdmin: user?.isSuperAdmin === true,
      platformReadOnly:
        user?.role === "admin" &&
        user?.tenantId === DEFAULT_TENANT_ID &&
        user?.isSuperAdmin !== true,
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
    }),
    [user, isLoading, authEnabled, accounts, login, loginWithSms, activateAccount, switchAccount, logoutCurrentAccount, logoutAllAccounts, logout, updateAvatar, updatePhone, updatePreferences, canPlatform],
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
