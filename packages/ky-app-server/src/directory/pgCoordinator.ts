import type { Pool } from 'pg';

import type { DirectorySyncCoordinator } from './managedSync.js';

export class PgDirectorySyncCoordinator implements DirectorySyncCoordinator {
  constructor(
    private readonly pool: Pool,
    private readonly lockKey: string,
  ) {
    if (lockKey.trim() === '') throw new Error('目录同步锁标识不能为空');
  }

  async runExclusive(run: () => Promise<void>): Promise<boolean> {
    const client = await this.pool.connect();
    let locked = false;
    let releaseError: Error | undefined;
    try {
      const result = await client.query<{ locked: boolean }>(
        'SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked',
        [this.lockKey],
      );
      locked = result.rows[0]?.locked === true;
      if (!locked) return false;
      await run();
      return true;
    } finally {
      if (locked) {
        try {
          await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [this.lockKey]);
        } catch (error) {
          releaseError = error instanceof Error ? error : new Error(String(error));
        }
      }
      client.release(releaseError);
      if (releaseError) throw releaseError;
    }
  }
}
