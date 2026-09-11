import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { canonicalJson, digestBuffer } from './artifact-lib.mjs';
import { assertDatabaseEvidence } from './migration-postconditions.mjs';

/** No application startup, DDL or writes. Named extended queries forbid multiple statements. */
export async function readMigrationPostconditions({ manifest, config, environment, Pool }) {
  const plan = manifest.migrationPlan;
  if (!['none', 'expand'].includes(plan?.phase))
    throw new Error('Unsupported migration readback phase');
  const evidence = {
    schemaVersion: 1,
    releaseId: manifest.releaseId,
    manifestDigest: manifest.digest,
    planDigest: plan.planDigest,
    ...(plan.phase === 'expand' ? { postconditionsDigest: plan.postconditionsDigest } : {}),
    environment,
    observedAt: new Date().toISOString(),
    status: 'passed',
    checks: [],
  };
  if (plan.phase === 'none') {
    evidence.status = 'not_required';
    assertDatabaseEvidence(manifest, evidence, environment);
    return evidence;
  }
  if (
    !plan.postconditions?.length ||
    digestBuffer(canonicalJson(plan.postconditions)) !== plan.postconditionsDigest
  )
    throw new Error('Missing bound database postconditions');
  for (const check of plan.postconditions) {
    const store = check.configPath
      .split('.')
      .reduce((value, key) => (Object.hasOwn(value ?? {}, key) ? value[key] : undefined), config);
    if (!store?.connectionString) throw new Error(`Missing configured database for ${check.id}`);
    const pool = new Pool({
      connectionString: store.connectionString,
      max: 1,
      options:
        '-c default_transaction_read_only=on -c statement_timeout=15000 -c lock_timeout=5000',
    });
    let client;
    try {
      client = await pool.connect();
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const identity = await client.query('SELECT current_database() AS database');
      const params = check.params.map((value) =>
        value === '$tablePrefix' ? (store.tablePrefix ?? 'runtime') : value,
      );
      const result = await client.query({
        name: 'release-postcondition',
        text: check.sql,
        values: params,
      });
      if (result.rows.length !== 1 || result.rows[0]?.ok !== true)
        throw new Error(`Database postcondition failed: ${check.id}`);
      const address = new URL(store.connectionString);
      evidence.checks.push({
        id: check.id,
        status: 'passed',
        database: identity.rows[0].database,
        targetDigest: digestBuffer(
          canonicalJson({
            host: address.hostname,
            port: address.port || '5432',
            database: identity.rows[0].database,
            prefix: store.tablePrefix ?? 'runtime',
          }),
        ),
      });
    } finally {
      await client?.query('ROLLBACK').catch(() => undefined);
      client?.release();
      await pool.end();
    }
  }
  evidence.observedAt = new Date().toISOString();
  assertDatabaseEvidence(manifest, evidence, environment);
  return evidence;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [, , manifestPath, configPath, serverRoot, environment, output] = process.argv;
  if (!output || !['staging', 'production'].includes(environment))
    throw new Error(
      'Usage: read-migration-postconditions.mjs <manifest> <config> <server-root> <environment> <output>',
    );
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  // A no-migration readback must not need credentials, a server install or the PG driver.
  const required = manifest.migrationPlan?.phase !== 'none';
  const config = required ? JSON.parse(await readFile(configPath, 'utf8')) : {};
  const Pool = required ? createRequire(resolve(serverRoot, 'package.json'))('pg').Pool : null;
  const evidence = await readMigrationPostconditions({ manifest, config, environment, Pool });
  const serialized = canonicalJson(evidence) + '\n';
  JSON.parse(serialized); // Never publish a malformed evidence file.
  await writeFile(output, serialized, { mode: 0o600 });
}
