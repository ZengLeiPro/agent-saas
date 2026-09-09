import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const root = new URL('../../', import.meta.url);
const deploy = new URL('../deploy-recovery-web.sh', import.meta.url);

test('recovery audit, verified repair, refusal and compensation contracts', () => {
  const result = spawnSync('python3', [new URL('./web-recovery-repair.test.py', import.meta.url).pathname], {
    encoding: 'utf8', timeout: 30_000,
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  process.stdout.write(result.stderr);
});

test('recovery workflow is manual, protected, locked and does not loosen the ordinary deploy gate', async () => {
  const workflow = await readFile(new URL('.github/workflows/repair-web-recovery.yml', root), 'utf8');
  assert.match(workflow, /workflow_dispatch:/);
  assert.doesNotMatch(workflow, /\n  (?:push|pull_request):/);
  for (const contract of ['default: audit', 'environment: production', 'group: production-runtime',
    'cancel-in-progress: false', "github.ref == 'refs/heads/main'", 'EXPECTED_PLAN_DIGEST',
    'test "$CONFIRM_RECOVERY_ONLY" = true', 'PRODUCTION_SSH_HOST_KEY_SHA256',
    'run-with-production-lock-guard.sh', 'web-recovery-report.json']) assert.ok(workflow.includes(contract), contract);
  const script = await readFile(new URL('./repair-web-recovery.py', import.meta.url), 'utf8');
  assert.doesNotMatch(script, /write-live-production-identity|systemctl|ossutil['", ]+rm/);
  assert.match(script, /check_public_identity/);
  assert.match(script, /seal-root-staged-payload/);
});

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'recovery-reuse-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const release = join(directory, 'releases', 'same-sha');
  await mkdir(release, { recursive: true });
  const files = { 'index.html': 'old HTML', 'sw.js': 'old SW', 'manifest.webmanifest': '{}', 'release-identity.json': '{"old":true}' };
  for (const [key, value] of Object.entries(files)) await writeFile(join(release, key), value);
  await symlink(release, join(directory, 'current'));
  async function archive(overrides = {}) {
    const source = await mkdtemp(join(directory, 'incoming-'));
    for (const [key, value] of Object.entries({ ...files, ...overrides })) {
      await mkdir(join(source, key, '..'), { recursive: true });
      await writeFile(join(source, key), value);
    }
    const file = `${source}.tgz`;
    const result = spawnSync('tar', ['-C', source, '-czf', file, '.'], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return file;
  }
  function run(file, runId = '123.2') {
    return spawnSync('bash', [deploy.pathname], { encoding: 'utf8', env: {
      ...process.env, RECOVERY_WEB_ROOT: directory, RELEASE_ID: 'same-sha', RUN_ID: runId,
      ARCHIVE: file, RECOVERY_WEB_BEFORE_TARGET: release,
    } });
  }
  return { directory, release, files, archive, run };
}

test('same SHA with different HTML gets a new immutable target and leaves the old release intact', async (t) => {
  const value = await fixture(t);
  const file = await value.archive({ 'index.html': 'new HTML' });
  const result = value.run(file);
  assert.equal(result.status, 0, result.stderr);
  const target = await readlink(join(value.directory, 'current'));
  assert.equal(target, `${value.release}.123.2`);
  assert.equal(await readFile(join(target, 'index.html'), 'utf8'), 'new HTML');
  assert.equal(await readFile(join(value.release, 'index.html'), 'utf8'), 'old HTML');
  assert.equal(await readlink(join(value.directory, 'previous')), value.release);
  assert.match(await readFile(join(value.directory, 'transactions/123.2.activation'), 'utf8'), /state=activated/);
  // An activated receipt is idempotent even after the input archive was moved.
  assert.equal(value.run(file).status, 0);
});

test('identical same-SHA contents can be reused without inventing another target', async (t) => {
  const value = await fixture(t);
  const result = value.run(await value.archive());
  assert.equal(result.status, 0, result.stderr);
  assert.equal(await readlink(join(value.directory, 'current')), value.release);
});

test('a changed release identity alone cannot silently reuse the previous SHA directory', async (t) => {
  const value = await fixture(t);
  const result = value.run(await value.archive({ 'release-identity.json': '{"new":true}' }));
  assert.equal(result.status, 0, result.stderr);
  const target = await readlink(join(value.directory, 'current'));
  assert.notEqual(target, value.release);
  assert.equal(await readFile(join(target, 'release-identity.json'), 'utf8'), '{"new":true}');
});

test('shared immutable asset conflicts still fail before current changes', async (t) => {
  const value = await fixture(t);
  await mkdir(join(value.directory, 'shared-root/assets'), { recursive: true });
  await writeFile(join(value.directory, 'shared-root/assets/hash.js'), 'old immutable');
  const result = value.run(await value.archive({ 'assets/hash.js': 'different immutable' }));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /immutable recovery Web asset conflicts/);
  assert.equal(await readlink(join(value.directory, 'current')), value.release);
});

test('a conflicting transaction target is never overwritten', async (t) => {
  const value = await fixture(t);
  await mkdir(`${value.release}.123.2`);
  await writeFile(join(`${value.release}.123.2`, 'index.html'), 'reserved');
  const result = value.run(await value.archive({ 'index.html': 'new' }));
  assert.notEqual(result.status, 0);
  assert.equal(await readlink(join(value.directory, 'current')), value.release);
  assert.equal(await readFile(join(`${value.release}.123.2`, 'index.html'), 'utf8'), 'reserved');
});
