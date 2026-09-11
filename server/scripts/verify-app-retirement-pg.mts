/** Isolated PostgreSQL contract. No model, deployment, production host or production credentials. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { PgEventStore } from '../src/runtime/pgEventStore.js';
import { PgRunStore } from '../src/runtime/runStore.js';
import { PgToolInvocationStore } from '../src/runtime/toolInvocationStore.js';
import { databaseIdentity, readWorkProof } from '../../scripts/release/app-retirement-evidence.mjs';

const connectionString = process.env.TEST_DATABASE_URL;
assert(
  connectionString,
  'TEST_DATABASE_URL is required; this contract must not be silently skipped',
);
assert(
  ['127.0.0.1', 'localhost'].includes(new URL(connectionString).hostname),
  'Use the isolated local PostgreSQL service',
);
const prefix = `retire_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
const pool = new pg.Pool({ connectionString, max: 4 });
const events = new PgEventStore({ connectionString, tablePrefix: prefix, poolMax: 2 });
const runs = new PgRunStore({
  pool,
  tablePrefix: prefix,
  writerCapability: { capability: 'tenant-native-v1', allowPrivilegedRoleForTests: true },
});
const tools = new PgToolInvocationStore({ pool, tablePrefix: prefix });
const tenantId = 'retirement-tenant';
const runId = randomUUID();
const invocationId = randomUUID();
const config = { runtimeEventStore: { backend: 'pg', connectionString, tablePrefix: prefix } };
const target = { databaseIdentity: databaseIdentity(config) };
const readback = (tenant = tenantId) =>
  readWorkProof({
    target,
    config,
    Pool: pg.Pool,
    inventory: [{ runId, workerId: 'old-worker', tenantId: tenant }],
  });
let checks = 0;
try {
  // These are the real application initializers, not a hand-written substitute schema.
  await events.init();
  await runs.init();
  await tools.init();
  await runs.createPending({
    runId,
    sessionId: 'retirement-session',
    userId: 'fixture-user',
    tenantId,
  });
  assert.equal((await readback()).verified, false);
  checks++;
  await pool.query(
    `UPDATE ${runs.runsTable} SET status='running', worker_id='new-worker', lease_expires_at=now()+interval '1 minute' WHERE run_id=$1`,
    [runId],
  );
  assert.equal((await readback()).new_owner, 1);
  checks++;
  await tools.start({
    invocationId,
    runId,
    sessionId: 'retirement-session',
    toolCallId: 'fixture-tool',
    toolName: 'Shell',
    executionTarget: 'server-local',
    tenantId,
    metadata: { workerId: 'old-worker', invokeClaimedByWorkerId: 'old-worker' },
  });
  assert.equal((await readback()).verified, false);
  checks++;
  await pool.query(
    `UPDATE ${prefix}_tool_invocations SET metadata=$2::jsonb WHERE invocation_id=$1`,
    [invocationId, JSON.stringify({ invokeClaimedByWorkerId: 'new-worker' })],
  );
  assert.equal((await readback()).new_owner, 1);
  checks++;
  await pool.query(
    `UPDATE ${runs.runsTable} SET lease_expires_at=now()-interval '1 second' WHERE run_id=$1`,
    [runId],
  );
  assert.equal((await readback()).verified, false);
  checks++;
  await pool.query(
    `UPDATE ${runs.runsTable} SET status='completed', completed_at=now(), worker_id=NULL, lease_expires_at=NULL WHERE run_id=$1`,
    [runId],
  );
  assert.equal((await readback()).verified, false);
  checks++;
  await tools.complete(invocationId, 'completed');
  assert.equal((await readback()).terminal, 1);
  checks++;
  assert.equal((await readback('other-tenant')).verified, false);
  checks++;
  await pool.query(
    `UPDATE ${runs.runsTable} SET status='cancelled', cancelled_at=now() WHERE run_id=$1`,
    [runId],
  );
  await pool.query(
    `UPDATE ${prefix}_tool_invocations SET status='cancelled', cancel_requested_at=now(), cancel_delivered_at=NULL WHERE invocation_id=$1`,
    [invocationId],
  );
  assert.equal((await readback()).verified, false);
  checks++;
  await pool.query(
    `UPDATE ${prefix}_tool_invocations SET cancel_delivered_at=now() WHERE invocation_id=$1`,
    [invocationId],
  );
  assert.equal((await readback()).terminal, 1);
  checks++;
  await pool.query(
    `UPDATE ${runs.runsTable} SET status='failed', failed_at=now(), status_reason='external_tool_outcome_unknown' WHERE run_id=$1`,
    [runId],
  );
  assert.equal((await readback()).verified, false);
  checks++;
  await pool.query(
    `UPDATE ${runs.runsTable} SET status='waiting_user', status_reason=NULL, worker_id=NULL WHERE run_id=$1`,
    [runId],
  );
  assert.equal((await readback()).suspended, 1);
  checks++;
  const before = (
    await pool.query(`SELECT updated_at FROM ${runs.runsTable} WHERE run_id=$1`, [runId])
  ).rows;
  await readback();
  assert.deepEqual(
    (await pool.query(`SELECT updated_at FROM ${runs.runsTable} WHERE run_id=$1`, [runId])).rows,
    before,
  );
  checks++;
  console.log(
    `Retirement PostgreSQL contract passed: ${checks} assertions against real runtime schema; no skipped checks`,
  );
} finally {
  await events.close();
  const tables = await pool.query(
    "SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename LIKE $1",
    [prefix + '_%'],
  );
  for (const { tablename } of tables.rows) {
    assert(/^[a-z0-9_]+$/.test(tablename) && tablename.startsWith(prefix + '_'));
    await pool.query(`DROP TABLE IF EXISTS ${tablename} CASCADE`);
  }
  await pool.end();
}
