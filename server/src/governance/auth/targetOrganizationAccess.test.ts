import type { Request } from 'express';
import { describe, expect, it, vi } from 'vitest';

import { resolveTargetOrganizationAccess } from './targetOrganizationAccess.js';

const request = (overrides: Partial<NonNullable<Request['user']>> = {}) =>
  ({
    user: { sub: 'actor-1', username: 'actor', role: 'admin', tenantId: 'tenant-a', ...overrides },
  }) as Request;

describe('resolveTargetOrganizationAccess', () => {
  it('allows an active platform administrator to manage an explicit customer tenant without Membership lookup', async () => {
    const getMembership = vi.fn();
    await expect(
      resolveTargetOrganizationAccess(request({ tenantId: 'pantheon' }), 'tenant-b', 'manage', {
        memberships: {
          getPlatformAdmin: vi.fn().mockResolvedValue({ userId: 'actor-1', status: 'active' }),
          getMembership,
        } as never,
        tenantExists: (tenantId) => tenantId === 'tenant-b',
      }),
    ).resolves.toMatchObject({
      actorPersona: 'platform_admin',
      targetTenantId: 'tenant-b',
      accessMode: 'platform_manage',
    });
    expect(getMembership).not.toHaveBeenCalled();
  });

  it('requires an explicit target tenant from platform administrators', async () => {
    await expect(
      resolveTargetOrganizationAccess(request({ tenantId: 'pantheon' }), undefined, 'read', {
        memberships: {
          getPlatformAdmin: vi.fn().mockResolvedValue({ userId: 'actor-1', status: 'active' }),
          getMembership: vi.fn(),
        } as never,
      }),
    ).rejects.toMatchObject({ code: 'TARGET_TENANT_REQUIRED' });
  });

  it('keeps organization administrators in their own active organization', async () => {
    const authorities = {
      memberships: {
        getPlatformAdmin: vi.fn().mockResolvedValue(null),
        getMembership: vi.fn().mockResolvedValue({
          tenantId: 'tenant-a',
          userId: 'actor-1',
          persona: 'org_admin',
          status: 'active',
        }),
      } as never,
    };
    await expect(
      resolveTargetOrganizationAccess(request(), undefined, 'manage', authorities),
    ).resolves.toMatchObject({ accessMode: 'organization_manage', targetTenantId: 'tenant-a' });
    await expect(
      resolveTargetOrganizationAccess(request(), 'tenant-b', 'read', authorities),
    ).rejects.toMatchObject({ code: 'TARGET_ORGANIZATION_FORBIDDEN' });
  });

  it('only grants effective reads to ordinary members', async () => {
    const authorities = {
      memberships: {
        getPlatformAdmin: vi.fn().mockResolvedValue(null),
        getMembership: vi.fn().mockResolvedValue({
          tenantId: 'tenant-a',
          userId: 'actor-1',
          persona: 'member',
          status: 'active',
        }),
      } as never,
    };
    await expect(
      resolveTargetOrganizationAccess(request({ role: 'user' }), undefined, 'read', authorities),
    ).resolves.toMatchObject({ accessMode: 'effective_only' });
    await expect(
      resolveTargetOrganizationAccess(request({ role: 'user' }), undefined, 'manage', authorities),
    ).rejects.toMatchObject({ code: 'TARGET_ORGANIZATION_FORBIDDEN' });
  });
});
