import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { authFetch, setOnUnauthorized, wsClient, TOKEN_KEY, INPUT_DRAFT_KEY } from '@agent/shared';
import type { AuthUser } from '@agent/shared';
import { mobileSecureStorage, migrateLegacyKeychainItem } from '../platform/mobileSecureStorage';
import { loadServerUrl, loadLanUrl, startLanProbe } from '../platform/mobileConfig';
import { clearSessionListCache } from '../lib/sessionListCache';
import { clearAllMessageCache } from '../platform/mobileMessageCache';
import { fileCacheService } from '../services/fileCacheService';
import { textContentCache } from '../services/textContentCache';
import { clearFileListCache } from '../hooks/useFileList';
import { clearPreviewTokenCache } from '../services/previewTokenCache';
import { clearGroupsCache, getPlatform } from '@agent/shared';

const CACHED_USER_KEY = 'agentChat.cachedUser';

interface AuthContextValue {
  user: AuthUser | null;
  loading: boolean;
  login: (username: string, password: string) => Promise<{ ok: boolean; error?: string }>;
  loginWithSms: (phone: string, code: string) => Promise<{ ok: boolean; error?: string }>;
  logout: () => Promise<void>;
  updateAvatar: (avatar: string | undefined, avatarVersion?: number) => void;
  /** Re-fetch user info from server (e.g. when returning to foreground to pick up setting changes) */
  refreshUser: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);

  const logout = useCallback(async () => {
    await mobileSecureStorage.removeItem(TOKEN_KEY);
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
    setUser(null);
  }, []);

  // Check existing token on mount
  useEffect(() => {
    setOnUnauthorized(() => {
      void logout();
    });
    wsClient.setOnAuthFailure(() => {
      void logout();
    });

    (async () => {
      try {
        await loadServerUrl();
        await loadLanUrl();
        startLanProbe();
        // Share Intent 版本：keychain group 切到共享 group，把老版本的 token 搬过来
        await migrateLegacyKeychainItem(TOKEN_KEY);
        const token = await mobileSecureStorage.getItem(TOKEN_KEY);
        if (!token) {
          setLoading(false);
          return;
        }
        const res = await authFetch('/api/auth/me');
        if (res.ok) {
          const data = await res.json() as AuthUser;
          setUser(data);
          await AsyncStorage.setItem(CACHED_USER_KEY, JSON.stringify(data));
        } else {
          await mobileSecureStorage.removeItem(TOKEN_KEY);
          await AsyncStorage.removeItem(CACHED_USER_KEY);
        }
      } catch {
        // Network error — use cached user if available (offline tolerance)
        const cached = await AsyncStorage.getItem(CACHED_USER_KEY);
        if (cached) {
          try {
            setUser(JSON.parse(cached) as AuthUser);
          } catch { /* corrupted cache, ignore */ }
        }
      } finally {
        setLoading(false);
      }
    })();
  }, [logout]);

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
    try {
      const token = await mobileSecureStorage.getItem(TOKEN_KEY);
      if (!token) return;
      const res = await authFetch('/api/auth/me');
      if (res.ok) {
        const data = await res.json() as AuthUser;
        setUser(data);
        await AsyncStorage.setItem(CACHED_USER_KEY, JSON.stringify(data));
      }
    } catch {
      // Network error — keep current user state
    }
  }, []);

  const applyLoginResponse = useCallback(async (data: { token: string; user: AuthUser }) => {
    await mobileSecureStorage.setItem(TOKEN_KEY, data.token);
    await AsyncStorage.setItem(CACHED_USER_KEY, JSON.stringify(data.user));
    setUser(data.user);
  }, []);

  const postLogin = useCallback(async (url: string, body: unknown) => {
    try {
      const res = await authFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        return { ok: false, error: body.error || '登录失败' };
      }

      const data = await res.json() as { token: string; user: AuthUser };
      await applyLoginResponse(data);
      return { ok: true };
    } catch {
      return { ok: false, error: '网络错误，请检查服务器地址' };
    }
  }, [applyLoginResponse]);

  const login = useCallback(async (username: string, password: string) => {
    return postLogin('/api/auth/login', { username, password });
  }, [postLogin]);

  const loginWithSms = useCallback(async (phone: string, code: string) => {
    return postLogin('/api/auth/sms/login', { phone, code });
  }, [postLogin]);

  return (
    <AuthContext.Provider value={{ user, loading, login, loginWithSms, logout, updateAvatar, refreshUser }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
