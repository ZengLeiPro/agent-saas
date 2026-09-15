import { describe, expect, it, vi } from 'vitest';

import { PLATFORM_ADMIN, TEST_SYSTEM } from '../__tests__/harness.js';
import { resolveKyAppConfig } from '../config.js';
import type { KyAppInstallation } from '../systems/types.js';
import { assertBaseUrl, KyAppInstallationService } from './service.js';

const verifiedAt = '2026-09-15T00:00:00.000Z';

function installation(
  patch: Partial<KyAppInstallation> & Pick<KyAppInstallation, 'installationId'>,
): KyAppInstallation {
  const { installationId, ...overrides } = patch;
  return {
    installationId,
    tenantId: 'tenant-current',
    systemId: TEST_SYSTEM,
    baseUrl: 'https://shared.apps.kaiyancn.com',
    origin: 'https://shared.apps.kaiyancn.com',
    techContactUserId: 'contact',
    status: 'pending',
    domainVerificationToken: 'current-token',
    domainVerifiedAt: null,
    registeredDigest: null,
    stateVersion: 1,
    createdAt: verifiedAt,
    createdBy: PLATFORM_ADMIN.sub,
    updatedAt: verifiedAt,
    updatedBy: PLATFORM_ADMIN.sub,
    ...overrides,
  };
}

describe('assertBaseUrl', () => {
  it('第一期生产只接受公司控制的应用子域', () => {
    const config = resolveKyAppConfig({ kyApp: { environment: 'prod' } });
    if (!config) throw new Error('测试配置缺失');
    expect(() => assertBaseUrl('https://demo.apps.kaiyancn.com', config)).not.toThrow();
    expect(() => assertBaseUrl('https://apps.kaiyancn.com', config)).toThrow(/\*/u);
    expect(() => assertBaseUrl('https://erp.customer.example', config)).toThrow(/kaiyancn/u);
  });

  it('本地测试仍可使用回环地址', () => {
    const config = resolveKyAppConfig({
      kyApp: {
        environment: 'local',
        publicIssuer: 'http://127.0.0.1:4001',
        allowInsecureOutbound: true,
      },
    });
    if (!config) throw new Error('测试配置缺失');
    expect(() => assertBaseUrl('http://127.0.0.1:4002', config)).not.toThrow();
  });
});

describe('KyAppInstallationService 域名验证复用', () => {
  function rig(
    dnsValues: string[],
    currentPatch: Omit<Partial<KyAppInstallation>, 'installationId'> = {},
  ) {
    const current = installation({ installationId: 'installation-current', ...currentPatch });
    const markDomainVerified = vi.fn(async () => ({
      ...current,
      domainVerifiedAt: verifiedAt,
    }));
    const resolveTxt = vi.fn(async () => dnsValues.map((value) => [value]));
    const service = new KyAppInstallationService({
      config: resolveKyAppConfig({ kyApp: { environment: 'staging' } })!,
      systems: {
        getInstallation: vi.fn(async () => current),
        markDomainVerified,
      } as never,
      events: { enqueue: vi.fn() } as never,
      audit: {
        append: vi.fn(async (event) => ({ ...event, auditId: 'audit-event' })),
      } as never,
      resolveTxt,
    });
    return { service, markDomainVerified, resolveTxt };
  }

  it('同一系统和 hostname 的历史验证仍通过实时 DNS 复验时可复用', async () => {
    const donor = installation({
      installationId: 'installation-donor',
      tenantId: 'tenant-donor',
      status: 'enabled',
      domainVerificationToken: 'donor-token',
      domainVerifiedAt: verifiedAt,
    });
    const { service, markDomainVerified, resolveTxt } = rig(['donor-token']);

    const result = await service.verifyDomain('installation-current', PLATFORM_ADMIN, [donor]);

    expect(result.installation.domainVerifiedAt).toBe(verifiedAt);
    expect(result.result.detail).toBe('同一业务系统的相同域名已通过实时归属复验');
    expect(markDomainVerified).toHaveBeenCalledWith('installation-current', PLATFORM_ADMIN.sub);
    expect(resolveTxt).toHaveBeenCalledTimes(2);
  });

  it('历史实例缺少自己的令牌时仍可使用同系统同域名的有效证明', async () => {
    const donor = installation({
      installationId: 'installation-donor',
      tenantId: 'tenant-donor',
      status: 'enabled',
      domainVerificationToken: 'donor-token',
      domainVerifiedAt: verifiedAt,
    });
    const { service, markDomainVerified, resolveTxt } = rig(['donor-token'], {
      domainVerificationToken: null,
    });

    const result = await service.verifyDomain('installation-current', PLATFORM_ADMIN, [donor]);

    expect(result.installation.domainVerifiedAt).toBe(verifiedAt);
    expect(markDomainVerified).toHaveBeenCalledOnce();
    expect(resolveTxt).toHaveBeenCalledTimes(1);
  });

  it('不同系统、不同 hostname、未验证、已删除或 DNS 已失效的事实都不能复用', async () => {
    const candidates = [
      installation({
        installationId: 'wrong-system',
        systemId: 'other-system',
        domainVerificationToken: 'wrong-system-token',
        domainVerifiedAt: verifiedAt,
      }),
      installation({
        installationId: 'wrong-host',
        baseUrl: 'https://other.apps.kaiyancn.com',
        origin: 'https://other.apps.kaiyancn.com',
        domainVerificationToken: 'wrong-host-token',
        domainVerifiedAt: verifiedAt,
      }),
      installation({
        installationId: 'unverified',
        domainVerificationToken: 'unverified-token',
        domainVerifiedAt: null,
      }),
      installation({
        installationId: 'deleted',
        status: 'deleted',
        domainVerificationToken: 'deleted-token',
        domainVerifiedAt: verifiedAt,
      }),
      installation({
        installationId: 'stale-proof',
        status: 'enabled',
        domainVerificationToken: 'stale-token',
        domainVerifiedAt: verifiedAt,
      }),
    ];
    const { service, markDomainVerified } = rig([
      'wrong-system-token',
      'wrong-host-token',
      'unverified-token',
      'deleted-token',
    ]);

    await expect(
      service.verifyDomain('installation-current', PLATFORM_ADMIN, candidates),
    ).rejects.toMatchObject({ code: 'domain_verification_failed' });
    expect(markDomainVerified).not.toHaveBeenCalled();
  });
});
