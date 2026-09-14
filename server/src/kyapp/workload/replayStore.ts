import {
  PgGovernanceMigrationRunner,
  governanceTablePrefix,
  type GovernancePgPool,
} from '../../data/governance-schema/index.js';

export interface ReplayReservationStore {
  reserve(input: {
    keyId: string;
    jti: string;
    kind: 'client_assertion' | 'dpop';
    expiresAt: Date;
  }): Promise<boolean>;
  deleteExpired(now: Date): Promise<number>;
  reserveMany(
    inputs: Array<{
      keyId: string;
      jti: string;
      kind: 'client_assertion' | 'dpop';
      expiresAt: Date;
    }>,
  ): Promise<'reserved' | 'client_assertion_replayed' | 'dpop_replayed'>;
}

export class PgReplayReservationStore implements ReplayReservationStore {
  readonly table: string;
  private readonly tablePrefix?: string;

  constructor(private readonly options: { pool: GovernancePgPool; tablePrefix?: string }) {
    this.tablePrefix = options.tablePrefix;
    this.table = `${governanceTablePrefix(options.tablePrefix)}_ky_app_dpop_replays`;
  }

  async init(): Promise<void> {
    await new PgGovernanceMigrationRunner(this.options.pool, this.tablePrefix).run();
  }

  async reserve(input: {
    keyId: string;
    jti: string;
    kind: 'client_assertion' | 'dpop';
    expiresAt: Date;
  }): Promise<boolean> {
    const result = await this.options.pool.query(
      `INSERT INTO ${this.table}(key_id,jti,proof_kind,expires_at)
       VALUES ($1,$2,$3,$4) ON CONFLICT (key_id,jti) DO NOTHING RETURNING key_id`,
      [input.keyId, input.jti, input.kind, input.expiresAt],
    );
    return result.rowCount === 1;
  }

  async deleteExpired(now: Date): Promise<number> {
    const result = await this.options.pool.query(
      `DELETE FROM ${this.table} WHERE expires_at <= $1`,
      [now],
    );
    return result.rowCount ?? 0;
  }

  async reserveMany(
    inputs: Array<{
      keyId: string;
      jti: string;
      kind: 'client_assertion' | 'dpop';
      expiresAt: Date;
    }>,
  ): Promise<'reserved' | 'client_assertion_replayed' | 'dpop_replayed'> {
    const client = await this.options.pool.connect();
    try {
      await client.query('BEGIN');
      for (const input of inputs) {
        const result = await client.query(
          `INSERT INTO ${this.table}(key_id,jti,proof_kind,expires_at)
           VALUES ($1,$2,$3,$4) ON CONFLICT (key_id,jti) DO NOTHING RETURNING key_id`,
          [input.keyId, input.jti, input.kind, input.expiresAt],
        );
        if (result.rowCount !== 1) {
          await client.query('ROLLBACK');
          return input.kind === 'client_assertion' ? 'client_assertion_replayed' : 'dpop_replayed';
        }
      }
      await client.query('COMMIT');
      return 'reserved';
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}
