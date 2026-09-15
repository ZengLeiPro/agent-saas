import { describe, expect, it, vi } from 'vitest';

import { buildManifest, PLATFORM_ADMIN, TEST_SYSTEM } from '../__tests__/harness.js';
import { resolveKyAppConfig } from '../config.js';
import { KyAppInstallationError } from '../installations/service.js';
import { KyAppExistingOnboardService } from './existingOnboard.js';
import type { KyAppOnboardExecution } from './store.js';

describe('KyAppExistingOnboardService V2', () => {
  it('DNS 完成后恢复到自动授权入口且不签发旧凭据', async () => {
    const tenantId = 'tenant-v2';
    const digest = 'a'.repeat(64);
    const issue = vi.fn();
    let dnsVerified = false;
    let execution: KyAppOnboardExecution | null = null;
    let installation: Record<string, unknown> | null = null;

    const service = new KyAppExistingOnboardService({
      config: resolveKyAppConfig({ kyApp: { environment: 'staging' } })!,
      useV2: () => true,
      store: {
        withExecutionLock: async (_identity: string, operation: () => Promise<unknown>) =>
          operation(),
        get: async () => execution,
        createOrResume: async (input: {
          tenantId: string;
          systemId: string;
          installationId: string;
          requestDigest: string;
          request: Record<string, unknown>;
        }) => {
          if (!execution) {
            execution = {
              executionId: 'onboard-v2',
              ...input,
              status: 'running',
              currentStep: 'existing_organization',
              steps: [],
              result: {},
              lastErrorCode: null,
              createdAt: '2026-09-15T00:00:00.000Z',
              updatedAt: '2026-09-15T00:00:00.000Z',
              completedAt: null,
            };
          }
          return { execution, created: false };
        },
        update: async (input: Partial<KyAppOnboardExecution>) => {
          execution = { ...execution!, ...input };
          return execution;
        },
      },
      settings: {
        get: async () => ({
          version: 1,
          settings: {
            baseUrl: 'https://{tenantId}.apps.kaiyancn.com',
            origin: 'https://{tenantId}.apps.kaiyancn.com',
          },
        }),
      },
      tenants: {
        findByIdStrict: (id: string) =>
          id === tenantId ? { id, name: 'V2 测试组织', disabled: false } : undefined,
        listAllStrict: () => [{ id: tenantId, name: 'V2 测试组织', disabled: false }],
      },
      users: {
        findById: (id: string) =>
          id === 'contact'
            ? { id, tenantId, username: 'contact', realName: '技术联系人', disabled: false }
            : undefined,
      },
      memberships: {
        getMembership: async () => ({
          tenantId,
          userId: 'contact',
          status: 'active',
          persona: 'org_admin',
          isOwner: true,
        }),
      },
      systems: {
        getDefinition: async () => ({
          systemId: TEST_SYSTEM,
          status: 'published',
          publishedDigest: digest,
        }),
        getVersion: async () => ({ status: 'published', manifest: buildManifest() }),
        listInstallationsForTenant: async () => (installation ? [installation] : []),
        getInstallation: async () => installation,
      },
      installations: {
        create: async (request: Record<string, unknown>) => {
          installation = {
            installationId: request.installationId,
            tenantId,
            systemId: TEST_SYSTEM,
            techContactUserId: 'contact',
            baseUrl: request.baseUrl,
            origin: request.origin,
            status: 'pending',
            domainVerificationToken: 'dns-token',
          };
          return installation;
        },
        probeDomainOwnership: async () => ({ verified: dnsVerified }),
        verifyDomain: async () => {
          if (!dnsVerified)
            throw new KyAppInstallationError(
              'DNS TXT 未包含当前实例的验证令牌',
              'domain_verification_failed',
            );
          installation = {
            ...installation!,
            domainVerifiedAt: '2026-09-15T00:01:00.000Z',
          };
          return { installation };
        },
      },
      credentials: { listMetadata: async () => [], issue },
    } as never);

    const initial = await service.start(
      {
        systemId: TEST_SYSTEM,
        tenantId,
        techContactUserId: 'contact',
        expectedSettingsVersion: 1,
        expectedDigest: digest,
      },
      PLATFORM_ADMIN,
    );
    expect(initial.execution.lastErrorCode).toBe('domain_verification_required');

    dnsVerified = true;
    const resumed = await service.resume(initial.execution.executionId, PLATFORM_ADMIN);
    expect(resumed.execution.lastErrorCode).toBe('authorization_required');
    expect(resumed.authorization).toEqual({
      path: `/ky-app/credential-claim/${resumed.execution.installationId}`,
      installationId: resumed.execution.installationId,
    });
    expect(issue).not.toHaveBeenCalled();
  });
});
