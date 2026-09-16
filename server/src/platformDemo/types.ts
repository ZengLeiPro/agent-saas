/** Platform demo mode — sample-data persona for selected org admins. */

export const PLATFORM_DEMO_CAPABILITY = 'platform_demo_access' as const;
export type PlatformDemoCapability = typeof PLATFORM_DEMO_CAPABILITY;

export type PlatformDemoActorPersona = 'platform_demo';
export type PlatformDemoAccessMode = 'platform_demo';

export interface PlatformDemoCapabilityGrant {
  tenantId: string;
  userId: string;
  capability: PlatformDemoCapability;
  grantedBy: string;
  grantedAt: string;
  revokedAt?: string;
  revokedBy?: string;
}

export interface PlatformDemoAccess {
  actorUserId: string;
  actorTenantId: string;
  actorPersona: PlatformDemoActorPersona;
  accessMode: PlatformDemoAccessMode;
  capability: PlatformDemoCapability;
}

export interface PlatformDemoSessionDraft {
  sessionKey: string;
  actorUserId: string;
  actorTenantId: string;
  sectionId: string;
  draft: Record<string, unknown>;
  updatedAt: string;
  expiresAt: string;
}

export interface PlatformDemoAnalyticsFixture {
  series: Array<{ date: string; requests: number; tokens: number; activeUsers: number }>;
  totals: { organizations: number; users: number; runs24h: number; errorRate: number };
}

export interface PlatformDemoConfigFixture {
  sectionId: string;
  label: string;
  shape: Record<string, unknown>;
}

export const PLATFORM_DEMO_BANNER =
  '演示模式 · 数据与操作为示例，不会影响平台' as const;

export const PLATFORM_DEMO_MENU_LABEL = '平台管理（演示）' as const;

/** Env / process flag; when explicitly "0"/"false", demo entry is disabled. */
export function isPlatformDemoFeatureEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const raw = env.PLATFORM_DEMO_MODE_ENABLED?.trim().toLowerCase();
  if (raw === '0' || raw === 'false' || raw === 'off') return false;
  return true;
}

export function platformDemoSessionKey(actorUserId: string, actorTenantId: string, sectionId: string): string {
  return `${actorTenantId}::${actorUserId}::${sectionId}`;
}
