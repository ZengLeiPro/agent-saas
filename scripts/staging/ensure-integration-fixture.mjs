#!/usr/bin/env node

import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const RELEASE_ID = /^rc-\d{8}-\d{2,}$/u;
const TABLE_PREFIX = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const FIXTURE_USERNAME = 'staging-e2e-admin';
const FIXTURE_IDS = Object.freeze({
  board: 'staging-e2e-integration-board',
  deliveryTask: 'staging-e2e-integration-delivery',
  integrationTask: 'staging-e2e-integration-task',
  source: 'staging-e2e-integration-source',
});

function tableNames(prefix) {
  if (!TABLE_PREFIX.test(prefix)) throw new Error('Unsafe Staging table prefix');
  return {
    boards: `${prefix}_taskboards`,
    tasks: `${prefix}_taskboard_tasks`,
    sources: `${prefix}_taskboard_integration_sources`,
  };
}

export async function ensureIntegrationFixture(client, input) {
  const tables = tableNames(input.tablePrefix);
  const requiredTables = Object.values(tables);
  const schema = await client.query(
    'SELECT name, to_regclass(name) AS relation FROM unnest($1::text[]) AS required(name)',
    [requiredTables],
  );
  if (
    schema.rows.length !== requiredTables.length ||
    schema.rows.some((row) => row.relation === null)
  ) {
    throw new Error('Staging Taskboard migrations are incomplete');
  }

  await client.query('BEGIN');
  try {
    await client.query("SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='15s'");
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
      'agent-saas-staging-e2e-integration-fixture',
    ]);
    await client.query(
      `INSERT INTO ${tables.boards}
         (id,tenant_id,owner_user_id,name,description,visibility,prompt,next_task_number,version)
       VALUES ($1,$2,$3,$4,$5,'personal','',3,1)
       ON CONFLICT (id) DO NOTHING`,
      [
        FIXTURE_IDS.board,
        input.tenantId,
        input.userId,
        'Staging E2E Integration Fixture',
        'Isolated canceled fixture for migration and authenticated source readback only.',
      ],
    );
    await client.query(
      `INSERT INTO ${tables.tasks}
         (id,board_id,identifier,kind,title,description,status,priority,labels,sort_order,
          creator_user_id,creator_name,version)
       VALUES ($1,$2,'STAGING-E2E-1','delivery',$3,$4,'canceled','low',$5,1024,$6,$7,1)
       ON CONFLICT (id) DO NOTHING`,
      [
        FIXTURE_IDS.deliveryTask,
        FIXTURE_IDS.board,
        'Canceled Staging delivery fixture',
        'Never dispatched; exists only as an isolated integration-source relation.',
        ['staging-e2e-fixture'],
        input.userId,
        FIXTURE_USERNAME,
      ],
    );
    await client.query(
      `INSERT INTO ${tables.tasks}
         (id,board_id,identifier,kind,title,description,status,priority,labels,sort_order,
          creator_user_id,creator_name,workflow_version,version)
       VALUES ($1,$2,'STAGING-E2E-2','integration',$3,$4,'canceled','low',$5,2048,$6,$7,3,1)
       ON CONFLICT (id) DO NOTHING`,
      [
        FIXTURE_IDS.integrationTask,
        FIXTURE_IDS.board,
        'Canceled Staging integration fixture',
        'Never merged; validates only migrated storage and authenticated readback.',
        ['staging-e2e-fixture'],
        input.userId,
        FIXTURE_USERNAME,
      ],
    );
    await client.query(
      `INSERT INTO ${tables.sources}
         (id,integration_task_id,delivery_task_id,repository_id,source_order,state)
       VALUES ($1,$2,$3,'staging-fixture:none',0,'canceled')
       ON CONFLICT (id) DO NOTHING`,
      [FIXTURE_IDS.source, FIXTURE_IDS.integrationTask, FIXTURE_IDS.deliveryTask],
    );
    const readback = await client.query(
      `SELECT b.tenant_id,b.owner_user_id,i.kind AS integration_kind,i.status AS integration_status,
              i.workflow_version,s.id AS source_id,s.delivery_task_id,s.state AS source_state,
              s.repository_id
         FROM ${tables.sources} s
         JOIN ${tables.tasks} i ON i.id=s.integration_task_id
         JOIN ${tables.boards} b ON b.id=i.board_id
        WHERE i.id=$1`,
      [FIXTURE_IDS.integrationTask],
    );
    const row = readback.rows[0];
    if (
      !row ||
      row.tenant_id !== input.tenantId ||
      row.owner_user_id !== input.userId ||
      row.integration_kind !== 'integration' ||
      row.integration_status !== 'canceled' ||
      Number(row.workflow_version) !== 3 ||
      row.source_id !== FIXTURE_IDS.source ||
      row.delivery_task_id !== FIXTURE_IDS.deliveryTask ||
      row.source_state !== 'canceled' ||
      row.repository_id !== 'staging-fixture:none'
    ) {
      throw new Error('Staging Integration fixture conflicts with authoritative readback');
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  }
  return {
    schemaVersion: 1,
    releaseId: input.releaseId,
    migrationReadback: { tables: requiredTables, status: 'present' },
    fixture: {
      username: FIXTURE_USERNAME,
      taskId: FIXTURE_IDS.integrationTask,
      sourceId: FIXTURE_IDS.source,
      state: 'canceled',
      evidenceScope: 'storage-and-authenticated-readback-only',
    },
  };
}

export async function runCli(argv = process.argv, env = process.env) {
  const [releaseId, serverRoot = '/opt/agent-saas-staging/current/server'] = argv.slice(2);
  if (!RELEASE_ID.test(releaseId ?? '')) throw new Error('A valid Staging release ID is required');
  if (env.AGENT_SAAS_ENVIRONMENT !== 'staging')
    throw new Error('Integration fixture is restricted to AGENT_SAAS_ENVIRONMENT=staging');
  const resolvedServerRoot = resolve(serverRoot);
  if (!resolvedServerRoot.startsWith('/opt/agent-saas-staging/'))
    throw new Error('Server root is outside the Staging release root');
  const configPath = '/etc/agent-saas-staging/config.json';
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  const store = config.runtimeEventStore;
  if (store?.backend !== 'pg' || store.tablePrefix !== 'staging_runtime')
    throw new Error('Staging PostgreSQL identity is invalid');
  const databaseUrl = new URL(store.connectionString);
  if (
    decodeURIComponent(databaseUrl.username) !== 'agent_saas_staging' ||
    databaseUrl.pathname !== '/agent_saas_staging'
  ) {
    throw new Error('Refusing a non-Staging PostgreSQL identity');
  }
  if (typeof config.auth?.usersFile !== 'string')
    throw new Error('Staging users file is not configured');
  const users = JSON.parse(await readFile(config.auth.usersFile, 'utf8'));
  const actor = users.users?.find((user) => user.username === FIXTURE_USERNAME);
  if (!actor || actor.role !== 'admin' || actor.tenantId !== 'pantheon')
    throw new Error('Dedicated Staging E2E platform administrator is absent');

  const requireFromRelease = createRequire(resolve(resolvedServerRoot, 'package.json'));
  const { Pool } = requireFromRelease('pg');
  const pool = new Pool({
    connectionString: store.connectionString,
    max: 1,
    connectionTimeoutMillis: 10_000,
    statement_timeout: 15_000,
    lock_timeout: 5_000,
    idle_in_transaction_session_timeout: 20_000,
    application_name: 'agent-saas-staging-e2e-fixture',
  });
  try {
    const client = await pool.connect();
    try {
      const result = await ensureIntegrationFixture(client, {
        releaseId,
        tablePrefix: store.tablePrefix,
        tenantId: actor.tenantId,
        userId: actor.id,
      });
      process.stdout.write(`${JSON.stringify(result)}\n`);
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) await runCli();
