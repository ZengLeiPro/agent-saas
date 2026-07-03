import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import type { AuthUser, LoginCredentials } from "@/types/auth";
import type { UserPreferences } from "@agent/shared";
import { DEFAULT_TENANT_ID } from "@agent/shared";
import { setOnUnauthorized } from "@/lib/authFetch";
import { wsClient } from "@/lib/wsClient";
import { TOKEN_KEY, SESSION_STORAGE_KEY, INPUT_DRAFT_KEY } from "@/lib/constants";
import { authPreload } from "@/lib/preload";
import { clearSessionListCache } from "@/lib/sessionListCache";
import { clearAllMessageCache } from "@/lib/messageCache";
import { clearUnreadAiReplyCache } from "@/lib/unreadAiReplies";

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
  /** 鉴权功能是否启用（后端未开启时为 false，此时无需登录） */
  authEnabled: boolean;
  login: (credentials: LoginCredentials) => Promise<void>;
  logout: () => void;
  /** 更新当前用户头像 URL + 版本号 */
  updateAvatar: (avatar: string | undefined, avatarVersion?: number) => void;
  /** 更新当前用户手机号（PATCH /me/phone 成功后回写本地 user 状态） */
  updatePhone: (phone: string | undefined) => void;
  updatePreferences: (preferences: UserPreferences) => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [authEnabled, setAuthEnabled] = useState(true);

  const logout = useCallback(() => {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(SESSION_STORAGE_KEY);
    localStorage.removeItem(INPUT_DRAFT_KEY);
    clearSessionListCache();
    clearUnreadAiReplyCache();
    void clearAllMessageCache();
    setUser(null);
  }, []);

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
        setUser({ id: result.user.id, username: result.user.username, role: result.user.role, tenantId: result.user.tenantId, realName: result.user.realName, position: result.user.position, phone: result.user.phone, avatar: result.user.avatar, avatarVersion: result.user.avatarVersion, debugMode: result.user.debugMode === true, preferences: result.user.preferences ?? {} });
        setAuthEnabled(true);
      } else if (result.status === "no-auth") {
        setAuthEnabled(false);
      } else if (result.status === "unauthenticated") {
        localStorage.removeItem(TOKEN_KEY);
      }
      // "error" 状态：保持默认即可
      setIsLoading(false);
    });
  }, []);

  const login = useCallback(async (credentials: LoginCredentials) => {
    const res = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(credentials),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error((data as { error?: string }).error || "登录失败");
    }
    const data = await res.json();
    localStorage.setItem(TOKEN_KEY, data.token);
    setUser({ id: data.user.id, username: data.user.username, role: data.user.role, tenantId: data.user.tenantId, realName: data.user.realName, position: data.user.position, phone: data.user.phone, avatar: data.user.avatar, avatarVersion: data.user.avatarVersion, debugMode: data.user.debugMode === true, preferences: data.user.preferences ?? {} });
  }, []);

  const updateAvatar = useCallback((avatar: string | undefined, avatarVersion?: number) => {
    setUser((prev) => prev ? { ...prev, avatar, avatarVersion } : prev);
  }, []);

  const updatePhone = useCallback((phone: string | undefined) => {
    setUser((prev) => prev ? { ...prev, phone } : prev);
  }, []);

  const updatePreferences = useCallback((preferences: UserPreferences) => {
    setUser((prev) => prev ? { ...prev, preferences: { ...(prev.preferences ?? {}), ...preferences } } : prev);
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      isLoading,
      isAuthenticated: user !== null,
      isAdmin: user?.role === "admin",
      isPlatformAdmin: user?.role === "admin" && user?.tenantId === DEFAULT_TENANT_ID,
      authEnabled,
      login,
      logout,
      updateAvatar,
      updatePhone,
      updatePreferences,
    }),
    [user, isLoading, authEnabled, login, logout, updateAvatar, updatePhone, updatePreferences],
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
