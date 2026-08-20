import { governanceResourcesApi } from './governanceApi';
import { authFetch } from './authFetch';
import type {
  AliyunConnectInput,
  AliyunConnectionResponse,
  GithubConnectionResponse,
  XConnectInput,
  XConnectionResponse,
  GoogleWorkspaceConnectionResponse,
  GoogleWorkspaceOAuthStartResponse,
  NotionAuthSessionResponse,
  NotionConnectionResponse,
  NotionDisconnectResponse,
} from '../types/connectors';

async function jsonOrError<T>(res: Response, fallback: string): Promise<T> {
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { error?: string };
    throw new Error(body.error || fallback);
  }
  return res.json() as Promise<T>;
}

export type NativeRuntimeConnectorId = 'github' | 'x' | 'dws' | 'feishu' | 'notion' | 'google-workspace' | 'aliyun';

export async function setNativeConnectorRuntimeEnabled(
  connectorId: NativeRuntimeConnectorId,
  runtimeEnabled: boolean,
): Promise<{ connectorId: NativeRuntimeConnectorId; runtimeEnabled: boolean }> {
  return jsonOrError(await authFetch(`/api/connectors/${connectorId}/runtime`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ runtimeEnabled }),
  }), runtimeEnabled ? '恢复连接器失败' : '暂停连接器失败');
}

export async function fetchGithubConnection(): Promise<GithubConnectionResponse> {
  return jsonOrError(await authFetch('/api/connectors/github'), '读取 GitHub 连接失败');
}

export async function connectGithub(input: {
  token: string;
}): Promise<GithubConnectionResponse> {
  const res = await authFetch('/api/connectors/github', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  return jsonOrError(res, 'GitHub 连接失败');
}

export async function disconnectGithub(): Promise<GithubConnectionResponse> {
  const res = await authFetch('/api/connectors/github', { method: 'DELETE' });
  return jsonOrError(res, 'GitHub 断开失败');
}

export async function fetchXConnection(): Promise<XConnectionResponse> {
  return jsonOrError(await authFetch('/api/connectors/x'), '读取 X 连接失败');
}

export async function connectX(input: XConnectInput): Promise<XConnectionResponse> {
  const authToken = input.authToken.trim();
  const ct0 = input.ct0.trim();
  if (!authToken || !ct0) throw new Error('X 连接凭据不能为空');
  await governanceResourcesApi.createCredential({
    connectorId: 'x',
    kind: 'personal_grant',
    purpose: 'X bird CLI 用户凭据',
    scopeSummary: { scopes: ['x:*'] },
    secret: JSON.stringify({ authToken, ct0 }),
  });
  return {
    connection: {
      connectorId: 'x',
      status: 'connected',
      runtimeEnabled: true,
    },
  };
}

export async function disconnectX(): Promise<XConnectionResponse> {
  return jsonOrError(await authFetch('/api/connectors/x', { method: 'DELETE' }), 'X 断开失败');
}

export async function fetchNotionConnection(): Promise<NotionConnectionResponse> {
  return jsonOrError(await authFetch('/api/connectors/notion'), '读取 Notion 连接失败');
}

export async function fetchNotionAuthSession(): Promise<NotionAuthSessionResponse> {
  return jsonOrError(await authFetch('/api/connectors/notion/auth/session'), '读取 Notion 授权状态失败');
}

export async function startNotionAuthSession(): Promise<NotionAuthSessionResponse> {
  return jsonOrError(await authFetch('/api/connectors/notion/auth/session', {
    method: 'POST',
  }), '启动 Notion 授权失败');
}

export async function disconnectNotion(): Promise<NotionDisconnectResponse> {
  const res = await authFetch('/api/connectors/notion', { method: 'DELETE' });
  return jsonOrError(res, 'Notion 断开失败');
}

export async function fetchGoogleWorkspaceConnection(): Promise<GoogleWorkspaceConnectionResponse> {
  return jsonOrError(
    await authFetch('/api/connectors/google-workspace'),
    '读取 Google Workspace 连接失败',
  );
}

export async function startGoogleWorkspaceOAuth(nativeDeviceId?: string): Promise<GoogleWorkspaceOAuthStartResponse> {
  return jsonOrError(await authFetch('/api/connectors/google-workspace/oauth/start', {
    method: 'POST',
    ...(nativeDeviceId ? {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nativeDeviceId }),
    } : {}),
  }), '启动 Google Workspace 授权失败');
}

export async function disconnectGoogleWorkspace(): Promise<void> {
  const res = await authFetch('/api/connectors/google-workspace', { method: 'DELETE' });
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { error?: string };
    throw new Error(body.error || 'Google Workspace 断开失败');
  }
}

export async function fetchAliyunConnection(): Promise<AliyunConnectionResponse> {
  return jsonOrError(await authFetch('/api/connectors/aliyun'), '读取阿里云连接失败');
}

export async function connectAliyun(input: AliyunConnectInput): Promise<AliyunConnectionResponse> {
  return jsonOrError(await authFetch('/api/connectors/aliyun', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  }), '阿里云连接失败');
}

export async function disconnectAliyun(): Promise<AliyunConnectionResponse> {
  return jsonOrError(
    await authFetch('/api/connectors/aliyun', { method: 'DELETE' }),
    '阿里云断开失败',
  );
}
