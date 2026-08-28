import assert from 'node:assert/strict';
import test from 'node:test';
import {
  productionObservationUrl,
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
  const state = validateProductionObservations(observations());
  assert.equal(state.components.acs.sandboxImageDigest, IMAGE);
  assert.match(state.digest, /^sha256:/u);
});

test('fails closed when any observer is unknown or disagrees', () => {
  const drifted = observations();
  drifted.acs.sandboxImageDigest = `sha256:${'9'.repeat(64)}`;
  assert.throws(() => validateProductionObservations(drifted), /disagrees/u);
  const unknown = observations();
  unknown.web.webDigest = undefined;
  assert.throws(() => validateProductionObservations(unknown), /disagrees/u);
});

test('cache-busts external observers without changing the local ACS health route', () => {
  assert.equal(
    productionObservationUrl('https://agent.kaiyan.net/release-identity.json', 123).href,
    'https://agent.kaiyan.net/release-identity.json?release_observation=123',
  );
  assert.equal(
    productionObservationUrl('http://127.0.0.1:3400/health', 123).href,
    'http://127.0.0.1:3400/health',
  );
});
