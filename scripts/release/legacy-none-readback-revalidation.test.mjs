import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { digestBuffer } from './artifact-lib.mjs';
import {
  fixture,
  iso,
  digest,
  asBytes,
  parseLegacy,
} from './fixtures/legacy-none-revalidation-fixture.mjs';
import { stagingBinding } from './staging-deployment-binding.mjs';
import { validateStagingDeployment } from './staging-deployment-evidence.mjs';
import {
  revalidateLegacyNoneReadback,
  bindLegacyRevalidation,
} from './legacy-none-readback-revalidation.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const cli = join(root, 'legacy-none-readback-revalidation.mjs');
const strict = join(root, 'verify-migration-readback.mjs');
const shell = join(root, 'verify-staging-promotion-evidence.sh');
const recover = (f) => revalidateLegacyNoneReadback(f);
const receiptReport = (f, receipt = recover(f)) => ({
  receipt,
  manifest: f.manifest,
  history: f.history,
  repository: f.repository,
  bytes: f.bytes,
  now: f.now,
  report: { status: 'passed', ...stagingBinding(f.manifest, f.history) },
});

test('interrupted NONE promotion adds distinct proof while preserving invalid original bytes', () => {
  const f = fixture();
  const before = Buffer.from(f.bytes);
  const proof = recover(f);
  assert.equal(proof.status, 'revalidated');
  assert.equal(proof.scope, 'legacy_none_plan_only');
  assert.equal(proof.original.formatValid, false);
  assert.equal(proof.original.digest, digestBuffer(before));
  assert.deepEqual(proof.verification, {
    kind: 'manifest_none_plan',
    databaseAccessed: false,
    stagingRerun: false,
    status: 'not_required',
    checks: 0,
  });
  assert.deepEqual(f.bytes, before);
  assert.throws(() => JSON.parse(f.bytes));
  const { digest: receiptDigest, ...body } = proof;
  assert.equal(receiptDigest, digest(body));
  const report = bindLegacyRevalidation(receiptReport(f, proof));
  assert.equal(report.databaseReadbackRevalidation.digest, receiptDigest);
  assert.equal(report.databaseReadbackRevalidation.originalFormatValid, false);
});

const mutations = {
  'fresh verified candidate': (f) => {
    f.history = f.history.slice(0, 3);
  },
  'before-change retry': (f) => {
    f.history = f.history.slice(0, 4);
    f.history.push({ ...f.history.at(-1), state: 'failed_before_change' });
  },
  'unreviewed promoting tail': (f) => f.history.pop(),
  'completed transaction': (f) => {
    f.history.at(-1).state = 'completed';
  },
  'rolled back transaction': (f) => {
    f.history.at(-1).state = 'rolled_back';
  },
  'rejected acceptance': (f) => {
    f.history.at(-1).state = 'rejected';
  },
  'foreign history RC': (f) => {
    f.history[3].releaseId = 'rc-20260911-118';
  },
  'foreign history manifest': (f) => {
    f.history[3].manifestDigest = `sha256:${'1'.repeat(64)}`;
  },
  'unknown producer': (f) => {
    f.producerBlob = '0'.repeat(40);
  },
  'expand plan': (f) => {
    f.manifest.migrationPlan.phase = 'expand';
  },
  'contract plan': (f) => {
    f.manifest.migrationPlan.contract = 'execute';
  },
  'none with postconditions': (f) => {
    f.manifest.migrationPlan.postconditions = [];
  },
  'different repository': (f) => {
    f.repository = 'foreign/repo';
  },
  'different run': (f) => {
    f.run.id = 702;
  },
  'different attempt': (f) => {
    f.run.run_attempt = 2;
  },
  'different source': (f) => {
    f.run.head_sha = '0'.repeat(40);
  },
  'different branch': (f) => {
    f.run.head_branch = 'workbench';
  },
  'different workflow': (f) => {
    f.run.path = '.github/workflows/ci.yml';
  },
  'different trigger': (f) => {
    f.run.event = 'push';
  },
  'failed staging': (f) => {
    f.run.conclusion = 'failure';
  },
  'expired RC': (f) => {
    f.manifest.promotionPolicy.expiresAt = iso(f.now - 1);
  },
  'missing expiry': (f) => {
    delete f.manifest.promotionPolicy.expiresAt;
  },
  'future staging': (f) => {
    f.run.updated_at = iso(f.now + 120000);
  },
  'oversize evidence': (f) => {
    f.bytes = Buffer.alloc(4097);
  },
  'malformed UTF-8': (f) => {
    f.bytes = Buffer.from([0xff]);
  },
  'different invalid JSON': (f) => {
    f.bytes = Buffer.from('{bad secret-token');
  },
  'duplicate key': (f) => {
    f.bytes = Buffer.from(
      f.bytes.toString().replace('"schemaVersion":1', '"schemaVersion":1,"schemaVersion":1'),
    );
  },
  'double undefined defect': (f) => {
    f.bytes = Buffer.from(
      f.bytes
        .toString()
        .replace(
          '"postconditionsDigest":undefined,',
          '"postconditionsDigest":undefined,"postconditionsDigest":undefined,',
        ),
    );
  },
  'noncanonical whitespace': (f) => {
    f.bytes = Buffer.from(' ' + f.bytes.toString());
  },
  'valid JSON is not legacy proof': (f) => {
    f.bytes = asBytes(parseLegacy(f.bytes));
  },
};
for (const [name, mutate] of Object.entries(mutations)) {
  test(`legacy recovery rejects ${name}`, () => {
    const f = fixture();
    mutate(f);
    assert.throws(() => recover(f));
  });
}
for (const [field, value] of [
  ['releaseId', 'rc-20260911-118'],
  ['releaseSha', '0'.repeat(40)],
  ['manifestDigest', `sha256:${'0'.repeat(64)}`],
  ['migrationPhase', 'expand'],
  ['migrationPlanDigest', `sha256:${'0'.repeat(64)}`],
]) {
  test(`promoting marker must bind the same ${field}`, () => {
    const f = fixture();
    const reason = JSON.parse(f.history[4].reason);
    reason[field] = value;
    f.history[4].reason = JSON.stringify(reason);
    assert.throws(() => recover(f));
  });
}
for (const [field, value] of [
  ['releaseId', 'rc-20260911-118'],
  ['manifestDigest', `sha256:${'0'.repeat(64)}`],
  ['planDigest', `sha256:${'0'.repeat(64)}`],
  ['environment', 'production'],
  ['status', 'passed'],
  ['schemaVersion', 2],
  ['checks', [{ id: 'not-empty' }]],
  ['observedAt', iso(0)],
  ['unknownField', 'private-token'],
]) {
  test(`archived legacy evidence still validates ${field}`, () => {
    const f = fixture();
    f.bytes = asBytes({ ...parseLegacy(f.bytes), [field]: value, postconditionsDigest: undefined });
    assert.throws(() => recover(f));
  });
}
for (const name of [
  'hash',
  'history',
  'stale',
  'report',
  'repository',
  'attempt',
  'original bytes',
  'verification semantics',
]) {
  test(`supplement binding rejects changed ${name}`, () => {
    const f = fixture();
    const input = receiptReport(f);
    if (name === 'original bytes') input.bytes = Buffer.from('changed');
    if (name === 'verification semantics') {
      input.receipt.verification.stagingRerun = true;
      const { digest: ignored, ...body } = input.receipt;
      input.receipt.digest = digest(body);
      assert.ok(ignored);
    }
    if (name === 'hash') input.receipt.original.digest = `sha256:${'0'.repeat(64)}`;
    if (name === 'history') input.history.at(-1).operationKey = 'modified';
    if (name === 'stale') input.now += 300001;
    if (name === 'report') input.report.status = 'rejected';
    if (name === 'repository') input.repository = 'foreign/repo';
    if (name === 'attempt') input.report.stagingRunAttempt = '2';
    assert.throws(() => bindLegacyRevalidation(input));
  });
}

async function sandbox(t) {
  const directory = await mkdtemp(join(tmpdir(), 'legacy-none-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const f = fixture();
  const git = (...args) =>
    execFileSync('git', args, {
      cwd: directory,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  git('init', '-q');
  git('config', 'user.name', 'Recovery Test');
  git('config', 'user.email', 'recovery@example.invalid');
  await mkdir(join(directory, 'scripts/release'), { recursive: true });
  await writeFile(
    join(directory, 'scripts/release/read-migration-postconditions.mjs'),
    await readFile(join(root, 'fixtures/legacy-none-readback-producer.source.txt')),
  );
  git('add', 'scripts');
  git('commit', '-qm', 'Historical producer fixture');
  f.manifest.releaseSha = git('rev-parse', 'HEAD').trim();
  f.run.head_sha = f.manifest.releaseSha;
  f.latestRun.head_sha = f.manifest.releaseSha;
  f.deployment.sha = f.manifest.releaseSha;
  const marker = JSON.parse(f.history[4].reason);
  marker.releaseSha = f.manifest.releaseSha;
  f.history[4].reason = JSON.stringify(marker);
  const evidence = join(directory, 'evidence');
  await mkdir(join(evidence, 'attempt-evidence'), { recursive: true });
  const paths = {
    manifest: join(directory, 'manifest.json'),
    history: join(directory, 'history.jsonl'),
    evidence,
  };
  const save = async () => {
    await writeFile(paths.manifest, JSON.stringify(f.manifest));
    await writeFile(paths.history, f.history.map((x) => JSON.stringify(x)).join('\n') + '\n');
    await writeFile(join(evidence, 'staging-attempt.json'), JSON.stringify(f.run));
    await writeFile(join(evidence, 'attempt-evidence/staging-database-readback.json'), f.bytes);
  };
  await save();
  const invoke = (mode = 'revalidate', extra = []) =>
    spawnSync(
      process.execPath,
      [cli, mode, paths.manifest, paths.history, evidence, f.repository, ...extra],
      { cwd: directory, encoding: 'utf8', timeout: 15000 },
    );
  return { directory, f, paths, save, invoke };
}

test('real CLI: strict reader rejects old bytes; new proof is create-only and binds approval', async (t) => {
  const s = await sandbox(t);
  const original = join(s.paths.evidence, 'attempt-evidence/staging-database-readback.json');
  const strictResult = spawnSync(
    process.execPath,
    [
      strict,
      s.paths.manifest,
      original,
      join(s.paths.evidence, 'staging-attempt.json'),
      '701',
      '1',
      s.f.repository,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(strictResult.status, 1);
  const result = s.invoke();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).originalFormatValid, false);
  assert.deepEqual(await readFile(original), s.f.bytes);
  assert.equal(s.invoke().status, 1, 'must not overwrite a previous supplement');
  await writeFile(join(s.paths.evidence, 'report.json'), JSON.stringify(receiptReport(s.f).report));
  const bound = s.invoke('bind');
  assert.equal(bound.status, 0, bound.stderr);
  assert.equal(
    JSON.parse(await readFile(join(s.paths.evidence, 'report.json'))).databaseReadbackRevalidation
      .originalFormatValid,
    false,
  );
});

test('real CLI fails closed on extra args, symlinks and private malformed content', async (t) => {
  const s = await sandbox(t);
  assert.equal(s.invoke('revalidate', ['extra']).status, 1);
  const original = join(s.paths.evidence, 'attempt-evidence/staging-database-readback.json');
  await rm(original);
  await symlink(s.paths.manifest, original);
  assert.equal(s.invoke().status, 1);
  await rm(original);
  await writeFile(original, '{private-token=not-for-logs');
  const result = s.invoke();
  assert.equal(result.status, 1);
  assert.ok(!result.stderr.includes('not-for-logs'));
  assert.equal(result.stdout, '');
});

test('real production preflight shell revalidates only interrupted legacy NONE and keeps final checks', async (t) => {
  const s = await sandbox(t);
  const f = s.f;
  const smokeBody = {
    schemaVersion: 1,
    status: 'passed',
    environment: 'staging',
    releaseId: f.manifest.releaseId,
    sourceSha: f.manifest.releaseSha,
    manifestDigest: f.manifest.digest,
    stagingRunId: '701',
    stagingRunAttempt: '1',
    actor: 'staging-e2e-admin',
    observedAt: iso(f.now - 600000),
    checks: ['login', 'authenticated-read', 'persistence-read', 'websocket'],
  };
  const source = join(s.directory, 'archive');
  await mkdir(source);
  await writeFile(
    join(source, 'staging-core-smoke.json'),
    JSON.stringify({ ...smokeBody, evidenceDigest: digest(smokeBody) }),
  );
  await writeFile(join(source, 'staging-database-readback.json'), f.bytes);
  const bin = join(s.directory, 'bin');
  await mkdir(bin);
  const config = { source, deployment: f.deployment, statuses: f.statusPages, run: f.run };
  const configPath = join(s.directory, 'gh-fixture.json');
  await writeFile(configPath, JSON.stringify(config));
  await writeFile(
    join(bin, 'gh'),
    `#!/usr/bin/env node\nimport fs from 'node:fs';\nimport path from 'node:path';\nconst c=JSON.parse(fs.readFileSync(${JSON.stringify(configPath)},'utf8'));\nconst a=process.argv.slice(2);\nif(a[0]==='api'){ const url=a.at(-1); const value=url.includes('/statuses')?c.statuses:url.includes('/deployments/')?c.deployment:c.run; console.log(JSON.stringify(value)); }\nelse if(a[0]==='run'&&a[1]==='download'){const d=a[a.indexOf('--dir')+1];fs.mkdirSync(d,{recursive:true});for(const n of fs.readdirSync(c.source)) fs.copyFileSync(path.join(c.source,n),path.join(d,n));}\nelse process.exit(9);\n`,
    { mode: 0o755 },
  );
  // The fake GitHub transport is the only substituted boundary. Run actual Bash,
  // strict verifier, metadata validators, core smoke, Git-object probe and revalidator.
  const invoke = (out) =>
    spawnSync('bash', [shell, s.paths.manifest, s.paths.history, out], {
      cwd: s.directory,
      encoding: 'utf8',
      timeout: 30000,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, GITHUB_REPOSITORY: f.repository },
    });
  const out = join(s.directory, 'preflight');
  const result = invoke(out);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const report = JSON.parse(await readFile(join(out, 'report.json')));
  assert.equal(report.status, 'passed');
  assert.ok(report.databaseReadbackRevalidation.digest);
  assert.deepEqual(
    await readFile(join(out, 'attempt-evidence/staging-database-readback.json')),
    f.bytes,
  );
  // Fresh candidates remain blocked; the old invalid artifact is not generally accepted.
  f.history = f.history.slice(0, 3);
  await s.save();
  const fresh = invoke(join(s.directory, 'fresh'));
  assert.notEqual(fresh.status, 0);
  const freshReport = JSON.parse(await readFile(join(s.directory, 'fresh/report.json')));
  assert.equal(freshReport.status, 'rejected');
  // The ordinary legal NONE path still passes with no exception receipt.
  await writeFile(join(source, 'staging-database-readback.json'), asBytes(parseLegacy(f.bytes)));
  const normal = invoke(join(s.directory, 'normal'));
  assert.equal(normal.status, 0, normal.stderr);
  const normalReport = JSON.parse(await readFile(join(s.directory, 'normal/report.json')));
  assert.equal(normalReport.status, 'passed');
  assert.equal(normalReport.databaseReadbackRevalidation, undefined);
  // Existing deployment revocation is not bypassed by the legacy path.
  config.statuses[0][0].state = 'failure';
  await writeFile(configPath, JSON.stringify(config));
  const revoked = invoke(join(s.directory, 'revoked'));
  assert.notEqual(revoked.status, 0);
});

test('revalidated evidence does not turn a revoked or superseded Staging run into success', () => {
  const f = fixture();
  recover(f);
  f.latestRun.run_attempt = 2;
  assert.throws(() => validateStagingDeployment({ ...f, attemptRun: f.run }));
});
