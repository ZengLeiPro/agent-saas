export interface SubscriptionCredentialLock {
  runExclusive<T>(key: string, fn: () => Promise<T>): Promise<T>;
}

interface PgLockClient {
  query(sql: string, values?: unknown[]): Promise<unknown>;
  release(): void;
}

export interface PgLockPool {
  connect(): Promise<PgLockClient>;
}

export interface PgSubscriptionLockScope {
  <T>(client: PgLockClient, action: () => Promise<T>): Promise<T>;
}

export class PgSubscriptionCredentialLock implements SubscriptionCredentialLock {
  constructor(
    private readonly pool: PgLockPool,
    private readonly scope?: PgSubscriptionLockScope,
  ) {}

  async runExclusive<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('SELECT pg_advisory_lock(hashtext($1))', [key]);
      return await (this.scope ? this.scope(client, fn) : fn());
    } finally {
      await client.query('SELECT pg_advisory_unlock(hashtext($1))', [key]).catch(() => undefined);
      client.release();
    }
  }
}

export class LocalSubscriptionCredentialLock implements SubscriptionCredentialLock {
  private readonly tails = new Map<string, Promise<void>>();

  async runExclusive<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.catch(() => undefined).then(() => current);
    this.tails.set(key, tail);
    await previous.catch(() => undefined);
    try {
      return await fn();
    } finally {
      release();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }
}
