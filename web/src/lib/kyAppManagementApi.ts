import { authFetch } from '@/lib/authFetch';

export class KyAppManagementError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public requestId: string,
    public retryable: boolean,
    public diagnosticReport?: unknown,
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
      body?.report,
    );
  // A disabled/misrouted API may return the SPA HTML with HTTP 200. Never
  // turn a parse failure (or a null/primitive payload) into a successful read.
  if (body === null || typeof body !== 'object' || Array.isArray(body))
    throw new KyAppManagementError(
      response.status,
      'invalid_response',
      '业务系统接口未返回有效 JSON 数据，请重试或联系管理员检查服务配置。',
      '',
      true,
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
  domainVerifiedAt?: string | null;
  deliveryStatus?: string | null;
  lastUsageAt?: string | null;
  updatedAt?: string | null;
}
export interface InstallationPage {
  installations: InstallationItem[];
  nextCursor: string | null;
}
