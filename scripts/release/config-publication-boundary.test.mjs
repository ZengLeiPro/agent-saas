import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  atomicWrite, preparePublicationAuthority, rawRevision, saveSnapshot, writePublication,
} from './config-publication.mjs';
import { validatePrivateConfigIdentityReleaseBinding } from './read-production-state.mjs';

const OLD = { schemaVersion: 1, digest: `sha256:${'a'.repeat(64)}` };
const ONLINE = { schemaVersion: 1, digest: `sha256:${'b'.repeat(64)}` };
async function fixture(fn) {
  const root = mkdtempSync(join(tmpdir(), 'publication-boundary-'));
  const configPath = join(root, 'config.json');
  const snapshot = join(root, 'private-summary.json');
  const summary = (identity, releaseId = 'release-a') => ({
    schemaVersion: 1, status: 'consistent', releaseId, expected: identity,
    observed: { ...identity, credentialVersionDigest: null, versionResolution: 'resolved', secretRefCount: 0 },
  });
  writeFileSync(configPath, '{}\n');
  try {
    const baseline = preparePublicationAuthority(configPath, 'release-a', OLD);
    const next = '{"models":{"default":"main/model"}}\n';
    saveSnapshot(configPath, next);
    writePublication(configPath, { ...baseline, revision: randomUUID(), sequence: 2,
      rawRevision: rawRevision(next), identity: ONLINE, changedPaths: ['models'], actor: 'admin' });
    atomicWrite(configPath, next);
    atomicWrite(snapshot, JSON.stringify(summary(ONLINE)));
    await fn({ configPath, snapshot, summary });
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test('old-instance rollback boundary accepts only the signed current online version', () => fixture(async ({ configPath, snapshot }) => {
  await assert.rejects(validatePrivateConfigIdentityReleaseBinding({
    privateSnapshotPath: snapshot, releaseId: 'release-a', expectedConfigIdentity: OLD,
  }), /disagrees/u);
  const verified = await validatePrivateConfigIdentityReleaseBinding({
    privateSnapshotPath: snapshot, releaseId: 'release-a', expectedConfigIdentity: OLD,
    productionConfigPath: configPath,
  });
  assert.equal(verified.expected.digest, ONLINE.digest);
}));

test('signed config selection does not weaken exact code-release binding', () => fixture(async ({ configPath, snapshot }) => {
  await assert.rejects(validatePrivateConfigIdentityReleaseBinding({
    privateSnapshotPath: snapshot, releaseId: 'another-code-release', expectedConfigIdentity: ONLINE,
    productionConfigPath: configPath,
  }), /release binding/u);
}));

test('a different code release still uses its own freshly computed candidate identity', () => fixture(async ({ configPath, snapshot, summary }) => {
  atomicWrite(snapshot, JSON.stringify(summary(OLD, 'release-b')));
  await validatePrivateConfigIdentityReleaseBinding({
    privateSnapshotPath: snapshot, releaseId: 'release-b', expectedConfigIdentity: OLD,
    productionConfigPath: configPath,
  });
}));

test('unpublished file changes cannot be accepted by rollback validation', () => fixture(async ({ configPath, snapshot }) => {
  writeFileSync(configPath, '{"unpublished":true}');
  await assert.rejects(validatePrivateConfigIdentityReleaseBinding({
    privateSnapshotPath: snapshot, releaseId: 'release-a', expectedConfigIdentity: OLD,
    productionConfigPath: configPath,
  }), /Unpublished/u);
}));

test('both environment-bound rollback validators explicitly select the production authority', () => {
  const source = readFileSync('scripts/release/deploy-production-release.sh', 'utf8');
  for (const functionName of ['validate_worker_release_boundary', 'validate_api_release_boundary_from_env']) {
    const start = source.indexOf(`${functionName}() {`);
    assert.ok(start >= 0);
    const block = source.slice(start, source.indexOf('\n}\n', start));
    assert.match(block, /productionConfigPath: '\/etc\/agent-saas\/config\.json'/u);
  }
});
