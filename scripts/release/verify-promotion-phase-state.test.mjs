import assert from 'node:assert/strict';
import test from 'node:test';
import { assertPromotionPhaseState } from './verify-promotion-phase-state.mjs';

const BASE_SHA = 'a'.repeat(40);
const RELEASE_SHA = 'b'.repeat(40);
const digest = (value) => `sha256:${value.repeat(64)}`;

function fixture() {
  const manifest = {
    productionBaseline: {
      web: { sourceSha: BASE_SHA, artifactDigest: digest('1') },
      api: { sourceSha: BASE_SHA, artifactDigest: digest('2') },
      runtimeWorker: { sourceSha: BASE_SHA, artifactDigest: digest('2') },
      acs: {
        sourceSha: BASE_SHA,
        orchestratorArtifactDigest: digest('3'),
        sandboxImageDigest: digest('4'),
      },
    },
    components: {
      web: { action: 'deploy', sourceSha: RELEASE_SHA, artifactDigest: digest('5') },
      api: { action: 'deploy', sourceSha: RELEASE_SHA, artifactDigest: digest('6') },
      runtimeWorker: { action: 'deploy', sourceSha: RELEASE_SHA, artifactDigest: digest('6') },
      acs: {
        action: 'deploy',
        sourceSha: RELEASE_SHA,
        orchestratorArtifactDigest: digest('7'),
        sandboxImageDigest: digest('8'),
      },
    },
  };
  const state = {
    components: {
      web: { gitSha: BASE_SHA, artifactDigest: digest('1') },
      api: { gitSha: BASE_SHA, artifactDigest: digest('2') },
      runtimeWorker: { gitSha: BASE_SHA, artifactDigest: digest('2') },
      acs: {
        gitSha: BASE_SHA,
        orchestratorArtifactDigest: digest('3'),
        sandboxImageDigest: digest('4'),
      },
    },
  };
  return { manifest, state };
}

function deployAcs(value) {
  value.state.components.acs = {
    gitSha: RELEASE_SHA,
    orchestratorArtifactDigest: digest('7'),
    sandboxImageDigest: digest('8'),
  };
}

function deployApp(value) {
  value.state.components.api = { gitSha: RELEASE_SHA, artifactDigest: digest('6') };
  value.state.components.runtimeWorker = { gitSha: RELEASE_SHA, artifactDigest: digest('6') };
}

test('each promotion phase accepts only its exact predecessor matrix', () => {
  const value = fixture();
  assert.doesNotThrow(() => assertPromotionPhaseState(value.manifest, value.state, 'acs'));
  deployAcs(value);
  assert.doesNotThrow(() => assertPromotionPhaseState(value.manifest, value.state, 'app'));
  deployApp(value);
  assert.doesNotThrow(() => assertPromotionPhaseState(value.manifest, value.state, 'web'));
});

test('fails closed when another deploy changes production between phases', () => {
  const beforeAcs = fixture();
  beforeAcs.state.components.api.artifactDigest = digest('9');
  assert.throws(
    () => assertPromotionPhaseState(beforeAcs.manifest, beforeAcs.state, 'acs'),
    /Production changed after promotion gate: api\.artifactDigest/u,
  );

  const beforeApp = fixture();
  deployAcs(beforeApp);
  beforeApp.state.components.runtimeWorker.artifactDigest = digest('9');
  assert.throws(
    () => assertPromotionPhaseState(beforeApp.manifest, beforeApp.state, 'app'),
    /Production changed after promotion gate: runtimeWorker\.artifactDigest/u,
  );

  const beforeWeb = fixture();
  deployAcs(beforeWeb);
  deployApp(beforeWeb);
  beforeWeb.state.components.acs.sandboxImageDigest = digest('9');
  assert.throws(
    () => assertPromotionPhaseState(beforeWeb.manifest, beforeWeb.state, 'web'),
    /Production changed after promotion gate: acs\.sandboxImageDigest/u,
  );
});

test('partial keep matrices preserve the frozen baseline expectation', () => {
  const value = fixture();
  value.manifest.components.api.action = 'keep';
  value.manifest.components.runtimeWorker.action = 'keep';
  value.manifest.components.acs.action = 'keep';
  assert.doesNotThrow(() => assertPromotionPhaseState(value.manifest, value.state, 'app'));
  assert.doesNotThrow(() => assertPromotionPhaseState(value.manifest, value.state, 'web'));
});
