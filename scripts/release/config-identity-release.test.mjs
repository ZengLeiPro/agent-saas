#!/usr/bin/env node
/**
 * TASK-318：release 脚本链路对 configIdentity 的处理。
 *
 * 覆盖：
 * - read-production-state：API configIdentity 结构校验 + 透传进 state。
 * - write-production-identity：从 release env 读取 expected identity
 *   （releaseId 匹配才采用；格式非法 fail closed；旧 env 兼容返回 undefined）。
 * - read-runtime-identity：identity.configIdentity 存在时必须是合法形态。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  readPrivateConfigIdentitySnapshot,
  validateExpectedConfigIdentityObservers,
  validateProductionObservations,
} from './read-production-state.mjs';
import {
  buildProductionIdentity,
  readExpectedConfigIdentityFromReleaseEnv,
  resolveExpectedConfigIdentityForProduction,
} from './write-production-identity.mjs';
import { validateRuntimeIdentity } from './read-runtime-identity.mjs';

const SHA = 'a'.repeat(40);
const DIGEST = `sha256:${'b'.repeat(64)}`;
const CONFIG_DIGEST = `sha256:${'d'.repeat(64)}`;
const API_RELEASE_TARGET = `/opt/agent-saas-app/releases/${DIGEST.slice('sha256:'.length)}`;

function baseIdentity() {
  return {
    schemaVersion: 1,
    environment: 'production',
    gitSha: SHA,
    configSchemaVersion: 1,
    configFingerprint: DIGEST,
    components: {
      web: { gitSha: SHA, artifactDigest: DIGEST, deployedAt: '2026-08-29T00:00:00.000Z' },
      api: { gitSha: SHA, artifactDigest: DIGEST, deployedAt: '2026-08-29T00:00:00.000Z' },
      runtimeWorker: {
        gitSha: SHA,
        artifactDigest: DIGEST,
        deployedAt: '2026-08-29T00:00:00.000Z',
      },
      acs: {
        gitSha: SHA,
        orchestratorArtifactDigest: DIGEST,
        sandboxImageDigest: DIGEST,
        deployedAt: '2026-08-29T00:00:00.000Z',
      },
    },
    topology: {
      observedAt: new Date().toISOString(),
      api: {
        activeColor: 'blue',
        activeColorFile: '/etc/agent-saas/active-color',
        unit: 'agent-saas-server@blue.service',
        releaseSymlink: '/opt/agent-saas-app/color/blue',
        releaseTarget: '/opt/agent-saas-app/releases/x',
        pidfile: '/run/agent-saas-server-blue.pid',
      },
      runtimeWorker: {
        activeColor: 'green',
        activeColorFile: '/etc/agent-saas/runtime-worker-active-color',
        unit: 'agent-saas-runtime-worker@green.service',
        releaseSymlink: '/opt/agent-saas-app/worker/green',
        releaseTarget: '/opt/agent-saas-app/releases/x',
        pidfile: '/run/agent-saas-runtime-worker-green.pid',
        readyfile: '/run/agent-saas-runtime-worker-green.ready',
      },
    },
  };
}

function baseObservations() {
  return {
    runtime: baseIdentity(),
    api: {
      status: 'ok',
      release: {
        environment: 'production',
        releaseId: 'rc-1',
        releaseSha: SHA,
        serverDigest: DIGEST,
        safetyAttested: true,
      },
    },
    web: { environment: 'production', schemaVersion: 1, releaseSha: SHA, webDigest: DIGEST },
    acs: {
      environment: 'production',
      releaseIdentityAttested: true,
      namespace: 'agent-saas-coding',
      sourceSha: SHA,
      orchestratorArtifactDigest: DIGEST,
      sandboxImageDigest: DIGEST,
      configFingerprint: DIGEST,
    },
  };
}

const validConfigIdentity = {
  schemaVersion: 1,
  status: 'consistent',
  releaseId: 'rc-1',
  expected: { schemaVersion: 1, digest: CONFIG_DIGEST },
  observed: {
    schemaVersion: 1,
    digest: CONFIG_DIGEST,
    credentialVersionDigest: null,
    versionResolution: 'resolved',
    secretRefCount: 0,
  },
};
const relationshipContradictions = JSON.parse(
  readFileSync(
    new URL('./fixtures/config-identity-relationship-contradictions.json', import.meta.url),
  ),
);

test('read-production-state passes structured configIdentity through into state', () => {
  const observations = baseObservations();
  observations.runtime.configIdentity = validConfigIdentity.expected;
  observations.api.configIdentity = validConfigIdentity;
  const state = validateProductionObservations(observations);
  assert.equal(state.configIdentity.status, 'consistent');
  assert.equal(state.configIdentity.expected.digest, CONFIG_DIGEST);
  assert.ok(state.digest.startsWith('sha256:'));
});

test('read-production-state rejects configIdentity without releaseId', () => {
  const observations = baseObservations();
  const { releaseId: _releaseId, ...withoutReleaseId } = validConfigIdentity;
  observations.api.configIdentity = withoutReleaseId;
  assert.throws(
    () => validateProductionObservations(observations),
    /requires a non-empty releaseId/,
  );
});

test('read-production-state rejects missing ConfigIdentity after the first upgrade', () => {
  assert.throws(
    () => validateProductionObservations(baseObservations()),
    /completely absent during steady-state/,
  );
  assert.throws(
    () =>
      validateProductionObservations(baseObservations(), {
        configIdentityStage: 'legacy-pre-upgrade-baseline',
      }),
    /Unknown Production ConfigIdentity stage/,
  );
});

test('read-production-state rejects a malformed configIdentity payload', () => {
  const observations = baseObservations();
  observations.api.configIdentity = { schemaVersion: 1, status: 'weird' };
  assert.throws(
    () => validateProductionObservations(observations),
    /config identity payload is malformed/,
  );
});

test('read-production-state rejects semantically partial configIdentity states', () => {
  const consistentWithoutSides = baseObservations();
  consistentWithoutSides.api.configIdentity = { schemaVersion: 1, status: 'consistent' };
  assert.throws(
    () => validateProductionObservations(consistentWithoutSides),
    /requires expected and observed/,
  );

  const unverifiableWithoutReason = baseObservations();
  unverifiableWithoutReason.api.configIdentity = {
    ...validConfigIdentity,
    status: 'unverifiable',
  };
  assert.throws(() => validateProductionObservations(unverifiableWithoutReason), /requires reason/);
});

test('read-production-state rejects impossible status/version relationships', () => {
  const observations = baseObservations();
  observations.api.configIdentity = {
    ...validConfigIdentity,
    observed: {
      ...validConfigIdentity.observed,
      versionResolution: 'unavailable',
      secretRefCount: 1,
    },
  };
  assert.throws(
    () => validateProductionObservations(observations),
    /consistent config identity conflicts/,
  );
});

test('read-production-state rejects unresolved-version reasons that hide a stronger state', () => {
  for (const [name, summary] of Object.entries(relationshipContradictions)) {
    const observations = baseObservations();
    if (summary.expected) observations.runtime.configIdentity = summary.expected;
    observations.api.configIdentity = summary;
    assert.throws(
      () => validateProductionObservations(observations),
      /unverifiable config identity reason conflicts with its sides/,
      name,
    );
  }
});

test('read-production-state rejects unknown configIdentity fields before evidence serialization', () => {
  const observations = baseObservations();
  observations.api.configIdentity = {
    ...validConfigIdentity,
    plaintextSecret: 'must-not-enter-production-state',
  };
  assert.throws(
    () => validateProductionObservations(observations),
    /unknown fields: plaintextSecret/,
  );
});

test('private ConfigIdentity snapshot strictly rebuilds the API evidence boundary', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 't318-private-config-identity-'));
  try {
    const snapshot = join(tmp, 'config-identity.json');
    writeFileSync(snapshot, JSON.stringify(validConfigIdentity));
    assert.deepEqual(await readPrivateConfigIdentitySnapshot(snapshot), validConfigIdentity);

    writeFileSync(
      snapshot,
      JSON.stringify({
        ...validConfigIdentity,
        plaintextSecret: 'must-not-cross-private-boundary',
      }),
    );
    await assert.rejects(
      readPrivateConfigIdentitySnapshot(snapshot),
      /unknown fields: plaintextSecret/,
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('read-production-state rejects both directions of unilateral expected ConfigIdentity in every stage', () => {
  const fixture = JSON.parse(
    readFileSync(new URL('./fixtures/config-identity-unilateral.json', import.meta.url)),
  );
  for (const [name, sides] of Object.entries(fixture)) {
    const observations = baseObservations();
    if (sides.runtimeExpected) observations.runtime.configIdentity = sides.runtimeExpected;
    if (sides.apiSummary) observations.api.configIdentity = sides.apiSummary;
    for (const configIdentityStage of ['steady-state']) {
      assert.throws(
        () => validateProductionObservations(observations, { configIdentityStage }),
        /expected ConfigIdentity is missing from/,
        `${name} must fail during ${configIdentityStage}`,
      );
    }
  }
});

test('steady-state rejects a partially migrated API summary without expected binding', () => {
  const observations = baseObservations();
  observations.api.configIdentity = {
    schemaVersion: 1,
    status: 'unverifiable',
    reason: 'expected_not_bound',
    releaseId: 'rc-1',
    observed: validConfigIdentity.observed,
  };
  assert.throws(
    () =>
      validateProductionObservations(observations, {
        configIdentityStage: 'steady-state',
      }),
    /expected ConfigIdentity is missing from both observers/,
  );
});

test('candidate readback accepts a new bound expected before trusted identity commit', () => {
  const observations = baseObservations();
  observations.api.configIdentity = validConfigIdentity;
  assert.doesNotThrow(() =>
    validateExpectedConfigIdentityObservers(
      { schemaVersion: 1, digest: `sha256:${'f'.repeat(64)}` },
      observations.api.configIdentity,
      { configIdentityStage: 'candidate-readback' },
    ),
  );
  assert.throws(
    () =>
      validateExpectedConfigIdentityObservers(
        undefined,
        {
          schemaVersion: 1,
          status: 'unverifiable',
          reason: 'expected_not_bound',
          releaseId: 'rc-1',
          observed: validConfigIdentity.observed,
        },
        { configIdentityStage: 'candidate-readback' },
      ),
    /requires a consistent API expected ConfigIdentity/,
  );
});

test('read-production-state rejects expected config identity mismatch across trusted/API observers', () => {
  const observations = baseObservations();
  observations.runtime.configIdentity = {
    schemaVersion: 1,
    digest: `sha256:${'f'.repeat(64)}`,
  };
  observations.api.configIdentity = validConfigIdentity;
  assert.throws(
    () => validateProductionObservations(observations),
    /expected config identity digest disagrees across observers/,
  );
});

test('write-production-identity reads expected config identity only for the matching release', () => {
  const tmp = mkdtempSync(join(tmpdir(), 't318-release-env-'));
  try {
    const envPath = join(tmp, 'server-blue.release.env');
    writeFileSync(
      envPath,
      [
        'AGENT_SAAS_RELEASE_ID=rc-1',
        `AGENT_SAAS_CONFIG_IDENTITY_DIGEST=${CONFIG_DIGEST}`,
        'AGENT_SAAS_CONFIG_IDENTITY_SCHEMA_VERSION=1',
        `AGENT_SAAS_CONFIG_IDENTITY_CREDENTIAL_VERSION_DIGEST=sha256:${'e'.repeat(64)}`,
        '',
      ].join('\n'),
      'utf8',
    );
    const expectedConfigIdentity = readExpectedConfigIdentityFromReleaseEnv('blue', 'rc-1', {
      envPath,
    });
    assert.deepEqual(expectedConfigIdentity, {
      schemaVersion: 1,
      digest: CONFIG_DIGEST,
      credentialVersionDigest: `sha256:${'e'.repeat(64)}`,
    });

    const manifest = {
      releaseId: 'rc-1',
      digest: DIGEST,
      components: {
        web: { sourceSha: SHA, artifactDigest: DIGEST, action: 'deploy' },
        api: { sourceSha: SHA, artifactDigest: DIGEST, action: 'deploy' },
        runtimeWorker: { sourceSha: SHA, artifactDigest: DIGEST, action: 'deploy' },
        acs: {
          sourceSha: SHA,
          orchestratorArtifactDigest: DIGEST,
          sandboxImageDigest: DIGEST,
          action: 'deploy',
        },
      },
    };
    const identity = buildProductionIdentity(
      manifest,
      baseIdentity().topology,
      '2026-08-29T01:00:00.000Z',
      undefined,
      expectedConfigIdentity,
    );
    assert.equal(identity.configIdentity.digest, CONFIG_DIGEST);
    assert.equal(identity.configIdentity.schemaVersion, 1);
    // legacy 字段语义不变。
    assert.equal(identity.configFingerprint, manifest.digest);
    const validation = validateRuntimeIdentity(identity, {
      refreshTopologyObservation: false,
      now: Date.now(),
    });
    assert.equal(
      validation.blockingReasons.filter((reason) => reason.includes('configIdentity')).length,
      0,
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('partial promotion with API keep inherits and cross-checks trusted expected configIdentity', () => {
  const previous = baseIdentity();
  previous.configIdentity = {
    schemaVersion: 1,
    digest: CONFIG_DIGEST,
    credentialVersionDigest: `sha256:${'e'.repeat(64)}`,
  };
  const manifest = {
    releaseId: 'rc-web-only',
    digest: DIGEST,
    components: {
      web: { sourceSha: SHA, artifactDigest: DIGEST, action: 'deploy' },
      api: { sourceSha: SHA, artifactDigest: DIGEST, action: 'keep' },
      runtimeWorker: { sourceSha: SHA, artifactDigest: DIGEST, action: 'keep' },
      acs: {
        sourceSha: SHA,
        orchestratorArtifactDigest: DIGEST,
        sandboxImageDigest: DIGEST,
        action: 'keep',
      },
    },
  };
  previous.topology.api.releaseTarget = API_RELEASE_TARGET;
  const activeReleaseManifest = {
    releaseId: 'rc-api-active',
    components: { api: { artifactDigest: DIGEST } },
  };
  const activeEnv = [
    'AGENT_SAAS_RELEASE_ID=rc-api-active',
    `AGENT_SAAS_SERVER_DIGEST=${DIGEST}`,
    `AGENT_SAAS_CONFIG_IDENTITY_DIGEST=${CONFIG_DIGEST}`,
    'AGENT_SAAS_CONFIG_IDENTITY_SCHEMA_VERSION=1',
    `AGENT_SAAS_CONFIG_IDENTITY_CREDENTIAL_VERSION_DIGEST=sha256:${'e'.repeat(64)}`,
    '',
  ].join('\n');
  const expected = resolveExpectedConfigIdentityForProduction(manifest, 'blue', previous, {
    readFile: () => activeEnv,
    activeReleaseManifest,
  });
  assert.throws(
    () =>
      resolveExpectedConfigIdentityForProduction(manifest, 'blue', previous, {
        readFile: () => activeEnv,
        activeReleaseManifest,
        activeReleaseTarget: `/opt/agent-saas-app/releases/${'f'.repeat(64)}`,
      }),
    /not bound to the active release target/,
  );
  assert.throws(
    () =>
      resolveExpectedConfigIdentityForProduction(manifest, 'blue', previous, {
        readFile: () => activeEnv,
        activeReleaseManifest,
        activeReleaseTarget: `/opt/agent-saas-app/not-releases/${DIGEST.slice('sha256:'.length)}`,
      }),
    /not bound to the active release target/,
  );
  assert.throws(
    () =>
      resolveExpectedConfigIdentityForProduction(manifest, 'blue', previous, {
        readFile: () => activeEnv.replace('rc-api-active', 'rc-stale-env'),
        activeReleaseManifest,
      }),
    /releaseId disagrees with active release manifest/,
  );
  assert.throws(
    () =>
      resolveExpectedConfigIdentityForProduction(manifest, 'blue', previous, {
        readFile: () => activeEnv.replace(DIGEST, `sha256:${'f'.repeat(64)}`),
        activeReleaseManifest,
      }),
    /server digest is not bound to the active release target/,
  );
  assert.throws(
    () =>
      resolveExpectedConfigIdentityForProduction(manifest, 'blue', previous, {
        readFile: () => activeEnv,
        activeReleaseManifest: {
          ...activeReleaseManifest,
          components: { api: { artifactDigest: `sha256:${'f'.repeat(64)}` } },
        },
      }),
    /server digest is not bound to the active release target/,
  );
  const identity = buildProductionIdentity(
    manifest,
    previous.topology,
    '2026-08-30T00:00:00.000Z',
    previous,
    expected,
  );

  assert.deepEqual(identity.configIdentity, previous.configIdentity);
  assert.throws(
    () =>
      resolveExpectedConfigIdentityForProduction(manifest, 'blue', previous, {
        readFile: () => activeEnv.replace(CONFIG_DIGEST, `sha256:${'f'.repeat(64)}`),
        activeReleaseManifest,
      }),
    /disagrees across trusted sources/,
  );
  assert.throws(
    () =>
      resolveExpectedConfigIdentityForProduction(manifest, 'blue', previous, {
        readFile: () =>
          ['AGENT_SAAS_RELEASE_ID=rc-api-active', `AGENT_SAAS_SERVER_DIGEST=${DIGEST}`, ''].join(
            '\n',
          ),
        activeReleaseManifest,
      }),
    /missing from one trusted source/,
  );
});

test('legacy API keep still verifies the content-addressed active release binding', () => {
  const previous = baseIdentity();
  previous.topology.api.releaseTarget = API_RELEASE_TARGET;
  const manifest = {
    releaseId: 'rc-web-only',
    digest: DIGEST,
    components: {
      web: { sourceSha: SHA, artifactDigest: DIGEST, action: 'deploy' },
      api: { sourceSha: SHA, artifactDigest: DIGEST, action: 'keep' },
      runtimeWorker: { sourceSha: SHA, artifactDigest: DIGEST, action: 'keep' },
      acs: {
        sourceSha: SHA,
        orchestratorArtifactDigest: DIGEST,
        sandboxImageDigest: DIGEST,
        action: 'keep',
      },
    },
  };
  const activeReleaseManifest = {
    releaseId: 'rc-api-active',
    components: { api: { artifactDigest: DIGEST } },
  };
  const activeEnv = [
    'AGENT_SAAS_RELEASE_ID=rc-api-active',
    `AGENT_SAAS_SERVER_DIGEST=${DIGEST}`,
    '',
  ].join('\n');

  assert.equal(
    resolveExpectedConfigIdentityForProduction(manifest, 'blue', previous, {
      readFile: () => activeEnv,
      activeReleaseManifest,
    }),
    undefined,
  );
  assert.throws(
    () =>
      resolveExpectedConfigIdentityForProduction(manifest, 'blue', previous, {
        readFile: () => activeEnv.replace(DIGEST, `sha256:${'f'.repeat(64)}`),
        activeReleaseManifest,
      }),
    /server digest is not bound to the active release target/,
  );
});

test('API deploy cannot silently drop an existing trusted expected configIdentity', () => {
  const previous = baseIdentity();
  previous.configIdentity = { schemaVersion: 1, digest: CONFIG_DIGEST };
  const manifest = {
    releaseId: 'rc-api-new',
    digest: DIGEST,
    components: {
      web: { sourceSha: SHA, artifactDigest: DIGEST, action: 'keep' },
      api: { sourceSha: SHA, artifactDigest: DIGEST, action: 'deploy' },
      runtimeWorker: { sourceSha: SHA, artifactDigest: DIGEST, action: 'deploy' },
      acs: {
        sourceSha: SHA,
        orchestratorArtifactDigest: DIGEST,
        sandboxImageDigest: DIGEST,
        action: 'keep',
      },
    },
  };
  assert.throws(
    () =>
      resolveExpectedConfigIdentityForProduction(manifest, 'blue', previous, {
        readFile: () => 'AGENT_SAAS_RELEASE_ID=rc-api-new\n',
      }),
    /would drop trusted expected configIdentity/,
  );
});

test('expected identity env parser handles mismatch and fails closed on incomplete or malformed identity', () => {
  const parse = (lines) =>
    readExpectedConfigIdentityFromReleaseEnv('blue', 'rc-1', {
      readFile: () => `${lines.join('\n')}\n`,
    });
  assert.equal(
    parse(['AGENT_SAAS_RELEASE_ID=rc-old', `AGENT_SAAS_CONFIG_IDENTITY_DIGEST=${CONFIG_DIGEST}`]),
    undefined,
  );
  assert.equal(parse(['AGENT_SAAS_RELEASE_ID=rc-1']), undefined);
  assert.throws(
    () => parse(['AGENT_SAAS_RELEASE_ID=rc-1', 'AGENT_SAAS_CONFIG_IDENTITY_SCHEMA_VERSION=1']),
    /metadata without its digest/,
  );
  assert.throws(
    () =>
      parse(['AGENT_SAAS_RELEASE_ID=rc-1', `AGENT_SAAS_CONFIG_IDENTITY_DIGEST=${CONFIG_DIGEST}`]),
    /missing config identity schema version/,
  );
  assert.throws(
    () =>
      parse([
        'AGENT_SAAS_RELEASE_ID=rc-1',
        `AGENT_SAAS_CONFIG_IDENTITY_DIGEST=${CONFIG_DIGEST}`,
        'AGENT_SAAS_CONFIG_IDENTITY_SCHEMA_VERSION=0',
      ]),
    /malformed config identity schema version/,
  );
  assert.throws(
    () =>
      parse([
        'AGENT_SAAS_RELEASE_ID=rc-1',
        `AGENT_SAAS_CONFIG_IDENTITY_DIGEST=${CONFIG_DIGEST}`,
        'AGENT_SAAS_CONFIG_IDENTITY_SCHEMA_VERSION=1.5',
      ]),
    /malformed config identity schema version/,
  );
  assert.throws(
    () => parse(['AGENT_SAAS_RELEASE_ID=rc-1', 'AGENT_SAAS_CONFIG_IDENTITY_DIGEST=nope']),
    /malformed config identity digest/,
  );
  assert.throws(
    () =>
      parse([
        'AGENT_SAAS_RELEASE_ID=rc-1',
        `AGENT_SAAS_CONFIG_IDENTITY_DIGEST=${CONFIG_DIGEST}`,
        'AGENT_SAAS_CONFIG_IDENTITY_SCHEMA_VERSION=1',
        'AGENT_SAAS_CONFIG_IDENTITY_CREDENTIAL_VERSION_DIGEST=nope',
      ]),
    /malformed config credential version digest/,
  );
});

test('runtime identity validation rejects a malformed configIdentity', () => {
  const identity = baseIdentity();
  identity.configIdentity = { schemaVersion: 1, digest: 'not-a-digest' };
  const validation = validateRuntimeIdentity(identity, { refreshTopologyObservation: false });
  assert.ok(
    validation.blockingReasons.some((reason) => reason.includes('configIdentity')),
    JSON.stringify(validation.blockingReasons),
  );
});

test('runtime identity validation accepts a valid configIdentity and tolerates its absence', () => {
  const without = validateRuntimeIdentity(baseIdentity(), { refreshTopologyObservation: false });
  assert.equal(
    without.blockingReasons.filter((reason) => reason.includes('configIdentity')).length,
    0,
  );
  const withValid = baseIdentity();
  withValid.configIdentity = { schemaVersion: 1, digest: CONFIG_DIGEST };
  const validated = validateRuntimeIdentity(withValid, { refreshTopologyObservation: false });
  assert.equal(
    validated.blockingReasons.filter((reason) => reason.includes('configIdentity')).length,
    0,
  );
});
