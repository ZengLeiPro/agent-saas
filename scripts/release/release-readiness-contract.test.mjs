import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { validateCandidateReleaseReadiness } from './read-production-state.mjs';

const fixture = async (name) =>
  JSON.parse(await readFile(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));

const expectedConfigIdentity = {
  schemaVersion: 1,
  digest: `sha256:${'c'.repeat(64)}`,
  credentialVersionDigest: null,
  versionResolution: 'resolved',
  secretRefCount: 0,
};

test('real anonymous readiness fixtures stay summary-free and validate against private snapshots', async () => {
  const manifest = await fixture('candidate-manifest.json');
  const privateSnapshotPath = new URL('./fixtures/candidate-config-identity.json', import.meta.url);
  for (const environment of ['production', 'staging']) {
    const readiness = await fixture(`${environment}-readiness.json`);
    assert.equal(Object.hasOwn(readiness, 'configIdentity'), false);
    assert.equal(expectedConfigIdentity.versionResolution, 'resolved');
    const summary = await validateCandidateReleaseReadiness({
      environment,
      manifest,
      readiness,
      privateSnapshotPath,
      expectedConfigIdentity,
    });
    assert.equal(summary.status, 'consistent');
  }
});

test('candidate contract rejects anonymous summary leaks and deployment/snapshot disagreement', async () => {
  const manifest = await fixture('candidate-manifest.json');
  const readiness = await fixture('production-readiness.json');
  const privateSnapshotPath = new URL('./fixtures/candidate-config-identity.json', import.meta.url);
  await assert.rejects(
    validateCandidateReleaseReadiness({
      environment: 'production',
      manifest,
      readiness: { ...readiness, configIdentity: await fixture('candidate-config-identity.json') },
      privateSnapshotPath,
      expectedConfigIdentity,
    }),
    /must not expose ConfigIdentity summary/,
  );
  await assert.rejects(
    validateCandidateReleaseReadiness({
      environment: 'production',
      manifest,
      readiness: {
        ...readiness,
        release: {
          ...readiness.release,
          expectedConfigIdentity: {
            ...expectedConfigIdentity,
            credentialVersionDigest: `sha256:${'d'.repeat(64)}`,
          },
        },
      },
      privateSnapshotPath,
      expectedConfigIdentity,
    }),
    /must not expose ConfigIdentity summary/,
  );
  await assert.rejects(
    validateCandidateReleaseReadiness({
      environment: 'production',
      manifest,
      readiness,
      privateSnapshotPath,
      expectedConfigIdentity: {
        ...expectedConfigIdentity,
        digest: `sha256:${'f'.repeat(64)}`,
      },
    }),
    /disagrees with deployment/,
  );
});

test('Production and Staging deploy modules consume the same private snapshot contract', async () => {
  const [production, staging, healthRoute] = await Promise.all([
    readFile(new URL('./deploy-production-release.sh', import.meta.url), 'utf8'),
    readFile(new URL('./deploy-staging-release.sh', import.meta.url), 'utf8'),
    readFile(new URL('../../server/src/routes/health.ts', import.meta.url), 'utf8'),
  ]);
  for (const deploy of [production, staging]) {
    assert.match(deploy, /validateCandidateReleaseReadiness/u);
    assert.doesNotMatch(deploy, /(?:ready|api)\.configIdentity/u);
  }
  assert.match(healthRoute, /摘要本身只走平台管理员 API \/ 私有运行态快照，不进匿名响应/u);
  assert.doesNotMatch(
    healthRoute.slice(
      healthRoute.indexOf("router.get('/healthz/ready'"),
      healthRoute.indexOf("router.get('/healthz/drain'"),
    ),
    /configIdentity\s*[},]/u,
  );
});
