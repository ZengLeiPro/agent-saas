import pg from 'pg';

const { Pool } = pg;
type PgPool = InstanceType<typeof Pool>;

export type CodexCredentialAvailability = 'available' | 'quota_cooldown' | 'auth_unavailable';

export interface CodexCredentialRuntimeState {
  credentialRef: string;
  availability: CodexCredentialAvailability;
  credentialGeneration: number;
  cooldownUntil?: string;
  lastFailureCode?: string;
}

export interface CodexCredentialRuntimeStateStore {
  get(credentialRef: string): Promise<CodexCredentialRuntimeState | undefined>;
  getGeneration(credentialRef: string): Promise<number | undefined>;
  markQuotaCooldown(
    credentialRef: string,
    cooldownUntil: string,
    failureCode: string,
    credentialGeneration: number,
  ): Promise<void>;
  markAuthUnavailable(
    credentialRef: string,
    failureCode: string,
    credentialGeneration: number,
  ): Promise<void>;
  clear(credentialRef: string, credentialGeneration?: number): Promise<void>;
}

/** file backend 与单元测试使用；PG backend 由工厂切换为共享实现。 */
export class InMemoryCodexCredentialRuntimeStateStore implements CodexCredentialRuntimeStateStore {
  private readonly states = new Map<string, CodexCredentialRuntimeState>();

  async get(credentialRef: string): Promise<CodexCredentialRuntimeState | undefined> {
    const state = this.states.get(credentialRef);
    if (!state) return undefined;
    if (
      state.availability === 'quota_cooldown' &&
      Date.parse(state.cooldownUntil ?? '') <= Date.now()
    ) {
      this.states.set(credentialRef, {
        credentialRef,
        availability: 'available',
        credentialGeneration: state.credentialGeneration,
      });
      return undefined;
    }
    return state.availability === 'available' ? undefined : { ...state };
  }

  async getGeneration(credentialRef: string): Promise<number | undefined> {
    return this.states.get(credentialRef)?.credentialGeneration;
  }

  async markQuotaCooldown(
    credentialRef: string,
    cooldownUntil: string,
    failureCode: string,
    credentialGeneration: number,
  ): Promise<void> {
    const current = this.states.get(credentialRef);
    if (
      current
      && (
        current.credentialGeneration > credentialGeneration
        || (current.credentialGeneration === credentialGeneration && current.availability === 'auth_unavailable')
      )
    ) return;
    this.states.set(credentialRef, {
      credentialRef,
      availability: 'quota_cooldown',
      credentialGeneration,
      cooldownUntil,
      lastFailureCode: failureCode,
    });
  }

  async markAuthUnavailable(
    credentialRef: string,
    failureCode: string,
    credentialGeneration: number,
  ): Promise<void> {
    const current = this.states.get(credentialRef);
    if (current && current.credentialGeneration > credentialGeneration) return;
    this.states.set(credentialRef, {
      credentialRef,
      availability: 'auth_unavailable',
      credentialGeneration,
      lastFailureCode: failureCode,
    });
  }

  async clear(credentialRef: string, credentialGeneration?: number): Promise<void> {
    if (credentialGeneration === undefined) {
      this.states.delete(credentialRef);
      return;
    }
    const current = this.states.get(credentialRef);
    if (current && current.credentialGeneration >= credentialGeneration) return;
    this.states.set(credentialRef, {
      credentialRef,
      availability: 'available',
      credentialGeneration,
    });
  }
}

export async function createCodexCredentialRuntimeStateStore(
  pool: PgPool | undefined,
  config: { backend: string; tablePrefix?: string } | undefined,
): Promise<CodexCredentialRuntimeStateStore> {
  if (!pool) return new InMemoryCodexCredentialRuntimeStateStore();
  const store = new PgCodexCredentialRuntimeStateStore(
    pool,
    config?.backend === 'pg' ? (config.tablePrefix ?? 'runtime') : 'runtime',
  );
  await store.init();
  return store;
}

export class PgCodexCredentialRuntimeStateStore implements CodexCredentialRuntimeStateStore {
  readonly table: string;

  constructor(
    private readonly pool: PgPool,
    tablePrefix = 'runtime',
  ) {
    this.table = `${sanitizeIdentifier(tablePrefix)}_codex_credential_runtime_state`;
  }

  async init(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('SELECT pg_advisory_lock(hashtext($1))', [`${this.table}:init`]);
      await client.query(`
        CREATE TABLE IF NOT EXISTS ${this.table} (
          credential_ref TEXT PRIMARY KEY,
          availability TEXT NOT NULL,
          credential_generation BIGINT NOT NULL DEFAULT 0,
          cooldown_until TIMESTAMPTZ,
          last_failure_code TEXT,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          CONSTRAINT ${this.table}_availability_check
            CHECK (availability IN ('available', 'quota_cooldown', 'auth_unavailable'))
        )
      `);
      await client.query(
        `CREATE INDEX IF NOT EXISTS ${this.table}_cooldown_idx ON ${this.table} (cooldown_until)`,
      );
    } finally {
      await client
        .query('SELECT pg_advisory_unlock(hashtext($1))', [`${this.table}:init`])
        .catch(() => undefined);
      client.release();
    }
  }

  async get(credentialRef: string): Promise<CodexCredentialRuntimeState | undefined> {
    await this.pool.query(
      `UPDATE ${this.table}
          SET availability = 'available', cooldown_until = NULL, last_failure_code = NULL, updated_at = now()
        WHERE credential_ref = $1 AND availability = 'quota_cooldown' AND cooldown_until <= now()`,
      [credentialRef],
    );
    const result = await this.pool.query<{
      credential_ref: string;
      availability: CodexCredentialAvailability;
      credential_generation: string | number;
      cooldown_until: Date | string | null;
      last_failure_code: string | null;
    }>(
      `SELECT credential_ref, availability, credential_generation, cooldown_until, last_failure_code
         FROM ${this.table} WHERE credential_ref = $1`,
      [credentialRef],
    );
    const row = result.rows[0];
    if (!row || row.availability === 'available') return undefined;
    return {
      credentialRef: row.credential_ref,
      availability: row.availability,
      credentialGeneration: Number(row.credential_generation),
      ...(row.cooldown_until ? { cooldownUntil: new Date(row.cooldown_until).toISOString() } : {}),
      ...(row.last_failure_code ? { lastFailureCode: row.last_failure_code } : {}),
    };
  }

  async getGeneration(credentialRef: string): Promise<number | undefined> {
    const result = await this.pool.query<{ credential_generation: string | number }>(
      `SELECT credential_generation FROM ${this.table} WHERE credential_ref = $1`,
      [credentialRef],
    );
    const value = result.rows[0]?.credential_generation;
    return value === undefined ? undefined : Number(value);
  }

  async markQuotaCooldown(
    credentialRef: string,
    cooldownUntil: string,
    failureCode: string,
    credentialGeneration: number,
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO ${this.table}
         (credential_ref, availability, credential_generation, cooldown_until, last_failure_code, updated_at)
       VALUES ($1, 'quota_cooldown', $2, $3, $4, now())
       ON CONFLICT (credential_ref) DO UPDATE SET
         availability = EXCLUDED.availability,
         credential_generation = EXCLUDED.credential_generation,
         cooldown_until = EXCLUDED.cooldown_until,
         last_failure_code = EXCLUDED.last_failure_code,
         updated_at = now()
       WHERE ${this.table}.credential_generation < EXCLUDED.credential_generation
          OR (${this.table}.credential_generation = EXCLUDED.credential_generation
              AND ${this.table}.availability <> 'auth_unavailable')`,
      [credentialRef, credentialGeneration, cooldownUntil, failureCode],
    );
  }

  async markAuthUnavailable(
    credentialRef: string,
    failureCode: string,
    credentialGeneration: number,
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO ${this.table}
         (credential_ref, availability, credential_generation, cooldown_until, last_failure_code, updated_at)
       VALUES ($1, 'auth_unavailable', $2, NULL, $3, now())
       ON CONFLICT (credential_ref) DO UPDATE SET
         availability = EXCLUDED.availability,
         credential_generation = EXCLUDED.credential_generation,
         cooldown_until = NULL,
         last_failure_code = EXCLUDED.last_failure_code,
         updated_at = now()
       WHERE ${this.table}.credential_generation <= EXCLUDED.credential_generation`,
      [credentialRef, credentialGeneration, failureCode],
    );
  }

  async clear(credentialRef: string, credentialGeneration?: number): Promise<void> {
    if (credentialGeneration === undefined) {
      await this.pool.query(`DELETE FROM ${this.table} WHERE credential_ref = $1`, [credentialRef]);
      return;
    }
    await this.pool.query(
      `INSERT INTO ${this.table}
         (credential_ref, availability, credential_generation, cooldown_until, last_failure_code, updated_at)
       VALUES ($1, 'available', $2, NULL, NULL, now())
       ON CONFLICT (credential_ref) DO UPDATE SET
         availability = EXCLUDED.availability,
         credential_generation = EXCLUDED.credential_generation,
         cooldown_until = NULL,
         last_failure_code = NULL,
         updated_at = now()
       WHERE ${this.table}.credential_generation < EXCLUDED.credential_generation`,
      [credentialRef, credentialGeneration],
    );
  }
}

function sanitizeIdentifier(value: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(value)) throw new Error(`Invalid SQL identifier: ${value}`);
  return value;
}
