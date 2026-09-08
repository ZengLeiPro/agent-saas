import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  atomicWrite, preparePublicationAuthority, publishedExpected, rawRevision,
  saveSnapshot, writePublication,
} from './config-publication.mjs';
import { validateExpectedConfigIdentityObservers } from './read-production-state.mjs';

const RELEASE_BASELINE = { schemaVersion: 1, digest: `sha256:${'a'.repeat(64)}` };
const ONLINE = { schemaVersion: 1, digest: `sha256:${'b'.repeat(64)}` };
function withPublished(fn) {
  const root = mkdtempSync(join(tmpdir(), 'published-release-evidence-'));
  const configPath = join(root, 'config.json');
  writeFileSync(configPath, '{}\n');
  try {
    const initial = preparePublicationAuthority(configPath, 'release-a', RELEASE_BASELINE);
    const next = '{"models":{"default":"main/model"}}\n';
    saveSnapshot(configPath, next);
    const record = writePublication(configPath, { ...initial, revision: randomUUID(),
      sequence: 2, rawRevision: rawRevision(next), identity: ONLINE,
      changedPaths: ['models'], actor: 'authorized-platform-admin' });
    atomicWrite(configPath, next);
    return fn({ configPath, record, next });
  } finally { rmSync(root, { recursive: true, force: true }); }
}
function summary(identity, releaseId = 'release-a') {
  return { schemaVersion: 1, status: 'consistent', releaseId, expected: identity,
    observed: { ...identity, credentialVersionDigest: null, versionResolution: 'resolved', secretRefCount: 0 } };
}

test('steady-state release evidence accepts signed online changes without changing code release identity', () => withPublished(({ configPath }) => {
  assert.throws(() => validateExpectedConfigIdentityObservers(RELEASE_BASELINE, summary(ONLINE), { configIdentityStage: 'steady-state' }));
  const authorized = publishedExpected(configPath, 'release-a', RELEASE_BASELINE);
  assert.doesNotThrow(() => validateExpectedConfigIdentityObservers(authorized, summary(ONLINE), { configIdentityStage: 'steady-state' }));
}));

test('a new code release uses its independently computed expected identity, not another code version digest', () => withPublished(({ configPath, next }) => {
  const nextCodeIdentity = { schemaVersion: 1, digest: `sha256:${'c'.repeat(64)}` };
  assert.deepEqual(publishedExpected(configPath, 'release-b', nextCodeIdentity), nextCodeIdentity);
  assert.equal(readFileSync(configPath, 'utf8'), next);
}));

test('returning to the prior code release selects its signed online identity rather than its stale original baseline', () => withPublished(({ configPath }) => {
  assert.deepEqual(publishedExpected(configPath, 'release-a', RELEASE_BASELINE), ONLINE);
  assert.doesNotThrow(() => validateExpectedConfigIdentityObservers(
    publishedExpected(configPath, 'release-a', RELEASE_BASELINE), summary(ONLINE), { configIdentityStage: 'steady-state' },
  ));
}));

test('all configuration identity transport manifests carry the shared signature verifier', () => {
  for (const path of [
    '.github/workflows/ci.yml', '.github/workflows/promote-release.yml',
    '.github/workflows/deploy-staging.yml', '.github/workflows/acs-sandbox.yml',
    'scripts/release/finalize-expand-migration.sh', '.github/acs-runtime-inputs.txt',
  ]) {
    assert.match(readFileSync(path, 'utf8'), /scripts\/release\/config-publication\.mjs/u, `${path} must transport the verifier`);
  }
});

test('build and deployment ship a sealed publication CLI and do not bootstrap in the runtime observer', () => {
  const scripts = JSON.parse(readFileSync('server/package.json', 'utf8')).scripts;
  assert.match(scripts['build:config-identity-cli'], /src\/release\/configPublicationCli\.ts/u);
  assert.match(readFileSync('scripts/release/deploy-production-release.sh', 'utf8'), /config-publication-cli\.js" prepare/u);
  assert.doesNotMatch(readFileSync('server/src/app/productionModelPublication.ts', 'utf8'), /preparePublicationAuthority/u);
});
