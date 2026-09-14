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
  readonly installationsTable: string;
  private readonly tablePrefix?: string;

  constructor(private readonly options: { pool: GovernancePgPool; tablePrefix?: string }) {
    this.tablePrefix = options.tablePrefix;
    const prefix = governanceTablePrefix(options.tablePrefix);
    this.table = `${prefix}_ky_app_deployment_keys`;
    this.installationsTable = `${prefix}_ky_app_tenant_system_installations`;
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

  async prepareNext(input: {
    installationId: string;
    keyId: string;
    deploymentId: string;
    publicJwk: P256PublicJwk;
    generation: number;
  }): Promise<DeploymentKeyRecord> {
    const result = await this.options.pool.query(
      `INSERT INTO ${this.table}
         (installation_id,key_id,deployment_id,public_jwk_json,status,generation)
       SELECT $1,$2,$3,$4::jsonb,'next',$5::bigint
       WHERE EXISTS (SELECT 1 FROM ${this.table}
         WHERE installation_id=$1 AND status='current' AND deployment_id=$3 AND generation=$5::bigint-1)
       ON CONFLICT (installation_id,key_id) DO UPDATE SET
         public_jwk_json=EXCLUDED.public_jwk_json,updated_at=clock_timestamp()
       WHERE ${this.table}.status='next' AND ${this.table}.deployment_id=EXCLUDED.deployment_id
         AND ${this.table}.generation=EXCLUDED.generation
       RETURNING *`,
      [
        input.installationId,
        input.keyId,
        input.deploymentId,
        JSON.stringify(input.publicJwk),
        input.generation,
      ],
    );
    if (!result.rows[0]) throw new Error('key_prepare_conflict');
    return rowToKey(result.rows[0] as Row);
  }

  async next(installationId: string): Promise<DeploymentKeyRecord | null> {
    const result = await this.options.pool.query(
      `SELECT * FROM ${this.table} WHERE installation_id=$1 AND status='next'`,
      [installationId],
    );
    return result.rows[0] ? rowToKey(result.rows[0] as Row) : null;
  }

  async commitNext(input: {
    installationId: string;
    currentKeyId: string;
    nextKeyId: string;
    generation: number;
    previousAcceptUntil: Date;
  }): Promise<DeploymentKeyRecord> {
    const client = await this.options.pool.connect();
    try {
      await client.query('BEGIN');
      const installation = await client.query(
        `SELECT current_key_id,identity_generation FROM ${this.installationsTable} WHERE installation_id=$1 FOR UPDATE`,
        [input.installationId],
      );
      if (
        installation.rows[0]?.current_key_id !== input.currentKeyId ||
        Number(installation.rows[0]?.identity_generation) + 1 !== input.generation
      )
        throw new Error('key_commit_conflict');
      const demoted = await client.query(
        `UPDATE ${this.table} SET status='previous',accept_until=$3,updated_at=clock_timestamp()
         WHERE installation_id=$1 AND key_id=$2 AND status='current'`,
        [input.installationId, input.currentKeyId, input.previousAcceptUntil],
      );
      if (demoted.rowCount !== 1) throw new Error('key_commit_conflict');
      const promoted = await client.query(
        `UPDATE ${this.table} SET status='current',updated_at=clock_timestamp()
         WHERE installation_id=$1 AND key_id=$2 AND status='next' AND generation=$3 RETURNING *`,
        [input.installationId, input.nextKeyId, input.generation],
      );
      if (!promoted.rows[0]) throw new Error('key_commit_conflict');
      const updated = await client.query(
        `UPDATE ${this.installationsTable} SET current_key_id=$2,identity_generation=$3,
           state_version=state_version+1,updated_at=clock_timestamp(),updated_by='__ky_app_key_rotation__'
         WHERE installation_id=$1 AND current_key_id=$4 AND identity_generation=$3-1 RETURNING installation_id`,
        [input.installationId, input.nextKeyId, input.generation, input.currentKeyId],
      );
      if (!updated.rows[0]) throw new Error('key_commit_conflict');
      await client.query('COMMIT');
      return rowToKey(promoted.rows[0] as Row);
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async revokePrevious(installationId: string): Promise<number> {
    const result = await this.options.pool.query(
      `UPDATE ${this.table} SET status='revoked',revoked_at=clock_timestamp(),
         accept_until=NULL,updated_at=clock_timestamp()
       WHERE installation_id=$1 AND status='previous'`,
      [installationId],
    );
    return result.rowCount ?? 0;
  }
}
