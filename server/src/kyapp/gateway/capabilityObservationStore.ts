import {
  governanceTablePrefix,
  type GovernancePgPool,
} from '../../data/governance-schema/index.js';
import type { AppCapabilityEntry } from './snapshot.js';

export type UserCapabilityObservationStatus = 'ready' | 'not_projected' | 'unavailable';

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
    registeredDigest: string,
  ): Promise<UserCapabilityObservation | null>;
  listForInstallation(
    tenantId: string,
    installationId: string,
    registeredDigest: string,
  ): Promise<UserCapabilityObservation[]>;
}

type SnapshotRow = {
  user_id: unknown;
  entries: unknown;
  degraded: unknown;
  updated_at: unknown;
};

function parseEntries(value: unknown): AppCapabilityEntry[] {
  if (Array.isArray(value)) return value as AppCapabilityEntry[];
  if (typeof value !== 'string' || value === '') return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? (parsed as AppCapabilityEntry[]) : [];
  } catch {
    return [];
  }
}

function fromSnapshot(
  row: SnapshotRow,
  tenantId: string,
  installationId: string,
  registeredDigest: string,
): UserCapabilityObservation {
  const enabledCapabilityCount = parseEntries(row.entries).filter(
    (entry) =>
      entry.installationId === installationId && entry.registeredDigest === registeredDigest,
  ).length;
  return {
    tenantId,
    installationId,
    userId: String(row.user_id),
    registeredDigest,
    status:
      enabledCapabilityCount > 0 ? 'ready' : row.degraded === true ? 'unavailable' : 'not_projected',
    enabledCapabilityCount,
    checkedAt: new Date(String(row.updated_at)).toISOString(),
  };
}

/** 从真实会话最终落库的工具快照生成用户能力状态，不另建派生状态表。 */
export class PgKyAppCapabilityObservationReader implements UserCapabilityObservationReader {
  readonly snapshotsTable: string;

  constructor(private readonly pool: GovernancePgPool, tablePrefix?: string) {
    this.snapshotsTable = `${governanceTablePrefix(tablePrefix)}_ky_app_session_tool_snapshots`;
  }

  async get(
    tenantId: string,
    installationId: string,
    userId: string,
    registeredDigest: string,
  ): Promise<UserCapabilityObservation | null> {
    const result = await this.pool.query(
      `SELECT user_id,entries,degraded,updated_at FROM ${this.snapshotsTable}
       WHERE tenant_id=$1 AND user_id=$2
         AND string_to_array(snapshot_key,'|') @> ARRAY[$3 || ':' || $4]
       ORDER BY updated_at DESC,session_id DESC LIMIT 1`,
      [tenantId, userId, installationId, registeredDigest],
    );
    const row = result.rows[0] as SnapshotRow | undefined;
    return row ? fromSnapshot(row, tenantId, installationId, registeredDigest) : null;
  }

  async listForInstallation(
    tenantId: string,
    installationId: string,
    registeredDigest: string,
  ): Promise<UserCapabilityObservation[]> {
    const result = await this.pool.query(
      `SELECT DISTINCT ON (user_id) user_id,entries,degraded,updated_at
       FROM ${this.snapshotsTable}
       WHERE tenant_id=$1
         AND string_to_array(snapshot_key,'|') @> ARRAY[$2 || ':' || $3]
       ORDER BY user_id,updated_at DESC,session_id DESC`,
      [tenantId, installationId, registeredDigest],
    );
    return result.rows.map((row) =>
      fromSnapshot(row as SnapshotRow, tenantId, installationId, registeredDigest),
    );
  }
}
