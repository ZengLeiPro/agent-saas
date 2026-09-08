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
  overrides: {
    registeredDigest?: string | null;
    runtime?: Record<string, unknown> | null;
    installationStatus?: 'pending' | 'enabled' | 'disabled';
    domainVerifiedAt?: string | null;
    observation?: Record<string, unknown> | null;
  } = {},
) {
  const current = {
    ...installation,
    status: overrides.installationStatus ?? 'enabled',
    domainVerifiedAt:
      'domainVerifiedAt' in overrides ? (overrides.domainVerifiedAt ?? null) : installation.domainVerifiedAt,
    registeredDigest: overrides.registeredDigest ?? null,
  };
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
    capabilityObservations: {
      get: vi.fn().mockResolvedValue(overrides.observation ?? null),
    } as never,
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

  it('pending 保持接入中并引导继续验证域名，而不是显示已停用', async () => {
    expect(
      await service({ installationStatus: 'pending', domainVerifiedAt: null }).listForUser(
        'tenant-1',
        'user-1',
      ),
    )
      .toMatchObject([
        {
          state: 'pending',
          pageStatus: 'not_configured',
          agentStatus: 'not_configured',
          reasonCode: 'domain_verification_required',
          nextAction: 'continue_onboarding',
        },
      ]);
  });

  it('技术门禁通过但尚无真实 /me 观测时不标记 Agent 可用', async () => {
    const runtime = {
      liveStatus: 'ok',
      readyStatus: 'ok',
      manifestDigest: digest,
      consecutiveFailures: 0,
      readyCheckedAt: '2026-09-08T01:00:00Z',
      liveCheckedAt: '2026-09-08T01:00:00Z',
    };
    expect(await service({ registeredDigest: digest, runtime }).listForUser('tenant-1', 'user-1'))
      .toMatchObject([
        {
          agentStatus: 'waiting_personal_authorization',
          personalAuthorizationStatus: 'pending',
          canUseAgent: false,
          reasonCode: 'me_not_verified',
        },
      ]);
  });

  it('真实会话 /me 观测到至少一个能力后才标记 Agent 可用', async () => {
    const runtime = {
      liveStatus: 'ok',
      readyStatus: 'ok',
      manifestDigest: digest,
      consecutiveFailures: 0,
      readyCheckedAt: '2026-09-08T01:00:00Z',
      liveCheckedAt: '2026-09-08T01:00:00Z',
    };
    expect(
      await service({
        registeredDigest: digest,
        runtime,
        observation: {
          tenantId: 'tenant-1',
          installationId: 'install-1',
          userId: 'user-1',
          registeredDigest: digest,
          status: 'ready',
          enabledCapabilityCount: 1,
          checkedAt: '2026-09-08T01:01:00Z',
        },
      }).listForUser('tenant-1', 'user-1'),
    ).toMatchObject([
      {
        pageStatus: 'available',
        agentStatus: 'ready',
        canOpenPage: true,
        canUseAgent: true,
        reasonCode: null,
        nextAction: 'none',
        personalAuthorizationStatus: 'connected',
      },
      ]);
  });

  it('/me 调用失败或未返回授权能力时均不标记 Agent 可用', async () => {
    const runtime = {
      liveStatus: 'ok',
      readyStatus: 'ok',
      manifestDigest: digest,
      consecutiveFailures: 0,
      readyCheckedAt: '2026-09-08T01:00:00Z',
      liveCheckedAt: '2026-09-08T01:00:00Z',
    };
    const unavailable = await service({
      registeredDigest: digest,
      runtime,
      observation: {
        registeredDigest: digest,
        status: 'unavailable',
        enabledCapabilityCount: 0,
      },
    }).listForUser('tenant-1', 'user-1');
    expect(unavailable).toMatchObject([
      {
        agentStatus: 'degraded',
        personalAuthorizationStatus: 'pending',
        canUseAgent: false,
        reasonCode: 'me_unavailable',
      },
    ]);

    const notProjected = await service({
      registeredDigest: digest,
      runtime,
      observation: {
        registeredDigest: digest,
        status: 'not_projected',
        enabledCapabilityCount: 0,
      },
    }).listForUser('tenant-1', 'user-1');
    expect(notProjected).toMatchObject([
      {
        agentStatus: 'waiting_personal_authorization',
        personalAuthorizationStatus: 'pending',
        canUseAgent: false,
        reasonCode: 'me_no_projected_capabilities',
      },
    ]);
  });
});
