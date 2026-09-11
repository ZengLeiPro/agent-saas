import pg from 'pg';
const { Pool } = pg;
type PgPool = InstanceType<typeof Pool>;
/** A generation-only fence; no token, hash of a token, or account identity is persisted here. */
export interface SubscriptionRefreshJournal {
  get(ref: string): Promise<number | undefined>;
  begin(ref: string, generation: number): Promise<void>;
  clear(ref: string, generation?: number): Promise<void>;
}
export class InMemorySubscriptionRefreshJournal implements SubscriptionRefreshJournal {
  private readonly pending = new Map<string, number>();
  async get(ref: string) {
    return this.pending.get(ref);
  }
  async begin(ref: string, generation: number) {
    if (this.pending.has(ref)) throw new Error('subscription refresh is already pending');
    this.pending.set(ref, generation);
  }
  async clear(ref: string, generation?: number) {
    if (generation === undefined || this.pending.get(ref) === generation) this.pending.delete(ref);
  }
}
export class PgGrokRefreshJournal implements SubscriptionRefreshJournal {
  readonly table: string;
  constructor(
    private readonly pool: PgPool,
    prefix = 'runtime',
  ) {
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(prefix))
      throw new Error('Invalid runtime table prefix');
    this.table = `${prefix.slice(0, 30)}_grok_credential_refresh_journal`;
  }
  async init(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('SELECT pg_advisory_lock(hashtext($1))', [`${this.table}:init`]);
      await client.query(`CREATE TABLE IF NOT EXISTS ${this.table} (
        credential_ref TEXT PRIMARY KEY, credential_generation BIGINT NOT NULL CHECK (credential_generation > 0),
        started_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);
    } finally {
      await client
        .query('SELECT pg_advisory_unlock(hashtext($1))', [`${this.table}:init`])
        .catch(() => undefined);
      client.release();
    }
  }
  async get(ref: string): Promise<number | undefined> {
    const result = await this.pool.query(
      `SELECT credential_generation FROM ${this.table} WHERE credential_ref = $1`,
      [ref],
    );
    if (!result.rows[0]) return undefined;
    const generation = Number(result.rows[0].credential_generation);
    if (!Number.isSafeInteger(generation) || generation < 1)
      throw new Error('Invalid refresh generation');
    return generation;
  }
  async begin(ref: string, generation: number): Promise<void> {
    await this.pool.query(
      `INSERT INTO ${this.table} (credential_ref, credential_generation) VALUES ($1, $2)`,
      [ref, generation],
    );
  }
  async clear(ref: string, generation?: number): Promise<void> {
    await this.pool.query(
      `DELETE FROM ${this.table} WHERE credential_ref = $1${generation === undefined ? '' : ' AND credential_generation = $2'}`,
      generation === undefined ? [ref] : [ref, generation],
    );
  }
}
export async function createGrokRefreshJournal(
  pool: PgPool | undefined,
  prefix?: string,
): Promise<SubscriptionRefreshJournal> {
  if (!pool) return new InMemorySubscriptionRefreshJournal();
  const journal = new PgGrokRefreshJournal(pool, prefix);
  await journal.init();
  return journal;
}
