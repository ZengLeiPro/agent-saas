import {
  PgGovernanceMigrationRunner,
  governanceTablePrefix,
  type GovernancePgPool,
} from '../governance-schema/index.js';
import { BUILTIN_SKILL_PRESENTATIONS } from './builtins.js';
import {
  SkillPresentationConflictError,
  type SkillPresentationKey,
  type SkillPresentationRecord,
  type SkillPresentationStore,
  type UpsertSkillPresentationInput,
} from './types.js';

function rowToRecord(row: Record<string, unknown>): SkillPresentationRecord {
  return {
    resourceScope: row.resource_scope as SkillPresentationRecord['resourceScope'],
    resourceTenantId: String(row.resource_tenant_id),
    skillId: String(row.skill_id),
    audienceTenantId: String(row.audience_tenant_id),
    locale: String(row.locale),
    displayName: String(row.display_name),
    summary: String(row.summary),
    revision: Number(row.revision),
    createdAt:
      row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    createdBy: String(row.created_by),
    updatedAt:
      row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
    updatedBy: String(row.updated_by),
  };
}

export class PgSkillPresentationStore implements SkillPresentationStore {
  readonly table: string;
  private readonly tablePrefix?: string;

  constructor(private readonly options: { pool: GovernancePgPool; tablePrefix?: string }) {
    this.tablePrefix = options.tablePrefix;
    this.table = `${governanceTablePrefix(options.tablePrefix)}_skill_presentations`;
  }

  async init(): Promise<void> {
    await new PgGovernanceMigrationRunner(this.options.pool, this.tablePrefix).run();
    await this.ensureBuiltinDefaults();
  }

  async ensureBuiltinDefaults(): Promise<void> {
    for (const item of BUILTIN_SKILL_PRESENTATIONS) {
      await this.options.pool.query(
        `INSERT INTO ${this.table}
          (resource_scope,resource_tenant_id,skill_id,audience_tenant_id,locale,display_name,summary,created_by,updated_by)
         VALUES ('platform','',$1,'','zh-CN',$2,$3,'system:builtin-skill-catalog','system:builtin-skill-catalog')
         ON CONFLICT (resource_scope,resource_tenant_id,skill_id,audience_tenant_id,locale) DO NOTHING`,
        [item.skillId, item.displayName, item.summary],
      );
    }
  }

  async getExact(key: SkillPresentationKey): Promise<SkillPresentationRecord | null> {
    const result = await this.options.pool.query(
      `SELECT * FROM ${this.table}
       WHERE resource_scope=$1 AND resource_tenant_id=$2 AND skill_id=$3
         AND audience_tenant_id=$4 AND locale=$5`,
      [key.resourceScope, key.resourceTenantId, key.skillId, key.audienceTenantId, key.locale],
    );
    return result.rows[0] ? rowToRecord(result.rows[0] as Record<string, unknown>) : null;
  }

  async listEffectivePlatform(
    skillIds: readonly string[],
    tenantId?: string,
  ): Promise<Map<string, SkillPresentationRecord>> {
    if (skillIds.length === 0) return new Map();
    const audiences = tenantId ? ['', tenantId] : [''];
    const result = await this.options.pool.query(
      `SELECT * FROM ${this.table}
       WHERE resource_scope='platform' AND resource_tenant_id='' AND locale='zh-CN'
         AND skill_id=ANY($1::text[]) AND audience_tenant_id=ANY($2::text[])
       ORDER BY CASE WHEN audience_tenant_id='' THEN 0 ELSE 1 END`,
      [[...skillIds], audiences],
    );
    const records = new Map<string, SkillPresentationRecord>();
    for (const row of result.rows as Array<Record<string, unknown>>) {
      const record = rowToRecord(row);
      records.set(record.skillId, record);
    }
    return records;
  }

  async listTenantOwned(
    skillIds: readonly string[],
    tenantId: string,
  ): Promise<Map<string, SkillPresentationRecord>> {
    if (skillIds.length === 0) return new Map();
    const result = await this.options.pool.query(
      `SELECT * FROM ${this.table}
       WHERE resource_scope='tenant' AND resource_tenant_id=$1 AND audience_tenant_id=''
         AND locale='zh-CN' AND skill_id=ANY($2::text[])`,
      [tenantId, [...skillIds]],
    );
    return new Map(
      (result.rows as Array<Record<string, unknown>>).map((row) => {
        const record = rowToRecord(row);
        return [record.skillId, record];
      }),
    );
  }

  async upsert(input: UpsertSkillPresentationInput): Promise<SkillPresentationRecord> {
    const result = await this.options.pool.query(
      `INSERT INTO ${this.table}
        (resource_scope,resource_tenant_id,skill_id,audience_tenant_id,locale,display_name,summary,revision,created_by,updated_by)
       SELECT $1,$2,$3,$4,$5,$6,$7,1,$9,$9
       WHERE $8=0 OR EXISTS (
         SELECT 1 FROM ${this.table}
         WHERE resource_scope=$1 AND resource_tenant_id=$2 AND skill_id=$3
           AND audience_tenant_id=$4 AND locale=$5 AND revision=$8
       )
       ON CONFLICT (resource_scope,resource_tenant_id,skill_id,audience_tenant_id,locale)
       DO UPDATE SET display_name=EXCLUDED.display_name,summary=EXCLUDED.summary,
         revision=${this.table}.revision+1,updated_at=NOW(),updated_by=EXCLUDED.updated_by
       WHERE ${this.table}.revision=$8
       RETURNING *`,
      [
        input.resourceScope,
        input.resourceTenantId,
        input.skillId,
        input.audienceTenantId,
        input.locale,
        input.displayName,
        input.summary,
        input.expectedRevision,
        input.updatedBy,
      ],
    );
    if (!result.rows[0]) throw new SkillPresentationConflictError();
    return rowToRecord(result.rows[0] as Record<string, unknown>);
  }

  async delete(key: SkillPresentationKey, expectedRevision: number): Promise<void> {
    const result = await this.options.pool.query(
      `DELETE FROM ${this.table}
       WHERE resource_scope=$1 AND resource_tenant_id=$2 AND skill_id=$3
         AND audience_tenant_id=$4 AND locale=$5 AND revision=$6
       RETURNING revision`,
      [
        key.resourceScope,
        key.resourceTenantId,
        key.skillId,
        key.audienceTenantId,
        key.locale,
        expectedRevision,
      ],
    );
    if (!result.rows[0]) throw new SkillPresentationConflictError();
  }
}

function memoryKey(key: SkillPresentationKey): string {
  return [
    key.resourceScope,
    key.resourceTenantId,
    key.skillId,
    key.audienceTenantId,
    key.locale,
  ].join('\0');
}

export class InMemorySkillPresentationStore implements SkillPresentationStore {
  private readonly records = new Map<string, SkillPresentationRecord>();

  async getExact(key: SkillPresentationKey): Promise<SkillPresentationRecord | null> {
    return this.records.get(memoryKey(key)) ?? null;
  }

  async listEffectivePlatform(
    skillIds: readonly string[],
    tenantId?: string,
  ): Promise<Map<string, SkillPresentationRecord>> {
    const result = new Map<string, SkillPresentationRecord>();
    for (const skillId of skillIds) {
      const base = await this.getExact({
        resourceScope: 'platform',
        resourceTenantId: '',
        skillId,
        audienceTenantId: '',
        locale: 'zh-CN',
      });
      if (base) result.set(skillId, base);
      if (tenantId) {
        const override = await this.getExact({
          resourceScope: 'platform',
          resourceTenantId: '',
          skillId,
          audienceTenantId: tenantId,
          locale: 'zh-CN',
        });
        if (override) result.set(skillId, override);
      }
    }
    return result;
  }

  async listTenantOwned(
    skillIds: readonly string[],
    tenantId: string,
  ): Promise<Map<string, SkillPresentationRecord>> {
    const result = new Map<string, SkillPresentationRecord>();
    for (const skillId of skillIds) {
      const record = await this.getExact({
        resourceScope: 'tenant',
        resourceTenantId: tenantId,
        skillId,
        audienceTenantId: '',
        locale: 'zh-CN',
      });
      if (record) result.set(skillId, record);
    }
    return result;
  }

  async upsert(input: UpsertSkillPresentationInput): Promise<SkillPresentationRecord> {
    const key = memoryKey(input);
    const previous = this.records.get(key);
    if ((previous?.revision ?? 0) !== input.expectedRevision)
      throw new SkillPresentationConflictError();
    const now = new Date().toISOString();
    const record: SkillPresentationRecord = {
      resourceScope: input.resourceScope,
      resourceTenantId: input.resourceTenantId,
      skillId: input.skillId,
      audienceTenantId: input.audienceTenantId,
      locale: input.locale,
      displayName: input.displayName,
      summary: input.summary,
      revision: (previous?.revision ?? 0) + 1,
      createdAt: previous?.createdAt ?? now,
      createdBy: previous?.createdBy ?? input.updatedBy,
      updatedAt: now,
      updatedBy: input.updatedBy,
    };
    this.records.set(key, record);
    return record;
  }

  async delete(key: SkillPresentationKey, expectedRevision: number): Promise<void> {
    const encoded = memoryKey(key);
    const previous = this.records.get(encoded);
    if (!previous || previous.revision !== expectedRevision)
      throw new SkillPresentationConflictError();
    this.records.delete(encoded);
  }
}
