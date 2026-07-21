import pg from 'pg';

import {
  BUILTIN_AGENT_PROFILES,
  BUILTIN_AGENT_PROFILE_BINDINGS,
  builtinProfileVersionId,
  createBuiltinAgentProfileRecords,
} from './builtins.js';
import {
  AGENT_PROFILE_SCHEMA_VERSION,
  AgentRuntimeProfileError,
  assertAgentProfileKey,
  digestAgentRuntimeProfileConfig,
  newAgentProfileId,
  newAgentProfileVersionId,
  parseAgentRuntimeProfileConfig,
  type AgentProfileBindingKey,
  type AgentRuntimeProfile,
  type AgentRuntimeProfileBinding,
  type AgentRuntimeProfileStore,
  type AgentRuntimeProfileVersion,
  type CreateAgentRuntimeProfileInput,
  type ResolvedAgentRuntimeProfile,
  type UpdateAgentRuntimeProfileDraftInput,
} from './types.js';

const { Pool } = pg;
type PgPool = InstanceType<typeof Pool>;

export class InMemoryAgentRuntimeProfileStore implements AgentRuntimeProfileStore {
  readonly durable = false;
  private readonly profiles = new Map<string, AgentRuntimeProfile>();
  private readonly versions = new Map<string, AgentRuntimeProfileVersion>();
  private readonly bindings = new Map<AgentProfileBindingKey, AgentRuntimeProfileBinding>();

  async init(): Promise<void> {
    if (this.profiles.size > 0) return;
    const records = createBuiltinAgentProfileRecords();
    for (const profile of records.profiles) this.profiles.set(profile.profileId, clone(profile));
    for (const version of records.versions) this.versions.set(version.profileVersionId, clone(version));
    for (const binding of records.bindings) this.bindings.set(binding.bindingKey, clone(binding));
  }

  async listProfiles(): Promise<AgentRuntimeProfile[]> {
    return [...this.profiles.values()].map(clone).sort((a, b) => a.profileKey.localeCompare(b.profileKey));
  }

  async getProfile(profileId: string): Promise<AgentRuntimeProfile | null> {
    return cloneOrNull(this.profiles.get(profileId));
  }

  async createProfile(_input: CreateAgentRuntimeProfileInput): Promise<AgentRuntimeProfile> {
    throw notDurable();
  }

  async copyProfile(_profileId: string, _input: CreateAgentRuntimeProfileInput): Promise<AgentRuntimeProfile> {
    throw notDurable();
  }

  async updateDraft(_profileId: string, _input: UpdateAgentRuntimeProfileDraftInput): Promise<AgentRuntimeProfile> {
    throw notDurable();
  }

  async publish(_profileId: string, _expectedRevision: number, _actor: string): Promise<AgentRuntimeProfileVersion> {
    throw notDurable();
  }

  async archive(_profileId: string, _expectedRevision: number, _actor: string): Promise<AgentRuntimeProfile> {
    throw notDurable();
  }

  async listVersions(profileId: string): Promise<AgentRuntimeProfileVersion[]> {
    return [...this.versions.values()]
      .filter((version) => version.profileId === profileId)
      .map(clone)
      .sort((a, b) => b.versionNumber - a.versionNumber);
  }

  async getVersion(profileVersionId: string): Promise<AgentRuntimeProfileVersion | null> {
    return cloneOrNull(this.versions.get(profileVersionId));
  }

  async listBindings(): Promise<AgentRuntimeProfileBinding[]> {
    return [...this.bindings.values()].map(clone).sort((a, b) => a.bindingKey.localeCompare(b.bindingKey));
  }

  async updateBinding(_bindingKey: AgentProfileBindingKey, _profileId: string, _actor: string): Promise<AgentRuntimeProfileBinding> {
    throw notDurable();
  }

  async resolveBinding(bindingKey: AgentProfileBindingKey): Promise<ResolvedAgentRuntimeProfile | null> {
    const binding = this.bindings.get(bindingKey);
    if (!binding) return null;
    const profile = this.profiles.get(binding.profileId);
    if (!profile?.latestVersion || profile.status === 'archived') return null;
    const version = this.versions.get(profile.latestVersion.profileVersionId);
    if (!version) return null;
    return { bindingKey, profile: clone(profile), version: clone(version), source: 'builtin' };
  }
}

export interface PgAgentRuntimeProfileStoreOptions {
  pool?: PgPool;
  connectionString?: string;
  tablePrefix?: string;
}

interface ProfileRow {
  profile_id: string;
  profile_key: string;
  name: string;
  description: string;
  purpose: string;
  status: string;
  is_system: boolean;
  draft_config: unknown;
  draft_digest: string;
  revision: string | number;
  latest_version_id: string | null;
  created_by: string;
  created_at: string | Date;
  updated_by: string;
  updated_at: string | Date;
  archived_by: string | null;
  archived_at: string | Date | null;
  latest_version_number?: string | number | null;
  latest_version_digest?: string | null;
  latest_version_published_by?: string | null;
  latest_version_published_at?: string | Date | null;
}

interface VersionRow {
  profile_version_id: string;
  profile_id: string;
  version_number: string | number;
  config_schema_version: string | number;
  config_json: unknown;
  config_digest: string;
  published_by: string;
  published_at: string | Date;
}

interface ResolvedProfileRow extends ProfileRow, VersionRow {
  version_profile_id: string;
}

interface BindingRow {
  binding_key: string;
  profile_id: string;
  updated_by: string;
  updated_at: string | Date;
}

export class PgAgentRuntimeProfileStore implements AgentRuntimeProfileStore {
  readonly durable = true;
  readonly pool: PgPool;
  readonly profilesTable: string;
  readonly versionsTable: string;
  readonly bindingsTable: string;
  private readonly immutableFunction: string;
  private readonly ownsPool: boolean;

  constructor(options: PgAgentRuntimeProfileStoreOptions) {
    if (!options.pool && !options.connectionString) {
      throw new Error('PgAgentRuntimeProfileStore requires either pool or connectionString');
    }
    const prefix = sanitizeIdentifier(options.tablePrefix ?? 'runtime');
    this.profilesTable = `${prefix}_agent_profiles`;
    this.versionsTable = `${prefix}_agent_profile_versions`;
    this.bindingsTable = `${prefix}_agent_profile_bindings`;
    this.immutableFunction = `${prefix}_reject_agent_profile_version_mutation`;
    this.pool = options.pool ?? new Pool({ connectionString: options.connectionString! });
    this.ownsPool = !options.pool;
  }

  async init(): Promise<void> {
    const lockKey = `${this.profilesTable}:init`;
    const client = await this.pool.connect();
    try {
      await client.query('SELECT pg_advisory_lock(hashtext($1))', [lockKey]);
      await client.query(`
        CREATE TABLE IF NOT EXISTS ${this.profilesTable} (
          profile_id TEXT PRIMARY KEY,
          profile_key TEXT NOT NULL UNIQUE,
          name TEXT NOT NULL,
          description TEXT NOT NULL DEFAULT '',
          purpose TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL CHECK (status IN ('draft','published','archived')),
          is_system BOOLEAN NOT NULL DEFAULT FALSE,
          draft_config JSONB NOT NULL,
          draft_digest TEXT NOT NULL,
          revision BIGINT NOT NULL DEFAULT 1,
          latest_version_id TEXT,
          created_by TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL,
          updated_by TEXT NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL,
          archived_by TEXT,
          archived_at TIMESTAMPTZ,
          CHECK ((status = 'archived') = (archived_at IS NOT NULL))
        )
      `);
      await client.query(`
        CREATE TABLE IF NOT EXISTS ${this.versionsTable} (
          profile_version_id TEXT PRIMARY KEY,
          profile_id TEXT NOT NULL REFERENCES ${this.profilesTable}(profile_id) ON DELETE RESTRICT,
          version_number INTEGER NOT NULL CHECK (version_number > 0),
          config_schema_version INTEGER NOT NULL,
          config_json JSONB NOT NULL,
          config_digest TEXT NOT NULL,
          published_by TEXT NOT NULL,
          published_at TIMESTAMPTZ NOT NULL,
          UNIQUE (profile_id, version_number)
        )
      `);
      // 早期开发版曾禁止同一配置摘要再次发布，会让管理员无法把 v1 配置
      // 作为 v3 正式回滚。只拒绝“与当前版本无变化”，历史配置可生成新版本。
      await client.query(`
        ALTER TABLE ${this.versionsTable}
        DROP CONSTRAINT IF EXISTS ${this.versionsTable}_profile_id_config_digest_key
      `);
      await client.query(`
        DO $$ BEGIN
          ALTER TABLE ${this.profilesTable}
            ADD CONSTRAINT ${this.profilesTable}_latest_version_fk
            FOREIGN KEY (latest_version_id) REFERENCES ${this.versionsTable}(profile_version_id) ON DELETE RESTRICT;
        EXCEPTION WHEN duplicate_object THEN NULL;
        END $$
      `);
      await client.query(`
        CREATE TABLE IF NOT EXISTS ${this.bindingsTable} (
          binding_key TEXT PRIMARY KEY,
          profile_id TEXT NOT NULL REFERENCES ${this.profilesTable}(profile_id) ON DELETE RESTRICT,
          updated_by TEXT NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL
        )
      `);
      await client.query(`CREATE INDEX IF NOT EXISTS ${this.profilesTable}_status_idx ON ${this.profilesTable}(status, updated_at DESC)`);
      await client.query(`CREATE INDEX IF NOT EXISTS ${this.versionsTable}_profile_idx ON ${this.versionsTable}(profile_id, version_number DESC)`);
      await client.query(`
        CREATE OR REPLACE FUNCTION ${this.immutableFunction}() RETURNS trigger AS $$
        BEGIN
          RAISE EXCEPTION 'published Agent Profile versions are immutable' USING ERRCODE = '55000';
        END;
        $$ LANGUAGE plpgsql
      `);
      await client.query(`DROP TRIGGER IF EXISTS ${this.versionsTable}_immutable ON ${this.versionsTable}`);
      await client.query(`
        CREATE TRIGGER ${this.versionsTable}_immutable
        BEFORE UPDATE OR DELETE ON ${this.versionsTable}
        FOR EACH ROW EXECUTE FUNCTION ${this.immutableFunction}()
      `);
      await this.seedBuiltins(client);
    } finally {
      await client.query('SELECT pg_advisory_unlock(hashtext($1))', [lockKey]).catch(() => undefined);
      client.release();
    }
  }

  async close(): Promise<void> {
    if (this.ownsPool) await this.pool.end();
  }

  async listProfiles(): Promise<AgentRuntimeProfile[]> {
    const result = await this.pool.query<ProfileRow>(this.profileSelectSql('ORDER BY p.profile_key'));
    return result.rows.map(normalizeProfileRow);
  }

  async getProfile(profileId: string): Promise<AgentRuntimeProfile | null> {
    const result = await this.pool.query<ProfileRow>(this.profileSelectSql('WHERE p.profile_id = $1'), [profileId]);
    return result.rows[0] ? normalizeProfileRow(result.rows[0]) : null;
  }

  async createProfile(input: CreateAgentRuntimeProfileInput): Promise<AgentRuntimeProfile> {
    const profileId = newAgentProfileId();
    const key = assertAgentProfileKey(input.profileKey);
    const config = parseAgentRuntimeProfileConfig(input.config ?? defaultDraftConfig());
    const now = new Date().toISOString();
    try {
      await this.pool.query(`
        INSERT INTO ${this.profilesTable}
          (profile_id, profile_key, name, description, purpose, status, is_system,
           draft_config, draft_digest, revision, created_by, created_at, updated_by, updated_at)
        VALUES ($1,$2,$3,$4,$5,'draft',FALSE,$6::jsonb,$7,1,$8,$9,$8,$9)
      `, [
        profileId,
        key,
        requireText(input.name, '名称', 100),
        input.description?.trim() ?? '',
        input.purpose?.trim() ?? '',
        JSON.stringify(config),
        digestAgentRuntimeProfileConfig(config),
        input.actor,
        now,
      ]);
      return (await this.getProfile(profileId))!;
    } catch (error) {
      throw mapPgError(error, 'Profile key 已存在');
    }
  }

  async copyProfile(profileId: string, input: CreateAgentRuntimeProfileInput): Promise<AgentRuntimeProfile> {
    const source = await this.getProfile(profileId);
    if (!source) throw new AgentRuntimeProfileError('Profile 不存在', 'NOT_FOUND');
    return this.createProfile({ ...input, config: input.config ?? source.draftConfig });
  }

  async updateDraft(profileId: string, input: UpdateAgentRuntimeProfileDraftInput): Promise<AgentRuntimeProfile> {
    const current = await this.getProfile(profileId);
    if (!current) throw new AgentRuntimeProfileError('Profile 不存在', 'NOT_FOUND');
    if (current.status === 'archived') throw new AgentRuntimeProfileError('已归档 Profile 不能编辑', 'PROFILE_ARCHIVED');
    const config = parseAgentRuntimeProfileConfig(input.config ?? current.draftConfig);
    const result = await this.pool.query(`
      UPDATE ${this.profilesTable}
      SET name=$3, description=$4, purpose=$5, draft_config=$6::jsonb, draft_digest=$7,
          revision=revision+1, updated_by=$8, updated_at=NOW()
      WHERE profile_id=$1 AND revision=$2 AND status <> 'archived'
    `, [
      profileId,
      input.expectedRevision,
      requireText(input.name ?? current.name, '名称', 100),
      input.description?.trim() ?? current.description,
      input.purpose?.trim() ?? current.purpose,
      JSON.stringify(config),
      digestAgentRuntimeProfileConfig(config),
      input.actor,
    ]);
    if (result.rowCount !== 1) throw conflict();
    return (await this.getProfile(profileId))!;
  }

  async publish(profileId: string, expectedRevision: number, actor: string): Promise<AgentRuntimeProfileVersion> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const locked = await client.query<ProfileRow>(`SELECT * FROM ${this.profilesTable} WHERE profile_id=$1 FOR UPDATE`, [profileId]);
      const row = locked.rows[0];
      if (!row) throw new AgentRuntimeProfileError('Profile 不存在', 'NOT_FOUND');
      if (row.status === 'archived') throw new AgentRuntimeProfileError('已归档 Profile 不能发布', 'PROFILE_ARCHIVED');
      if (Number(row.revision) !== expectedRevision) throw conflict();
      if (row.latest_version_id) {
        const latest = await client.query<{ config_digest: string }>(
          `SELECT config_digest FROM ${this.versionsTable} WHERE profile_version_id=$1`,
          [row.latest_version_id],
        );
        if (latest.rows[0]?.config_digest === row.draft_digest) {
          throw new AgentRuntimeProfileError('草稿与当前已发布版本没有变化', 'CONFLICT');
        }
      }
      const maxResult = await client.query<{ max_version: string | number }>(
        `SELECT COALESCE(MAX(version_number), 0) AS max_version FROM ${this.versionsTable} WHERE profile_id=$1`,
        [profileId],
      );
      const versionNumber = Number(maxResult.rows[0]?.max_version ?? 0) + 1;
      const versionId = newAgentProfileVersionId();
      const now = new Date().toISOString();
      const config = parseAgentRuntimeProfileConfig(row.draft_config);
      await client.query(`
        INSERT INTO ${this.versionsTable}
          (profile_version_id, profile_id, version_number, config_schema_version,
           config_json, config_digest, published_by, published_at)
        VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8)
      `, [versionId, profileId, versionNumber, AGENT_PROFILE_SCHEMA_VERSION, JSON.stringify(config), row.draft_digest, actor, now]);
      await client.query(`
        UPDATE ${this.profilesTable}
        SET status='published', latest_version_id=$3, revision=revision+1, updated_by=$4, updated_at=$5
        WHERE profile_id=$1 AND revision=$2
      `, [profileId, expectedRevision, versionId, actor, now]);
      await client.query('COMMIT');
      return {
        profileVersionId: versionId,
        profileId,
        versionNumber,
        configSchemaVersion: AGENT_PROFILE_SCHEMA_VERSION,
        config,
        configDigest: row.draft_digest,
        publishedBy: actor,
        publishedAt: now,
      };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw mapPgError(error, '该草稿内容已经发布');
    } finally {
      client.release();
    }
  }

  async archive(profileId: string, expectedRevision: number, actor: string): Promise<AgentRuntimeProfile> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const locked = await client.query<Pick<ProfileRow, 'status' | 'is_system' | 'revision'>>(
        `SELECT status, is_system, revision FROM ${this.profilesTable} WHERE profile_id=$1 FOR UPDATE`,
        [profileId],
      );
      const profile = locked.rows[0];
      if (!profile) throw new AgentRuntimeProfileError('Profile 不存在', 'NOT_FOUND');
      if (profile.is_system) throw new AgentRuntimeProfileError('系统预置 Profile 不能归档', 'SYSTEM_PROFILE');
      if (profile.status === 'archived') throw new AgentRuntimeProfileError('Profile 已归档', 'PROFILE_ARCHIVED');
      if (Number(profile.revision) !== expectedRevision) throw conflict();
      const bound = await client.query(`SELECT 1 FROM ${this.bindingsTable} WHERE profile_id=$1 LIMIT 1`, [profileId]);
      if (bound.rowCount) throw new AgentRuntimeProfileError('Profile 仍被运行场景绑定，请先改绑', 'CONFLICT');
      await client.query(`
        UPDATE ${this.profilesTable}
        SET status='archived', archived_by=$2, archived_at=NOW(), revision=revision+1,
            updated_by=$2, updated_at=NOW()
        WHERE profile_id=$1
      `, [profileId, actor]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
    return (await this.getProfile(profileId))!;
  }

  async listVersions(profileId: string): Promise<AgentRuntimeProfileVersion[]> {
    const result = await this.pool.query<VersionRow>(`
      SELECT * FROM ${this.versionsTable} WHERE profile_id=$1 ORDER BY version_number DESC
    `, [profileId]);
    return result.rows.map(normalizeVersionRow);
  }

  async getVersion(profileVersionId: string): Promise<AgentRuntimeProfileVersion | null> {
    const result = await this.pool.query<VersionRow>(`
      SELECT * FROM ${this.versionsTable} WHERE profile_version_id=$1
    `, [profileVersionId]);
    return result.rows[0] ? normalizeVersionRow(result.rows[0]) : null;
  }

  async listBindings(): Promise<AgentRuntimeProfileBinding[]> {
    const result = await this.pool.query<BindingRow>(`SELECT * FROM ${this.bindingsTable} ORDER BY binding_key`);
    return result.rows.map(normalizeBindingRow);
  }

  async updateBinding(bindingKey: AgentProfileBindingKey, profileId: string, actor: string): Promise<AgentRuntimeProfileBinding> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const locked = await client.query<Pick<ProfileRow, 'status' | 'latest_version_id'>>(
        `SELECT status, latest_version_id FROM ${this.profilesTable} WHERE profile_id=$1 FOR UPDATE`,
        [profileId],
      );
      const profile = locked.rows[0];
      if (!profile) throw new AgentRuntimeProfileError('Profile 不存在', 'NOT_FOUND');
      if (profile.status === 'archived') throw new AgentRuntimeProfileError('不能绑定已归档 Profile', 'PROFILE_ARCHIVED');
      if (!profile.latest_version_id) throw new AgentRuntimeProfileError('只能绑定已有发布版本的 Profile', 'PROFILE_NOT_PUBLISHED');
      const result = await client.query<BindingRow>(`
        INSERT INTO ${this.bindingsTable}(binding_key, profile_id, updated_by, updated_at)
        VALUES ($1,$2,$3,NOW())
        ON CONFLICT (binding_key) DO UPDATE SET
          profile_id=EXCLUDED.profile_id, updated_by=EXCLUDED.updated_by, updated_at=EXCLUDED.updated_at
        RETURNING *
      `, [bindingKey, profileId, actor]);
      await client.query('COMMIT');
      return normalizeBindingRow(result.rows[0]!);
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async resolveBinding(bindingKey: AgentProfileBindingKey): Promise<ResolvedAgentRuntimeProfile | null> {
    const result = await this.pool.query<ResolvedProfileRow>(`
      SELECT p.*, v.profile_version_id, v.profile_id AS version_profile_id,
             v.version_number, v.config_schema_version, v.config_json, v.config_digest,
             v.published_by, v.published_at
      FROM ${this.bindingsTable} b
      JOIN ${this.profilesTable} p ON p.profile_id=b.profile_id
      JOIN ${this.versionsTable} v ON v.profile_version_id=p.latest_version_id
      WHERE b.binding_key=$1 AND p.status='published'
    `, [bindingKey]);
    const row = result.rows[0];
    if (!row) return null;
    return {
      bindingKey,
      profile: normalizeProfileRow({
        ...row,
        latest_version_number: row.version_number,
        latest_version_digest: row.config_digest,
        latest_version_published_by: row.published_by,
        latest_version_published_at: row.published_at,
      }),
      version: normalizeVersionRow({ ...row, profile_id: row.version_profile_id }),
      source: 'database',
    };
  }

  private profileSelectSql(suffix: string): string {
    return `
      SELECT p.*,
             v.version_number AS latest_version_number,
             v.config_digest AS latest_version_digest,
             v.published_by AS latest_version_published_by,
             v.published_at AS latest_version_published_at
      FROM ${this.profilesTable} p
      LEFT JOIN ${this.versionsTable} v ON v.profile_version_id=p.latest_version_id
      ${suffix}
    `;
  }

  private async seedBuiltins(client: { query: (sql: string, values?: unknown[]) => Promise<{ rows: unknown[] }> }): Promise<void> {
    const records = createBuiltinAgentProfileRecords('2026-07-22T00:00:00.000Z');
    await client.query('BEGIN');
    try {
      for (const definition of BUILTIN_AGENT_PROFILES) {
        const version = records.versions.find((item) => item.profileId === definition.profileId)!;
        await client.query(`
          INSERT INTO ${this.profilesTable}
            (profile_id, profile_key, name, description, purpose, status, is_system,
             draft_config, draft_digest, revision, created_by, created_at, updated_by, updated_at)
          VALUES ($1,$2,$3,$4,$5,'published',TRUE,$6::jsonb,$7,1,'system',$8,'system',$8)
          ON CONFLICT (profile_id) DO NOTHING
        `, [definition.profileId, definition.profileKey, definition.name, definition.description, definition.purpose, JSON.stringify(version.config), version.configDigest, version.publishedAt]);
        await client.query(`
          INSERT INTO ${this.versionsTable}
            (profile_version_id, profile_id, version_number, config_schema_version,
             config_json, config_digest, published_by, published_at)
          VALUES ($1,$2,1,$3,$4::jsonb,$5,'system',$6)
          ON CONFLICT (profile_version_id) DO NOTHING
        `, [builtinProfileVersionId(definition.profileId), definition.profileId, AGENT_PROFILE_SCHEMA_VERSION, JSON.stringify(version.config), version.configDigest, version.publishedAt]);
        await client.query(`
          UPDATE ${this.profilesTable}
          SET latest_version_id=$2
          WHERE profile_id=$1 AND latest_version_id IS NULL
        `, [definition.profileId, builtinProfileVersionId(definition.profileId)]);
      }
      for (const [bindingKey, profileId] of Object.entries(BUILTIN_AGENT_PROFILE_BINDINGS)) {
        await client.query(`
          INSERT INTO ${this.bindingsTable}(binding_key, profile_id, updated_by, updated_at)
          VALUES ($1,$2,'system',$3)
          ON CONFLICT (binding_key) DO NOTHING
        `, [bindingKey, profileId, '2026-07-22T00:00:00.000Z']);
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    }
  }
}

function normalizeProfileRow(row: ProfileRow): AgentRuntimeProfile {
  const latestVersion = row.latest_version_id && row.latest_version_number && row.latest_version_digest
    ? {
        profileVersionId: row.latest_version_id,
        profileId: row.profile_id,
        versionNumber: Number(row.latest_version_number),
        configDigest: row.latest_version_digest,
        publishedBy: row.latest_version_published_by ?? 'unknown',
        publishedAt: toIso(row.latest_version_published_at ?? row.updated_at),
      }
    : undefined;
  return {
    profileId: row.profile_id,
    profileKey: row.profile_key,
    name: row.name,
    description: row.description,
    purpose: row.purpose,
    status: row.status as AgentRuntimeProfile['status'],
    systemProfile: row.is_system,
    draftConfig: parseAgentRuntimeProfileConfig(row.draft_config),
    draftDigest: row.draft_digest,
    revision: Number(row.revision),
    ...(latestVersion ? { latestVersion } : {}),
    createdBy: row.created_by,
    createdAt: toIso(row.created_at),
    updatedBy: row.updated_by,
    updatedAt: toIso(row.updated_at),
    ...(row.archived_by ? { archivedBy: row.archived_by } : {}),
    ...(row.archived_at ? { archivedAt: toIso(row.archived_at) } : {}),
  };
}

function normalizeVersionRow(row: VersionRow): AgentRuntimeProfileVersion {
  return {
    profileVersionId: row.profile_version_id,
    profileId: row.profile_id,
    versionNumber: Number(row.version_number),
    configSchemaVersion: Number(row.config_schema_version),
    config: parseAgentRuntimeProfileConfig(row.config_json),
    configDigest: row.config_digest,
    publishedBy: row.published_by,
    publishedAt: toIso(row.published_at),
  };
}

function normalizeBindingRow(row: BindingRow): AgentRuntimeProfileBinding {
  return {
    bindingKey: row.binding_key as AgentProfileBindingKey,
    profileId: row.profile_id,
    updatedBy: row.updated_by,
    updatedAt: toIso(row.updated_at),
  };
}

function defaultDraftConfig() {
  return createBuiltinAgentProfileRecords().profiles[0]!.draftConfig;
}

function requireText(value: string, label: string, max: number): string {
  const text = value.trim();
  if (!text) throw new AgentRuntimeProfileError(`${label}不能为空`, 'INVALID_CONFIG');
  if (text.length > max) throw new AgentRuntimeProfileError(`${label}不能超过 ${max} 字符`, 'INVALID_CONFIG');
  return text;
}

function notDurable(): AgentRuntimeProfileError {
  return new AgentRuntimeProfileError('当前未配置 PostgreSQL，内置 Profile 可运行但不能持久化管理', 'NOT_DURABLE');
}

function conflict(): AgentRuntimeProfileError {
  return new AgentRuntimeProfileError('Profile 已被其他管理员修改，请刷新后重试', 'CONFLICT');
}

function mapPgError(error: unknown, conflictMessage: string): Error {
  if (error instanceof AgentRuntimeProfileError) return error;
  const code = typeof error === 'object' && error ? (error as { code?: string }).code : undefined;
  if (code === '23505') return new AgentRuntimeProfileError(conflictMessage, 'CONFLICT');
  return error instanceof Error ? error : new Error(String(error));
}

function sanitizeIdentifier(value: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(value)) throw new Error(`Invalid table prefix: ${value}`);
  return value;
}

function toIso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function cloneOrNull<T>(value: T | undefined): T | null {
  return value === undefined ? null : clone(value);
}
