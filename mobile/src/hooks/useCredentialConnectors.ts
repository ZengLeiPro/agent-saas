/**
 * 凭据式内置连接器（GitHub / X / Notion / Google Workspace / 阿里云）状态与动作。
 *
 * 端点全部来自 shared `connectorsApi`，不在这里自造：
 *   fetch/connect/disconnect Github|X|Aliyun  —— 粘贴凭据即可，原生端与 Web 等价；
 *   fetch/start Notion auth session           —— 服务端会话轮询式，原生端等价可用；
 *   startGoogleWorkspaceOAuth(nativeBinding)  —— 需要原生 OAuth 回跳。
 *
 * 生产降级（重要）：`mobile/release-manifest.json` 的
 * `oauthCallback.enabled.production=false`，生产包 `extra.oauthCallback.allowlist`
 * 为空，`beginNativeOAuthTransaction()` 会直接拒绝启动授权。这里不绕开该边界，
 * 而是提前用 `nativeOAuthRedirectAvailable()` 判定并把 Google Workspace 降级为
 * 「请在 Web 端完成授权」——不自行打开生产 OAuth callback。
 */
import { useCallback, useEffect, useState } from 'react';
import {
  connectAliyun,
  connectGithub,
  connectX,
  disconnectAliyun,
  disconnectGithub,
  disconnectGoogleWorkspace,
  disconnectNotion,
  disconnectX,
  fetchAliyunConnection,
  fetchGithubConnection,
  fetchGoogleWorkspaceConnection,
  fetchNotionAuthSession,
  fetchNotionConnection,
  fetchXConnection,
  startNotionAuthSession,
  type AliyunConnectInput,
} from '@agent/shared';
import {
  connectorStatusLabel,
  resolveCredentialConnectorStatus,
  type ConnectorStatus,
} from '../lib/capabilities/connectorStatus';
import { getNativeOAuthCallbackAllowlist } from '../platform/nativeOAuthCallbackPolicy';

export type CredentialConnectorId = 'github' | 'x' | 'notion' | 'google-workspace' | 'aliyun';

export interface CredentialConnectorState {
  status: ConnectorStatus;
  statusLabel: string;
  /** 副标题：账号 / 工作区等可展示的连接身份，绝不包含任何凭据内容 */
  detail: string;
  /** 授权地址（Notion 会话式）；仅内存态 */
  authorizationUrl: string | null;
}

const EMPTY: CredentialConnectorState = {
  status: 'loading',
  statusLabel: connectorStatusLabel('loading'),
  detail: '',
  authorizationUrl: null,
};

/** 本构建是否配置了可信 OAuth 回跳（生产 profile 为空 → false）。 */
export function nativeOAuthRedirectAvailable(): boolean {
  return getNativeOAuthCallbackAllowlist().length > 0;
}

export interface CredentialConnectorsResult {
  states: Record<CredentialConnectorId, CredentialConnectorState>;
  loading: boolean;
  busyId: CredentialConnectorId | null;
  error: string | null;
  /** OAuth 回跳式连接器在本构建是否可用（生产为 false） */
  oauthRedirectAvailable: boolean;
  reload: () => void;
  connectGithubToken: (token: string) => Promise<void>;
  connectXCookies: (input: { authToken: string; ct0: string }) => Promise<void>;
  connectAliyunKeys: (input: AliyunConnectInput) => Promise<void>;
  startNotion: () => Promise<string | null>;
  disconnect: (id: CredentialConnectorId) => Promise<void>;
}

export function useCredentialConnectors(enabled = true): CredentialConnectorsResult {
  const [states, setStates] = useState<Record<CredentialConnectorId, CredentialConnectorState>>({
    github: EMPTY,
    x: EMPTY,
    notion: EMPTY,
    'google-workspace': EMPTY,
    aliyun: EMPTY,
  });
  const [loading, setLoading] = useState(enabled);
  const [busyId, setBusyId] = useState<CredentialConnectorId | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const [github, x, notion, notionSession, google, aliyun] = await Promise.all([
      fetchGithubConnection().catch(() => null),
      fetchXConnection().catch(() => null),
      fetchNotionConnection().catch(() => null),
      fetchNotionAuthSession().catch(() => null),
      fetchGoogleWorkspaceConnection().catch(() => null),
      fetchAliyunConnection().catch(() => null),
    ]);
    const notionAuthorizing =
      notionSession?.session?.status === 'starting' ||
      notionSession?.session?.status === 'awaiting_user';
    const build = (
      status: ConnectorStatus,
      detail: string,
      authorizationUrl: string | null = null,
    ): CredentialConnectorState => ({
      status,
      statusLabel: connectorStatusLabel(status),
      detail,
      authorizationUrl,
    });
    setStates({
      github: build(
        resolveCredentialConnectorStatus({
          loading: false,
          status: github?.connection.status,
          runtimeEnabled: github?.connection.runtimeEnabled ?? true,
        }),
        'GitHub CLI（gh）用户凭据',
      ),
      x: build(
        resolveCredentialConnectorStatus({
          loading: false,
          status: x?.connection.status,
          runtimeEnabled: x?.connection.runtimeEnabled ?? true,
        }),
        'X bird CLI 用户凭据',
      ),
      notion: build(
        resolveCredentialConnectorStatus({
          loading: false,
          status: notion?.connection.status,
          runtimeEnabled: notion?.connection.runtimeEnabled ?? true,
          available: notion?.available,
          authorizing: notionAuthorizing,
        }),
        notion?.connection.workspaceName ?? 'Notion 工作区',
        notionSession?.session?.authorizationUrl ?? null,
      ),
      'google-workspace': build(
        resolveCredentialConnectorStatus({
          loading: false,
          status: google?.connection?.status,
          runtimeEnabled: google?.connection?.runtimeEnabled ?? true,
          available: google?.available,
        }),
        google?.connection?.accountEmail ?? 'Google Workspace（gws）',
      ),
      aliyun: build(
        resolveCredentialConnectorStatus({
          loading: false,
          status: aliyun?.connection.status,
          runtimeEnabled: aliyun?.connection.runtimeEnabled ?? true,
        }),
        aliyun?.connection.regionId ? `地域 ${aliyun.connection.regionId}` : '阿里云 CLI 用户凭据',
      ),
    });
    setLoading(false);
  }, []);

  const reload = useCallback(() => {
    if (!enabled) return;
    void load();
  }, [enabled, load]);

  useEffect(() => {
    reload();
  }, [reload]);

  const run = useCallback(
    async (id: CredentialConnectorId, action: () => Promise<void>) => {
      setBusyId(id);
      setError(null);
      try {
        await action();
        await load();
      } catch (err) {
        setError(err instanceof Error ? err.message : '连接器操作失败');
      } finally {
        setBusyId(null);
      }
    },
    [load],
  );

  const connectGithubToken = useCallback(
    (token: string) =>
      run('github', async () => {
        await connectGithub({ token });
      }),
    [run],
  );
  const connectXCookies = useCallback(
    (input: { authToken: string; ct0: string }) =>
      run('x', async () => {
        await connectX(input);
      }),
    [run],
  );
  const connectAliyunKeys = useCallback(
    (input: AliyunConnectInput) =>
      run('aliyun', async () => {
        await connectAliyun(input);
      }),
    [run],
  );

  /** 返回授权地址交由调用方打开；失败返回 null 并落到 error。 */
  const startNotion = useCallback(async (): Promise<string | null> => {
    setBusyId('notion');
    setError(null);
    try {
      const result = await startNotionAuthSession();
      await load();
      return result.session?.authorizationUrl ?? null;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Notion 授权启动失败');
      return null;
    } finally {
      setBusyId(null);
    }
  }, [load]);

  const disconnect = useCallback(
    (id: CredentialConnectorId) =>
      run(id, async () => {
        if (id === 'github') await disconnectGithub();
        else if (id === 'x') await disconnectX();
        else if (id === 'notion') await disconnectNotion();
        else if (id === 'google-workspace') await disconnectGoogleWorkspace();
        else await disconnectAliyun();
      }),
    [run],
  );

  return {
    states,
    loading,
    busyId,
    error,
    oauthRedirectAvailable: nativeOAuthRedirectAvailable(),
    reload,
    connectGithubToken,
    connectXCookies,
    connectAliyunKeys,
    startNotion,
    disconnect,
  };
}
