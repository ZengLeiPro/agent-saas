import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalJson, digestBuffer } from './artifact-lib.mjs';
import { baselineFromCheckpoint, createProductionCheckpoint } from './production-checkpoint.mjs';
import {
  assertRepairManifest,
  validateRecoveryObservations,
} from './read-production-recovery-state.mjs';
const sha = 'a'.repeat(40);
const digest = `sha256:${'b'.repeat(64)}`;
function manifest() {
  const app = { sourceSha: sha, artifactDigest: digest, action: 'deploy' };
  const body = {
    schemaVersion: 2,
    releaseId: 'rc-20260908-00',
    releaseSha: sha,
    components: {
      api: app,
      runtimeWorker: app,
      web: { ...app, action: 'keep' },
      acs: {
        sourceSha: sha,
        orchestratorArtifactDigest: digest,
        sandboxImageDigest: digest,
        action: 'deploy',
      },
    },
    migrationPlan: { phase: 'none', contract: 'separate_release' },
  };
  return {
    ...body,
    digest: digestBuffer(Buffer.from(`agent-saas-release-manifest-v2\0${canonicalJson(body)}`)),
  };
}
const expectedConfig = { schemaVersion: 1, digest };
const observedConfig = {
  ...expectedConfig,
  credentialVersionDigest: null,
  versionResolution: 'resolved',
  secretRefCount: 0,
};
function observations() {
  const release = manifest();
  const env = {
    AGENT_SAAS_RELEASE_ID: release.releaseId,
    AGENT_SAAS_RELEASE_SHA: sha,
    AGENT_SAAS_SERVER_DIGEST: digest,
  };
  return {
    manifest: release,
    installedManifest: release,
    trusted: {
      environment: 'production',
      configIdentity: expectedConfig,
      components: {
        api: { gitSha: sha, artifactDigest: digest },
        runtimeWorker: { gitSha: sha, artifactDigest: digest },
      },
    },
    apiEnv: { ...env },
    workerEnv: { ...env },
    serverBytes: { artifactDigest: digest },
    acsBytes: { artifactDigest: digest },
    web: { schemaVersion: 1, environment: 'production', releaseSha: sha, webDigest: digest },
    acs: {
      status: 'ok',
      environment: 'production',
      releaseIdentityAttested: true,
      namespace: 'agent-saas-coding',
      sourceSha: sha,
      orchestratorArtifactDigest: digest,
      sandboxImageDigest: digest,
    },
    expectedConfig,
    observedConfig,
  };
}
test('explicit repair proves old App bytes and fresh offline config without pretending old readiness', () => {
  const result = validateRecoveryObservations(observations());
  assert.equal(result.configIdentity.status, 'consistent');
  assert.equal(result.status, undefined);
  assert.equal(result.components.api.artifactDigest, digest);
});
test('explicit repair reports fully resolved credential-only rotation without accepting config drift', () => {
  const o = observations();
  o.expectedConfig = {
    ...o.expectedConfig,
    credentialVersionDigest: `sha256:${'c'.repeat(64)}`,
  };
  o.trusted.configIdentity = o.expectedConfig;
  o.observedConfig = {
    ...o.observedConfig,
    secretRefCount: 1,
    credentialVersionDigest: `sha256:${'d'.repeat(64)}`,
  };
  const result = validateRecoveryObservations(o);
  assert.equal(result.configIdentity.status, 'drifted');
  assert.equal(result.configIdentity.expected.digest, result.configIdentity.observed.digest);
});
for (const [label, change] of Object.entries({
  'config drift': (o) => {
    o.observedConfig = { ...o.observedConfig, digest: `sha256:${'c'.repeat(64)}` };
  },
  'unknown App prefix': (o) => {
    o.trusted.components.api.artifactDigest = `sha256:${'c'.repeat(64)}`;
  },
  'mixed generations': (o) => {
    o.workerEnv.AGENT_SAAS_RELEASE_ID = 'rc-20260908-01';
  },
  'wrong installed bytes': (o) => {
    o.serverBytes.artifactDigest = `sha256:${'c'.repeat(64)}`;
  },
  'unhealthy ACS': (o) => {
    o.acs.status = 'unhealthy';
  },
  'wrong ACS bytes': (o) => {
    o.acsBytes.artifactDigest = `sha256:${'c'.repeat(64)}`;
  },
  'foreign Web': (o) => {
    o.web.environment = 'staging';
  },
}))
  test(`repair refuses ${label}`, () => {
    const o = observations();
    change(o);
    assert.throws(() => validateRecoveryObservations(o));
  });
test('repair rejects keep-App and contract plans even if manifest digest is valid', () => {
  for (const change of [
    (m) => {
      m.components.api = { ...m.components.api, action: 'keep' };
    },
    (m) => {
      m.migrationPlan.phase = 'contract';
    },
  ]) {
    const m = manifest();
    change(m);
    const { digest: unused, ...body } = m;
    m.digest = digestBuffer(Buffer.from(`agent-saas-release-manifest-v2\0${canonicalJson(body)}`));
    assert.throws(() => assertRepairManifest(m));
  }
});
function checkpoint() {
  const o = observations();
  const result = validateRecoveryObservations(o);
  const body = {
    schemaVersion: 1,
    environment: 'production',
    releaseId: o.manifest.releaseId,
    observedAt: '2026-09-08T01:00:00.000Z',
    ...result,
  };
  return createProductionCheckpoint({
    manifest: o.manifest,
    state: { ...body, digest: digestBuffer(Buffer.from(canonicalJson(body))) },
    completed: {
      state: 'completed',
      releaseId: o.manifest.releaseId,
      manifestDigest: o.manifest.digest,
    },
    runId: 123,
    runAttempt: 2,
    now: Date.parse(body.observedAt),
  });
}
test('historical baseline keeps immutable component proof and removes current health/config assertions', () => {
  const cp = checkpoint();
  const baseline = baselineFromCheckpoint(cp);
  assert.deepEqual(baseline.components, cp.productionState.components);
  assert.equal(baseline.configIdentity, undefined);
  assert.equal(baseline.topology, undefined);
  assert.equal(baseline.baselineObservation.kind, 'last_committed');
  assert.equal(baseline.baselineObservation.checkpointDigest, cp.digest);
});
test('checkpoint rejects uncompleted, mismatched, and tampered history', () => {
  const cp = checkpoint();
  cp.productionState.components.api.gitSha = 'c'.repeat(40);
  assert.throws(() => baselineFromCheckpoint(cp), /checkpoint digest/u);
  const valid = checkpoint();
  assert.throws(
    () =>
      createProductionCheckpoint({
        manifest: valid.manifest,
        state: valid.productionState,
        completed: { ...valid.completed, state: 'needs_human' },
        runId: 1,
        runAttempt: 1,
      }),
    /completed promotion/u,
  );
});

test('new checkpoints reject stale and future observations while historical baseline remains usable', () => {
  const cp = checkpoint();
  for (const offset of [300_001, -30_001]) {
    assert.throws(
      () =>
        createProductionCheckpoint({
          manifest: cp.manifest,
          state: cp.productionState,
          completed: cp.completed,
          runId: 123,
          runAttempt: 2,
          now: Date.parse(cp.productionState.observedAt) + offset,
        }),
      /must be fresh/u,
    );
  }
  assert.equal(baselineFromCheckpoint(cp).baselineObservation.kind, 'last_committed');
});
