import { describe, expect, it } from 'vitest';

import type { KyAppInstallation } from '../systems/types.js';
import type { KyAppInstallationRuntimeRecord } from './runtimeStore.js';
import { installationReadiness } from './readiness.js';

const installation: KyAppInstallation = {
  installationId: 'install-demo',
  tenantId: 'tenant-a',
  systemId: 'demo',
  baseUrl: 'https://api.example.com',
  origin: 'https://app.example.com',
  techContactUserId: 'u1',
  status: 'enabled',
  domainVerificationToken: null,
  domainVerifiedAt: '2026-09-08T00:00:00.000Z',
  registeredDigest: 'digest-a',
  stateVersion: 3,
  createdAt: '2026-09-08T00:00:00.000Z',
  createdBy: 'u1',
  updatedAt: '2026-09-08T00:00:00.000Z',
  updatedBy: 'u1',
};

const runtime: KyAppInstallationRuntimeRecord = {
  installationId: installation.installationId,
  liveStatus: 'ok',
  liveCheckedAt: '2026-09-08T01:00:00.000Z',
  readyStatus: 'ok',
  readyCheckedAt: '2026-09-08T01:00:00.000Z',
  manifestDigest: 'digest-a',
  contractVersion: 1,
  appVersion: '1.0.0',
  directoryCheckpoint: null,
  directoryAgeSeconds: null,
  jwksKids: [],
  consecutiveFailures: 0,
  lastError: null,
  alertedAt: null,
  updatedAt: '2026-09-08T01:00:00.000Z',
};

describe('installationReadiness', () => {
  it('pending 首次接入按真实步骤推进，不归类为已停用', () => {
    expect(
      installationReadiness({
        installation: { ...installation, status: 'pending', domainVerifiedAt: null },
        publishedDigest: 'digest-a',
        runtime: null,
        assignmentConfigured: false,
      }),
    ).toMatchObject({
      overallStatus: 'action_required',
      pageStatus: 'not_configured',
      agentStatus: 'not_configured',
      currentStep: 'domain_verification',
      reasonCode: 'domain_verification_required',
      nextAction: '验证业务域名',
    });
  });

  it('pending 完成技术与授权门禁后才提示启用', () => {
    expect(
      installationReadiness({
        installation: { ...installation, status: 'pending' },
        publishedDigest: 'digest-a',
        runtime,
        assignmentConfigured: true,
      }),
    ).toMatchObject({
      overallStatus: 'action_required',
      currentStep: 'activation',
      reasonCode: 'activation_required',
      nextAction: '启用业务系统',
    });
  });

  it('把完整接入闭环归一为可用状态', () => {
    expect(
      installationReadiness({
        installation,
        publishedDigest: 'digest-a',
        runtime,
        assignmentConfigured: true,
      }),
    ).toMatchObject({
      overallStatus: 'ready',
      pageStatus: 'available',
      agentStatus: 'ready',
      reasonCode: null,
      nextAction: '无需处理',
    });
  });

  it.each([
    {
      name: '域名未验证',
      patch: { domainVerifiedAt: null },
      runtime,
      assigned: true,
      reasonCode: 'domain_verification_required',
      ownerRole: 'technical_contact',
    },
    {
      name: '服务检查失败',
      patch: {},
      runtime: { ...runtime, readyStatus: 'failed' as const },
      assigned: true,
      reasonCode: 'diagnostic_failed',
      ownerRole: 'technical_contact',
    },
    {
      name: '发布摘要不一致',
      patch: {},
      runtime: { ...runtime, manifestDigest: 'digest-old' },
      assigned: true,
      reasonCode: 'manifest_digest_mismatch',
      ownerRole: 'platform_admin',
    },
    {
      name: '尚未配置授权',
      patch: {},
      runtime,
      assigned: false,
      reasonCode: 'assignment_required',
      ownerRole: 'organization_admin',
    },
  ])(
    '$name 时给出确定的责任人与下一步',
    ({ patch, runtime: current, assigned, reasonCode, ownerRole }) => {
      expect(
        installationReadiness({
          installation: { ...installation, ...patch },
          publishedDigest: 'digest-a',
          runtime: current,
          assignmentConfigured: assigned,
        }),
      ).toMatchObject({ reasonCode, ownerRole });
    },
  );
});
