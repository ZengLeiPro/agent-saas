import {
  governanceTablePrefix,
  type GovernancePgPool,
} from '../../data/governance-schema/index.js';

export type UserCapabilityObservationStatus =
  'ready' | 'insufficient_scope' | 'capacity_limited' | 'unavailable';

export interface UserCapabilityObservation {
  tenantId: string;
  installationId: string;
  userId: string;
  registeredDigest: string;
  status: UserCapabilityObservationStatus;
  enabledCapabilityCount: number;
  checkedAt: string;
}

export interface UserCapabilityObservationReader {
  get(
    tenantId: string,
    installationId: string,
    userId: string,
  ): Promise<UserCapabilityObservation | null>;
  listForInstallation(
    tenantId: string,
    installationId: string,
  ): Promise<UserCapabilityObservation[]>;
}

function fromRow(row: Record<string, unknown>): UserCapabilityObservation {
  return {
    tenantId: String(row.tenant_id),
    installationId: String(row.installation_id),
    userId: String(row.user_id),
    registeredDigest: String(row.registered_digest),
    status: row.status as UserCapabilityObservationStatus,
    enabledCapabilityCount: Number(row.enabled_capability_count),
    checkedAt: new Date(String(row.checked_at)).toISOString(),
  };
}

export class PgKyAppUserCapabilityObservationStore implements UserCapabilityObservationReader {
  readonly table: string;

  constructor(
    private readonly pool: GovernancePgPool,
    tablePrefix?: string,
  ) {
    this.table = `${governanceTablePrefix(tablePrefix)}_ky_app_user_capability_observations`;
  }

  async record(input: Omit<UserCapabilityObservation, 'checkedAt'>): Promise<void> {
    await this.pool.query(
      `INSERT INTO ${this.table}
        (tenant_id,installation_id,user_id,registered_digest,status,enabled_capability_count,checked_at)
       VALUES ($1,$2,$3,$4,$5,$6,NOW())
       ON CONFLICT (tenant_id,installation_id,user_id) DO UPDATE SET
         registered_digest=EXCLUDED.registered_digest,status=EXCLUDED.status,
         enabled_capability_count=EXCLUDED.enabled_capability_count,checked_at=NOW()`,
      [
        input.tenantId,
        input.installationId,
        input.userId,
        input.registeredDigest,
        input.status,
        input.enabledCapabilityCount,
      ],
    );
  }

  async get(tenantId: string, installationId: string, userId: string) {
    const result = await this.pool.query(
      `SELECT * FROM ${this.table}
       WHERE tenant_id=$1 AND installation_id=$2 AND user_id=$3`,
      [tenantId, installationId, userId],
    );
    return result.rows[0] ? fromRow(result.rows[0]) : null;
  }

  async listForInstallation(tenantId: string, installationId: string) {
    const result = await this.pool.query(
      `SELECT * FROM ${this.table}
       WHERE tenant_id=$1 AND installation_id=$2 ORDER BY user_id`,
      [tenantId, installationId],
    );
    return result.rows.map(fromRow);
  }
}
