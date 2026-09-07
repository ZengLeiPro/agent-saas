/**
 * WP2a 安装实例服务层（规范 §2.5、§3.7、§8.1、§8.4）。
 *
 * 负责：建实例（系统必须已发布、技术联系人必须是本组织成员）、域名归属验证（DNS TXT）、
 * 启用/停用/删除状态机（`stateVersion` 单调 +1、事件入 outbox、`resource_assignments`
 * 保留已配置授权范围）、`registeredDigest` 的 CAS 切换。
 *
 * 每个写操作都走治理审计三段式（intent → 业务动作 → outcome）；
 * metadata 的键名一律避开 `secret|token|password|message|content|persona|memory|prompt|parameter|argument`
 * （`data/governance-audit/store.ts` 的 `FORBIDDEN_METADATA_KEY`），值也不放任何明文凭据。
 */
import { randomBytes } from 'node:crypto';
import { resolveTxt as dnsResolveTxt } from 'node:dns/promises';

import type { PgAssignmentStore } from '../../data/assignments/store.js';
import type { GovernanceAuditStore } from '../../data/governance-audit/types.js';
import {
  recordGovernanceIntent,
  recordGovernanceOutcome,
  governanceDigest,
  type GovernanceActor,
} from '../../data/governance-audit/recorder.js';
import type { KyAppPlatformConfig } from '../config.js';
import type { PgKyAppOutboundEventStore } from '../events/store.js';
import {
  KyAppSystemConflictError,
  KyAppSystemNotFoundError,
  type KyAppInstallation,
  type KyAppInstallationStatus,
} from '../systems/types.js';
import type { PgKyAppSystemStore } from '../systems/store.js';

/** §2.5 域名归属验证的 TXT 记录前缀。 */
export const KY_APP_DOMAIN_VERIFICATION_PREFIX = '_ky-app-verify';
/** 第一期生产应用域：公司控制 DNS，避免把任意客户域当成平台出站目标。 */
export const KY_APP_PRODUCTION_HOST_SUFFIX = '.apps.kaiyancn.com';

/** 状态 → outbox 事件类型（`pending` 不产生事件）。 */
const EVENT_TYPE_BY_STATUS = {
  enabled: 'installation.enabled',
  disabled: 'installation.disabled',
  deleted: 'installation.deleted',
} as const;

export interface KyAppInstallationMembershipReader {
  getMembership(
    tenantId: string,
    userId: string,
  ): Promise<{ status: 'active' | 'disabled' } | null>;
}

export interface KyAppInstallationServiceOptions {
  config: KyAppPlatformConfig;
  systems: PgKyAppSystemStore;
  events: PgKyAppOutboundEventStore;
  audit?: GovernanceAuditStore;
  assignments?: PgAssignmentStore;
  memberships?: KyAppInstallationMembershipReader;
  /** 可注入的 DNS TXT 查询，默认 `node:dns/promises` 的 `resolveTxt`。 */
  resolveTxt?: (hostname: string) => Promise<string[][]>;
  /**
   * 可选的证书 SAN 第二通道（§2.5）。平台当前没有统一的证书读取入口，
   * 未注入即只做 DNS TXT 一条通道（见基线偏差记录）。
   */
  inspectCertificateSans?: (hostname: string) => Promise<string[]>;
  /**
   * WP3：安装实例状态或 `registeredDigest` 变化时的进程内通知。
   * Capability Gateway 用它作为会话工具快照的失效入口（规范 §6.1）。
   * 只做进程内失效，不承担跨进程一致性（跨进程靠下一次 run 比对 digest 自然重建）。
   */
  onInstallationStateChanged?: (installationId: string) => void;
  now?: () => number;
}

export class KyAppInstallationError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = 'KyAppInstallationError';
  }
}

export interface CreateInstallationInput {
  installationId: string;
  tenantId: string;
  systemId: string;
  baseUrl: string;
  origin: string;
  techContactUserId: string;
}

export interface DomainVerificationResult {
  verified: boolean;
  method: 'dns_txt' | 'certificate_san';
  hostname: string;
  /** 未通过时给出的排查提示（只进日志与平台管理界面）。 */
  detail: string;
}

export class KyAppInstallationService {
  private readonly now: () => number;
  private readonly resolveTxt: (hostname: string) => Promise<string[][]>;

  constructor(private readonly options: KyAppInstallationServiceOptions) {
    this.now = options.now ?? Date.now;
    this.resolveTxt = options.resolveTxt ?? dnsResolveTxt;
  }

  /** 建安装实例：系统必须已发布、技术联系人必须是该组织的有效成员。 */
  async create(input: CreateInstallationInput, actor: GovernanceActor): Promise<KyAppInstallation> {
    const definition = await this.options.systems.getDefinition(input.systemId);
    if (!definition) throw new KyAppSystemNotFoundError(`未知系统 ${input.systemId}`);
    if (definition.status !== 'published') {
      throw new KyAppInstallationError('系统尚未发布，不能建安装实例', 'system_not_published');
    }
    assertOrigin(input.origin);
    assertBaseUrl(input.baseUrl, this.options.config);
    await this.assertTenantMember(input.tenantId, input.techContactUserId);

    const domainVerificationToken = randomBytes(24).toString('base64url');
    return this.audited(
      actor,
      {
        action: 'ky_app.installation.create',
        targetId: input.installationId,
        targetTenantId: input.tenantId,
        purpose: 'app_installation_provisioning',
        metadata: { systemId: input.systemId, origin: input.origin },
      },
      async () => {
        const created = await this.options.systems.createInstallation({
          ...input,
          domainVerificationToken,
          actor: actor.sub,
        });
        return {
          value: created,
          afterDigest: governanceDigest({
            installationId: created.installationId,
            status: created.status,
            stateVersion: created.stateVersion,
          }),
        };
      },
    );
  }

  /** 域名归属验证：`_ky-app-verify.<host>` 的 TXT 记录须包含登记时生成的 token。 */
  async verifyDomain(
    installationId: string,
    actor: GovernanceActor,
  ): Promise<{ installation: KyAppInstallation; result: DomainVerificationResult }> {
    const installation = await this.require(installationId);
    if (!installation.domainVerificationToken) {
      throw new KyAppInstallationError(
        '该实例没有待验证的域名归属令牌',
        'verification_unavailable',
      );
    }
    const hostname = new URL(installation.baseUrl).hostname;
    const result = await this.probeDomainOwnership(hostname, installation.domainVerificationToken);
    if (!result.verified) {
      throw new KyAppInstallationError(result.detail, 'domain_verification_failed');
    }
    const updated = await this.audited(
      actor,
      {
        action: 'ky_app.installation.verify_domain',
        targetId: installationId,
        targetTenantId: installation.tenantId,
        purpose: 'app_installation_provisioning',
        metadata: { hostname, verificationMethod: result.method },
      },
      async () => {
        const value = await this.options.systems.markDomainVerified(installationId, actor.sub);
        return { value, afterDigest: governanceDigest({ hostname, verified: true }) };
      },
    );
    return { installation: updated, result };
  }

  /** `ready` 周期复验用：只读探测，不写库、不写审计。 */
  async probeDomainOwnership(hostname: string, token: string): Promise<DomainVerificationResult> {
    const fqdn = `${KY_APP_DOMAIN_VERIFICATION_PREFIX}.${hostname}`;
    try {
      const records = await this.resolveTxt(fqdn);
      const flattened = records.map((chunks) => chunks.join(''));
      if (flattened.includes(token)) {
        return { verified: true, method: 'dns_txt', hostname, detail: 'DNS TXT 记录匹配' };
      }
    } catch (error) {
      const detail = `DNS TXT ${fqdn} 查询失败：${error instanceof Error ? error.message : String(error)}`;
      const fallback = await this.probeCertificateSan(hostname);
      return fallback ?? { verified: false, method: 'dns_txt', hostname, detail };
    }
    const fallback = await this.probeCertificateSan(hostname);
    return (
      fallback ?? {
        verified: false,
        method: 'dns_txt',
        hostname,
        detail: `DNS TXT ${fqdn} 未包含登记的验证令牌`,
      }
    );
  }

  /**
   * 状态机：`enable` / `disable` / `delete`。
   * 成功迁移后 `stateVersion` +1、事件入 outbox、`resource_assignments` 同步；
   * `deleted` 是吸收终态。
   */
  async setStatus(input: {
    installationId: string;
    status: Extract<KyAppInstallationStatus, 'enabled' | 'disabled' | 'deleted'>;
    actor: GovernanceActor;
    /** 组织管理员只能操作本组织；平台管理员传 undefined。 */
    limitToTenantId?: string;
  }): Promise<KyAppInstallation> {
    const current = await this.require(input.installationId);
    if (input.limitToTenantId !== undefined && current.tenantId !== input.limitToTenantId) {
      throw new KyAppInstallationError('无权操作其他组织的安装实例', 'forbidden');
    }
    if (current.status === 'deleted') {
      throw new KyAppSystemConflictError('安装实例已删除，状态不可再变更');
    }
    return this.audited(
      input.actor,
      {
        action: `ky_app.installation.${input.status}`,
        targetId: input.installationId,
        targetTenantId: current.tenantId,
        purpose: 'app_installation_lifecycle',
        beforeDigest: governanceDigest({
          status: current.status,
          stateVersion: current.stateVersion,
        }),
        metadata: { systemId: current.systemId, fromState: current.status, toState: input.status },
      },
      async () => {
        const updated = await this.options.systems.updateInstallationStatus({
          installationId: input.installationId,
          status: input.status,
          actor: input.actor.sub,
        });
        if (updated.stateVersion !== current.stateVersion) {
          await this.options.events.enqueue({
            installationId: updated.installationId,
            stateVersion: updated.stateVersion,
            type: EVENT_TYPE_BY_STATUS[input.status],
            retryWindowMs: this.options.config.events.retryWindowMs,
            now: new Date(this.now()),
          });
        }
        this.notifyStateChanged(updated.installationId);
        await this.syncAssignments(updated, input.actor.sub);
        return {
          value: updated,
          afterDigest: governanceDigest({
            status: updated.status,
            stateVersion: updated.stateVersion,
          }),
        };
      },
    );
  }

  /** §8.1 发布顺序最后一步：CAS 切换 `registeredDigest`，前置条件由 store 校验。 */
  async setRegisteredDigest(input: {
    installationId: string;
    digest: string;
    observedDigest: string;
    expectedRegisteredDigest: string | null;
    actor: GovernanceActor;
  }): Promise<KyAppInstallation> {
    const current = await this.require(input.installationId);
    return this.audited(
      input.actor,
      {
        action: 'ky_app.installation.registered_digest',
        targetId: input.installationId,
        targetTenantId: current.tenantId,
        purpose: 'app_release_gate',
        beforeDigest: governanceDigest({ registeredDigest: current.registeredDigest }),
        metadata: { systemId: current.systemId, manifestDigest: input.digest },
      },
      async () => {
        const value = await this.options.systems.setRegisteredDigest({
          installationId: input.installationId,
          digest: input.digest,
          observedDigest: input.observedDigest,
          expectedRegisteredDigest: input.expectedRegisteredDigest,
          actor: input.actor.sub,
        });
        this.notifyStateChanged(value.installationId);
        return {
          value,
          afterDigest: governanceDigest({ registeredDigest: value.registeredDigest }),
        };
      },
    );
  }

  /** 通知订阅者失效；订阅者抛错不影响安装实例状态机。 */
  private notifyStateChanged(installationId: string): void {
    try {
      this.options.onInstallationStateChanged?.(installationId);
    } catch {
      // 失效通知是尽力而为：拿不到通知的会话下一次 run 比对 digest 也会重建。
    }
  }

  async require(installationId: string): Promise<KyAppInstallation> {
    const installation = await this.options.systems.getInstallation(installationId);
    if (!installation) throw new KyAppSystemNotFoundError(`未知安装实例 ${installationId}`);
    return installation;
  }

  /**
   * `resource_assignments` 保留已配置授权范围（规范 §8.1）：
   * `enabled` → 保留原规则；首次启用空集合，需管理员显式授权；
   * `disabled` → 保留集合但标 `disabled`；`deleted` → 清空分配。
   */
  private async syncAssignments(installation: KyAppInstallation, updatedBy: string): Promise<void> {
    const assignments = this.options.assignments;
    if (!assignments) return;
    const existing = await assignments.getAssignmentSet(
      installation.tenantId,
      'system_installation',
      installation.installationId,
    );
    const expectedVersion = existing?.version ?? 0;
    if (installation.status === 'deleted') {
      if (!existing) return;
      await assignments.replaceAssignments(
        installation.tenantId,
        'system_installation',
        installation.installationId,
        [],
        expectedVersion,
        updatedBy,
        { resourceName: installation.systemId, status: 'disabled' },
      );
      return;
    }
    await assignments.replaceAssignments(
      installation.tenantId,
      'system_installation',
      installation.installationId,
      existing?.assignments.map(({ assigneeType, assigneeId, effect }) => ({ assigneeType, ...(assigneeId ? { assigneeId } : {}), effect })) ?? [],
      expectedVersion,
      updatedBy,
      {
        resourceName: installation.systemId,
        status: installation.status === 'enabled' ? 'enabled' : 'disabled',
      },
    );
  }

  private async probeCertificateSan(hostname: string): Promise<DomainVerificationResult | null> {
    const inspect = this.options.inspectCertificateSans;
    if (!inspect) return null;
    try {
      const sans = await inspect(hostname);
      if (sans.includes(hostname)) {
        return { verified: true, method: 'certificate_san', hostname, detail: '证书 SAN 匹配' };
      }
      return {
        verified: false,
        method: 'certificate_san',
        hostname,
        detail: '证书 SAN 不包含该域名',
      };
    } catch {
      return null;
    }
  }

  private async assertTenantMember(tenantId: string, userId: string): Promise<void> {
    const memberships = this.options.memberships;
    if (!memberships) {
      throw new KyAppInstallationError(
        '成员事实源不可用，无法校验技术联系人',
        'memberships_unavailable',
      );
    }
    const membership = await memberships.getMembership(tenantId, userId);
    if (!membership || membership.status !== 'active') {
      throw new KyAppInstallationError('技术联系人必须是该组织的有效成员', 'tech_contact_invalid');
    }
  }

  /** 治理审计三段式包装：intent → 动作 → outcome（失败也补 outcome）。 */
  private async audited<T>(
    actor: GovernanceActor,
    change: {
      action: string;
      targetId: string;
      targetTenantId: string;
      purpose: string;
      beforeDigest?: string;
      metadata: Record<string, string | number | boolean>;
    },
    run: () => Promise<{ value: T; afterDigest?: string }>,
  ): Promise<T> {
    const intent = await recordGovernanceIntent(this.options.audit, actor, {
      action: change.action,
      targetType: 'system_installation',
      targetId: change.targetId,
      targetTenantId: change.targetTenantId,
      purpose: change.purpose,
      ...(change.beforeDigest ? { beforeDigest: change.beforeDigest } : {}),
      metadata: change.metadata,
    });
    let result: { value: T; afterDigest?: string };
    try {
      result = await run();
    } catch (error) {
      await recordGovernanceOutcome(this.options.audit!, intent, 'failed', {
        metadata: { failureKind: errorKind(error) },
      }).catch(() => undefined);
      throw error;
    }
    await recordGovernanceOutcome(this.options.audit!, intent, 'succeeded', {
      ...(result.afterDigest ? { afterDigest: result.afterDigest } : {}),
      metadata: {},
    });
    return result.value;
  }
}

function errorKind(error: unknown): string {
  if (error instanceof KyAppInstallationError) return error.code;
  if (error instanceof KyAppSystemConflictError) return 'conflict';
  if (error instanceof KyAppSystemNotFoundError) return 'not_found';
  return 'internal';
}

/** §2.5：跨站独立域，登记的 origin 必须是不含路径的 origin。 */
export function assertOrigin(origin: string): void {
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    throw new KyAppInstallationError('origin 不是合法 URL', 'invalid_origin');
  }
  if (parsed.origin !== origin) {
    throw new KyAppInstallationError('origin 必须是不含路径与结尾斜杠的来源', 'invalid_origin');
  }
}

/** baseUrl 同样只接受 origin 形态；prod 一律 https。 */
export function assertBaseUrl(baseUrl: string, config: KyAppPlatformConfig): void {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new KyAppInstallationError('baseUrl 不是合法 URL', 'invalid_base_url');
  }
  if (parsed.origin !== baseUrl) {
    throw new KyAppInstallationError('baseUrl 必须是不含路径与结尾斜杠的来源', 'invalid_base_url');
  }
  if (
    parsed.protocol !== 'https:' &&
    !(config.allowInsecureOutbound && config.environment !== 'prod')
  ) {
    throw new KyAppInstallationError('baseUrl 必须是 https', 'invalid_base_url');
  }
  if (
    config.environment === 'prod' &&
    (!parsed.hostname.endsWith(KY_APP_PRODUCTION_HOST_SUFFIX) ||
      parsed.hostname === KY_APP_PRODUCTION_HOST_SUFFIX.slice(1))
  ) {
    throw new KyAppInstallationError(
      `第一期生产 baseUrl 必须使用 *${KY_APP_PRODUCTION_HOST_SUFFIX}`,
      'invalid_base_url',
    );
  }
}
