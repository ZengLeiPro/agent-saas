/**
 * WP2a 单测用的进程内 store 替身。
 *
 * 与 PG 实现同签名、同语义（状态机、CAS、原子消费、幂等键），
 * 但不依赖数据库，让端点 × 鉴权矩阵、发布门禁、投递/探测等用例在没有 PG 的环境也能跑。
 * PG 上的真实行为另有 `*.pg.test.ts` 覆盖。
 */
import { randomUUID } from 'node:crypto';

import { manifestDigest } from '@kaiyan/ky-app-contract';

import {
  KY_APP_CREDENTIAL_SCOPES,
  KyAppCredentialConflictError,
  serviceCredentialDigest,
  type KyAppCredentialScope,
  type KyAppInstallationKeyRecord,
  type KyAppServiceCredentialRecord,
} from '../installations/credentialStore.js';
import type { KyAppInstallationRuntimeRecord } from '../installations/runtimeStore.js';
import {
  backoffDelayMs,
  type EnqueueKyAppEventInput,
  type KyAppEventType,
  type KyAppOutboundEvent,
} from '../events/store.js';
import {
  KyAppSystemConflictError,
  KyAppSystemNotFoundError,
  canTransitionInstallationStatus,
  canTransitionSystemStatus,
  type CreateKyAppInstallationInput,
  type KyAppInstallation,
  type KyAppInstallationStatus,
  type KyAppSystemDefinition,
  type KyAppSystemStatus,
  type KyAppSystemVersion,
  type PublishKyAppVersionInput,
  type RegisterKyAppVersionInput,
} from '../systems/types.js';

const ISO = (): string => new Date().toISOString();

export class MemoryKyAppSystemStore {
  readonly installationsTable = 'memory_ky_app_tenant_system_installations';
  private readonly definitions = new Map<string, KyAppSystemDefinition>();
  private readonly versions = new Map<string, KyAppSystemVersion>();
  private readonly installations = new Map<string, KyAppInstallation>();

  async init(): Promise<void> {
    // 内存实现无需建表。
  }

  async getDefinition(systemId: string): Promise<KyAppSystemDefinition | null> {
    return this.definitions.get(systemId) ?? null;
  }

  async listDefinitions(): Promise<KyAppSystemDefinition[]> {
    return [...this.definitions.values()].sort((a, b) => a.systemId.localeCompare(b.systemId));
  }

  async getVersion(systemId: string, digest: string): Promise<KyAppSystemVersion | null> {
    return this.versions.get(`${systemId} ${digest}`) ?? null;
  }

  async listVersions(systemId: string): Promise<KyAppSystemVersion[]> {
    return [...this.versions.values()].filter((item) => item.systemId === systemId);
  }

  async registerVersion(input: RegisterKyAppVersionInput): Promise<{
    definition: KyAppSystemDefinition;
    version: KyAppSystemVersion;
    created: boolean;
  }> {
    const digest = manifestDigest(input.manifest);
    const current = this.definitions.get(input.systemId);
    if (current?.status === 'retired') {
      throw new KyAppSystemConflictError(`系统 ${input.systemId} 已退役，不能再登记版本`);
    }
    if (!current) {
      this.definitions.set(input.systemId, {
        systemId: input.systemId,
        name: input.name,
        status: 'draft',
        publishedDigest: null,
        version: 1,
        createdAt: ISO(),
        createdBy: input.actor,
        updatedAt: ISO(),
        updatedBy: input.actor,
      });
    }
    const key = `${input.systemId} ${digest}`;
    const existing = this.versions.get(key);
    if (existing) {
      return {
        definition: this.definitions.get(input.systemId)!,
        version: existing,
        created: false,
      };
    }
    const version: KyAppSystemVersion = {
      systemId: input.systemId,
      digest,
      contractVersion: Number(input.manifest.contractVersion ?? 1),
      manifest: input.manifest,
      status: 'draft',
      reviewStatus: input.reviewStatus ?? 'not_required',
      reviewReasons: [...(input.reviewReasons ?? [])],
      reviewedBy: null,
      reviewedAt: null,
      createdAt: ISO(),
      createdBy: input.actor,
      publishedAt: null,
      publishedBy: null,
    };
    this.versions.set(key, version);
    const definition = {
      ...this.definitions.get(input.systemId)!,
      name: input.name,
      updatedBy: input.actor,
    };
    this.definitions.set(input.systemId, definition);
    return { definition, version, created: true };
  }

  async reviewVersion(input: {
    systemId: string;
    digest: string;
    reviewer: string;
  }): Promise<KyAppSystemVersion> {
    const version = this.requireVersion(input.systemId, input.digest);
    if (version.reviewStatus === 'not_required') {
      throw new KyAppSystemConflictError('该版本未触发人工复核');
    }
    if (version.createdBy === input.reviewer) {
      throw new KyAppSystemConflictError('复核人必须不同于版本登记人');
    }
    const updated: KyAppSystemVersion = {
      ...version,
      reviewStatus: 'approved',
      reviewedBy: input.reviewer,
      reviewedAt: ISO(),
    };
    this.versions.set(`${input.systemId} ${input.digest}`, updated);
    return updated;
  }

  async publishVersion(input: PublishKyAppVersionInput): Promise<{
    definition: KyAppSystemDefinition;
    version: KyAppSystemVersion;
  }> {
    const definition = this.definitions.get(input.systemId);
    if (!definition) throw new KyAppSystemNotFoundError(`未知系统 ${input.systemId}`);
    if (definition.version !== input.expectedVersion) {
      throw new KyAppSystemConflictError('系统版本号已变化');
    }
    if (definition.status === 'retired') throw new KyAppSystemConflictError('系统已退役，不可发布');
    const version = this.requireVersion(input.systemId, input.digest);
    if (version.reviewStatus === 'pending') {
      throw new KyAppSystemConflictError('该版本仍待非发布者复核，不能发布');
    }
    if (version.status === 'retired') throw new KyAppSystemConflictError('已退役版本不能发布');
    const publishedVersion: KyAppSystemVersion = {
      ...version,
      status: 'published',
      publishedAt: ISO(),
      publishedBy: input.actor,
    };
    this.versions.set(`${input.systemId} ${input.digest}`, publishedVersion);
    const updated: KyAppSystemDefinition = {
      ...definition,
      status: 'published',
      publishedDigest: input.digest,
      version: definition.version + 1,
      updatedAt: ISO(),
      updatedBy: input.actor,
    };
    this.definitions.set(input.systemId, updated);
    return { definition: updated, version: publishedVersion };
  }

  async updateDefinitionStatus(input: {
    systemId: string;
    status: KyAppSystemStatus;
    expectedVersion: number;
    actor: string;
  }): Promise<KyAppSystemDefinition> {
    const definition = this.definitions.get(input.systemId);
    if (!definition) throw new KyAppSystemNotFoundError(`未知系统 ${input.systemId}`);
    if (definition.version !== input.expectedVersion) {
      throw new KyAppSystemConflictError('系统版本号已变化');
    }
    if (!canTransitionSystemStatus(definition.status, input.status)) {
      throw new KyAppSystemConflictError(
        `系统状态不能从 ${definition.status} 迁移到 ${input.status}`,
      );
    }
    const updated = {
      ...definition,
      status: input.status,
      version: definition.version + 1,
      updatedAt: ISO(),
      updatedBy: input.actor,
    };
    this.definitions.set(input.systemId, updated);
    return updated;
  }

  async getInstallation(installationId: string): Promise<KyAppInstallation | null> {
    return this.installations.get(installationId) ?? null;
  }

  async listInstallationsForTenant(tenantId: string): Promise<KyAppInstallation[]> {
    return [...this.installations.values()]
      .filter((item) => item.tenantId === tenantId && item.status !== 'deleted')
      .sort((a, b) => a.installationId.localeCompare(b.installationId));
  }

  async listEnabled(): Promise<KyAppInstallation[]> {
    return [...this.installations.values()]
      .filter((item) => item.status === 'enabled')
      .sort((a, b) => a.installationId.localeCompare(b.installationId));
  }

  async listLive(): Promise<KyAppInstallation[]> {
    return [...this.installations.values()].filter((item) => item.status !== 'deleted');
  }

  async createInstallation(input: CreateKyAppInstallationInput): Promise<KyAppInstallation> {
    if (this.installations.has(input.installationId)) {
      throw new KyAppSystemConflictError('安装实例已存在');
    }
    const installation: KyAppInstallation = {
      installationId: input.installationId,
      tenantId: input.tenantId,
      systemId: input.systemId,
      baseUrl: input.baseUrl,
      origin: input.origin,
      techContactUserId: input.techContactUserId,
      status: 'pending',
      domainVerificationToken: input.domainVerificationToken ?? null,
      domainVerifiedAt: null,
      registeredDigest: null,
      stateVersion: 1,
      createdAt: ISO(),
      createdBy: input.actor,
      updatedAt: ISO(),
      updatedBy: input.actor,
    };
    this.installations.set(input.installationId, installation);
    return installation;
  }

  async updateInstallationStatus(input: {
    installationId: string;
    status: KyAppInstallationStatus;
    actor: string;
  }): Promise<KyAppInstallation> {
    const current = this.requireInstallation(input.installationId);
    if (current.status === input.status) return current;
    if (!canTransitionInstallationStatus(current.status, input.status)) {
      throw new KyAppSystemConflictError(
        `安装实例状态不能从 ${current.status} 迁移到 ${input.status}`,
      );
    }
    const updated = {
      ...current,
      status: input.status,
      stateVersion: current.stateVersion + 1,
      updatedAt: ISO(),
      updatedBy: input.actor,
    };
    this.installations.set(input.installationId, updated);
    return updated;
  }

  async markDomainVerified(installationId: string, actor: string): Promise<KyAppInstallation> {
    const current = this.requireInstallation(installationId);
    const updated = { ...current, domainVerifiedAt: ISO(), updatedAt: ISO(), updatedBy: actor };
    this.installations.set(installationId, updated);
    return updated;
  }

  async setRegisteredDigest(input: {
    installationId: string;
    digest: string;
    observedDigest: string;
    expectedRegisteredDigest: string | null;
    actor: string;
  }): Promise<KyAppInstallation> {
    if (input.observedDigest !== input.digest) {
      throw new KyAppSystemConflictError('部署上报的 manifestDigest 与待登记 digest 不一致');
    }
    const current = this.requireInstallation(input.installationId);
    if (current.registeredDigest !== input.expectedRegisteredDigest) {
      throw new KyAppSystemConflictError('registeredDigest CAS 失败：并发变化');
    }
    if (current.status === 'deleted') {
      throw new KyAppSystemConflictError('已删除的安装实例不能登记 digest');
    }
    const version = this.requireVersion(current.systemId, input.digest);
    if (version.status !== 'published') {
      throw new KyAppSystemConflictError('目标版本未发布，不能登记为 registeredDigest');
    }
    const updated = {
      ...current,
      registeredDigest: input.digest,
      updatedAt: ISO(),
      updatedBy: input.actor,
    };
    this.installations.set(input.installationId, updated);
    return updated;
  }

  private requireVersion(systemId: string, digest: string): KyAppSystemVersion {
    const version = this.versions.get(`${systemId} ${digest}`);
    if (!version) throw new KyAppSystemNotFoundError(`未知系统版本 ${systemId}@${digest}`);
    return version;
  }

  private requireInstallation(installationId: string): KyAppInstallation {
    const installation = this.installations.get(installationId);
    if (!installation) throw new KyAppSystemNotFoundError(`未知安装实例 ${installationId}`);
    return installation;
  }
}

export class MemoryKyAppCredentialStore {
  private readonly credentials = new Map<string, KyAppServiceCredentialRecord>();
  private readonly keys = new Map<string, KyAppInstallationKeyRecord>();
  private keySequence = 0;

  async init(): Promise<void> {
    // 内存实现无需建表。
  }

  async issueCredential(input: {
    credentialId: string;
    installationId: string;
    tokenSha256: string;
    scopes: readonly KyAppCredentialScope[];
    secretRef: string;
    ackDeadlineAt: Date;
    expiresAt: Date;
  }): Promise<KyAppServiceCredentialRecord> {
    const record: KyAppServiceCredentialRecord = {
      credentialId: input.credentialId,
      installationId: input.installationId,
      tokenSha256: input.tokenSha256,
      scopes: [...(input.scopes ?? KY_APP_CREDENTIAL_SCOPES)],
      status: 'pending_ack',
      secretRef: input.secretRef,
      claimedAt: null,
      issuedAt: new Date(Date.now() + (this.keySequence += 1)).toISOString(),
      ackDeadlineAt: input.ackDeadlineAt.toISOString(),
      ackedAt: null,
      expiresAt: input.expiresAt.toISOString(),
      revokedAt: null,
    };
    this.credentials.set(record.credentialId, record);
    return record;
  }

  async findByToken(token: string): Promise<KyAppServiceCredentialRecord | null> {
    const digest = serviceCredentialDigest(token);
    return [...this.credentials.values()].find((item) => item.tokenSha256 === digest) ?? null;
  }

  async listCredentials(installationId: string): Promise<KyAppServiceCredentialRecord[]> {
    return [...this.credentials.values()]
      .filter((item) => item.installationId === installationId)
      .sort((a, b) => b.issuedAt.localeCompare(a.issuedAt));
  }

  async markClaimed(credentialId: string): Promise<KyAppServiceCredentialRecord | null> {
    const record = this.credentials.get(credentialId);
    if (!record || record.claimedAt !== null) return null;
    const updated = { ...record, claimedAt: ISO() };
    this.credentials.set(credentialId, updated);
    return updated;
  }

  async acknowledge(credentialId: string, now: Date): Promise<KyAppServiceCredentialRecord | null> {
    const record = this.credentials.get(credentialId);
    if (!record || record.status !== 'pending_ack') return null;
    if (Date.parse(record.ackDeadlineAt) <= now.getTime()) return null;
    const updated: KyAppServiceCredentialRecord = {
      ...record,
      status: 'active',
      ackedAt: now.toISOString(),
    };
    this.credentials.set(credentialId, updated);
    return updated;
  }

  async revokeCredential(credentialId: string): Promise<KyAppServiceCredentialRecord | null> {
    const record = this.credentials.get(credentialId);
    if (!record || record.status === 'revoked') return null;
    const updated: KyAppServiceCredentialRecord = {
      ...record,
      status: 'revoked',
      revokedAt: ISO(),
    };
    this.credentials.set(credentialId, updated);
    return updated;
  }

  async expireStale(now: Date): Promise<number> {
    let count = 0;
    for (const [id, record] of this.credentials) {
      const ackExpired =
        record.status === 'pending_ack' && Date.parse(record.ackDeadlineAt) <= now.getTime();
      const lifetimeExpired =
        (record.status === 'pending_ack' || record.status === 'active') &&
        Date.parse(record.expiresAt) <= now.getTime();
      if (!ackExpired && !lifetimeExpired) continue;
      this.credentials.set(id, { ...record, status: 'expired' });
      count += 1;
    }
    return count;
  }

  async getInstallationKeys(installationId: string): Promise<KyAppInstallationKeyRecord[]> {
    return [...this.keys.values()]
      .filter((item) => item.installationId === installationId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async rotateInstallationKey(input: {
    installationId: string;
    keyVersion: string;
    secretRef: string;
    acceptPreviousMs: number;
  }): Promise<KyAppInstallationKeyRecord> {
    const key = `${input.installationId} ${input.keyVersion}`;
    if (this.keys.has(key)) {
      throw new KyAppCredentialConflictError(`安装密钥 keyVersion 已存在：${input.keyVersion}`);
    }
    for (const [id, record] of this.keys) {
      if (record.installationId !== input.installationId) continue;
      if (record.status === 'previous') {
        this.keys.set(id, { ...record, status: 'revoked', revokedAt: ISO() });
      } else if (record.status === 'current') {
        this.keys.set(id, {
          ...record,
          status: 'previous',
          supersededAt: ISO(),
          acceptUntil: new Date(Date.now() + input.acceptPreviousMs).toISOString(),
        });
      }
    }
    const record: KyAppInstallationKeyRecord = {
      installationId: input.installationId,
      keyVersion: input.keyVersion,
      secretRef: input.secretRef,
      status: 'current',
      createdAt: new Date(Date.now() + (this.keySequence += 1)).toISOString(),
      supersededAt: null,
      acceptUntil: null,
      revokedAt: null,
    };
    this.keys.set(key, record);
    return record;
  }

  async findAcceptableKey(
    installationId: string,
    keyVersion: string,
    now: Date,
  ): Promise<KyAppInstallationKeyRecord | null> {
    const record = this.keys.get(`${installationId} ${keyVersion}`);
    if (!record) return null;
    if (record.status === 'current') return record;
    if (
      record.status === 'previous' &&
      record.acceptUntil !== null &&
      Date.parse(record.acceptUntil) > now.getTime()
    ) {
      return record;
    }
    return null;
  }
}

export class MemoryKyAppRuntimeStore {
  readonly table = 'memory_ky_app_installation_runtime';
  readonly records = new Map<string, KyAppInstallationRuntimeRecord>();

  async init(): Promise<void> {
    // 内存实现无需建表。
  }

  async get(installationId: string): Promise<KyAppInstallationRuntimeRecord | null> {
    return this.records.get(installationId) ?? null;
  }

  async recordLive(input: {
    installationId: string;
    status: 'ok' | 'maintenance' | 'failed';
    error?: string;
  }): Promise<KyAppInstallationRuntimeRecord> {
    const current = this.records.get(input.installationId) ?? this.blank(input.installationId);
    const failed = input.status === 'failed';
    const updated: KyAppInstallationRuntimeRecord = {
      ...current,
      liveStatus: input.status,
      liveCheckedAt: ISO(),
      consecutiveFailures: failed ? current.consecutiveFailures + 1 : 0,
      lastError: input.error ?? null,
      updatedAt: ISO(),
    };
    this.records.set(input.installationId, updated);
    return updated;
  }

  async recordReady(input: {
    installationId: string;
    status: 'ok' | 'failed';
    manifestDigest?: string;
    contractVersion?: number;
    appVersion?: string;
    directoryCheckpoint?: string;
    directoryAgeSeconds?: number;
    jwksKids?: readonly string[];
    error?: string;
  }): Promise<KyAppInstallationRuntimeRecord> {
    const current = this.records.get(input.installationId) ?? this.blank(input.installationId);
    const updated: KyAppInstallationRuntimeRecord = {
      ...current,
      readyStatus: input.status,
      readyCheckedAt: ISO(),
      manifestDigest: input.manifestDigest ?? current.manifestDigest,
      contractVersion: input.contractVersion ?? current.contractVersion,
      appVersion: input.appVersion ?? current.appVersion,
      directoryCheckpoint: input.directoryCheckpoint ?? current.directoryCheckpoint,
      directoryAgeSeconds: input.directoryAgeSeconds ?? current.directoryAgeSeconds,
      jwksKids: [...(input.jwksKids ?? [])],
      lastError: input.error ?? null,
      updatedAt: ISO(),
    };
    this.records.set(input.installationId, updated);
    return updated;
  }

  async markAlerted(installationId: string): Promise<void> {
    const current = this.records.get(installationId);
    if (!current) return;
    this.records.set(installationId, { ...current, alertedAt: ISO(), updatedAt: ISO() });
  }

  async clearAlert(installationId: string): Promise<void> {
    const current = this.records.get(installationId);
    if (!current) return;
    this.records.set(installationId, { ...current, alertedAt: null, updatedAt: ISO() });
  }

  private blank(installationId: string): KyAppInstallationRuntimeRecord {
    return {
      installationId,
      liveStatus: 'unknown',
      liveCheckedAt: null,
      readyStatus: 'unknown',
      readyCheckedAt: null,
      manifestDigest: null,
      contractVersion: null,
      appVersion: null,
      directoryCheckpoint: null,
      directoryAgeSeconds: null,
      jwksKids: [],
      consecutiveFailures: 0,
      lastError: null,
      alertedAt: null,
      updatedAt: ISO(),
    };
  }
}

export class MemoryKyAppOutboundEventStore {
  readonly events = new Map<string, KyAppOutboundEvent>();

  async init(): Promise<void> {
    // 内存实现无需建表。
  }

  async enqueue(input: EnqueueKyAppEventInput): Promise<KyAppOutboundEvent> {
    const now = input.now ?? new Date();
    const duplicate = [...this.events.values()].find(
      (item) =>
        item.installationId === input.installationId &&
        item.type === input.type &&
        item.stateVersion === input.stateVersion,
    );
    if (duplicate) return duplicate;
    const event: KyAppOutboundEvent = {
      eventId: input.eventId ?? randomUUID(),
      installationId: input.installationId,
      stateVersion: input.stateVersion,
      type: input.type as KyAppEventType,
      payload: input.payload ?? {},
      status: 'pending',
      attempts: 0,
      occurredAt: now.toISOString(),
      nextAttemptAt: now.toISOString(),
      giveUpAt: new Date(now.getTime() + input.retryWindowMs).toISOString(),
      deliveredAt: null,
      verifiedKid: null,
      lastError: null,
    };
    this.events.set(event.eventId, event);
    return event;
  }

  async listDue(now: Date, limit = 50): Promise<KyAppOutboundEvent[]> {
    return [...this.events.values()]
      .filter(
        (item) => item.status === 'pending' && Date.parse(item.nextAttemptAt) <= now.getTime(),
      )
      .sort(
        (a, b) =>
          a.installationId.localeCompare(b.installationId) ||
          a.stateVersion - b.stateVersion ||
          a.occurredAt.localeCompare(b.occurredAt),
      )
      .slice(0, limit);
  }

  async listSince(installationId: string, stateVersion: number): Promise<KyAppOutboundEvent[]> {
    return [...this.events.values()]
      .filter((item) => item.installationId === installationId && item.stateVersion >= stateVersion)
      .sort((a, b) => a.stateVersion - b.stateVersion);
  }

  async markDelivered(eventId: string, verifiedKid?: string): Promise<KyAppOutboundEvent | null> {
    const event = this.events.get(eventId);
    if (!event || event.status !== 'pending') return null;
    const updated: KyAppOutboundEvent = {
      ...event,
      status: 'delivered',
      deliveredAt: ISO(),
      attempts: event.attempts + 1,
      verifiedKid: verifiedKid ?? null,
      lastError: null,
    };
    this.events.set(eventId, updated);
    return updated;
  }

  async markFailed(input: {
    eventId: string;
    error: string;
    now?: Date;
  }): Promise<KyAppOutboundEvent | null> {
    const event = this.events.get(input.eventId);
    if (!event || event.status !== 'pending') return null;
    const now = input.now ?? new Date();
    const attempts = event.attempts + 1;
    const nextAttemptAt = new Date(now.getTime() + backoffDelayMs(attempts));
    const exhausted = nextAttemptAt.getTime() > Date.parse(event.giveUpAt);
    const updated: KyAppOutboundEvent = {
      ...event,
      attempts,
      nextAttemptAt: nextAttemptAt.toISOString(),
      status: exhausted ? 'abandoned' : 'pending',
      lastError: input.error.slice(0, 500),
    };
    this.events.set(input.eventId, updated);
    return updated;
  }
}

/** 与 `KyAppInstallationDirectory` 同形态的内存替身。 */
export class MemoryKyAppDirectory {
  constructor(private readonly systems: MemoryKyAppSystemStore) {}

  listEnabled(): Promise<KyAppInstallation[]> {
    return this.systems.listEnabled();
  }

  listLive(): Promise<KyAppInstallation[]> {
    return this.systems.listLive();
  }
}
