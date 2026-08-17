import pg from 'pg';
import { describe } from 'vitest';

import type { PgEventStore } from '../runtime/pgEventStore.js';

export const testPgUrl = process.env.TEST_DATABASE_URL?.trim();
export const describePg = testPgUrl ? describe : describe.skip;
if (!testPgUrl) console.warn('[pgRunStoreSteering.pg] SKIPPED: TEST_DATABASE_URL is not configured');

const { Pool } = pg;
type PgPool = InstanceType<typeof Pool>;

export async function cleanupSteeringPgTest(
  pool: PgPool,
  eventStore: PgEventStore,
  prefix: string,
): Promise<void> {
  try {
    await pool.query(`DROP TABLE IF EXISTS ${prefix}_tool_invocations`);
    await pool.query(`DROP TABLE IF EXISTS ${prefix}_steering_inputs`);
    await pool.query(`DROP TABLE IF EXISTS ${prefix}_steering_sessions`);
    await pool.query(`DROP TABLE IF EXISTS ${prefix}_message_submissions`);
    await pool.query(`DROP TABLE IF EXISTS ${prefix}_runs`);
    await pool.query(`DROP TABLE IF EXISTS ${prefix}_events`);
    await pool.query(`DROP TABLE IF EXISTS ${prefix}_event_cursors`);
  } finally {
    await eventStore.close();
    await pool.end();
  }
}

export async function waitForBlockedQuery(pool: PgPool, queryPattern: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const result = await pool.query(
      `SELECT count(*)::int AS count FROM pg_stat_activity
        WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE $1`,
      [queryPattern],
    );
    if (Number(result.rows[0]?.count ?? 0) >= 1) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`等待数据库锁竞争超时：${queryPattern}`);
}
