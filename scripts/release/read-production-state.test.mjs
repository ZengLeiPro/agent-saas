import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  productionObservationUrl,
  validateConfigIdentitySummary,
  validateExpectedConfigIdentityObservers,
  validateProductionObservations,
} from './read-production-state.mjs';

const SHA = 'a'.repeat(40);
const SERVER = `sha256:${'1'.repeat(64)}`;
const WEB = `sha256:${'2'.repeat(64)}`;
const ORCH = `sha256:${'3'.repeat(64)}`;
const IMAGE = `sha256:${'4'.repeat(64)}`;
const FINGERPRINT = `sha256:${'5'.repeat(64)}`;
const configIdentityCases = JSON.parse(
  readFileSync(new URL('./fixtures/config-identity-summary-cases.json', import.meta.url), 'utf8'),
).cases;

function observations() {
  const expected = { schemaVersion: 1, digest: FINGERPRINT };
  const configIdentity = {
    schemaVersion: 1,
    status: 'consistent',
    releaseId: 'rc-20260826-01',
    expected,
    observed: {
      ...expected,
      credentialVersionDigest: null,
      versionResolution: 'resolved',
      secretRefCount: 0,
    },
  };
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
      configIdentity: expected,
      environment: 'production',
      components,
      configFingerprint: FINGERPRINT,
      topology: { observedAt: '2026-08-26T00:00:00.000Z' },
    },
    api: {
      configIdentity,
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

for (const fixtureCase of configIdentityCases) {
  test(`Config Identity fixture ${fixtureCase.valid.productionState ? 'accepts' : 'rejects'} ${fixtureCase.name}`, () => {
    if (fixtureCase.valid.productionState) {
      assert.deepEqual(validateConfigIdentitySummary(fixtureCase.summary), fixtureCase.summary);
    } else {
      assert.throws(() => validateConfigIdentitySummary(fixtureCase.summary), /config identity/u);
    }
  });
}

test('cross-validates API, Worker topology, Web snapshot and ACS identities', () => {
  const state = validateProductionObservations(observations(), {
    configIdentityStage: 'steady-state',
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
        configIdentityStage: 'steady-state',
      }),
    /disagrees/u,
  );
  const unknown = observations();
  unknown.web.webDigest = undefined;
  assert.throws(
    () =>
      validateProductionObservations(unknown, {
        configIdentityStage: 'steady-state',
      }),
    /disagrees/u,
  );
});

test('正常生产与旧入口均拒绝完全缺失的配置身份', () => {
  const fixture = JSON.parse(
    readFileSync(new URL('./fixtures/legacy-main-production-observations.json', import.meta.url)),
  );
  assert.throws(
    () =>
      validateProductionObservations(fixture, {
        configIdentityStage: 'legacy-pre-upgrade-baseline',
      }),
    /Unknown Production ConfigIdentity stage/u,
  );
  assert.throws(
    () => validateProductionObservations(fixture),
    /completely absent during steady-state/u,
  );
});

test('候选读回允许已切换的新身份，拒绝缺失或不一致', () => {
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
  const retryOptions = { configIdentityStage: 'candidate-readback' };

  assert.throws(
    () => validateExpectedConfigIdentityObservers(undefined, undefined, retryOptions),
    /requires a consistent API expected/u,
  );
  assert.throws(
    () => validateExpectedConfigIdentityObservers(undefined, upgradedApi, retryOptions),
    /missing from trusted runtime identity/u,
  );
  assert.doesNotThrow(() =>
    validateExpectedConfigIdentityObservers(oldExpected, upgradedApi, retryOptions),
  );
  assert.throws(
    () => validateExpectedConfigIdentityObservers(oldExpected, undefined, retryOptions),
    /requires a consistent API expected/u,
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
    /requires a consistent API expected/u,
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
