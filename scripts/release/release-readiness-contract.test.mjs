import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  readReleaseConfigIdentityBinding,
  validateCandidateReleaseReadiness,
  validatePrivateConfigIdentityReleaseBinding,
} from './read-production-state.mjs';

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

test('private ConfigIdentity release helper compares every release binding field', async () => {
  const summary = await fixture('candidate-config-identity.json');
  const dir = await mkdtemp(join(tmpdir(), 'worker-config-identity-binding-'));
  const privateSnapshotPath = join(dir, 'worker.json');
  try {
    await writeFile(privateSnapshotPath, JSON.stringify(summary));
    await assert.doesNotReject(
      validatePrivateConfigIdentityReleaseBinding({
        privateSnapshotPath,
        releaseId: summary.releaseId,
        expectedConfigIdentity,
        label: 'Candidate Worker private ConfigIdentity',
      }),
    );

    const mismatches = [
      ['releaseId', { releaseId: 'rc-wrong' }, /not consistent with the release binding/],
      [
        'schemaVersion',
        { expectedConfigIdentity: { ...expectedConfigIdentity, schemaVersion: 2 } },
        /expected schemaVersion disagrees with deployment/,
      ],
      [
        'digest',
        {
          expectedConfigIdentity: {
            ...expectedConfigIdentity,
            digest: `sha256:${'f'.repeat(64)}`,
          },
        },
        /expected digest disagrees with deployment/,
      ],
      [
        'credentialVersionDigest',
        {
          expectedConfigIdentity: {
            ...expectedConfigIdentity,
            credentialVersionDigest: `sha256:${'d'.repeat(64)}`,
          },
        },
        /expected credentialVersionDigest disagrees with deployment/,
      ],
    ];
    for (const [field, overrides, expectedError] of mismatches) {
      await assert.rejects(
        validatePrivateConfigIdentityReleaseBinding({
          privateSnapshotPath,
          releaseId: summary.releaseId,
          expectedConfigIdentity,
          label: 'Candidate Worker private ConfigIdentity',
          ...overrides,
        }),
        expectedError,
        field,
      );
    }

    await writeFile(
      privateSnapshotPath,
      JSON.stringify({
        schemaVersion: 1,
        status: 'unverifiable',
        reason: 'expected_not_bound',
        releaseId: summary.releaseId,
        observed: summary.observed,
      }),
    );
    await assert.rejects(
      validatePrivateConfigIdentityReleaseBinding({
        privateSnapshotPath,
        releaseId: summary.releaseId,
        expectedConfigIdentity,
      }),
      /not consistent with the release binding/,
    );

    await rm(privateSnapshotPath);
    await assert.rejects(
      validatePrivateConfigIdentityReleaseBinding({
        privateSnapshotPath,
        releaseId: summary.releaseId,
        expectedConfigIdentity,
      }),
      /ENOENT/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('rollback release env is parsed without shell evaluation and must match the old Worker snapshot', async () => {
  const summary = await fixture('candidate-config-identity.json');
  const dir = await mkdtemp(join(tmpdir(), 'rollback-worker-binding-'));
  const envPath = join(dir, 'runtime-worker-blue.release.env');
  const privateSnapshotPath = join(dir, 'worker.json');
  try {
    await writeFile(privateSnapshotPath, JSON.stringify(summary));
    await writeFile(envPath, [
      `AGENT_SAAS_RELEASE_ID=${summary.releaseId}`,
      `AGENT_SAAS_CONFIG_IDENTITY_SCHEMA_VERSION=${summary.expected.schemaVersion}`,
      `AGENT_SAAS_CONFIG_IDENTITY_DIGEST=${summary.expected.digest}`,
      '',
    ].join('\n'));
    const binding = await readReleaseConfigIdentityBinding(envPath);
    await assert.doesNotReject(validatePrivateConfigIdentityReleaseBinding({
      privateSnapshotPath,
      ...binding,
      label: 'Rollback Worker private ConfigIdentity',
    }));

    await writeFile(envPath, [
      `AGENT_SAAS_RELEASE_ID=${summary.releaseId}`,
      `AGENT_SAAS_CONFIG_IDENTITY_SCHEMA_VERSION=${summary.expected.schemaVersion}`,
      `AGENT_SAAS_CONFIG_IDENTITY_DIGEST=sha256:${'f'.repeat(64)}`,
      '',
    ].join('\n'));
    await assert.rejects(
      validatePrivateConfigIdentityReleaseBinding({
        privateSnapshotPath,
        ...await readReleaseConfigIdentityBinding(envPath),
        label: 'Rollback Worker private ConfigIdentity',
      }),
      /expected digest disagrees with deployment/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Production and Staging deploy modules enforce the private snapshot commit boundary', async () => {
  const [production, staging, healthRoute] = await Promise.all([
    readFile(new URL('./deploy-production-release.sh', import.meta.url), 'utf8'),
    readFile(new URL('./deploy-staging-release.sh', import.meta.url), 'utf8'),
    readFile(new URL('../../server/src/routes/health.ts', import.meta.url), 'utf8'),
  ]);
  for (const deploy of [production, staging]) {
    assert.match(deploy, /validateCandidateReleaseReadiness/u);
    assert.doesNotMatch(deploy, /(?:ready|api)\.configIdentity/u);
  }
  const workerPidCheck = production.indexOf(
    'pid="$(cat "$run_root/agent-saas-runtime-worker-$color.pid"',
  );
  const workerEnvironmentCheck = production.indexOf(
    'systemctl show "agent-saas-runtime-worker@$color" --property Environment --value',
  );
  assert.ok(workerPidCheck > -1);
  assert.ok(workerEnvironmentCheck > workerPidCheck);
  assert.match(production, /privateSnapshotPath: snapshotPath/u);
  assert.match(production, /readReleaseConfigIdentityBinding/u);
  assert.match(production, /runtime_data_root\/config-governance\/config\.lock/u);

  const candidateInitialCheck = production.indexOf("'Candidate Worker private ConfigIdentity'");
  const candidateFence = production.indexOf(
    'acquire_config_governance_fence /mnt/agent-saas/server-data',
    candidateInitialCheck,
  );
  const candidateFinalCheck = production.indexOf(
    "'Candidate Worker final ConfigIdentity'",
    candidateFence,
  );
  const candidateMarker = production.indexOf(
    'commit_worker_active_color "$worker_idle"',
    candidateFinalCheck,
  );
  assert.ok(candidateInitialCheck > -1);
  assert.ok(candidateFence > candidateInitialCheck);
  assert.ok(candidateFinalCheck > candidateFence);
  assert.ok(candidateMarker > candidateFinalCheck);

  const rollbackInitialCheck = production.indexOf("'Rollback Worker private ConfigIdentity'");
  const rollbackFence = production.indexOf(
    'acquire_config_governance_fence /mnt/agent-saas/server-data',
    rollbackInitialCheck,
  );
  const rollbackCandidateStop = production.indexOf(
    'systemctl disable --now "agent-saas-runtime-worker@$worker_idle"',
    rollbackFence,
  );
  const rollbackFinalCheck = production.indexOf(
    "'Rollback Worker final ConfigIdentity'",
    rollbackCandidateStop,
  );
  const rollbackMarker = production.indexOf(
    'commit_worker_active_color "$worker_active"',
    rollbackFinalCheck,
  );
  assert.ok(rollbackInitialCheck > -1);
  assert.ok(rollbackFence > rollbackInitialCheck);
  assert.ok(rollbackCandidateStop > rollbackFence);
  assert.ok(rollbackFinalCheck > rollbackCandidateStop);
  assert.ok(rollbackMarker > rollbackFinalCheck);
  assert.match(production, /Rollback candidate Worker restored authority/u);
  assert.match(healthRoute, /摘要本身只走平台管理员 API \/ 私有运行态快照，不进匿名响应/u);
  assert.doesNotMatch(
    healthRoute.slice(
      healthRoute.indexOf("router.get('/healthz/ready'"),
      healthRoute.indexOf("router.get('/healthz/drain'"),
    ),
    /configIdentity\s*[},]/u,
  );
});
