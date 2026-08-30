import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  productionObservationUrl,
  validateExpectedConfigIdentityObservers,
  validateProductionObservations,
} from './read-production-state.mjs';

const SHA = 'a'.repeat(40);
const SERVER = `sha256:${'1'.repeat(64)}`;
const WEB = `sha256:${'2'.repeat(64)}`;
const ORCH = `sha256:${'3'.repeat(64)}`;
const IMAGE = `sha256:${'4'.repeat(64)}`;
const FINGERPRINT = `sha256:${'5'.repeat(64)}`;

function observations() {
  const components = {
    web: { gitSha: SHA, artifactDigest: WEB, deployedAt: '2026-08-26T00:00:00.000Z' },
    api: { gitSha: SHA, artifactDigest: SERVER, deployedAt: '2026-08-26T00:00:00.000Z' },
    runtimeWorker: { gitSha: SHA, artifactDigest: SERVER, deployedAt: '2026-08-26T00:00:00.000Z' },
    acs: {
      gitSha: SHA,
      orchestratorArtifactDigest: ORCH,
      sandboxImageDigest: IMAGE,
      deployedAt: '2026-08-26T00:00:00.000Z',
    },
  };
  return {
    runtime: {
      environment: 'production',
      components,
      configFingerprint: FINGERPRINT,
      topology: { observedAt: '2026-08-26T00:00:00.000Z' },
    },
    api: {
      status: 'ok',
      release: {
        environment: 'production',
        releaseId: 'rc-20260826-01',
        releaseSha: SHA,
        serverDigest: SERVER,
        safetyAttested: true,
      },
    },
    web: {
      schemaVersion: 1,
      environment: 'production',
      releaseSha: SHA,
      webDigest: WEB,
      configFingerprint: FINGERPRINT,
    },
    acs: {
      environment: 'production',
      releaseIdentityAttested: true,
      sourceSha: SHA,
      orchestratorArtifactDigest: ORCH,
      sandboxImageDigest: IMAGE,
      namespace: 'agent-saas-coding',
      configFingerprint: FINGERPRINT,
    },
  };
}

test('cross-validates API, Worker topology, Web snapshot and ACS identities', () => {
  const state = validateProductionObservations(observations(), {
    configIdentityStage: 'legacy-pre-upgrade-baseline',
  });
  assert.equal(state.components.acs.sandboxImageDigest, IMAGE);
  assert.match(state.digest, /^sha256:/u);
});

test('fails closed when any observer is unknown or disagrees', () => {
  const drifted = observations();
  drifted.acs.sandboxImageDigest = `sha256:${'9'.repeat(64)}`;
  assert.throws(
    () =>
      validateProductionObservations(drifted, {
        configIdentityStage: 'legacy-pre-upgrade-baseline',
      }),
    /disagrees/u,
  );
  const unknown = observations();
  unknown.web.webDigest = undefined;
  assert.throws(
    () =>
      validateProductionObservations(unknown, {
        configIdentityStage: 'legacy-pre-upgrade-baseline',
      }),
    /disagrees/u,
  );
});

test('only the explicit legacy pre-upgrade baseline accepts complete ConfigIdentity absence', () => {
  const fixture = JSON.parse(
    readFileSync(new URL('./fixtures/legacy-main-production-observations.json', import.meta.url)),
  );
  assert.doesNotThrow(() =>
    validateProductionObservations(fixture, {
      configIdentityStage: 'legacy-pre-upgrade-baseline',
    }),
  );
  assert.throws(
    () => validateProductionObservations(fixture),
    /completely absent outside the legacy pre-upgrade baseline/u,
  );
});

test('API-upgrade retry baseline accepts only absence or an upgraded consistent API summary', () => {
  const oldExpected = { schemaVersion: 1, digest: `sha256:${'6'.repeat(64)}` };
  const newExpected = { schemaVersion: 1, digest: `sha256:${'7'.repeat(64)}` };
  const upgradedApi = {
    schemaVersion: 1,
    status: 'consistent',
    releaseId: 'rc-upgraded',
    expected: newExpected,
    observed: {
      ...newExpected,
      credentialVersionDigest: null,
      versionResolution: 'resolved',
      secretRefCount: 0,
    },
  };
  const retryOptions = { configIdentityStage: 'legacy-api-upgrade-retry-baseline' };

  assert.doesNotThrow(() =>
    validateExpectedConfigIdentityObservers(undefined, undefined, retryOptions),
  );
  assert.doesNotThrow(() =>
    validateExpectedConfigIdentityObservers(undefined, upgradedApi, retryOptions),
  );
  assert.doesNotThrow(() =>
    validateExpectedConfigIdentityObservers(oldExpected, upgradedApi, retryOptions),
  );
  assert.throws(
    () => validateExpectedConfigIdentityObservers(oldExpected, undefined, retryOptions),
    /requires either complete observer absence or a consistent API expected/u,
  );
  assert.throws(
    () =>
      validateExpectedConfigIdentityObservers(
        undefined,
        {
          schemaVersion: 1,
          status: 'unverifiable',
          reason: 'expected_not_bound',
          releaseId: 'rc-upgraded',
          observed: upgradedApi.observed,
        },
        retryOptions,
      ),
    /requires either complete observer absence or a consistent API expected/u,
  );

  for (const configIdentityStage of ['candidate-readback', 'steady-state']) {
    assert.throws(
      () =>
        validateExpectedConfigIdentityObservers(undefined, undefined, {
          configIdentityStage,
        }),
      /ConfigIdentity/u,
    );
  }
  assert.throws(
    () => validateExpectedConfigIdentityObservers(oldExpected, upgradedApi),
    /digest disagrees across observers/u,
  );
});

test('cache-busts remote observers without changing the local ACS health route', () => {
  assert.equal(
    productionObservationUrl('https://agent.kaiyan.net/release-identity.json', 123).href,
    'https://agent.kaiyan.net/release-identity.json?release_observation=123',
  );
  assert.equal(
    productionObservationUrl('http://127.0.0.1:3400/health', 123).href,
    'http://127.0.0.1:3400/health',
  );
});
