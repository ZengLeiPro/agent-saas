import { authFetch } from './authFetch';
import type {
  GithubConnectionResponse,
  GoogleWorkspaceConnectionResponse,
  GoogleWorkspaceOAuthStartResponse,
  NotionAuthSessionResponse,
  NotionConnectionResponse,
} from '../types/connectors';

async function jsonOrError<T>(res: Response, fallback: string): Promise<T> {
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { error?: string };
    throw new Error(body.error || fallback);
  }
  return res.json() as Promise<T>;
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

export async function disconnectNotion(): Promise<void> {
  const res = await authFetch('/api/connectors/notion', { method: 'DELETE' });
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { error?: string };
    throw new Error(body.error || 'Notion 断开失败');
  }
}

export async function fetchGoogleWorkspaceConnection(): Promise<GoogleWorkspaceConnectionResponse> {
  return jsonOrError(
    await authFetch('/api/connectors/google-workspace'),
    '读取 Google Workspace 连接失败',
  );
}

export async function startGoogleWorkspaceOAuth(): Promise<GoogleWorkspaceOAuthStartResponse> {
  return jsonOrError(await authFetch('/api/connectors/google-workspace/oauth/start', {
    method: 'POST',
  }), '启动 Google Workspace 授权失败');
}

export async function disconnectGoogleWorkspace(): Promise<void> {
  const res = await authFetch('/api/connectors/google-workspace', { method: 'DELETE' });
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { error?: string };
    throw new Error(body.error || 'Google Workspace 断开失败');
  }
}
