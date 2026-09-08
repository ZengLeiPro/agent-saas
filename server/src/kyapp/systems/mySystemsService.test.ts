import { describe, expect, it, vi } from 'vitest';
import { MySystemsService } from './mySystemsService.js';

const digest = 'a'.repeat(64);
const installation = {
  installationId: 'install-1',
  tenantId: 'tenant-1',
  systemId: 'erp',
  baseUrl: 'https://api.example.com',
  origin: 'https://app.example.com',
  techContactUserId: 'tech',
  status: 'enabled',
  domainVerificationToken: null,
  domainVerifiedAt: '2026-09-08T00:00:00Z',
  registeredDigest: null,
  stateVersion: 1,
  createdAt: '',
  createdBy: '',
  updatedAt: '',
  updatedBy: '',
} as const;
const definition = {
  systemId: 'erp',
  name: 'ERP',
  status: 'published',
  publishedDigest: digest,
  version: 1,
  createdAt: '',
  createdBy: '',
  updatedAt: '',
  updatedBy: '',
} as const;

function service(
  overrides: { registeredDigest?: string | null; runtime?: Record<string, unknown> | null } = {},
) {
  const current = { ...installation, registeredDigest: overrides.registeredDigest ?? null };
  return new MySystemsService({
    systems: {
      listInstallationsForTenant: vi.fn().mockResolvedValue([current]),
      getDefinition: vi.fn().mockResolvedValue(definition),
      getVersion: vi.fn().mockResolvedValue({
        manifest: { name: '演示 ERP', externalLinkHosts: ['DOCS.EXAMPLE.COM'] },
      }),
    } as never,
    assignments: {
      listEffectiveResourceIds: vi.fn().mockResolvedValue([{ resourceId: 'install-1' }]),
    } as never,
    runtimeStore: { get: vi.fn().mockResolvedValue(overrides.runtime ?? null) } as never,
  });
}

describe('MySystemsService', () => {
  it('已分配但未登记版本时页面可开，Agent 能力保持关闭并给出下一步', async () => {
    expect(await service().listForUser('tenant-1', 'user-1')).toMatchObject([
      {
        name: '演示 ERP',
        pageStatus: 'available',
        agentStatus: 'waiting_service',
        canOpenPage: true,
        canUseAgent: false,
        reasonCode: 'ready_required',
        nextAction: 'continue_onboarding',
        externalLinkHosts: ['docs.example.com'],
      },
    ]);
  });

  it('登记版本、live/ready 和 digest 一致后才标记 Agent 可用', async () => {
    const runtime = {
      liveStatus: 'ok',
      readyStatus: 'ok',
      manifestDigest: digest,
      consecutiveFailures: 0,
      readyCheckedAt: '2026-09-08T01:00:00Z',
      liveCheckedAt: '2026-09-08T01:00:00Z',
    };
    expect(
      await service({ registeredDigest: digest, runtime }).listForUser('tenant-1', 'user-1'),
    ).toMatchObject([
      {
        pageStatus: 'available',
        agentStatus: 'ready',
        canOpenPage: true,
        canUseAgent: true,
        reasonCode: null,
        nextAction: 'none',
      },
    ]);
  });
});
