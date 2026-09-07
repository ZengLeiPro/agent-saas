import { authFetch } from '@/lib/authFetch';

export class KyAppManagementError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public requestId: string,
    public retryable: boolean,
  ) {
    super(message);
  }
}
export async function kyAppRequest<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await authFetch(`/api/app-contract/v1${path}`, {
    ...options,
    cache: 'no-store',
    headers: { 'Content-Type': 'application/json', ...options.headers },
  });
  const body = await response.json().catch(() => null);
  if (!response.ok)
    throw new KyAppManagementError(
      response.status,
      body?.error?.code ?? 'unknown',
      body?.error?.message ?? `请求失败 (${response.status})`,
      body?.error?.requestId ?? '',
      body?.error?.retryable === true,
    );
  return body as T;
}
export const kyAppPost = <T>(path: string, body: unknown = {}) =>
  kyAppRequest<T>(path, { method: 'POST', body: JSON.stringify(body) });
export const installationPath = (id: string, suffix = '') =>
  `/installations/${encodeURIComponent(id)}${suffix}`;
export interface SystemDefinition {
  systemId: string;
  name: string;
  status: string;
  version: number;
  publishedDigest: string | null;
  allowedActions?: string[];
}
export interface InstallationItem {
  installationId: string;
  tenantId: string;
  systemId: string;
  systemName: string;
  status: string;
  runtimeStatus: string;
  registeredDigest: string | null;
  publishedDigest: string | null;
  allowedActions?: string[];
}
export interface InstallationPage {
  installations: InstallationItem[];
  nextCursor: string | null;
}
