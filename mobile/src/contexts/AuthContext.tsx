import React, { createContext, useContext, useState, useEffect, useCallback, useMemo, useRef } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  AUTH_SESSION_KEY,
  AuthLifecycleTransaction,
  authFetch,
  createStorageJournalStore,
  setOnUnauthorized,
  wsClient,
  TOKEN_KEY,
  INPUT_DRAFT_KEY,
  resetChatStore,
  INITIAL_IDENTITY_STATE,
  identityReducer,
  scopedSensitiveKey,
} from '@agent/shared';
import type { AuthUser, BoundaryIdentity, IdentityEvent, IdentityState } from '@agent/shared';
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
import { clearAllMessageCache, setMobileMessageCacheIdentity } from '../platform/mobileMessageCache';
import { clearMobileCacheV2Namespace } from '../platform/mobileCacheAdapter';
import { fileCacheService } from '../services/fileCacheService';
import { textContentCache } from '../services/textContentCache';
import { clearFileListCache } from '../hooks/useFileList';
import { cancelNativeOAuthTransaction } from '../services/nativeOAuthHandoff';
import { clearGroupsCache, getPlatform, setSensitiveTransportAllowed } from '@agent/shared';
import { clearAllLocalAppLockPolicies } from '../platform/localAppLockStorage';

const CACHED_USER_KEY = 'agentChat.cachedUser';
const IDENTITY_META_KEY = 'agentChat.identity.v1';
const AUTH_REQUEST_TIMEOUT_MS = 15_000;

interface ServiceOriginChangeResult {
  ok: boolean;
  changed?: boolean;
  requiresReauthentication?: boolean;
  error?: string;
}

interface AuthContextValue {
  identity: BoundaryIdentity | null;
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
  const identityRef = useRef<IdentityState>(INITIAL_IDENTITY_STATE);
  const [identityState, setIdentityState] = useState<IdentityState>(INITIAL_IDENTITY_STATE);
  const transitionIdentity = useCallback(async (event: IdentityEvent) => {
    const next = identityReducer(identityRef.current, event);
    identityRef.current = next;
    setIdentityState(next);
    setMobileMessageCacheIdentity(next.identity);
    await AsyncStorage.setItem(IDENTITY_META_KEY, JSON.stringify(next));
    if (next.identity && (event.type === 'authenticated' || event.type === 'principal-switched' || event.type === 'tenant-switched')) {
      wsClient.unfreezeSending();
    }
    return next.identity;
  }, []);
  const cachedUserKey = useCallback((identity: BoundaryIdentity | null) => scopedSensitiveKey(CACHED_USER_KEY, identity), []);
  const [loading, setLoading] = useState(true); // held until journal recovery completes
  const [serviceConfig, setServiceConfig] = useState<MobileServicePolicy>(
    getServiceConfigSnapshot,
  );

  const lifecycle = useMemo(() => new AuthLifecycleTransaction(
    createStorageJournalStore({
      getItem: (key) => AsyncStorage.getItem(key),
      setItem: (key, value) => AsyncStorage.setItem(key, value),
      removeItem: (key) => AsyncStorage.removeItem(key),
    }),
    {
      fenceGeneration: async () => {
        setSensitiveTransportAllowed(false);
        wsClient.freezeSending();
        if (identityRef.current.identity) await transitionIdentity({ type: 'logout' });
        setUser(null);
        const token = await mobileSecureStorage.getItem(TOKEN_KEY);
        const config = getServiceConfigSnapshot();
        if (token && config.ready) void fetch(`${config.apiOrigin}/api/auth/logout`, {
          method: 'POST', headers: { Authorization: `Bearer ${token}` },
        }).catch(() => undefined);
      },
      disconnectWs: () => wsClient.disconnect(),
      stopQueue: () => resetChatStore(),
      clearCursorEpoch: async () => {
        wsClient.resetRecovery({ sessionId: null });
        await getPlatform().storage.removeItem('agentChat.sessionId');
      },
      clearCache: async () => {
        await clearAllLocalAppLockPolicies();
        await cancelNativeOAuthTransaction();
        await AsyncStorage.removeItem(CACHED_USER_KEY);
        const scopedUser = cachedUserKey(identityRef.current.identity);
        if (scopedUser) await AsyncStorage.removeItem(scopedUser); // pre-M30 compatibility key
        await Promise.all([
          clearMobileCacheV2Namespace(), clearSessionListCache(), clearGroupsCache(), clearAllMessageCache(),
          fileCacheService.clearAll(), textContentCache.clearAll(), clearFileListCache(),
        ]);
        await Promise.all([
          Promise.resolve(getPlatform().storage.removeItem('avatarMap')),
          Promise.resolve(getPlatform().storage.removeItem(INPUT_DRAFT_KEY)),
        ]);
        const localKeys = await AsyncStorage.getAllKeys();
        const sensitiveKeys = localKeys.filter((key) =>
          key.startsWith('agentChat.model.') || key.startsWith('agentChat.inputDraft::') ||
          key.startsWith('agentChat.queue') || key.startsWith('agentChat.runtime') ||
          key.startsWith('agentChat.interaction') || key.startsWith('agentChat.upload') ||
          key.startsWith(CACHED_USER_KEY),
        );
        if (sensitiveKeys.length) await AsyncStorage.multiRemove(sensitiveKeys);
      },
      deleteToken: async () => {
        await mobileSecureStorage.removeItem(TOKEN_KEY);
        await mobileSecureStorage.removeItem(AUTH_SESSION_KEY);
      },
    },
  ), [cachedUserKey, transitionIdentity]);

  const clearAccountData = useCallback(async (_disconnectRealtime: boolean) => {
    await lifecycle.logout();
  }, [lifecycle]);

  const logout = useCallback(async () => { // shared transaction remains authoritative
    const token = await mobileSecureStorage.getItem(TOKEN_KEY);
    const config = getServiceConfigSnapshot();
    const serverFence = token && config.ready
      ? fetch(`${config.apiOrigin}/api/auth/logout`, {
          method: 'POST', headers: { Authorization: `Bearer ${token}` },
        }).then(() => undefined).catch(() => undefined)
      : Promise.resolve();
    await lifecycle.logout();
    await serverFence;
  }, [lifecycle]);

  // Check existing token on mount only after lifecycle recovery. Service configuration is resolved first;
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
        const storedIdentity = await AsyncStorage.getItem(IDENTITY_META_KEY);
        if (storedIdentity) {
          try {
            const parsed = JSON.parse(storedIdentity) as IdentityState;
            if (typeof parsed.generation === 'number') {
              identityRef.current = parsed;
              if (!cancelled) setIdentityState(parsed);
            }
          } catch { await AsyncStorage.removeItem(IDENTITY_META_KEY); }
        }
        // Journal recovery precedes every cached-token or reconnect decision.
        await lifecycle.resume();
        await lifecycle.failClosedIncompleteLogin({
          fenceUntilCommit: () => { setSensitiveTransportAllowed(false); wsClient.freezeSending(); },
          persistTokenAndBinding: () => undefined,
          installAuthenticatedState: () => undefined,
          commitConnections: () => undefined,
          failClosed: async () => {
            wsClient.disconnect();
            await mobileSecureStorage.removeItem(TOKEN_KEY);
            await mobileSecureStorage.removeItem(AUTH_SESSION_KEY);
            setUser(null);
          },
        });
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
        if (!token) {
          if (identityRef.current.identity) {
            await clearAccountData(false);
            await transitionIdentity({ type: 'token-invalidated' });
          }
          return;
        }

        const res = await timedAuthFetch('/api/auth/me'); // may atomically upgrade an N-1 token
        if (res.ok) {
          const binding = await mobileSecureStorage.getItem(AUTH_SESSION_KEY);
          if (!binding) {
            await clearAccountData(false);
            return;
          }
          const data = await res.json() as AuthUser;
          const identity = await transitionIdentity({ type: 'authenticated', principal: { userId: data.id, tenantId: data.tenantId } });
          if (!cancelled) setUser(data);
          const key = cachedUserKey(identity);
          if (key) await AsyncStorage.setItem(key, JSON.stringify(data));
        } else {
          await clearAccountData(false);
          await transitionIdentity({ type: 'token-invalidated' });
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
        const cacheKey = cachedUserKey(identityRef.current.identity);
        const cached = cacheKey ? await AsyncStorage.getItem(cacheKey) : null;
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
  }, [cachedUserKey, clearAccountData, lifecycle, logout, transitionIdentity]);

  const updateAvatar = useCallback((avatar: string | undefined, avatarVersion?: number) => {
    setUser((prev) => prev ? { ...prev, avatar, avatarVersion } : prev);
    const key = cachedUserKey(identityRef.current.identity);
    if (key) AsyncStorage.getItem(key).then(cached => {
      if (cached) {
        try {
          const u = JSON.parse(cached);
          u.avatar = avatar;
          u.avatarVersion = avatarVersion;
          void AsyncStorage.setItem(key, JSON.stringify(u));
        } catch { /* ignore */ }
      }
    });
  }, [cachedUserKey]);

  const refreshUser = useCallback(async () => {
    if (!getServiceConfigSnapshot().ready) return;
    try {
      const token = await mobileSecureStorage.getItem(TOKEN_KEY);
      if (!token) return;
      const res = await timedAuthFetch('/api/auth/me');
      if (res.ok) {
        const data = await res.json() as AuthUser;
        const current = identityRef.current.identity;
        const changed = !!current && (current.userId !== data.id || current.tenantId !== data.tenantId);
        if (changed) await clearAccountData(false);
        const identity = await transitionIdentity({ type: changed ? 'tenant-switched' : 'authenticated', principal: { userId: data.id, tenantId: data.tenantId } });
        setUser(data);
        const key = cachedUserKey(identity);
        if (key) await AsyncStorage.setItem(key, JSON.stringify(data));
      }
    } catch {
      // Network/TLS/timeout error — keep current user state and allow retry.
    }
  }, [cachedUserKey, clearAccountData, transitionIdentity]);

  const applyLoginResponse = useCallback(async (data: { token: string; authEpoch: number; generation: number; user: AuthUser }) => {
    const principal = { userId: data.user.id, tenantId: data.user.tenantId };
    const current = identityRef.current.identity;
    const switchingOwner = !!current && (current.userId !== principal.userId || current.tenantId !== principal.tenantId);
    await lifecycle.login({ authEpoch: data.authEpoch, generation: data.generation }, {
      fenceUntilCommit: async () => {
        setSensitiveTransportAllowed(false);
        wsClient.freezeSending();
        if (switchingOwner) {
          setMobileMessageCacheIdentity(null);
          await clearMobileCacheV2Namespace();
          resetChatStore();
          wsClient.resetRecovery({ sessionId: null });
        }
      },
      persistTokenAndBinding: async (binding) => {
        await mobileSecureStorage.setItem(TOKEN_KEY, data.token);
        await mobileSecureStorage.setItem(AUTH_SESSION_KEY, JSON.stringify(binding));
      },
      installAuthenticatedState: async () => {
        const identity = await transitionIdentity({ type: current ? 'principal-switched' : 'authenticated', principal });
        const key = cachedUserKey(identity);
        if (key) await AsyncStorage.setItem(key, JSON.stringify(data.user));
        setUser(data.user);
      },
      commitConnections: () => { setSensitiveTransportAllowed(true); wsClient.unfreezeSending(); },
      failClosed: async () => {
        setSensitiveTransportAllowed(false);
        wsClient.disconnect();
        await mobileSecureStorage.removeItem(TOKEN_KEY);
        await mobileSecureStorage.removeItem(AUTH_SESSION_KEY);
        setUser(null);
      },
    });
  }, [cachedUserKey, lifecycle, transitionIdentity]);

  const postLogin = useCallback(async (url: string, body: unknown) => {
    const currentConfig = getServiceConfigSnapshot();
    if (!currentConfig.ready) {
      return {
        ok: false,
        error: currentConfig.issue?.message ?? '可信服务配置尚未就绪。',
      };
    }

    try {
      // Logged-out transport is reopened only for the trusted login endpoint;
      // WS remains fenced until the shared transaction commits.
      setSensitiveTransportAllowed(true);
      const res = await timedAuthFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const responseBody = await res.json().catch(() => ({})) as { error?: string };
        return { ok: false, error: responseBody.error || '登录失败' };
      }

      const data = await res.json() as { token: string; authEpoch: number; generation: number; user: AuthUser };
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
      identity: identityState.identity,
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
