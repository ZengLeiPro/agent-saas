import { authFetch } from './authFetch.js';

export const PLATFORM_DEMO_BANNER = '演示模式 · 数据与操作为示例，不会影响平台';
export const PLATFORM_DEMO_MENU_LABEL = '平台管理（演示）';

export interface PlatformDemoAccessResponse {
  allowed: boolean;
  featureEnabled: boolean;
  reasonCode: string;
  banner: string;
  menuLabel: string;
  actorPersona?: 'platform_demo';
  accessMode?: 'platform_demo';
}

export interface PlatformDemoAnalyticsResponse {
  source: 'fixture';
  banner: string;
  analytics: {
    series: Array<{ date: string; requests: number; tokens: number; activeUsers: number }>;
    totals: { organizations: number; users: number; runs24h: number; errorRate: number };
  };
}

export interface PlatformDemoConfigSection {
  sectionId: string;
  label: string;
  shape: Record<string, unknown>;
}

export interface PlatformDemoConfigResponse {
  source: 'fixture';
  banner: string;
  section: PlatformDemoConfigSection;
  draft: Record<string, unknown> | null;
  draftUpdatedAt: string | null;
  draftExpiresAt: string | null;
}

export interface PlatformDemoSaveResponse {
  ok: true;
  source: 'demo_session';
  banner: string;
  sectionId: string;
  draft: Record<string, unknown>;
  updatedAt: string;
  expiresAt: string;
  affectsProduction: false;
}

async function readJson<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as
      | { error?: unknown; code?: unknown }
      | null;
    const error = new Error(
      typeof body?.error === 'string' ? body.error : `Platform demo request failed (${response.status})`,
    ) as Error & { status?: number; code?: string };
    error.status = response.status;
    if (typeof body?.code === 'string') error.code = body.code;
    throw error;
  }
  return response.json() as Promise<T>;
}

export async function fetchPlatformDemoAccess(): Promise<PlatformDemoAccessResponse> {
  const response = await authFetch('/api/platform-demo/access');
  return readJson(response);
}

export async function enterPlatformDemo(): Promise<{ ok: true; banner: string }> {
  const response = await authFetch('/api/platform-demo/enter', { method: 'POST' });
  return readJson(response);
}

export async function fetchPlatformDemoAnalytics(): Promise<PlatformDemoAnalyticsResponse> {
  const response = await authFetch('/api/platform-demo/analytics');
  return readJson(response);
}

export async function fetchPlatformDemoConfig(sectionId: string): Promise<PlatformDemoConfigResponse> {
  const response = await authFetch(`/api/platform-demo/config/${encodeURIComponent(sectionId)}`);
  return readJson(response);
}

export async function savePlatformDemoConfig(
  sectionId: string,
  draft: Record<string, unknown>,
): Promise<PlatformDemoSaveResponse> {
  const response = await authFetch(`/api/platform-demo/config/${encodeURIComponent(sectionId)}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ draft }),
  });
  return readJson(response);
}

export interface PlatformDemoCapabilityGrant {
  tenantId: string;
  userId: string;
  capability: 'platform_demo_access';
  grantedBy: string;
  grantedAt: string;
  revokedAt?: string;
  revokedBy?: string;
}

export interface PlatformDemoGrantCandidate {
  tenantId: string;
  userId: string;
  persona: 'org_admin';
  isOwner: boolean;
  status: 'active' | 'disabled';
}

export interface PlatformDemoGrantsResponse {
  grants: PlatformDemoCapabilityGrant[];
  featureEnabled: boolean;
  featureFlag: {
    envVar: string;
    hardOffWhenFalse: boolean;
    managedInPanel: boolean;
    description: string;
  };
}

export async function fetchPlatformDemoGrants(tenantId?: string): Promise<PlatformDemoGrantsResponse> {
  const query = tenantId ? `?tenantId=${encodeURIComponent(tenantId)}` : '';
  const response = await authFetch(`/api/platform-demo/grants${query}`);
  return readJson(response);
}

export async function fetchPlatformDemoGrantCandidates(
  tenantId: string,
): Promise<{ tenantId: string; candidates: PlatformDemoGrantCandidate[] }> {
  const response = await authFetch(
    `/api/platform-demo/grants/candidates?tenantId=${encodeURIComponent(tenantId)}`,
  );
  return readJson(response);
}

export async function grantPlatformDemoAccess(
  tenantId: string,
  userId: string,
): Promise<{ grant: PlatformDemoCapabilityGrant }> {
  const response = await authFetch('/api/platform-demo/grants', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tenantId, userId }),
  });
  return readJson(response);
}

export async function revokePlatformDemoAccess(
  tenantId: string,
  userId: string,
): Promise<{ grant: PlatformDemoCapabilityGrant }> {
  const response = await authFetch('/api/platform-demo/grants', {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tenantId, userId }),
  });
  return readJson(response);
}
