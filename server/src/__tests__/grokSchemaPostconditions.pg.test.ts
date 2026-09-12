import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { createGrokCredentialPersistence } from '../runtime/responses/grokCredentialPersistence.js';
import { grokSubscriptionTableName } from '../runtime/responses/grokSubscriptionTableNames.js';
const url = process.env.TEST_DATABASE_URL;
const pool = url ? new pg.Pool({ connectionString: url, max: 2 }) : undefined;
const sql = readFileSync(
  new URL('../../../scripts/release/grok-subscription-postcondition.sql', import.meta.url),
  'utf8',
);
const prefixes: string[] = [];
afterAll(async () => {
  if (!pool) return;
  for (const prefix of prefixes)
    for (const kind of ['runtime_state', 'refresh_journal'] as const)
      await pool.query(`DROP TABLE IF EXISTS ${grokSubscriptionTableName(prefix, kind)}`);
  await pool.end();
});
describe.skipIf(!pool)('Grok read-only schema postconditions', () => {
  it.each(['short', 'long'])(
    'proves %s prefix tables and detects a removed index or check constraint',
    async (size) => {
      const nonce = randomUUID().replaceAll('-', '');
      const prefix = size === 'short' ? 'g' + nonce.slice(0, 6) : 'grok_long_prefix_' + nonce;
      prefixes.push(prefix);
      const read = async () => Boolean((await pool!.query(sql, [prefix])).rows[0]?.ok);
      expect(await read()).toBe(false);
      await createGrokCredentialPersistence(pool, { backend: 'pg', tablePrefix: prefix });
      expect(await read()).toBe(true);
      const table = grokSubscriptionTableName(prefix, 'runtime_state');
      await pool!.query(`DROP INDEX ${table}_cooldown_idx`);
      expect(await read()).toBe(false);
      await createGrokCredentialPersistence(pool, { backend: 'pg', tablePrefix: prefix });
      expect(await read()).toBe(true);
      await pool!.query(`ALTER TABLE ${table} DROP CONSTRAINT ${table}_availability_check`);
      expect(await read()).toBe(false);
    },
  );
});
