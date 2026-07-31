import { authFetch } from './authFetch';
import type { GithubConnectionResponse } from '../types/connectors';

type ApiErrorBody = { error?: string };

async function jsonOrError(res: Response, fallback: string): Promise<GithubConnectionResponse> {
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as ApiErrorBody;
    throw new Error(body.error || `${fallback}: ${res.status}`);
  }
  return res.json() as Promise<GithubConnectionResponse>;
}

export async function fetchGithubConnection(): Promise<GithubConnectionResponse> {
  return jsonOrError(await authFetch('/api/connectors/github'), '读取 GitHub 连接失败');
}

export async function connectGithub(input: {
  token: string;
  mcpEnabled?: boolean;
}): Promise<GithubConnectionResponse> {
  return jsonOrError(await authFetch('/api/connectors/github', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  }), '连接 GitHub 失败');
}

export async function updateGithubCapabilities(mcpEnabled: boolean): Promise<GithubConnectionResponse> {
  return jsonOrError(await authFetch('/api/connectors/github', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mcpEnabled }),
  }), '更新 GitHub 能力失败');
}

export async function disconnectGithub(): Promise<GithubConnectionResponse> {
  return jsonOrError(await authFetch('/api/connectors/github', { method: 'DELETE' }), '断开 GitHub 失败');
}
