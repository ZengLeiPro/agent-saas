import React, { createContext, useCallback, useContext, useEffect, useReducer, useRef, useState } from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import {
  DEFAULT_LOCAL_LOCK_BACKGROUND_MS,
  INITIAL_LOCAL_APP_LOCK_STATE,
  authFetchForLocalUnlockValidation,
  fenceAuthSideEffects,
  localAppLockReducer,
  setSensitiveTransportAllowed,
  wsClient,
} from '@agent/shared';
import { useAuth } from './AuthContext';
import { biometricLocalAuth, type BiometricAvailability } from '../platform/biometricLocalAuth';
import { enableLocalAppLock, type LocalLockSessionValidation } from '../services/localAppLockEnablement';
import {
  readLocalAppLockPolicy,
  removeLocalAppLockPolicy,
  writeLocalAppLockPolicy,
} from '../platform/localAppLockStorage';

interface LocalAppLockContextValue {
  ready: boolean;
  enabled: boolean;
  locked: boolean;
  offlineShell: boolean;
  promptInFlight: boolean;
  failure: 'cancelled' | 'failed' | 'lockout' | null;
  availability: BiometricAvailability | null;
  enable: () => Promise<{ ok: boolean; error?: string }>;
  disable: () => Promise<{ ok: boolean; error?: string }>;
  unlock: () => Promise<void>;
  reauthenticate: () => Promise<void>;
}

const Context = createContext<LocalAppLockContextValue | null>(null);

export function LocalAppLockProvider({ children }: { children: React.ReactNode }) {
  const { identity, user, logout } = useAuth();
  const [state, dispatch] = useReducer(localAppLockReducer, INITIAL_LOCAL_APP_LOCK_STATE);
  const [ready, setReady] = useState(false);
  const [availability, setAvailability] = useState<BiometricAvailability | null>(null);
  const promptRef = useRef(false);
  const thresholdRef = useRef(DEFAULT_LOCAL_LOCK_BACKGROUND_MS);

  const applyTransportGate = useCallback((allowed: boolean) => {
    setSensitiveTransportAllowed(allowed);
    if (!allowed) void fenceAuthSideEffects();
    if (allowed) wsClient.unfreezeSending();
    else {
      wsClient.freezeSending();
      wsClient.disconnect();
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    setReady(false);
    dispatch({ type: 'identity-boundary' });
    applyTransportGate(!identity);
    if (!identity) {
      setAvailability(null);
      setReady(true);
      return;
    }
    void Promise.all([
      readLocalAppLockPolicy(identity),
      biometricLocalAuth.availability().catch(() => ({ supported: false, enrolled: false })),
    ]).then(([policy, capability]) => {
      if (cancelled) return;
      setAvailability(capability);
      const enabled = !!policy && capability.supported && capability.enrolled;
      thresholdRef.current = policy?.backgroundTimeoutMs ?? DEFAULT_LOCAL_LOCK_BACKGROUND_MS;
      dispatch({ type: 'configure', enabled });
      applyTransportGate(!enabled);
      setReady(true);
    });
    return () => { cancelled = true; };
  }, [identity?.userId, identity?.tenantId, identity?.generation, applyTransportGate]);

  useEffect(() => {
    promptRef.current = state.promptInFlight;
  }, [state.promptInFlight]);

  useEffect(() => {
    const onChange = (next: AppStateStatus) => {
      const now = Date.now();
      if (next === 'inactive' || next === 'background') {
        dispatch({ type: 'background', now, systemPrompt: promptRef.current });
      } else if (next === 'active') {
        dispatch({ type: 'foreground', now, thresholdMs: thresholdRef.current });
      }
    };
    const subscription = AppState.addEventListener('change', onChange);
    return () => subscription.remove();
  }, []);

  useEffect(() => {
    const allowed = state.access === 'full';
    applyTransportGate(allowed);
  }, [state.access, applyTransportGate]);

  const validateServerSession = useCallback(async (): Promise<LocalLockSessionValidation> => {
    if (!identity || !user) return 'invalid';
    try {
      const response = await authFetchForLocalUnlockValidation('/api/auth/me');
      if (!response.ok) return 'invalid';
      const current = await response.json() as { id?: string; tenantId?: string };
      return current.id === identity.userId && current.tenantId === identity.tenantId
        ? 'valid'
        : 'invalid';
    } catch {
      return 'offline';
    }
  }, [identity, user]);

  const enable = useCallback(async () => {
    if (!identity) return { ok: false, error: '请先登录' };
    const result = await enableLocalAppLock({
      validateSession: validateServerSession,
      availability: () => biometricLocalAuth.availability().catch(() => ({ supported: false, enrolled: false })),
      authenticate: biometricLocalAuth.authenticate,
      persist: () => writeLocalAppLockPolicy(identity, DEFAULT_LOCAL_LOCK_BACKGROUND_MS),
    });
    if (result.availability) setAvailability(result.availability);
    if (!result.ok) return result;
    thresholdRef.current = DEFAULT_LOCAL_LOCK_BACKGROUND_MS;
    dispatch({ type: 'configure', enabled: true });
    dispatch({ type: 'prompt-start', now: Date.now() });
    dispatch({ type: 'prompt-success', serverSessionValid: true, offline: false });
    return { ok: true };
  }, [identity, validateServerSession]);

  const disable = useCallback(async () => {
    if (!identity) return { ok: false, error: '请先登录' };
    const validation = await validateServerSession();
    if (validation !== 'valid') return { ok: false, error: validation === 'offline' ? '需联网验证当前登录后才能关闭' : '当前登录已失效，请重新登录' };
    await removeLocalAppLockPolicy(identity);
    dispatch({ type: 'configure', enabled: false });
    return { ok: true };
  }, [identity, validateServerSession]);

  const unlock = useCallback(async () => {
    if (!state.enabled || state.access !== 'locked' || promptRef.current) return;
    dispatch({ type: 'prompt-start', now: Date.now() });
    promptRef.current = true;
    const local = await biometricLocalAuth.authenticate();
    if (!local.ok) {
      dispatch({ type: 'prompt-failure', reason: local.reason });
      promptRef.current = false;
      return;
    }
    const validation = await validateServerSession();
    dispatch({
      type: 'prompt-success',
      serverSessionValid: validation === 'valid',
      offline: validation === 'offline',
    });
    promptRef.current = false;
    if (validation === 'invalid') await logout();
  }, [state.enabled, state.access, validateServerSession, logout]);

  const reauthenticate = useCallback(async () => {
    await logout();
  }, [logout]);

  return (
    <Context.Provider value={{
      ready,
      enabled: state.enabled,
      locked: state.access === 'locked',
      offlineShell: state.access === 'offline-shell',
      promptInFlight: state.promptInFlight,
      failure: state.failure,
      availability,
      enable,
      disable,
      unlock,
      reauthenticate,
    }}>
      {ready ? children : null}
    </Context.Provider>
  );
}

export function useLocalAppLock(): LocalAppLockContextValue {
  const value = useContext(Context);
  if (!value) throw new Error('useLocalAppLock must be used within LocalAppLockProvider');
  return value;
}
