import type { PlatformDemoCapability, PlatformDemoCapabilityGrant } from './types.js';
import { PLATFORM_DEMO_CAPABILITY } from './types.js';

export interface PlatformDemoCapabilityStore {
  getGrant(tenantId: string, userId: string, capability?: PlatformDemoCapability): Promise<PlatformDemoCapabilityGrant | null>;
  listGrants(tenantId: string): Promise<PlatformDemoCapabilityGrant[]>;
  grant(input: {
    tenantId: string;
    userId: string;
    grantedBy: string;
    capability?: PlatformDemoCapability;
    now?: Date;
  }): Promise<PlatformDemoCapabilityGrant>;
  revoke(input: {
    tenantId: string;
    userId: string;
    revokedBy: string;
    capability?: PlatformDemoCapability;
    now?: Date;
  }): Promise<PlatformDemoCapabilityGrant | null>;
}

function grantKey(tenantId: string, userId: string, capability: PlatformDemoCapability): string {
  return `${tenantId}::${userId}::${capability}`;
}

/** Process-local grants — sufficient for demo drafts and unit tests; optional PG later. */
export class InMemoryPlatformDemoCapabilityStore implements PlatformDemoCapabilityStore {
  private readonly grants = new Map<string, PlatformDemoCapabilityGrant>();

  async getGrant(
    tenantId: string,
    userId: string,
    capability: PlatformDemoCapability = PLATFORM_DEMO_CAPABILITY,
  ): Promise<PlatformDemoCapabilityGrant | null> {
    const grant = this.grants.get(grantKey(tenantId, userId, capability));
    if (!grant || grant.revokedAt) return null;
    return { ...grant };
  }

  async listGrants(tenantId: string): Promise<PlatformDemoCapabilityGrant[]> {
    return [...this.grants.values()]
      .filter((grant) => grant.tenantId === tenantId && !grant.revokedAt)
      .map((grant) => ({ ...grant }))
      .sort((a, b) => a.userId.localeCompare(b.userId));
  }

  async grant(input: {
    tenantId: string;
    userId: string;
    grantedBy: string;
    capability?: PlatformDemoCapability;
    now?: Date;
  }): Promise<PlatformDemoCapabilityGrant> {
    const capability = input.capability ?? PLATFORM_DEMO_CAPABILITY;
    const now = (input.now ?? new Date()).toISOString();
    const next: PlatformDemoCapabilityGrant = {
      tenantId: input.tenantId,
      userId: input.userId,
      capability,
      grantedBy: input.grantedBy,
      grantedAt: now,
    };
    this.grants.set(grantKey(input.tenantId, input.userId, capability), next);
    return { ...next };
  }

  async revoke(input: {
    tenantId: string;
    userId: string;
    revokedBy: string;
    capability?: PlatformDemoCapability;
    now?: Date;
  }): Promise<PlatformDemoCapabilityGrant | null> {
    const capability = input.capability ?? PLATFORM_DEMO_CAPABILITY;
    const key = grantKey(input.tenantId, input.userId, capability);
    const current = this.grants.get(key);
    if (!current || current.revokedAt) return null;
    const next: PlatformDemoCapabilityGrant = {
      ...current,
      revokedAt: (input.now ?? new Date()).toISOString(),
      revokedBy: input.revokedBy,
    };
    this.grants.set(key, next);
    return { ...next };
  }
}
