import { describe, expect, it, vi } from 'vitest';

import { EXAMPLE_MANIFEST, type Manifest } from '@kaiyan/ky-app-contract';

import { KyAppOnboardService } from './onboard.js';
import type { KyAppOnboardExecution } from './store.js';

const manifest = {
  ...EXAMPLE_MANIFEST,
  systemId: 'orders',
  name: '订单系统',
} as unknown as Manifest;

function initialExecution(): KyAppOnboardExecution {
  return {
    executionId: 'onb-1',
    tenantId: 'tenant-a',
    systemId: 'orders',
    installationId: 'iid-1',
    requestDigest: 'digest',
    request: {},
    status: 'running',
    currentStep: 'tenant_admin',
    steps: [],
    result: {},
    lastErrorCode: null,
    createdAt: '2026-09-07T00:00:00.000Z',
    updatedAt: '2026-09-07T00:00:00.000Z',
    completedAt: null,
  };
}

function request() {
  return {
    tenantId: 'tenant-a',
    tenantName: '甲公司',
    adminName: '管理员',
    adminPhone: '13800000000',
    techContactPhone: '13800000000',
    systemId: 'orders',
    installationId: 'iid-1',
    baseUrl: 'https://orders.apps.kaiyancn.com',
    origin: 'https://orders.apps.kaiyancn.com',
    grantCredits: 2_000,
    manifest,
    members: [],
    diagnostic: { readOnlyCapabilityId: 'order.search', readOnlyInput: {} },
  };
}

describe('KyAppOnboardService', () => {
  it('首次执行持久化到凭据领取等待点，领取票据不写入耐久结果', async () => {
    let execution = initialExecution();
    let pendingCredential = false;
    const adjustAccount = vi.fn().mockResolvedValue({});
    const issue = vi.fn().mockImplementation(async () => {
      pendingCredential = true;
      return {
        credentialId: 'cred-1',
        ticket: 'one-time-ticket',
        ticketExpiresAt: '2026-09-07T01:00:00.000Z',
        ackDeadlineAt: '2026-09-07T02:00:00.000Z',
      };
    });
    const installation = {
      installationId: 'iid-1',
      tenantId: 'tenant-a',
      systemId: 'orders',
      baseUrl: 'https://orders.apps.kaiyancn.com',
      origin: 'https://orders.apps.kaiyancn.com',
      techContactUserId: 'admin-1',
      status: 'pending',
      stateVersion: 1,
      domainVerificationToken: 'dns-token',
    };
    const service = new KyAppOnboardService({
      store: {
        withExecutionLock: async (_identity: string, operation: () => Promise<unknown>) =>
          operation(),
        createOrResume: async () => ({ execution, created: true }),
        update: async (input: Partial<KyAppOnboardExecution>) => {
          execution = { ...execution, ...input };
          return execution;
        },
      },
      tenants: { findByIdStrict: () => ({ id: 'tenant-a', name: '甲公司' }) },
      users: {
        findAllByPhone: () => [
          { id: 'admin-1', tenantId: 'tenant-a', disabled: false, username: '13800000000' },
        ],
      },
      memberships: {
        getMembership: async () => ({
          tenantId: 'tenant-a',
          userId: 'admin-1',
          persona: 'org_admin',
          isOwner: true,
          status: 'active',
          version: 1,
        }),
      },
      systems: {
        getDefinition: async () => null,
        registerVersion: async () => ({
          version: { digest: 'manifest-digest', status: 'published' },
        }),
        getInstallation: async () => null,
      },
      installations: { create: async () => installation },
      credentials: {
        listRotationDue: async () => [],
        listMetadata: async () =>
          pendingCredential
            ? [
                {
                  credentialId: 'cred-1',
                  status: 'pending_ack',
                  ackDeadlineAt: '2026-09-07T02:00:00.000Z',
                },
              ]
            : [],
        issue,
      },
      runtimeStore: {},
      memberImporter: {},
      billing: { adjustAccount },
      sharedDir: '/tmp/not-used',
    } as never);

    const first = await service.run(request(), {
      sub: 'platform-1',
      tenantId: 'pantheon',
      role: 'admin',
    });
    expect(first.execution).toMatchObject({
      status: 'waiting_external',
      currentStep: 'installation_credential',
      lastErrorCode: 'credential_claim_required',
    });
    expect(first.claim?.path).toContain('one-time-ticket');
    expect(JSON.stringify(first.execution)).not.toContain('one-time-ticket');
    expect(adjustAccount).toHaveBeenCalledWith(
      expect.objectContaining({
        creditsDelta: 2_000,
        idempotencyKey: 'ky-app:onboard:iid-1:grant',
      }),
    );

    const resumed = await service.run(request(), {
      sub: 'platform-1',
      tenantId: 'pantheon',
      role: 'admin',
    });
    expect(resumed.execution.lastErrorCode).toBe('credential_ack_required');
    expect(issue).toHaveBeenCalledTimes(1);
    expect(adjustAccount).toHaveBeenCalledTimes(2);
    expect(adjustAccount.mock.calls[0]?.[0].idempotencyKey).toBe(
      adjustAccount.mock.calls[1]?.[0].idempotencyKey,
    );
  });

  it('manifest 与系统不一致时在任何耐久写入前拒绝', async () => {
    const createOrResume = vi.fn();
    const service = new KyAppOnboardService({
      store: {
        withExecutionLock: async (_identity: string, operation: () => Promise<unknown>) =>
          operation(),
        createOrResume,
      },
    } as never);
    await expect(
      service.run(
        { ...request(), manifest: { ...manifest, systemId: 'another' } as Manifest },
        { sub: 'platform-1', tenantId: 'pantheon', role: 'admin' },
      ),
    ).rejects.toMatchObject({ name: 'KyAppOnboardConflictError' });
    expect(createOrResume).not.toHaveBeenCalled();
  });
});
