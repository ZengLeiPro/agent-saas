import type { P256PublicJwk } from '@kaiyan/ky-app-contract';

import {
  PgGovernanceMigrationRunner,
  governanceTablePrefix,
  type GovernancePgPool,
} from '../../data/governance-schema/index.js';
import type { DeploymentKeyRecord } from '../enrollment/types.js';

type Row = Record<string, unknown>;
const nullable = (value: unknown): string | null =>
  value === null || value === undefined
    ? null
    : value instanceof Date
      ? value.toISOString()
      : String(value);
const rowToKey = (row: Row): DeploymentKeyRecord => ({
  installationId: String(row.installation_id),
  keyId: String(row.key_id),
  deploymentId: String(row.deployment_id),
  publicJwk: row.public_jwk_json as P256PublicJwk,
  status: String(row.status) as DeploymentKeyRecord['status'],
  notBefore: nullable(row.not_before) ?? new Date(0).toISOString(),
  acceptUntil: nullable(row.accept_until),
  revokedAt: nullable(row.revoked_at),
  generation: Number(row.generation),
});

export class PgDeploymentKeyStore {
  readonly table: string;
  private readonly tablePrefix?: string;

  constructor(private readonly options: { pool: GovernancePgPool; tablePrefix?: string }) {
    this.tablePrefix = options.tablePrefix;
    this.table = `${governanceTablePrefix(options.tablePrefix)}_ky_app_deployment_keys`;
  }

  async init(): Promise<void> {
    await new PgGovernanceMigrationRunner(this.options.pool, this.tablePrefix).run();
  }

  async get(installationId: string, keyId: string): Promise<DeploymentKeyRecord | null> {
    const result = await this.options.pool.query(
      `SELECT * FROM ${this.table} WHERE installation_id=$1 AND key_id=$2`,
      [installationId, keyId],
    );
    return result.rows[0] ? rowToKey(result.rows[0] as Row) : null;
  }

  async current(installationId: string): Promise<DeploymentKeyRecord | null> {
    const result = await this.options.pool.query(
      `SELECT * FROM ${this.table} WHERE installation_id=$1 AND status='current'`,
      [installationId],
    );
    return result.rows[0] ? rowToKey(result.rows[0] as Row) : null;
  }

  async listAccepted(installationId: string, now: Date): Promise<DeploymentKeyRecord[]> {
    const result = await this.options.pool.query(
      `SELECT * FROM ${this.table}
       WHERE installation_id=$1 AND (
         status IN ('current','next') OR (status='previous' AND accept_until > $2)
       ) ORDER BY generation DESC`,
      [installationId, now],
    );
    return result.rows.map((row) => rowToKey(row as Row));
  }

  async revokeAll(installationId: string): Promise<number> {
    const result = await this.options.pool.query(
      `UPDATE ${this.table} SET status='revoked',revoked_at=clock_timestamp(),updated_at=clock_timestamp()
       WHERE installation_id=$1 AND status <> 'revoked'`,
      [installationId],
    );
    return result.rowCount ?? 0;
  }
}
