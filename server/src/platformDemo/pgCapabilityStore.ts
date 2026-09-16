import { governanceTablePrefix, type GovernancePgPool } from '../data/governance-schema/index.js';
import type { PlatformDemoCapability, PlatformDemoCapabilityGrant } from './types.js';
import { PLATFORM_DEMO_CAPABILITY } from './types.js';
import type { PlatformDemoCapabilityStore } from './capabilityStore.js';

export interface PgPlatformDemoCapabilityStoreOptions {
  pool: GovernancePgPool;
  tablePrefix?: string;
}

function rowToGrant(row: Record<string, unknown>): PlatformDemoCapabilityGrant {
  return {
    tenantId: String(row.tenant_id),
    userId: String(row.user_id),
    capability: String(row.capability) as PlatformDemoCapability,
    grantedBy: String(row.granted_by),
    grantedAt: row.granted_at instanceof Date ? row.granted_at.toISOString() : String(row.granted_at),
    ...(row.revoked_at
      ? {
          revokedAt: row.revoked_at instanceof Date ? row.revoked_at.toISOString() : String(row.revoked_at),
        }
      : {}),
    ...(row.revoked_by ? { revokedBy: String(row.revoked_by) } : {}),
  };
}

/** Postgres-backed membership capability grants (v49 table). */
export class PgPlatformDemoCapabilityStore implements PlatformDemoCapabilityStore {
  readonly grantsTable: string;

  constructor(private readonly options: PgPlatformDemoCapabilityStoreOptions) {
    const prefix = governanceTablePrefix(options.tablePrefix);
    this.grantsTable = `${prefix}_membership_capability_grants`;
  }

  async getGrant(
    tenantId: string,
    userId: string,
    capability: PlatformDemoCapability = PLATFORM_DEMO_CAPABILITY,
  ): Promise<PlatformDemoCapabilityGrant | null> {
    const result = await this.options.pool.query(
      `SELECT * FROM ${this.grantsTable}
       WHERE tenant_id=$1 AND user_id=$2 AND capability=$3 AND revoked_at IS NULL
       LIMIT 1`,
      [tenantId, userId, capability],
    );
    const row = result.rows[0];
    return row ? rowToGrant(row) : null;
  }

  async listGrants(tenantId?: string): Promise<PlatformDemoCapabilityGrant[]> {
    const result = tenantId
      ? await this.options.pool.query(
          `SELECT * FROM ${this.grantsTable}
           WHERE tenant_id=$1 AND revoked_at IS NULL
           ORDER BY granted_at DESC, user_id ASC`,
          [tenantId],
        )
      : await this.options.pool.query(
          `SELECT * FROM ${this.grantsTable}
           WHERE revoked_at IS NULL
           ORDER BY granted_at DESC, tenant_id ASC, user_id ASC`,
        );
    return result.rows.map(rowToGrant);
  }

  async grant(input: {
    tenantId: string;
    userId: string;
    grantedBy: string;
    capability?: PlatformDemoCapability;
    now?: Date;
  }): Promise<PlatformDemoCapabilityGrant> {
    const capability = input.capability ?? PLATFORM_DEMO_CAPABILITY;
    const now = input.now ?? new Date();
    const result = await this.options.pool.query(
      `INSERT INTO ${this.grantsTable} (
         tenant_id, user_id, capability, granted_by, granted_at, revoked_at, revoked_by
       ) VALUES ($1,$2,$3,$4,$5,NULL,NULL)
       ON CONFLICT (tenant_id, user_id, capability) DO UPDATE SET
         granted_by = EXCLUDED.granted_by,
         granted_at = EXCLUDED.granted_at,
         revoked_at = NULL,
         revoked_by = NULL
       RETURNING *`,
      [input.tenantId, input.userId, capability, input.grantedBy, now],
    );
    return rowToGrant(result.rows[0]);
  }

  async revoke(input: {
    tenantId: string;
    userId: string;
    revokedBy: string;
    capability?: PlatformDemoCapability;
    now?: Date;
  }): Promise<PlatformDemoCapabilityGrant | null> {
    const capability = input.capability ?? PLATFORM_DEMO_CAPABILITY;
    const now = input.now ?? new Date();
    const result = await this.options.pool.query(
      `UPDATE ${this.grantsTable}
       SET revoked_at=$4, revoked_by=$5
       WHERE tenant_id=$1 AND user_id=$2 AND capability=$3 AND revoked_at IS NULL
       RETURNING *`,
      [input.tenantId, input.userId, capability, now, input.revokedBy],
    );
    const row = result.rows[0];
    return row ? rowToGrant(row) : null;
  }
}
