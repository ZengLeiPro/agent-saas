/**
 * WP2a 系统目录三表存储（规范 §8.1）。
 *
 * 骨架照 `data/skillPresentations/store.ts`（`{pool, tablePrefix}` + `init()` 跑
 * `PgGovernanceMigrationRunner`），状态机与 CAS 照 `data/connectorCatalog/store.ts`
 * （advisory lock + `FOR UPDATE` + 乐观锁 version）。
 * digest 一律用 `@kaiyan/ky-app-contract` 的 JCS `manifestDigest`，与定制项目侧逐字节一致。
 */
import type { PoolClient } from 'pg';

import { manifestDigest } from '@kaiyan/ky-app-contract';

import {
  PgGovernanceMigrationRunner,
  governanceTablePrefix,
  type GovernancePgPool,
} from '../../data/governance-schema/index.js';
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
  type KyAppSystemStore,
  type KyAppSystemVersion,
  type PublishKyAppVersionInput,
  type RegisterKyAppVersionInput,
} from './types.js';

export interface PgKyAppSystemStoreOptions {
  pool: GovernancePgPool;
  tablePrefix?: string;
}

type Row = Record<string, unknown>;

function isoOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

function iso(value: unknown): string {
  return isoOrNull(value) ?? new Date(0).toISOString();
}

function rowToDefinition(row: Row): KyAppSystemDefinition {
  return {
    systemId: String(row.system_id),
    name: String(row.name),
    status: String(row.status) as KyAppSystemStatus,
    publishedDigest: row.published_digest === null ? null : String(row.published_digest),
    version: Number(row.version),
    createdAt: iso(row.created_at),
    createdBy: String(row.created_by),
    updatedAt: iso(row.updated_at),
    updatedBy: String(row.updated_by),
  };
}

function rowToVersion(row: Row): KyAppSystemVersion {
  return {
    systemId: String(row.system_id),
    digest: String(row.digest),
    contractVersion: Number(row.contract_version),
    manifest: row.manifest_json as Record<string, unknown>,
    status: String(row.status) as KyAppSystemStatus,
    reviewStatus: String(row.review_status) as KyAppSystemVersion['reviewStatus'],
    reviewReasons: Array.isArray(row.review_reasons) ? (row.review_reasons as string[]) : [],
    reviewedBy: row.reviewed_by === null ? null : String(row.reviewed_by),
    reviewedAt: isoOrNull(row.reviewed_at),
    createdAt: iso(row.created_at),
    createdBy: String(row.created_by),
    publishedAt: isoOrNull(row.published_at),
    publishedBy: row.published_by === null ? null : String(row.published_by),
  };
}

function rowToInstallation(row: Row): KyAppInstallation {
  return {
    installationId: String(row.installation_id),
    tenantId: String(row.tenant_id),
    systemId: String(row.system_id),
    baseUrl: String(row.base_url),
    origin: String(row.origin),
    techContactUserId: String(row.tech_contact_user_id),
    status: String(row.status) as KyAppInstallationStatus,
    domainVerificationToken:
      row.domain_verification_token === null ? null : String(row.domain_verification_token),
    domainVerifiedAt: isoOrNull(row.domain_verified_at),
    registeredDigest: row.registered_digest === null ? null : String(row.registered_digest),
    stateVersion: Number(row.state_version),
    createdAt: iso(row.created_at),
    createdBy: String(row.created_by),
    updatedAt: iso(row.updated_at),
    updatedBy: String(row.updated_by),
  };
}

export class PgKyAppSystemStore implements KyAppSystemStore {
  readonly definitionsTable: string;
  readonly versionsTable: string;
  readonly installationsTable: string;
  private readonly tablePrefix?: string;

  constructor(private readonly options: PgKyAppSystemStoreOptions) {
    const prefix = governanceTablePrefix(options.tablePrefix);
    this.tablePrefix = options.tablePrefix;
    this.definitionsTable = `${prefix}_ky_app_system_definitions`;
    this.versionsTable = `${prefix}_ky_app_system_definition_versions`;
    this.installationsTable = `${prefix}_ky_app_tenant_system_installations`;
  }

  async init(): Promise<void> {
    await new PgGovernanceMigrationRunner(this.options.pool, this.tablePrefix).run();
  }

  async getDefinition(systemId: string): Promise<KyAppSystemDefinition | null> {
    const result = await this.options.pool.query(
      `SELECT * FROM ${this.definitionsTable} WHERE system_id = $1`,
      [systemId],
    );
    return result.rows[0] ? rowToDefinition(result.rows[0] as Row) : null;
  }

  async listDefinitions(): Promise<KyAppSystemDefinition[]> {
    const result = await this.options.pool.query(
      `SELECT * FROM ${this.definitionsTable} ORDER BY system_id`,
    );
    return result.rows.map((row) => rowToDefinition(row as Row));
  }

  async getVersion(systemId: string, digest: string): Promise<KyAppSystemVersion | null> {
    const result = await this.options.pool.query(
      `SELECT * FROM ${this.versionsTable} WHERE system_id = $1 AND digest = $2`,
      [systemId, digest],
    );
    return result.rows[0] ? rowToVersion(result.rows[0] as Row) : null;
  }

  async listVersions(systemId: string): Promise<KyAppSystemVersion[]> {
    const result = await this.options.pool.query(
      `SELECT * FROM ${this.versionsTable} WHERE system_id = $1 ORDER BY created_at DESC`,
      [systemId],
    );
    return result.rows.map((row) => rowToVersion(row as Row));
  }

  /**
   * 登记一个 draft 版本。digest 由 manifest 的 JCS 计算，
   * 同 digest 重复上传直接返回既有版本（`created=false`），不改动任何状态。
   */
  async registerVersion(input: RegisterKyAppVersionInput): Promise<{
    definition: KyAppSystemDefinition;
    version: KyAppSystemVersion;
    created: boolean;
  }> {
    const digest = manifestDigest(input.manifest);
    return this.withTransaction(async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
        `ky_app_system:${input.systemId}`,
      ]);
      const current = await this.lockDefinition(client, input.systemId);
      if (current?.status === 'retired') {
        throw new KyAppSystemConflictError(`系统 ${input.systemId} 已退役，不能再登记版本`);
      }
      if (!current) {
        await client.query(
          `INSERT INTO ${this.definitionsTable}
             (system_id,name,status,version,created_by,updated_by)
           VALUES ($1,$2,'draft',1,$3,$3)`,
          [input.systemId, input.name, input.actor],
        );
      }

      const duplicate = await client.query(
        `SELECT * FROM ${this.versionsTable} WHERE system_id = $1 AND digest = $2`,
        [input.systemId, digest],
      );
      if (duplicate.rows[0]) {
        const existing = await this.lockDefinition(client, input.systemId);
        if (!existing) throw new KyAppSystemNotFoundError(`未知系统 ${input.systemId}`);
        return {
          definition: existing,
          version: rowToVersion(duplicate.rows[0] as Row),
          created: false,
        };
      }

      const contractVersion = Number(input.manifest.contractVersion ?? 1);
      const inserted = await client.query(
        `INSERT INTO ${this.versionsTable}
           (system_id,digest,contract_version,manifest_json,status,review_status,review_reasons,created_by)
         VALUES ($1,$2,$3,$4::jsonb,'draft',$5,$6::jsonb,$7)
         RETURNING *`,
        [
          input.systemId,
          digest,
          Number.isSafeInteger(contractVersion) && contractVersion > 0 ? contractVersion : 1,
          JSON.stringify(input.manifest),
          input.reviewStatus ?? 'not_required',
          JSON.stringify([...(input.reviewReasons ?? [])]),
          input.actor,
        ],
      );
      const definition = await this.touchDefinition(
        client,
        input.systemId,
        input.name,
        input.actor,
      );
      return { definition, version: rowToVersion(inserted.rows[0] as Row), created: true };
    });
  }

  /** 记录人工复核结论；复核人不得是版本的登记人（规范 §8.1）。 */
  async reviewVersion(input: {
    systemId: string;
    digest: string;
    reviewer: string;
  }): Promise<KyAppSystemVersion> {
    return this.withTransaction(async (client) => {
      const version = await this.lockVersion(client, input.systemId, input.digest);
      if (version.reviewStatus === 'not_required') {
        throw new KyAppSystemConflictError('该版本未触发人工复核');
      }
      if (version.createdBy === input.reviewer) {
        throw new KyAppSystemConflictError('复核人必须不同于版本登记人');
      }
      const updated = await client.query(
        `UPDATE ${this.versionsTable}
         SET review_status='approved', reviewed_by=$3, reviewed_at=NOW()
         WHERE system_id=$1 AND digest=$2 RETURNING *`,
        [input.systemId, input.digest, input.reviewer],
      );
      return rowToVersion(updated.rows[0] as Row);
    });
  }

  /**
   * 发布版本：乐观锁 CAS（`expectedVersion` 必须等于定义当前 `version`），
   * 待复核的版本一律拒绝，通过后定义状态机切到 `published` 并记录 publishedDigest。
   */
  async publishVersion(input: PublishKyAppVersionInput): Promise<{
    definition: KyAppSystemDefinition;
    version: KyAppSystemVersion;
  }> {
    return this.withTransaction(async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
        `ky_app_system:${input.systemId}`,
      ]);
      const definition = await this.lockDefinition(client, input.systemId);
      if (!definition) throw new KyAppSystemNotFoundError(`未知系统 ${input.systemId}`);
      if (definition.version !== input.expectedVersion) {
        throw new KyAppSystemConflictError(
          `系统 ${input.systemId} 版本号已变化（期望 ${input.expectedVersion}，实际 ${definition.version}）`,
        );
      }
      // 已发布的系统可以继续发布新版本；只有 retired 是终态。
      if (definition.status === 'retired') {
        throw new KyAppSystemConflictError(`系统 ${input.systemId} 已退役，不可发布`);
      }
      if (definition.status === 'disabled' && !canTransitionSystemStatus('disabled', 'published')) {
        throw new KyAppSystemConflictError(`系统 ${input.systemId} 当前状态不可发布`);
      }
      const version = await this.lockVersion(client, input.systemId, input.digest);
      if (version.reviewStatus === 'pending') {
        throw new KyAppSystemConflictError('该版本仍待非发布者复核，不能发布');
      }
      if (version.status === 'retired') throw new KyAppSystemConflictError('已退役版本不能发布');

      const publishedVersion = await client.query(
        `UPDATE ${this.versionsTable}
         SET status='published', published_at=NOW(), published_by=$3
         WHERE system_id=$1 AND digest=$2 RETURNING *`,
        [input.systemId, input.digest, input.actor],
      );
      const updated = await client.query(
        `UPDATE ${this.definitionsTable}
         SET status='published', published_digest=$2, version=version+1, updated_at=NOW(), updated_by=$3
         WHERE system_id=$1 AND version=$4 RETURNING *`,
        [input.systemId, input.digest, input.actor, input.expectedVersion],
      );
      if (!updated.rows[0]) throw new KyAppSystemConflictError('发布 CAS 失败：版本号并发变化');
      return {
        definition: rowToDefinition(updated.rows[0] as Row),
        version: rowToVersion(publishedVersion.rows[0] as Row),
      };
    });
  }

  /** 系统状态机迁移（`disabled` / `retired`）。 */
  async updateDefinitionStatus(input: {
    systemId: string;
    status: KyAppSystemStatus;
    expectedVersion: number;
    actor: string;
  }): Promise<KyAppSystemDefinition> {
    return this.withTransaction(async (client) => {
      const definition = await this.lockDefinition(client, input.systemId);
      if (!definition) throw new KyAppSystemNotFoundError(`未知系统 ${input.systemId}`);
      if (definition.version !== input.expectedVersion) {
        throw new KyAppSystemConflictError('系统版本号已变化');
      }
      if (!canTransitionSystemStatus(definition.status, input.status)) {
        throw new KyAppSystemConflictError(
          `系统状态不能从 ${definition.status} 迁移到 ${input.status}`,
        );
      }
      const updated = await client.query(
        `UPDATE ${this.definitionsTable}
         SET status=$2, version=version+1, updated_at=NOW(), updated_by=$3
         WHERE system_id=$1 AND version=$4 RETURNING *`,
        [input.systemId, input.status, input.actor, input.expectedVersion],
      );
      if (!updated.rows[0]) throw new KyAppSystemConflictError('状态迁移 CAS 失败');
      return rowToDefinition(updated.rows[0] as Row);
    });
  }

  async getInstallation(installationId: string): Promise<KyAppInstallation | null> {
    const result = await this.options.pool.query(
      `SELECT * FROM ${this.installationsTable} WHERE installation_id = $1`,
      [installationId],
    );
    return result.rows[0] ? rowToInstallation(result.rows[0] as Row) : null;
  }

  async listInstallationsForTenant(tenantId: string): Promise<KyAppInstallation[]> {
    const result = await this.options.pool.query(
      `SELECT * FROM ${this.installationsTable}
       WHERE tenant_id = $1 AND status <> 'deleted' ORDER BY installation_id`,
      [tenantId],
    );
    return result.rows.map((row) => rowToInstallation(row as Row));
  }

  async createInstallation(input: CreateKyAppInstallationInput): Promise<KyAppInstallation> {
    const result = await this.options.pool.query(
      `INSERT INTO ${this.installationsTable}
         (installation_id,tenant_id,system_id,base_url,origin,tech_contact_user_id,
          status,domain_verification_token,state_version,created_by,updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,'pending',$7,1,$8,$8)
       RETURNING *`,
      [
        input.installationId,
        input.tenantId,
        input.systemId,
        input.baseUrl,
        input.origin,
        input.techContactUserId,
        input.domainVerificationToken ?? null,
        input.actor,
      ],
    );
    return rowToInstallation(result.rows[0] as Row);
  }

  /** 安装实例状态机；每次成功迁移 `stateVersion` 单调 +1（规范 §3.7）。 */
  async updateInstallationStatus(input: {
    installationId: string;
    status: KyAppInstallationStatus;
    actor: string;
  }): Promise<KyAppInstallation> {
    return this.withTransaction(async (client) => {
      const current = await this.lockInstallation(client, input.installationId);
      if (current.status === input.status) return current;
      if (!canTransitionInstallationStatus(current.status, input.status)) {
        throw new KyAppSystemConflictError(
          `安装实例状态不能从 ${current.status} 迁移到 ${input.status}`,
        );
      }
      const updated = await client.query(
        `UPDATE ${this.installationsTable}
         SET status=$2, state_version=state_version+1, updated_at=NOW(), updated_by=$3
         WHERE installation_id=$1 RETURNING *`,
        [input.installationId, input.status, input.actor],
      );
      return rowToInstallation(updated.rows[0] as Row);
    });
  }

  /** 域名归属验证通过（规范 §8.1）；不推进 stateVersion（不是对外状态事件）。 */
  async markDomainVerified(installationId: string, actor: string): Promise<KyAppInstallation> {
    const result = await this.options.pool.query(
      `UPDATE ${this.installationsTable}
       SET domain_verified_at=NOW(), updated_at=NOW(), updated_by=$2
       WHERE installation_id=$1 RETURNING *`,
      [installationId, actor],
    );
    if (!result.rows[0]) throw new KyAppSystemNotFoundError(`未知安装实例 ${installationId}`);
    return rowToInstallation(result.rows[0] as Row);
  }

  /**
   * CAS 切换 `registeredDigest`（规范 §8.1 发布顺序）。
   * 前置条件：`observedDigest`（来自 `ready.manifestDigest`）必须等于目标 digest，
   * 且该 digest 对应的版本行必须已 published；`expectedRegisteredDigest` 是乐观锁。
   */
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
    return this.withTransaction(async (client) => {
      const current = await this.lockInstallation(client, input.installationId);
      if (current.registeredDigest !== input.expectedRegisteredDigest) {
        throw new KyAppSystemConflictError('registeredDigest CAS 失败：并发变化');
      }
      if (current.status === 'deleted') {
        throw new KyAppSystemConflictError('已删除的安装实例不能登记 digest');
      }
      const version = await this.lockVersion(client, current.systemId, input.digest);
      if (version.status !== 'published') {
        throw new KyAppSystemConflictError('目标版本未发布，不能登记为 registeredDigest');
      }
      const updated = await client.query(
        `UPDATE ${this.installationsTable}
         SET registered_digest=$2, updated_at=NOW(), updated_by=$3
         WHERE installation_id=$1 AND registered_digest IS NOT DISTINCT FROM $4
         RETURNING *`,
        [input.installationId, input.digest, input.actor, input.expectedRegisteredDigest],
      );
      if (!updated.rows[0]) throw new KyAppSystemConflictError('registeredDigest CAS 失败');
      return rowToInstallation(updated.rows[0] as Row);
    });
  }

  private async lockDefinition(
    client: PoolClient,
    systemId: string,
  ): Promise<KyAppSystemDefinition | null> {
    const result = await client.query(
      `SELECT * FROM ${this.definitionsTable} WHERE system_id = $1 FOR UPDATE`,
      [systemId],
    );
    return result.rows[0] ? rowToDefinition(result.rows[0] as Row) : null;
  }

  private async lockVersion(
    client: PoolClient,
    systemId: string,
    digest: string,
  ): Promise<KyAppSystemVersion> {
    const result = await client.query(
      `SELECT * FROM ${this.versionsTable} WHERE system_id = $1 AND digest = $2 FOR UPDATE`,
      [systemId, digest],
    );
    if (!result.rows[0]) throw new KyAppSystemNotFoundError(`未知系统版本 ${systemId}@${digest}`);
    return rowToVersion(result.rows[0] as Row);
  }

  private async lockInstallation(
    client: PoolClient,
    installationId: string,
  ): Promise<KyAppInstallation> {
    const result = await client.query(
      `SELECT * FROM ${this.installationsTable} WHERE installation_id = $1 FOR UPDATE`,
      [installationId],
    );
    if (!result.rows[0]) throw new KyAppSystemNotFoundError(`未知安装实例 ${installationId}`);
    return rowToInstallation(result.rows[0] as Row);
  }

  private async touchDefinition(
    client: PoolClient,
    systemId: string,
    name: string,
    actor: string,
  ): Promise<KyAppSystemDefinition> {
    const result = await client.query(
      `UPDATE ${this.definitionsTable}
       SET name=$2, updated_at=NOW(), updated_by=$3 WHERE system_id=$1 RETURNING *`,
      [systemId, name, actor],
    );
    return rowToDefinition(result.rows[0] as Row);
  }

  private async withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.options.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}
