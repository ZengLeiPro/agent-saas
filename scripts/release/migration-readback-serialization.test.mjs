import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { canonicalJson, digestBuffer } from './artifact-lib.mjs';
import { readMigrationPostconditions } from './read-migration-postconditions.mjs';
import { assertDatabaseEvidence } from './migration-postconditions.mjs';
import { assertArchivedDatabaseEvidence } from './verify-migration-readback.mjs';

const iso = (value) => new Date(value).toISOString();
const digest = (letter) => `sha256:${letter.repeat(64)}`;
const manifestFor = () => ({
  releaseId: 'rc-20260911-116', releaseSha: 'a'.repeat(40), digest: digest('b'),
  migrationPlan: { phase: 'none', planDigest: digest('c') },
  promotionPolicy: { expiresAt: iso(Date.now() + 3600000) },
});
class ForbiddenPool { constructor() { throw new Error('DB MUST NOT BE TOUCHED'); } }
const produce = (manifest = manifestFor(), Pool = ForbiddenPool) => readMigrationPostconditions({
  manifest, environment: 'staging', config: {}, Pool,
});
async function directory(t) {
  const root = await mkdtemp(join(tmpdir(), 'migration-readback-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
async function roundtrip(t, value) {
  const path = join(await directory(t), 'evidence.json');
  await writeFile(path, canonicalJson(value) + '\n');
  return JSON.parse(await readFile(path, 'utf8'));
}
function expandManifest() {
  const manifest = manifestFor();
  const postconditions = [{ id: 'schema', configPath: 'store', sql: 'SELECT true AS ok',
    params: ['$tablePrefix'], description: 'reviewed schema check' }];
  manifest.migrationPlan = { ...manifest.migrationPlan, phase: 'expand', postconditions,
    postconditionsDigest: digestBuffer(canonicalJson(postconditions)) };
  return manifest;
}
function database(ok = true) {
  const calls = [];
  class Pool {
    constructor(options) { calls.push(options); }
    async connect() {
      return {
        async query(query) {
          calls.push(query);
          if (query === 'SELECT current_database() AS database') return { rows: [{ database: 'isolated' }] };
          return { rows: [{ ok }] };
        },
        release() { calls.push('release'); },
      };
    }
    async end() { calls.push('end'); }
  }
  return { Pool, calls };
}
async function expanded(manifest = expandManifest(), db = database()) {
  const evidence = await readMigrationPostconditions({ manifest, environment: 'staging',
    config: { store: { connectionString: 'postgres://user:DO_NOT_EXPORT@localhost/isolated',
      tablePrefix: 'isolated' } }, Pool: db.Pool });
  return { manifest, evidence, calls: db.calls };
}

test('H02 none survives producer -> canonical file -> JSON.parse -> consumer without DB access', async (t) => {
  const manifest = manifestFor();
  const evidence = await roundtrip(t, await produce(manifest));
  assert.equal(evidence.status, 'not_required');
  assert.equal(Object.hasOwn(evidence, 'postconditionsDigest'), false);
  assertDatabaseEvidence(manifest, evidence, 'staging');
});
test('H02 real none CLI needs neither config credentials nor an installed pg driver', async (t) => {
  const root = await directory(t);
  const manifest = manifestFor();
  await writeFile(join(root, 'manifest.json'), JSON.stringify(manifest));
  const result = spawnSync(process.execPath, [
    fileURLToPath(new URL('./read-migration-postconditions.mjs', import.meta.url)),
    join(root, 'manifest.json'), join(root, 'missing-config'), join(root, 'missing-server'),
    'staging', join(root, 'out.json'),
  ], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assertDatabaseEvidence(manifest, JSON.parse(await readFile(join(root, 'out.json'))), 'staging');
});
test('H02 original production47 copied staging sample stays byte-identical and invalid', async () => {
  const bytes = await readFile(new URL('./fixtures/staging-none-readback.invalid.txt', import.meta.url));
  assert.equal(createHash('sha256').update(bytes).digest('hex'),
    '1e8d92c99b3b3492be9b50f3ec231c43833bb0fa190f1fe4bb990fcca433a444');
  assert.throws(() => JSON.parse(bytes), SyntaxError);
  assert.equal(canonicalJson({ z: [true, null, 3], a: { x: 'text' } }),
    '{"a":{"x":"text"},"z":[true,null,3]}');
});
for (const [field, value] of [
  ['releaseId', 'other'], ['manifestDigest', digest('d')], ['planDigest', digest('d')],
  ['environment', 'production'], ['schemaVersion', 2], ['status', 'passed'],
  ['checks', [{}]], ['checks', null], ['observedAt', 'invalid'], ['postconditionsDigest', null],
]) test(`H02 none consumer rejects invalid ${field}=${JSON.stringify(value)}`, async (t) => {
  const manifest = manifestFor();
  const evidence = await roundtrip(t, { ...await produce(manifest), [field]: value });
  assert.throws(() => assertDatabaseEvidence(manifest, evidence, 'staging'));
});
for (const offset of [-300001, 60001]) test(`live freshness boundary rejects ${offset}ms`, async () => {
  const manifest = manifestFor(); const now = Date.now();
  const evidence = { ...await produce(manifest), observedAt: iso(now + offset) };
  assert.throws(() => assertDatabaseEvidence(manifest, evidence, 'staging', now));
});
test('none rejects missing identity, hidden postconditions, unknown phase and invalid clock before DB', async () => {
  for (const mutate of [
    (m) => { delete m.digest; }, (m) => { delete m.migrationPlan.planDigest; },
    (m) => { m.migrationPlan.postconditionsDigest = digest('e'); },
    (m) => { m.migrationPlan.postconditions = [{}]; },
    (m) => { m.migrationPlan.phase = 'unknown'; },
  ]) { const manifest = manifestFor(); mutate(manifest); await assert.rejects(produce(manifest)); }
  const manifest = manifestFor(); const evidence = await produce(manifest);
  assert.throws(() => assertDatabaseEvidence(manifest, evidence, 'staging', NaN));
});
test('expand preserves bound digest, named read-only SQL, rollback, cleanup and file consumption', async (t) => {
  const { manifest, evidence, calls } = await expanded();
  const parsed = await roundtrip(t, evidence);
  assertDatabaseEvidence(manifest, parsed, 'staging');
  assert.equal(parsed.postconditionsDigest, manifest.migrationPlan.postconditionsDigest);
  assert.match(calls[0].options, /default_transaction_read_only=on/u);
  assert.ok(calls.includes('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'));
  assert.deepEqual(calls.find((call) => call?.name), {
    name: 'release-postcondition', text: 'SELECT true AS ok', values: ['isolated'],
  });
  assert.deepEqual(calls.slice(-3), ['ROLLBACK', 'release', 'end']);
  assert.doesNotMatch(canonicalJson(parsed), /DO_NOT_EXPORT|postgres:\/\//u);
});
test('expand missing or changed digest fails before connecting, failed SQL never passes', async () => {
  for (const value of [undefined, digest('f')]) {
    const manifest = expandManifest(); manifest.migrationPlan.postconditionsDigest = value;
    await assert.rejects(produce(manifest), /Missing bound database postconditions/u);
  }
  const db = database(false);
  await assert.rejects(expanded(expandManifest(), db), /Database postcondition failed/u);
  assert.deepEqual(db.calls.slice(-3), ['ROLLBACK', 'release', 'end']);
});
test('expand consumer still rejects stale, wrong identity, environment, digest and failed check', async (t) => {
  const { manifest, evidence } = await expanded();
  for (const patch of [
    { releaseId: 'other' }, { environment: 'production' }, { postconditionsDigest: digest('e') },
    { observedAt: iso(Date.now() - 3600000) }, { checks: [] },
    { checks: [{ ...evidence.checks[0], status: 'failed' }] },
  ]) assert.throws(() => assertDatabaseEvidence(manifest, { ...evidence, ...patch }, 'staging'));
  assertDatabaseEvidence(manifest, await roundtrip(t, evidence), 'staging');
});
async function archiveFixture(phase = 'none') {
  const now = Date.now();
  const manifest = phase === 'expand' ? expandManifest() : manifestFor();
  const evidence = phase === 'expand' ? (await expanded(manifest)).evidence : await produce(manifest);
  evidence.observedAt = iso(now - 600000);
  return {
    now, manifest, evidence, repository: 'owner/agent-saas', runId: '123', runAttempt: '1',
    run: { id: 123, run_attempt: 1, repository: { full_name: 'owner/agent-saas' },
      head_repository: { full_name: 'owner/agent-saas' }, head_sha: manifest.releaseSha,
      head_branch: 'main', event: 'workflow_dispatch', path: '.github/workflows/deploy-staging.yml',
      status: 'completed', conclusion: 'success', run_started_at: iso(now - 1200000),
      updated_at: iso(now - 500000) },
  };
}
for (const phase of ['none', 'expand']) test(`archived ${phase} has attempt/RC lifetime, not the live five-minute clock`, async (t) => {
  const f = await archiveFixture(phase); f.evidence = await roundtrip(t, f.evidence);
  assert.throws(() => assertDatabaseEvidence(f.manifest, f.evidence, 'staging', f.now));
  assert.equal(assertArchivedDatabaseEvidence(f).status, 'passed');
});
for (const [name, mutate] of [
  ['expired RC', (f) => { f.manifest.promotionPolicy.expiresAt = iso(f.now - 1); }],
  ['wrong attempt', (f) => { f.run.run_attempt = 2; }],
  ['wrong run', (f) => { f.run.id = 124; }],
  ['fork', (f) => { f.run.head_repository.full_name = 'fork/repo'; }],
  ['wrong source', (f) => { f.run.head_sha = 'e'.repeat(40); }],
  ['wrong workflow', (f) => { f.run.path = '.github/workflows/ci.yml'; }],
  ['failed run', (f) => { f.run.conclusion = 'failure'; }],
  ['before attempt', (f) => { f.evidence.observedAt = iso(f.now - 3600000); }],
  ['after attempt', (f) => { f.evidence.observedAt = iso(f.now); }],
  ['unknown phase', (f) => { f.manifest.migrationPlan.phase = 'contract'; }],
]) test(`archive rejects ${name}`, async () => {
  const f = await archiveFixture(); mutate(f);
  assert.throws(() => assertArchivedDatabaseEvidence(f));
});
test('real archive CLI accepts an explicit repository and rejects malformed evidence or arguments', async (t) => {
  const root = await directory(t); const f = await archiveFixture();
  for (const name of ['manifest', 'evidence', 'run'])
    await writeFile(join(root, `${name}.json`), JSON.stringify(f[name]));
  const args = [fileURLToPath(new URL('./verify-migration-readback.mjs', import.meta.url)),
    ...['manifest', 'evidence', 'run'].map((name) => join(root, `${name}.json`)), '123', '1', f.repository];
  const options = { encoding: 'utf8', env: { ...process.env, GITHUB_REPOSITORY: 'wrong/ambient' } };
  const accepted = spawnSync(process.execPath, args, options);
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.equal(JSON.parse(accepted.stdout).status, 'passed');
  // The evidence and ambient environment must never supply a missing trust boundary.
  for (const invalid of [args.slice(0, -1), [...args.slice(0, -1), 'wrong/repo'],
    [...args.slice(0, -1), 'DO_NOT_EXPORT?token=secret'], [...args, 'unexpected']]) {
    const rejected = spawnSync(process.execPath, invalid, {
      ...options, env: { ...process.env, GITHUB_REPOSITORY: f.repository },
    });
    assert.equal(rejected.status, 1, rejected.stderr);
    assert.equal(rejected.stdout, '');
    assert.doesNotMatch(rejected.stderr, /DO_NOT_EXPORT/u);
  }
  await writeFile(join(root, 'evidence.json'), '{"DO_NOT_EXPORT":undefined}');
  const rejected = spawnSync(process.execPath, args, options);
  assert.equal(rejected.status, 1);
  assert.doesNotMatch(rejected.stderr, /DO_NOT_EXPORT/u);
});
