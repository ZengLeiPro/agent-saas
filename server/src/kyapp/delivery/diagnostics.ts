import { randomBytes, randomUUID } from 'node:crypto';

import { toolName, validateMe, type Manifest } from '@kaiyan/ky-app-contract';

import { verifyKyAppAttestation } from '../attest/verify.js';
import type { AppLogicalCallRunner } from '../gateway/lcid.js';
import type { AppCapabilityEntry } from '../gateway/snapshot.js';
import type { KyAppCredentialManager } from '../installations/credentials.js';
import type { KyAppInstallationService } from '../installations/service.js';
import type { KyAppOutbound } from '../outbound.js';
import type { KyAppSatIssuer } from '../sat/issuer.js';
import type { PgKyAppSystemStore } from '../systems/store.js';

export type KyAppDiagnosticStatus = 'passed' | 'failed';

export interface KyAppDiagnosticCheck {
  id: 'dns' | 'live' | 'ready_digest' | 'attest' | 'admin_me' | 'read_only_capability';
  label: string;
  status: KyAppDiagnosticStatus;
  detail: string;
}

export interface KyAppDiagnosticReport {
  installationId: string;
  checkedAt: string;
  passed: boolean;
  checks: KyAppDiagnosticCheck[];
}

export interface KyAppDiagnosticFixture {
  adminUserId: string;
  readOnlyCapabilityId: string;
  readOnlyInput: Record<string, unknown>;
}

export interface KyAppDiagnosticsOptions {
  systems: PgKyAppSystemStore;
  installations: KyAppInstallationService;
  credentials: KyAppCredentialManager;
  issuer: KyAppSatIssuer;
  outbound: KyAppOutbound;
  logicalCalls: AppLogicalCallRunner;
  audience: string;
  resolveAuthBinding(userId: string): { authEpoch?: number; generation?: number } | null;
  isTenantAdmin(input: { tenantId: string; userId: string }): Promise<boolean>;
  now?: () => number;
}

function pathPrefixes(manifest: Manifest): { user: string[]; admin: string[] } {
  return {
    user: [...manifest.pathPrefixes.user],
    admin: [...manifest.pathPrefixes.admin],
  };
}

function readAttestation(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const value = (payload as { attestation?: unknown }).attestation;
  return typeof value === 'string' && value !== '' ? value : null;
}

/** WP5 一键诊断：每项都打真实对端，不以数据库旧状态或 UI 状态代替。 */
export class KyAppDiagnostics {
  private readonly now: () => number;

  constructor(private readonly options: KyAppDiagnosticsOptions) {
    this.now = options.now ?? Date.now;
  }

  async run(
    installationId: string,
    fixture: KyAppDiagnosticFixture,
  ): Promise<KyAppDiagnosticReport> {
    const installation = await this.options.installations.require(installationId);
    if (!installation.registeredDigest) {
      throw new Error('安装实例尚未登记 manifest digest');
    }
    const registeredDigest = installation.registeredDigest;
    const version = await this.options.systems.getVersion(installation.systemId, registeredDigest);
    if (!version) throw new Error('找不到安装实例登记的 manifest 版本');
    const manifest = version.manifest as unknown as Manifest;
    const checks: KyAppDiagnosticCheck[] = [];
    const record = async (
      id: KyAppDiagnosticCheck['id'],
      label: string,
      operation: () => Promise<string>,
    ) => {
      try {
        checks.push({ id, label, status: 'passed', detail: await operation() });
      } catch (error) {
        checks.push({
          id,
          label,
          status: 'failed',
          detail: error instanceof Error ? error.message : String(error),
        });
      }
    };

    await record('dns', 'DNS 归属', async () => {
      if (!installation.domainVerificationToken) throw new Error('缺少域名归属验证令牌');
      const result = await this.options.installations.probeDomainOwnership(
        new URL(installation.baseUrl).hostname,
        installation.domainVerificationToken,
      );
      if (!result.verified) throw new Error(result.detail);
      return `${result.method} 已验证`;
    });

    await record('live', 'live', async () => {
      const result = await this.options.outbound.request({
        baseUrl: installation.baseUrl,
        path: '/ky/v1/health/live',
        method: 'GET',
        requestId: randomUUID(),
      });
      const status = (result.json as { status?: unknown } | null)?.status;
      if (result.status !== 200 || (status !== 'ok' && status !== 'maintenance')) {
        throw new Error(`live 返回 HTTP ${result.status}，status=${String(status)}`);
      }
      return status === 'maintenance' ? '可达，当前维护中' : '可达';
    });

    await record('ready_digest', 'ready 与 digest', async () => {
      const requestId = randomUUID();
      const sat = await this.options.issuer.issue({
        act: 'platform',
        tenantId: installation.tenantId,
        installationId,
        systemId: installation.systemId,
        rid: requestId,
      });
      const result = await this.options.outbound.request({
        baseUrl: installation.baseUrl,
        path: '/ky/v1/health/ready',
        method: 'GET',
        requestId,
        headers: { Authorization: `Bearer ${sat.token}` },
      });
      const body = result.json as { status?: unknown; manifestDigest?: unknown } | null;
      if (result.status !== 200 || body?.status !== 'ok') {
        throw new Error(`ready 返回 HTTP ${result.status}，status=${String(body?.status)}`);
      }
      if (body.manifestDigest !== registeredDigest) {
        throw new Error('ready 上报 digest 与平台登记值不一致');
      }
      return `digest ${registeredDigest.slice(0, 12)}… 一致`;
    });

    await record('attest', '安装证明', async () => {
      const nonce = randomBytes(16).toString('base64url');
      const result = await this.options.outbound.request({
        baseUrl: installation.baseUrl,
        path: `/ky/v1/attest?nonce=${encodeURIComponent(nonce)}`,
        method: 'GET',
        requestId: randomUUID(),
      });
      const attestation = readAttestation(result.json);
      if (result.status !== 200 || !attestation)
        throw new Error(`attest 返回 HTTP ${result.status}`);
      const keys = await this.options.credentials.listAcceptableInstallationKeys(installationId);
      if (keys.length === 0) throw new Error('平台没有可用于验签的安装密钥');
      await verifyKyAppAttestation({
        token: attestation,
        installationId,
        expectedOrigin: installation.origin,
        audience: this.options.audience,
        nonce,
        keys,
        nowMs: this.now(),
      });
      return '签名、nonce、origin 与安装实例均匹配';
    });

    const tenantAdmin = await this.options
      .isTenantAdmin({ tenantId: installation.tenantId, userId: fixture.adminUserId })
      .catch(() => false);
    let adminMe: unknown = null;
    await record('admin_me', '管理员 /me', async () => {
      if (!tenantAdmin) throw new Error('诊断用户不是该组织的有效管理员');
      const sat = await this.options.issuer.issue({
        act: 'user',
        tenantId: installation.tenantId,
        installationId,
        systemId: installation.systemId,
        userId: fixture.adminUserId,
        tadm: true,
        pathPrefixes: pathPrefixes(manifest),
        authBinding: this.options.resolveAuthBinding(fixture.adminUserId),
      });
      const result = await this.options.outbound.request({
        baseUrl: installation.baseUrl,
        path: '/ky/v1/me',
        method: 'GET',
        requestId: randomUUID(),
        headers: { Authorization: `Bearer ${sat.token}` },
      });
      if (result.status !== 200) throw new Error(`/me 返回 HTTP ${result.status}`);
      const validation = validateMe(result.json, manifest);
      if (!validation.ok) throw new Error(`/me 不合契约：${validation.errors.join('；')}`);
      const user = (result.json as { user?: { id?: unknown; roles?: unknown } }).user;
      if (user?.id !== fixture.adminUserId || !Array.isArray(user.roles)) {
        throw new Error('/me 的管理员身份或 roles 不正确');
      }
      adminMe = result.json;
      return `管理员角色 ${user.roles.join('、') || '（空）'}`;
    });

    await record('read_only_capability', '只读能力', async () => {
      if (adminMe === null) throw new Error('管理员 /me 未通过，未继续调用能力');
      const capability = manifest.capabilities.find(
        (item) => item.id === fixture.readOnlyCapabilityId && item.riskLevel === 'read_only',
      );
      if (!capability) throw new Error('诊断能力不存在或不是 read_only');
      const enabled = (
        adminMe as { capabilities: Array<{ id: string; enabled: boolean }> }
      ).capabilities.some((item) => item.id === capability.id && item.enabled);
      if (!enabled) throw new Error('管理员 /me 未启用该诊断能力');
      const entry: AppCapabilityEntry = {
        installationId,
        systemId: installation.systemId,
        systemName: manifest.name,
        capabilityId: capability.id,
        toolName: toolName(installation.systemId, capability.id),
        capabilityName: capability.name,
        description: capability.description,
        riskLevel: capability.riskLevel,
        safeToRetry: capability.safeToRetry,
        inputSchema: capability.inputSchema,
        ...(capability.timeoutMs === undefined ? {} : { timeoutMs: capability.timeoutMs }),
        ...(capability.resultLink ? { resultLink: capability.resultLink } : {}),
        registeredDigest,
        baseUrl: installation.baseUrl,
      };
      const outcome = await this.options.logicalCalls.run({
        entry,
        tenantId: installation.tenantId,
        userId: fixture.adminUserId,
        sessionId: `diagnostic:${installationId}`,
        tenantAdmin: true,
        input: fixture.readOnlyInput,
      });
      if (outcome.outcome.kind !== 'success') {
        throw new Error(`只读能力失败：${outcome.outcome.code}`);
      }
      return `${capability.id} 调用成功（${outcome.attempts} 次请求）`;
    });

    return {
      installationId,
      checkedAt: new Date(this.now()).toISOString(),
      passed: checks.every((item) => item.status === 'passed'),
      checks,
    };
  }
}
