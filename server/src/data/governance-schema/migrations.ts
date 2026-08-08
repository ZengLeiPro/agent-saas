import type pg from 'pg';

export type GovernancePgPool = pg.Pool;

type GovernanceMigration = {
  version: number;
  statements: string[];
};

const IDENTIFIER_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

export function governanceTablePrefix(value = 'runtime'): string {
  if (!IDENTIFIER_PATTERN.test(value)) {
    throw new Error(`Invalid PostgreSQL identifier: ${value}`);
  }
  return value;
}

function migrations(prefix: string): GovernanceMigration[] {
  const versions = `${prefix}_governance_schema_versions`;
  const audit = `${prefix}_governance_audit_events`;
  const memberships = `${prefix}_tenant_memberships`;
  const platformAdmins = `${prefix}_platform_admins`;
  const issues = `${prefix}_governance_migration_issues`;
  const entitlementSets = `${prefix}_tenant_entitlement_sets`;
  const entitlementScopes = `${prefix}_entitlement_resource_scopes`;
  const entitlementItems = `${prefix}_entitlement_resource_items`;
  const policies = `${prefix}_tenant_policies`;

  return [
    {
      version: 1,
      statements: [
        `CREATE TABLE IF NOT EXISTS ${audit} (
          sequence BIGSERIAL UNIQUE NOT NULL,
          audit_id TEXT PRIMARY KEY,
          correlation_id TEXT NOT NULL,
          change_id TEXT,
          actor_type TEXT NOT NULL,
          actor_user_id TEXT NOT NULL,
          actor_persona TEXT NOT NULL,
          actor_tenant_id TEXT,
          action TEXT NOT NULL,
          target_type TEXT NOT NULL,
          target_id TEXT NOT NULL,
          target_tenant_id TEXT,
          purpose TEXT NOT NULL,
          reason TEXT,
          before_digest TEXT,
          after_digest TEXT,
          result TEXT NOT NULL CHECK (result IN ('intent', 'succeeded', 'failed')),
          occurred_at TIMESTAMPTZ NOT NULL,
          metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb
        )`,
        `CREATE INDEX IF NOT EXISTS ${audit}_correlation_idx
          ON ${audit} (correlation_id, sequence)`,
        `CREATE INDEX IF NOT EXISTS ${audit}_target_idx
          ON ${audit} (target_tenant_id, target_type, target_id, occurred_at DESC)`,
      ],
    },
    {
      version: 2,
      statements: [
        `CREATE TABLE IF NOT EXISTS ${memberships} (
          tenant_id TEXT NOT NULL,
          user_id TEXT NOT NULL,
          persona TEXT NOT NULL CHECK (persona IN ('member', 'org_admin')),
          is_owner BOOLEAN NOT NULL DEFAULT FALSE,
          status TEXT NOT NULL CHECK (status IN ('active', 'disabled')),
          source TEXT NOT NULL CHECK (source IN ('legacy_projection', 'governance')),
          version BIGINT NOT NULL DEFAULT 1 CHECK (version >= 1),
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          created_by TEXT NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_by TEXT NOT NULL,
          PRIMARY KEY (tenant_id, user_id),
          UNIQUE (user_id),
          CHECK (NOT is_owner OR persona = 'org_admin')
        )`,
        `CREATE INDEX IF NOT EXISTS ${memberships}_tenant_status_idx
          ON ${memberships} (tenant_id, status, persona, is_owner)`,
        `CREATE TABLE IF NOT EXISTS ${platformAdmins} (
          user_id TEXT PRIMARY KEY,
          status TEXT NOT NULL CHECK (status IN ('active', 'disabled')),
          source TEXT NOT NULL CHECK (source IN ('legacy_projection', 'governance')),
          version BIGINT NOT NULL DEFAULT 1 CHECK (version >= 1),
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          created_by TEXT NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_by TEXT NOT NULL
        )`,
        `CREATE INDEX IF NOT EXISTS ${platformAdmins}_status_idx
          ON ${platformAdmins} (status)`,
        `CREATE TABLE IF NOT EXISTS ${issues} (
          issue_id TEXT PRIMARY KEY,
          issue_type TEXT NOT NULL,
          tenant_id TEXT,
          resource_type TEXT,
          resource_id TEXT,
          legacy_key TEXT,
          detail_json JSONB NOT NULL DEFAULT '{}'::jsonb,
          status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'ignored')),
          version BIGINT NOT NULL DEFAULT 1 CHECK (version >= 1),
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          created_by TEXT NOT NULL,
          resolved_at TIMESTAMPTZ,
          resolved_by TEXT
        )`,
        `CREATE UNIQUE INDEX IF NOT EXISTS ${issues}_open_identity_uidx
          ON ${issues} (
            issue_type,
            COALESCE(tenant_id, ''),
            COALESCE(resource_type, ''),
            COALESCE(resource_id, ''),
            COALESCE(legacy_key, '')
          ) WHERE status = 'open'`,
        `CREATE INDEX IF NOT EXISTS ${issues}_tenant_status_idx
          ON ${issues} (tenant_id, status, issue_type, created_at)`,
      ],
    },
    {
      version: 3,
      statements: [
        `CREATE TABLE IF NOT EXISTS ${entitlementSets} (
          tenant_id TEXT PRIMARY KEY,
          source TEXT NOT NULL CHECK (source IN ('plan_default', 'platform_override', 'legacy_migrated')),
          status TEXT NOT NULL CHECK (status IN ('trial', 'active', 'suspended', 'expired')),
          effective_from TIMESTAMPTZ,
          effective_to TIMESTAMPTZ,
          limits_json JSONB NOT NULL DEFAULT '{}'::jsonb,
          version BIGINT NOT NULL DEFAULT 1 CHECK (version >= 1),
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          created_by TEXT NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_by TEXT NOT NULL,
          update_reason TEXT NOT NULL
        )`,
        `CREATE INDEX IF NOT EXISTS ${entitlementSets}_status_idx
          ON ${entitlementSets} (status, effective_to)`,
        `CREATE TABLE IF NOT EXISTS ${entitlementScopes} (
          tenant_id TEXT NOT NULL,
          resource_type TEXT NOT NULL,
          mode TEXT NOT NULL CHECK (mode IN ('all', 'selected')),
          source TEXT NOT NULL CHECK (source IN ('legacy_projection', 'governance')),
          version BIGINT NOT NULL DEFAULT 1 CHECK (version >= 1),
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          created_by TEXT NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_by TEXT NOT NULL,
          PRIMARY KEY (tenant_id, resource_type)
        )`,
        `CREATE TABLE IF NOT EXISTS ${entitlementItems} (
          tenant_id TEXT NOT NULL,
          resource_type TEXT NOT NULL,
          resource_id TEXT NOT NULL,
          source TEXT NOT NULL CHECK (source IN ('legacy_projection', 'governance')),
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          created_by TEXT NOT NULL,
          PRIMARY KEY (tenant_id, resource_type, resource_id),
          FOREIGN KEY (tenant_id, resource_type)
            REFERENCES ${entitlementScopes}(tenant_id, resource_type)
            ON DELETE CASCADE
        )`,
        `CREATE INDEX IF NOT EXISTS ${entitlementItems}_resource_idx
          ON ${entitlementItems} (resource_type, resource_id, tenant_id)`,
        `CREATE TABLE IF NOT EXISTS ${policies} (
          tenant_id TEXT NOT NULL,
          policy_key TEXT NOT NULL,
          value_json JSONB NOT NULL,
          source TEXT NOT NULL CHECK (source IN ('legacy_projection', 'governance')),
          version BIGINT NOT NULL DEFAULT 1 CHECK (version >= 1),
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          created_by TEXT NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_by TEXT NOT NULL,
          PRIMARY KEY (tenant_id, policy_key)
        )`,
        `CREATE INDEX IF NOT EXISTS ${policies}_key_idx
          ON ${policies} (policy_key, tenant_id)`,
      ],
    },
  ];
}

export class PgGovernanceMigrationRunner {
  readonly schemaVersionsTable: string;
  readonly prefix: string;

  constructor(private readonly pool: GovernancePgPool, tablePrefix?: string) {
    this.prefix = governanceTablePrefix(tablePrefix);
    this.schemaVersionsTable = `${this.prefix}_governance_schema_versions`;
  }

  async run(): Promise<void> {
    const client = await this.pool.connect();
    const lockKey = `${this.schemaVersionsTable}:migrate`;
    try {
      await client.query('SELECT pg_advisory_lock(hashtext($1))', [lockKey]);
      await client.query(`
        CREATE TABLE IF NOT EXISTS ${this.schemaVersionsTable} (
          version INTEGER PRIMARY KEY,
          applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      const appliedResult = await client.query<{ version: number }>(
        `SELECT version FROM ${this.schemaVersionsTable} ORDER BY version`,
      );
      const applied = new Set(appliedResult.rows.map(row => Number(row.version)));

      for (const migration of migrations(this.prefix)) {
        if (applied.has(migration.version)) continue;
        await client.query('BEGIN');
        try {
          for (const statement of migration.statements) {
            await client.query(statement);
          }
          await client.query(
            `INSERT INTO ${this.schemaVersionsTable} (version) VALUES ($1)`,
            [migration.version],
          );
          await client.query('COMMIT');
        } catch (error) {
          await client.query('ROLLBACK').catch(() => undefined);
          throw error;
        }
      }
    } finally {
      await client.query('SELECT pg_advisory_unlock(hashtext($1))', [lockKey]).catch(() => undefined);
      client.release();
    }
  }
}
