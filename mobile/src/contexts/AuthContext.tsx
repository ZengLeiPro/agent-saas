import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { authFetch, setOnUnauthorized, wsClient, TOKEN_KEY, INPUT_DRAFT_KEY } from '@agent/shared';
import type { AuthUser } from '@agent/shared';
import { mobileSecureStorage, migrateLegacyKeychainItem } from '../platform/mobileSecureStorage';
import {
  getServiceConfigSnapshot,
  loadServerUrl,
  setServerUrl,
} from '../platform/mobileConfig';
import {
  serviceConfigurationErrorMessage,
  type MobileServicePolicy,
} from '../platform/trustedServiceOrigin';
import { clearSessionListCache } from '../lib/sessionListCache';
import { clearAllMessageCache } from '../platform/mobileMessageCache';
import { fileCacheService } from '../services/fileCacheService';
import { textContentCache } from '../services/textContentCache';
import { clearFileListCache } from '../hooks/useFileList';
import { clearPreviewTokenCache } from '../services/previewTokenCache';
import { clearGroupsCache, getPlatform } from '@agent/shared';

const CACHED_USER_KEY = 'agentChat.cachedUser';
const AUTH_REQUEST_TIMEOUT_MS = 15_000;

interface ServiceOriginChangeResult {
  ok: boolean;
  changed?: boolean;
  requiresReauthentication?: boolean;
  error?: string;
}

interface AuthContextValue {
  user: AuthUser | null;
  loading: boolean;
  serviceConfig: MobileServicePolicy;
  login: (username: string, password: string) => Promise<{ ok: boolean; error?: string }>;
  loginWithSms: (phone: string, code: string) => Promise<{ ok: boolean; error?: string }>;
  logout: () => Promise<void>;
  changeServiceOrigin: (origin: string) => Promise<ServiceOriginChangeResult>;
  reloadServiceConfig: () => Promise<MobileServicePolicy>;
  updateAvatar: (avatar: string | undefined, avatarVersion?: number) => void;
  /** Re-fetch user info from server (e.g. when returning to foreground to pick up setting changes) */
  refreshUser: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

async function timedAuthFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AUTH_REQUEST_TIMEOUT_MS);
  try {
    return await authFetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [serviceConfig, setServiceConfig] = useState<MobileServicePolicy>(
    getServiceConfigSnapshot,
  );

  const clearAccountData = useCallback(async (disconnectRealtime: boolean) => {
    // Origin changes use this stronger path. Disconnect first so a credential
    // can never race onto the old socket after local authentication is cleared.
    if (disconnectRealtime) {
      wsClient.disconnect();
      wsClient.setLastSeq(0);
      wsClient.setEpoch(null);
    }
    await mobileSecureStorage.removeItem(TOKEN_KEY);
    // Clear in-memory auth immediately after the credential is gone; later
    // cache cleanup failures must not leave the UI authenticated.
    setUser(null);
    await AsyncStorage.removeItem(CACHED_USER_KEY);
    await clearSessionListCache();
    await clearGroupsCache();
    await clearAllMessageCache();
    await fileCacheService.clearAll();
    await textContentCache.clearAll();
    await clearFileListCache();
    clearPreviewTokenCache();
    void getPlatform().storage.removeItem('avatarMap');
    void getPlatform().storage.removeItem(INPUT_DRAFT_KEY);
  }, []);

  const logout = useCallback(async () => {
    await clearAccountData(false);
  }, [clearAccountData]);

  // Check existing token on mount. Service configuration is resolved first;
  // invalid production builds never touch an auth endpoint or cached login.
  useEffect(() => {
    let cancelled = false;
    setOnUnauthorized(() => {
      void logout();
    });
    wsClient.setOnAuthFailure(() => {
      void logout();
    });

    (async () => {
      let trustedServiceReady = false;
      try {
        // Migrate before checking the origin binding so a legacy keychain token
        // is also removed when this build selects a different trusted origin.
        await migrateLegacyKeychainItem(TOKEN_KEY);
        const config = await loadServerUrl(() => clearAccountData(true));
        if (!cancelled) setServiceConfig(config);
        if (!config.ready) {
          if (!cancelled) setUser(null);
          return;
        }
        trustedServiceReady = true;

        const token = await mobileSecureStorage.getItem(TOKEN_KEY);
        if (!token) return;

        const res = await timedAuthFetch('/api/auth/me');
        if (res.ok) {
          const data = await res.json() as AuthUser;
          if (!cancelled) setUser(data);
          await AsyncStorage.setItem(CACHED_USER_KEY, JSON.stringify(data));
        } else {
          await mobileSecureStorage.removeItem(TOKEN_KEY);
          await AsyncStorage.removeItem(CACHED_USER_KEY);
        }
      } catch {
        if (!trustedServiceReady) {
          if (!cancelled) {
            const snapshot = getServiceConfigSnapshot();
            setServiceConfig({
              ...snapshot,
              ready: false,
              apiOrigin: null,
              wsUrl: null,
              issue: {
                code: 'CONFIG_NOT_READY',
                message: '无法读取可信服务配置，请重试；若持续失败请联系发布负责人。',
              },
            });
            setUser(null);
          }
          return;
        }

        // Network/TLS/timeout error — use cached user only after the service
        // origin has passed the build-time trust policy.
        const cached = await AsyncStorage.getItem(CACHED_USER_KEY);
        if (cached && !cancelled) {
          try {
            setUser(JSON.parse(cached) as AuthUser);
          } catch { /* corrupted cache, ignore */ }
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [clearAccountData, logout]);

  const updateAvatar = useCallback((avatar: string | undefined, avatarVersion?: number) => {
    setUser((prev) => prev ? { ...prev, avatar, avatarVersion } : prev);
    AsyncStorage.getItem(CACHED_USER_KEY).then(cached => {
      if (cached) {
        try {
          const u = JSON.parse(cached);
          u.avatar = avatar;
          u.avatarVersion = avatarVersion;
          void AsyncStorage.setItem(CACHED_USER_KEY, JSON.stringify(u));
        } catch { /* ignore */ }
      }
    });
  }, []);

  const refreshUser = useCallback(async () => {
    if (!getServiceConfigSnapshot().ready) return;
    try {
      const token = await mobileSecureStorage.getItem(TOKEN_KEY);
      if (!token) return;
      const res = await timedAuthFetch('/api/auth/me');
      if (res.ok) {
        const data = await res.json() as AuthUser;
        setUser(data);
        await AsyncStorage.setItem(CACHED_USER_KEY, JSON.stringify(data));
      }
    } catch {
      // Network/TLS/timeout error — keep current user state and allow retry.
    }
  }, []);

  const applyLoginResponse = useCallback(async (data: { token: string; user: AuthUser }) => {
    // The response can only arrive through authFetch after the trusted-origin
    // guard; persist its token only after that boundary has succeeded.
    await mobileSecureStorage.setItem(TOKEN_KEY, data.token);
    await AsyncStorage.setItem(CACHED_USER_KEY, JSON.stringify(data.user));
    setUser(data.user);
  }, []);

  const postLogin = useCallback(async (url: string, body: unknown) => {
    const currentConfig = getServiceConfigSnapshot();
    if (!currentConfig.ready) {
      return {
        ok: false,
        error: currentConfig.issue?.message ?? '可信服务配置尚未就绪。',
      };
    }

    try {
      const res = await timedAuthFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const responseBody = await res.json().catch(() => ({})) as { error?: string };
        return { ok: false, error: responseBody.error || '登录失败' };
      }

      const data = await res.json() as { token: string; user: AuthUser };
      await applyLoginResponse(data);
      return { ok: true };
    } catch {
      return { ok: false, error: '无法连接可信服务，请检查网络或 TLS 配置后重试' };
    }
  }, [applyLoginResponse]);

  const login = useCallback(async (username: string, password: string) => {
    return postLogin('/api/auth/login', { username, password });
  }, [postLogin]);

  const loginWithSms = useCallback(async (phone: string, code: string) => {
    return postLogin('/api/auth/sms/login', { phone, code });
  }, [postLogin]);

  const changeServiceOrigin = useCallback(async (
    origin: string,
  ): Promise<ServiceOriginChangeResult> => {
    try {
      const result = await setServerUrl(origin, () => clearAccountData(true));
      setServiceConfig(result.policy);
      return {
        ok: true,
        changed: result.changed,
        requiresReauthentication: result.requiresReauthentication,
      };
    } catch (error) {
      return { ok: false, error: serviceConfigurationErrorMessage(error) };
    }
  }, [clearAccountData]);

  const reloadServiceConfig = useCallback(async (): Promise<MobileServicePolicy> => {
    try {
      const config = await loadServerUrl(() => clearAccountData(true));
      setServiceConfig(config);
      return config;
    } catch {
      const snapshot = getServiceConfigSnapshot();
      const failed: MobileServicePolicy = {
        ...snapshot,
        ready: false,
        apiOrigin: null,
        wsUrl: null,
        issue: {
          code: 'CONFIG_NOT_READY',
          message: '无法读取可信服务配置，请稍后重试。',
        },
      };
      setServiceConfig(failed);
      return failed;
    }
  }, [clearAccountData]);

  return (
    <AuthContext.Provider value={{
      user,
      loading,
      serviceConfig,
      login,
      loginWithSms,
      logout,
      changeServiceOrigin,
      reloadServiceConfig,
      updateAvatar,
      refreshUser,
    }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
