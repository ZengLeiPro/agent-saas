import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalJson, digestBuffer } from './artifact-lib.mjs';
import { confirmExpandMigration } from './confirm-expand-migration.mjs';

const SHA = 'a'.repeat(40);
const DIGEST = `sha256:${'b'.repeat(64)}`;
const MANIFEST_DIGEST = `sha256:${'c'.repeat(64)}`;
const PLAN_DIGEST = `sha256:${'d'.repeat(64)}`;
const RELEASE_ID = 'rc-20260831-01';
const NOW = new Date('2026-08-31T00:05:00.000Z');

const manifest = {
  releaseId: RELEASE_ID,
  releaseSha: SHA,
  digest: MANIFEST_DIGEST,
  migrationPlan: {
    phase: 'expand',
    confirmation: 'required_after_observation',
    planDigest: PLAN_DIGEST,
  },
  components: {
    web: { sourceSha: SHA, artifactDigest: DIGEST },
    api: { sourceSha: SHA, artifactDigest: DIGEST },
    runtimeWorker: { sourceSha: SHA, artifactDigest: DIGEST },
    acs: {
      sourceSha: SHA,
      orchestratorArtifactDigest: DIGEST,
      sandboxImageDigest: DIGEST,
    },
  },
};
const components = {
  web: { gitSha: SHA, artifactDigest: DIGEST },
  api: { gitSha: SHA, artifactDigest: DIGEST },
  runtimeWorker: { gitSha: SHA, artifactDigest: DIGEST },
  acs: {
    gitSha: SHA,
    orchestratorArtifactDigest: DIGEST,
    sandboxImageDigest: DIGEST,
  },
};
const targetDigest = digestBuffer(canonicalJson(components));
const promotingReason = JSON.stringify({
  releaseId: RELEASE_ID,
  releaseSha: SHA,
  manifestDigest: MANIFEST_DIGEST,
  migrationPhase: 'expand',
  migrationPlanDigest: PLAN_DIGEST,
  productionBeforeDigest: `sha256:${'e'.repeat(64)}`,
  productionTargetDigest: targetDigest,
});
const attestations = [
  {
    state: 'promoting',
    releaseId: RELEASE_ID,
    manifestDigest: MANIFEST_DIGEST,
    recordedAt: '2026-08-31T00:00:00.000Z',
    reason: promotingReason,
  },
  {
    state: 'awaiting_expand_confirmation',
    releaseId: RELEASE_ID,
    manifestDigest: MANIFEST_DIGEST,
    recordedAt: '2026-08-31T00:01:00.000Z',
  },
];
const live = {
  schemaVersion: 1,
  environment: 'production',
  observedAt: '2026-08-31T00:04:00.000Z',
  components,
};
const apiReady = {
  status: 'ok',
  release: {
    environment: 'production',
    safetyAttested: true,
    releaseId: RELEASE_ID,
    releaseSha: SHA,
  },
};

function confirm(overrides = {}) {
  return confirmExpandMigration({
    manifest,
    attestations,
    live,
    apiReady,
    now: NOW,
    ...overrides,
  });
}

test('confirms only the original RC, migration plan, promotion baseline and live target', () => {
  const evidence = confirm();
  assert.deepEqual(evidence, {
    schemaVersion: 1,
    releaseId: RELEASE_ID,
    manifestDigest: MANIFEST_DIGEST,
    migrationPlanDigest: PLAN_DIGEST,
    productionBeforeDigest: `sha256:${'e'.repeat(64)}`,
    productionTargetDigest: targetDigest,
    liveObservedAt: '2026-08-31T00:04:00.000Z',
    apiReadyReleaseId: RELEASE_ID,
    apiReadyReleaseSha: SHA,
    confirmedAt: '2026-08-31T00:05:00.000Z',
    status: 'completed',
  });
});

test('fails closed for duplicate confirmation and production drift', () => {
  assert.throws(
    () =>
      confirm({ attestations: [...attestations, { ...attestations.at(-1), state: 'completed' }] }),
    /cannot be confirmed from completed/u,
  );
  assert.throws(
    () =>
      confirm({
        live: {
          ...live,
          components: {
            ...components,
            web: { ...components.web, artifactDigest: `sha256:${'f'.repeat(64)}` },
          },
        },
      }),
    /baseline drifted/u,
  );
});

test('fails closed for cross-manifest and cross-plan confirmation', () => {
  assert.throws(
    () =>
      confirm({
        manifest: { ...manifest, migrationPlan: { ...manifest.migrationPlan, planDigest: DIGEST } },
      }),
    /not bound/u,
  );
  assert.throws(
    () =>
      confirm({
        attestations: [attestations[0], { ...attestations[1], manifestDigest: DIGEST }],
      }),
    /not bound/u,
  );
});

test('fails closed for an API migration/readiness readback from another release', () => {
  assert.throws(
    () =>
      confirm({
        apiReady: { ...apiReady, release: { ...apiReady.release, releaseId: 'rc-20260831-02' } },
      }),
    /not bound to the RC/u,
  );
});

test('fails closed when the confirmation window or production readback is stale', () => {
  assert.throws(() => confirm({ now: new Date('2026-08-31T02:01:00.001Z') }), /window expired/u);
  assert.throws(
    () => confirm({ live: { ...live, observedAt: '2026-08-30T23:59:59.999Z' } }),
    /readback is stale/u,
  );
});
