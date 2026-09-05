/**
 * 「服务端轮询式」内置连接器（钉钉 DWS / 飞书）的状态机。
 *
 * 契约与 Web `CapabilityCenter/DingtalkConnector.tsx` / `FeishuConnector.tsx` 同源：
 *   GET    /api/{dws|feishu}/connections        读连接与 runtimeEnabled
 *   DELETE /api/{dws|feishu}/connections        断开（DWS 需 ?profileId=）
 *   GET    /api/{dws|feishu}/auth/session       读授权会话（503=服务不可用）
 *   POST   /api/{dws|feishu}/auth/session       发起授权，返回 authorizationUrl
 *   DELETE /api/{dws|feishu}/auth/session       取消授权
 *
 * 与 Web 的唯一差异是「打开授权页」的方式：Web 用同步栈里的 window.open 穿过
 * popup blocker，原生端用 `Linking.openURL` 交给系统浏览器，
 * 授权结果一律靠**服务端会话轮询**回收，不依赖 OAuth 原生回跳
 * （生产 profile 的 `oauthCallback.enabled.production=false`，见 release-manifest.json）。
 * 因此这两个连接器在生产包里可用，与凭据式 OAuth 连接器的降级路径无关。
 *
 * 安全边界：authorizationUrl 强制 HTTPS 后才交给系统浏览器；
 * 会话 id / 授权 URL 只存在内存 state，不落 AsyncStorage、不打日志。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Linking } from 'react-native';
import { authFetch, setNativeConnectorRuntimeEnabled } from '@agent/shared';
import type { NativeRuntimeConnectorId } from '@agent/shared';
import {
  connectorStatusLabel,
  isAuthSessionInProgress,
  resolvePollingConnectorStatus,
  type ConnectorStatus,
  type PollingConnectionView,
} from '../lib/capabilities/connectorStatus';

/** 轮询周期与 Web 一致（2s）。 */
const POLL_INTERVAL_MS = 2_000;

export interface PollingConnectionDetail extends PollingConnectionView {
  profileId?: string;
  profileName?: string | null;
  corpName?: string | null;
  message: string;
}

export interface PollingAuthSession {
  sessionId: string;
  status: 'starting' | 'awaiting_user' | 'connected' | 'failed' | 'expired';
  authorizationUrl: string | null;
  userCode?: string | null;
  message: string;
}

export type PollingConnectorKind = 'dws' | 'feishu';

export interface PollingConnectorState {
  kind: PollingConnectorKind;
  connections: PollingConnectionDetail[];
  authSession: PollingAuthSession | null;
  loading: boolean;
  connecting: boolean;
  busy: boolean;
  error: string | null;
  runtimeEnabled: boolean;
  status: ConnectorStatus;
  statusLabel: string;
  /** DWS 支持一个用户连接多个组织 profile；飞书只有一条。 */
  multiProfile: boolean;
  startConnection: () => Promise<void>;
  cancelAuthorization: () => Promise<void>;
  disconnect: (profileId?: string) => Promise<void>;
  setRuntimeEnabled: (enabled: boolean) => Promise<void>;
  reload: () => void;
}

function assertHttps(url: string): string {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:') throw new Error('授权地址必须使用 HTTPS');
  return parsed.toString();
}

const FAILURE_TEXT: Record<PollingConnectorKind, string> = {
  dws: '钉钉',
  feishu: '飞书',
};

export function usePollingAuthConnector(
  kind: PollingConnectorKind,
  enabled = true,
): PollingConnectorState {
  const label = FAILURE_TEXT[kind];
  const [connections, setConnections] = useState<PollingConnectionDetail[]>([]);
  const [authSession, setAuthSession] = useState<PollingAuthSession | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [connecting, setConnecting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [runtimeEnabled, setRuntimeEnabledState] = useState(true);
  const [serviceUnavailable, setServiceUnavailable] = useState(false);
  const openedUrlRef = useRef<string | null>(null);

  const loadConnections = useCallback(
    async (showLoading: boolean) => {
      if (showLoading) setLoading(true);
      try {
        const res = await authFetch(`/api/${kind}/connections`);
        const data = (await res.json().catch(() => ({}))) as {
          connections?: PollingConnectionDetail[];
          runtimeEnabled?: boolean;
          error?: string;
        };
        if (!res.ok) throw new Error(data.error || `${label}连接状态读取失败`);
        setConnections(data.connections ?? []);
        setRuntimeEnabledState(data.runtimeEnabled ?? true);
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : `${label}连接状态读取失败`);
      } finally {
        if (showLoading) setLoading(false);
      }
    },
    [kind, label],
  );

  const loadAuthSession = useCallback(async () => {
    const res = await authFetch(`/api/${kind}/auth/session`);
    const data = (await res.json().catch(() => ({}))) as {
      session?: PollingAuthSession | null;
      error?: string;
    };
    if (res.status === 503) {
      setServiceUnavailable(true);
      return null;
    }
    if (!res.ok) throw new Error(data.error || `${label}授权状态读取失败`);
    setServiceUnavailable(false);
    setAuthSession(data.session ?? null);
    return data.session ?? null;
  }, [kind, label]);

  const reload = useCallback(() => {
    if (!enabled) return;
    void loadConnections(true);
    void loadAuthSession().catch((err: unknown) =>
      setError(err instanceof Error ? err.message : `${label}授权状态读取失败`),
    );
  }, [enabled, label, loadAuthSession, loadConnections]);

  useEffect(() => {
    if (!enabled) return;
    reload();
  }, [enabled, reload]);

  // 授权进行中：轮询会话状态；连接刚建立时后端仍在做首次凭据检测，同样需要轮询。
  useEffect(() => {
    if (!enabled) return;
    const authorizing = isAuthSessionInProgress(authSession?.status ?? null);
    const checking = connections.some((item) => item.status === 'pending');
    if (!authorizing && !checking) return;
    const timer = setInterval(() => {
      if (authorizing) {
        void loadAuthSession().catch(() => undefined);
      }
      if (checking || authorizing) void loadConnections(false);
    }, POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [enabled, authSession?.status, connections, loadAuthSession, loadConnections]);

  // 会话进入 awaiting_user 后拿到授权地址，交给系统浏览器（同一 URL 只开一次）。
  useEffect(() => {
    const url = authSession?.authorizationUrl;
    if (!enabled || authSession?.status !== 'awaiting_user' || !url) return;
    if (openedUrlRef.current === url) return;
    openedUrlRef.current = url;
    try {
      void Linking.openURL(assertHttps(url));
    } catch (err) {
      setError(err instanceof Error ? err.message : '授权地址不可信，已阻止打开');
    }
  }, [enabled, authSession?.status, authSession?.authorizationUrl]);

  const startConnection = useCallback(async () => {
    setConnecting(true);
    setError(null);
    openedUrlRef.current = null;
    try {
      const res = await authFetch(`/api/${kind}/auth/session`, { method: 'POST' });
      const data = (await res.json().catch(() => ({}))) as {
        session?: PollingAuthSession;
        error?: string;
      };
      if (res.status === 503) setServiceUnavailable(true);
      if (!res.ok || !data.session) {
        throw new Error(data.error || `${label}授权启动失败，请稍后重试`);
      }
      setServiceUnavailable(false);
      setAuthSession(data.session);
      if (data.session.authorizationUrl) {
        openedUrlRef.current = data.session.authorizationUrl;
        await Linking.openURL(assertHttps(data.session.authorizationUrl));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : `${label}授权启动失败，请稍后重试`);
    } finally {
      setConnecting(false);
    }
  }, [kind, label]);

  const cancelAuthorization = useCallback(async () => {
    setBusy(true);
    try {
      const res = await authFetch(`/api/${kind}/auth/session`, { method: 'DELETE' });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(data.error || `${label}授权取消失败，请稍后重试`);
      setAuthSession(null);
      openedUrlRef.current = null;
    } catch (err) {
      setError(err instanceof Error ? err.message : `${label}授权取消失败，请稍后重试`);
    } finally {
      setBusy(false);
    }
  }, [kind, label]);

  const disconnect = useCallback(
    async (profileId?: string) => {
      setBusy(true);
      try {
        const query = profileId ? `?profileId=${encodeURIComponent(profileId)}` : '';
        const res = await authFetch(`/api/${kind}/connections${query}`, { method: 'DELETE' });
        const data = (await res.json().catch(() => ({}))) as {
          connections?: PollingConnectionDetail[];
          error?: string;
        };
        if (!res.ok) throw new Error(data.error || `${label}断开失败，请稍后重试`);
        setConnections(data.connections ?? []);
      } catch (err) {
        setError(err instanceof Error ? err.message : `${label}断开失败，请稍后重试`);
      } finally {
        setBusy(false);
      }
    },
    [kind, label],
  );

  const setRuntimeEnabled = useCallback(
    async (next: boolean) => {
      setBusy(true);
      try {
        await setNativeConnectorRuntimeEnabled(kind as NativeRuntimeConnectorId, next);
        setRuntimeEnabledState(next);
      } catch (err) {
        setError(err instanceof Error ? err.message : `${label}状态更新失败`);
      } finally {
        setBusy(false);
      }
    },
    [kind, label],
  );

  const status = resolvePollingConnectorStatus({
    loading,
    connections,
    authSessionStatus: authSession?.status ?? null,
    connecting,
    runtimeEnabled,
    serviceUnavailable,
  });

  return {
    kind,
    connections,
    authSession,
    loading,
    connecting,
    busy,
    error,
    runtimeEnabled,
    status,
    statusLabel: connectorStatusLabel(
      status,
      connections.filter((item) => item.status === 'connected').length,
    ),
    multiProfile: kind === 'dws',
    startConnection,
    cancelAuthorization,
    disconnect,
    setRuntimeEnabled,
    reload,
  };
}
