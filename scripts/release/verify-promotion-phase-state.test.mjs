import assert from 'node:assert/strict';
import test from 'node:test';
import { validateLiveProductionComponents } from './read-live-production-components.mjs';
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

function readLiveState(state) {
  const { components } = state;
  return {
    components: validateLiveProductionComponents({
      api: {
        status: 'ok',
        release: {
          environment: 'production',
          releaseSha: components.api.gitSha,
          serverDigest: components.api.artifactDigest,
          safetyAttested: true,
        },
      },
      web: {
        schemaVersion: 1,
        environment: 'production',
        releaseSha: components.web.gitSha,
        webDigest: components.web.artifactDigest,
      },
      workerReleaseEnvironment: {
        AGENT_SAAS_RELEASE_SHA: components.runtimeWorker.gitSha,
        AGENT_SAAS_SERVER_DIGEST: components.runtimeWorker.artifactDigest,
      },
      workerSystemdEnvironment: 'AGENT_SAAS_ENVIRONMENT=production',
      acs: {
        environment: 'production',
        releaseIdentityAttested: true,
        namespace: 'agent-saas-coding',
        sourceSha: components.acs.gitSha,
        orchestratorArtifactDigest: components.acs.orchestratorArtifactDigest,
        sandboxImageDigest: components.acs.sandboxImageDigest,
      },
    }),
  };
}

test('live reader accepts ACS → App → Web only at each exact predecessor matrix', () => {
  const value = fixture();
  assert.doesNotThrow(() =>
    assertPromotionPhaseState(value.manifest, readLiveState(value.state), 'acs'),
  );
  deployAcs(value);
  assert.doesNotThrow(() =>
    assertPromotionPhaseState(value.manifest, readLiveState(value.state), 'app'),
  );
  deployApp(value);
  assert.doesNotThrow(() =>
    assertPromotionPhaseState(value.manifest, readLiveState(value.state), 'web'),
  );
});

test('current phase retry accepts the exact target after a committed phase failure', () => {
  const value = fixture();
  deployAcs(value);
  assert.doesNotThrow(() =>
    assertPromotionPhaseState(value.manifest, readLiveState(value.state), 'acs'),
  );
  assert.doesNotThrow(() =>
    assertPromotionPhaseState(value.manifest, readLiveState(value.state), 'app'),
  );
  deployApp(value);
  assert.doesNotThrow(() =>
    assertPromotionPhaseState(value.manifest, readLiveState(value.state), 'app'),
  );
  assert.doesNotThrow(() =>
    assertPromotionPhaseState(value.manifest, readLiveState(value.state), 'web'),
  );
  value.state.components.web = { gitSha: RELEASE_SHA, artifactDigest: digest('5') };
  assert.doesNotThrow(() =>
    assertPromotionPhaseState(value.manifest, readLiveState(value.state), 'web'),
  );
});

test('whole job retry accepts only an exact committed prefix from every earlier phase', () => {
  const value = fixture();
  deployAcs(value);
  deployApp(value);
  value.state.components.web = { gitSha: RELEASE_SHA, artifactDigest: digest('5') };
  for (const phase of ['acs', 'app', 'web']) {
    assert.doesNotThrow(() =>
      assertPromotionPhaseState(value.manifest, readLiveState(value.state), phase),
    );
  }

  const skippedPredecessors = fixture();
  skippedPredecessors.state.components.web = {
    gitSha: RELEASE_SHA,
    artifactDigest: digest('5'),
  };
  assert.throws(
    () =>
      assertPromotionPhaseState(
        skippedPredecessors.manifest,
        readLiveState(skippedPredecessors.state),
        'acs',
      ),
    /Production changed after promotion gate: web\.gitSha/u,
  );
});

test('fails closed when another deploy changes production between phases', () => {
  const beforeAcs = fixture();
  beforeAcs.state.components.api.artifactDigest = digest('9');
  assert.throws(
    () => assertPromotionPhaseState(beforeAcs.manifest, readLiveState(beforeAcs.state), 'acs'),
    /Production changed after promotion gate: api\.artifactDigest/u,
  );

  const beforeApp = fixture();
  deployAcs(beforeApp);
  beforeApp.state.components.runtimeWorker.artifactDigest = digest('9');
  assert.throws(
    () => assertPromotionPhaseState(beforeApp.manifest, readLiveState(beforeApp.state), 'app'),
    /Production changed after promotion gate: runtimeWorker\.artifactDigest/u,
  );

  const halfApp = fixture();
  deployAcs(halfApp);
  halfApp.state.components.api = { gitSha: RELEASE_SHA, artifactDigest: digest('6') };
  assert.throws(
    () => assertPromotionPhaseState(halfApp.manifest, readLiveState(halfApp.state), 'app'),
    /Production changed after promotion gate: api\.gitSha/u,
  );

  const beforeWeb = fixture();
  deployAcs(beforeWeb);
  deployApp(beforeWeb);
  beforeWeb.state.components.acs.sandboxImageDigest = digest('9');
  assert.throws(
    () => assertPromotionPhaseState(beforeWeb.manifest, readLiveState(beforeWeb.state), 'web'),
    /Production changed after promotion gate: acs\.sandboxImageDigest/u,
  );
});

test('partial keep matrices preserve the frozen baseline expectation', () => {
  const value = fixture();
  value.manifest.components.api.action = 'keep';
  value.manifest.components.runtimeWorker.action = 'keep';
  value.manifest.components.acs.action = 'keep';
  assert.doesNotThrow(() =>
    assertPromotionPhaseState(value.manifest, readLiveState(value.state), 'app'),
  );
  assert.doesNotThrow(() =>
    assertPromotionPhaseState(value.manifest, readLiveState(value.state), 'web'),
  );
});
