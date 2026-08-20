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

interface PersonalCredentialSummary {
  credentialId: string;
  connectorId?: string;
  kind: string;
  status: string;
  version: number;
  createdAt?: string;
  updatedAt?: string;
}

interface PersonalCredentialMutation {
  credentialId: string;
  version: number;
  createdAt?: string;
  updatedAt?: string;
}

const REVOKABLE_CREDENTIAL_STATUSES = [
  'active', 'rotation_due', 'expired', 'suspended', 'revoked', 'validation_failed',
];

async function savePersonalCredential(input: {
  connectorId: string;
  secret: string;
  purpose: string;
  scopeSummary?: Record<string, unknown>;
  rotateReason: string;
}): Promise<void> {
  const current = await governanceResourcesApi.listCredentials<{ credentials: PersonalCredentialSummary[] }>();
  const existing = current.credentials
    .filter(credential => credential.connectorId === input.connectorId
      && credential.kind === 'personal_grant'
      && ['active', 'rotation_due'].includes(credential.status))
    .sort((left, right) => (Date.parse(right.updatedAt ?? '') - Date.parse(left.updatedAt ?? ''))
      || right.credentialId.localeCompare(left.credentialId))[0];

  if (existing) {
    const command = {
      expectedVersion: existing.version,
      secret: input.secret,
      reason: input.rotateReason,
    };
    const preview = await governanceResourcesApi.previewCredentialRotation<{
      previewId: string;
      baselineDigest: string;
      expiresAt: string;
    }>(existing.credentialId, command);
    await governanceResourcesApi.rotateCredential<PersonalCredentialMutation>(existing.credentialId, {
      ...command,
      previewId: preview.previewId,
      baselineDigest: preview.baselineDigest,
      expiresAt: preview.expiresAt,
    });
    return;
  }

  await governanceResourcesApi.createCredential<PersonalCredentialMutation>({
    connectorId: input.connectorId,
    kind: 'personal_grant',
    purpose: input.purpose,
    ...(input.scopeSummary ? { scopeSummary: input.scopeSummary } : {}),
    secret: input.secret,
  });
}

async function revokePersonalCredentials(connectorId: string, reason: string): Promise<void> {
  const current = await governanceResourcesApi.listCredentials<{ credentials: PersonalCredentialSummary[] }>();
  const credentials = current.credentials.filter(credential => credential.connectorId === connectorId
    && credential.kind === 'personal_grant'
    && REVOKABLE_CREDENTIAL_STATUSES.includes(credential.status));
  for (const credential of credentials) {
    const command = { expectedVersion: credential.version, reason };
    const preview = await governanceResourcesApi.previewCredentialRevoke<{
      previewId: string;
      baselineDigest: string;
      expiresAt: string;
    }>(credential.credentialId, command);
    await governanceResourcesApi.revokeCredential(credential.credentialId, {
      ...command,
      previewId: preview.previewId,
      baselineDigest: preview.baselineDigest,
      expiresAt: preview.expiresAt,
    });
  }
}

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

function normalizeGithubToken(value: string): string | undefined {
  const token = value.trim().replace(/^Bearer\s+/i, '');
  const valid = /^gh[pousr]_[A-Za-z0-9_]+$/.test(token)
    || /^github_pat_[A-Za-z0-9_]+$/.test(token);
  return valid ? token : undefined;
}

export async function connectGithub(input: { token: string }): Promise<GithubConnectionResponse> {
  const token = normalizeGithubToken(input.token);
  if (!token) throw new Error('请输入有效的 GitHub Personal Access Token');
  await savePersonalCredential({
    connectorId: 'github',
    secret: token,
    purpose: 'GitHub CLI 用户凭据',
    scopeSummary: { scopes: ['github:*'] },
    rotateReason: '更新 GitHub CLI 用户凭据',
  });
  return fetchGithubConnection();
}

export async function disconnectGithub(): Promise<GithubConnectionResponse> {
  await revokePersonalCredentials('github', '用户主动断开 GitHub');
  return fetchGithubConnection();
}

export async function fetchXConnection(): Promise<XConnectionResponse> {
  return jsonOrError(await authFetch('/api/connectors/x'), '读取 X 连接失败');
}

export async function connectX(input: XConnectInput): Promise<XConnectionResponse> {
  const authToken = input.authToken.trim();
  const ct0 = input.ct0.trim();
  if (!authToken || !ct0) throw new Error('X 连接凭据不能为空');

  await savePersonalCredential({
    connectorId: 'x',
    secret: JSON.stringify({ authToken, ct0 }),
    purpose: 'X bird CLI 用户凭据',
    scopeSummary: { scopes: ['x:*'] },
    rotateReason: '更新 X bird CLI 用户凭据',
  });
  return fetchXConnection();
}

export async function disconnectX(): Promise<XConnectionResponse> {
  await revokePersonalCredentials('x', '用户主动断开 X');
  return fetchXConnection();
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

function normalizeAliyunInput(input: AliyunConnectInput): AliyunConnectInput {
  const accessKeyId = input.accessKeyId.trim();
  const accessKeySecret = input.accessKeySecret.trim();
  const regionId = input.regionId.trim();
  if (!accessKeyId || !accessKeySecret) throw new Error('AccessKey ID 和 AccessKey Secret 不能为空');
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)+$/.test(regionId)) throw new Error('地域 ID 格式不正确');
  return { accessKeyId, accessKeySecret, regionId };
}

export async function fetchAliyunConnection(): Promise<AliyunConnectionResponse> {
  return jsonOrError(await authFetch('/api/connectors/aliyun'), '读取阿里云连接失败');
}

export async function connectAliyun(input: AliyunConnectInput): Promise<AliyunConnectionResponse> {
  const normalized = normalizeAliyunInput(input);
  await savePersonalCredential({
    connectorId: 'aliyun',
    secret: JSON.stringify({
      accessKeyId: normalized.accessKeyId,
      accessKeySecret: normalized.accessKeySecret,
      regionId: normalized.regionId,
    }),
    purpose: '阿里云 CLI 用户凭据',
    scopeSummary: { regionId: normalized.regionId, scopes: ['aliyun:*'] },
    rotateReason: '更新阿里云 CLI 用户凭据',
  });
  return fetchAliyunConnection();
}

export async function disconnectAliyun(): Promise<AliyunConnectionResponse> {
  await revokePersonalCredentials('aliyun', '用户主动断开阿里云');
  return fetchAliyunConnection();
}
