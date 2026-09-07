#!/usr/bin/env tsx
/** Scoped registry-only repair. Preview is the default; no app startup or remote provision. */
import { readFile, writeFile, open } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import pg from 'pg';
import { supersedeLegacyHand } from '../src/runtime/handSupersession.js';

const { values } = parseArgs({
  options: {
    config: { type: 'string' },
    tenant: { type: 'string' },
    session: { type: 'string', multiple: true },
    plan: { type: 'string' },
    execute: { type: 'boolean', default: false },
    snapshot: { type: 'string' },
  },
});
type Entry = {
  sessionId: string;
  legacyHandId: string;
  replacementHandId: string;
  legacyUpdatedAt: string;
  replacementUpdatedAt: string;
};
type Plan = {
  schemaVersion: 1;
  tenantId: string;
  database: string;
  databaseTarget: string;
  tablePrefix: string;
  entries: Entry[];
};

async function main() {
  if (!values.config || !values.tenant || !values.plan)
    throw new Error('Required: --config <JSON config> --tenant <id> --plan <file>');
  if (values.execute && !values.snapshot)
    throw new Error('--execute requires --snapshot <new protected file>');
  const config = JSON.parse(await readFile(values.config, 'utf8'));
  const runtime = config.runtimeEventStore;
  if (runtime?.backend !== 'pg' || !runtime.connectionString)
    throw new Error('Config must select PostgreSQL runtimeEventStore');
  const prefix = runtime.tablePrefix ?? 'runtime';
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(prefix)) throw new Error('Invalid tablePrefix');
  const pool = new pg.Pool({
    connectionString: runtime.connectionString,
    max: 1,
    options: '-c statement_timeout=15000 -c lock_timeout=5000',
  });
  try {
    const database = String((await pool.query('SELECT current_database() AS name')).rows[0].name);
    const address = new URL(runtime.connectionString);
    const databaseTarget = `${address.hostname}:${address.port || '5432'}/${database}`;
    if (!values.execute) {
      if (!values.session?.length)
        throw new Error('Preview requires one or more explicit --session <id>');
      const { rows } = await pool.query(
        `SELECT hand_id, session_id, workspace_id, status, updated_at, metadata->>'tenantRemoteHandId' AS provider
         FROM ${prefix}_hands WHERE tenant_id = $1 AND session_id = ANY($2::text[]) ORDER BY hand_id`,
        [values.tenant, values.session],
      );
      const entries: Entry[] = [];
      for (const row of rows.filter((item) => item.hand_id.startsWith('th_') && item.provider)) {
        const verdict = await supersedeLegacyHand(pool, prefix, row.hand_id, values.tenant, false);
        console.log(
          JSON.stringify({
            sessionId: row.session_id,
            workspaceId: row.workspace_id,
            status: row.status,
            ...verdict,
          }),
        );
        if (verdict.outcome !== 'superseded') continue;
        const old = rows.find((item) => item.hand_id === verdict.legacyHandId);
        if (!old) continue;
        entries.push({
          sessionId: row.session_id,
          legacyHandId: old.hand_id,
          replacementHandId: row.hand_id,
          legacyUpdatedAt: new Date(old.updated_at).toISOString(),
          replacementUpdatedAt: new Date(row.updated_at).toISOString(),
        });
      }
      const plan: Plan = {
        schemaVersion: 1,
        tenantId: values.tenant,
        database,
        databaseTarget,
        tablePrefix: prefix,
        entries,
      };
      await writeFile(values.plan, JSON.stringify(plan, null, 2) + '\n', {
        flag: 'wx',
        mode: 0o600,
      });
      console.log(JSON.stringify({ mode: 'preview', eligible: entries.length, plan: values.plan }));
      return;
    }
    const plan: Plan = JSON.parse(await readFile(values.plan, 'utf8'));
    if (
      plan.schemaVersion !== 1 ||
      plan.tenantId !== values.tenant ||
      plan.database !== database ||
      plan.databaseTarget !== databaseTarget ||
      plan.tablePrefix !== prefix ||
      !Array.isArray(plan.entries) ||
      plan.entries.length > 100
    ) {
      throw new Error('Plan target mismatch or invalid plan');
    }
    // Snapshot may contain credential references; keep it local and mode 0600, never print rows.
    const snapshot = await open(values.snapshot!, 'wx', 0o600);
    try {
      for (const entry of plan.entries) {
        const { rows } = await pool.query(
          `SELECT * FROM ${prefix}_hands WHERE tenant_id = $1 AND session_id = $2 AND hand_id = ANY($3::text[]) ORDER BY hand_id`,
          [plan.tenantId, entry.sessionId, [entry.legacyHandId, entry.replacementHandId]],
        );
        if (rows.length !== 2 || !entry.legacyUpdatedAt || !entry.replacementUpdatedAt)
          throw new Error('Snapshot target is missing');
        await snapshot.write(
          JSON.stringify({ kind: 'before', tenantId: plan.tenantId, entry, rows }) + '\n',
        );
        await snapshot.sync();
        const verdict = await supersedeLegacyHand(
          pool,
          prefix,
          entry.replacementHandId,
          plan.tenantId,
          true,
          entry,
        );
        await snapshot.write(JSON.stringify({ kind: 'result', ...verdict }) + '\n');
        await snapshot.sync();
        console.log(JSON.stringify(verdict));
        if (verdict.outcome !== 'superseded')
          throw new Error(`Stopped at changed/blocked entry: ${verdict.reason ?? verdict.outcome}`);
        const readback = await pool.query(
          `SELECT metadata->>'supersededBy' AS replacement FROM ${prefix}_hands WHERE hand_id = $1 AND tenant_id = $2`,
          [entry.legacyHandId, plan.tenantId],
        );
        if (readback.rows[0]?.replacement !== entry.replacementHandId)
          throw new Error('Supersession readback mismatch');
      }
    } finally {
      await snapshot.close();
    }
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Legacy Hand repair failed');
  process.exitCode = 1;
});
