import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalJson, digestBuffer } from './artifact-lib.mjs';
import { resolveBaselineArtifacts } from './resolve-baseline-artifacts.mjs';

const SHA = 'a'.repeat(40);
const SERVER = `sha256:${'1'.repeat(64)}`;
const WEB = `sha256:${'2'.repeat(64)}`;
const ACS = `sha256:${'3'.repeat(64)}`;
const IMAGE = `sha256:${'4'.repeat(64)}`;
const RUNTIME = `sha256:${'5'.repeat(64)}`;
const DEPENDENCIES = `sha256:${'6'.repeat(64)}`;
const CONTRACT = `sha256:${'7'.repeat(64)}`;
const IDENTITY = `sha256:${'8'.repeat(64)}`;

function signIndex(index) {
  const body = structuredClone(index);
  delete body.aggregateDigest;
  delete body.indexUri;
  return {
    ...index,
    aggregateDigest: digestBuffer(Buffer.from(canonicalJson(body))),
  };
}

function fixture() {
  const production = {
    environment: 'production',
    releaseId: 'rc-20260828-02',
    components: {
      web: { gitSha: SHA, artifactDigest: WEB },
      api: { gitSha: SHA, artifactDigest: SERVER },
      runtimeWorker: { gitSha: SHA, artifactDigest: SERVER },
      acs: { gitSha: SHA, orchestratorArtifactDigest: ACS, sandboxImageDigest: IMAGE },
    },
  };
  const indexes = [
    signIndex({
      schemaVersion: 2,
      sourceSha: SHA,
      indexUri: `oss://records/baselines/production-${SHA}/artifact-index.json`,
      artifacts: {
        serverBundle: { path: 'server.tgz', digest: SERVER, size: 10 },
        webAssets: { path: 'web.tgz', digest: WEB, size: 11 },
        acsOrchestrator: { path: 'acs.tgz', digest: ACS, size: 12 },
      },
      acsImage: { reference: `registry.example.com/acs@${IMAGE}`, digest: IMAGE },
      runtimeDependencies: {
        path: 'runtime-dependencies.json',
        digest: RUNTIME,
        size: 13,
        sourceSha: SHA,
        identityDigest: IDENTITY,
        dependencyDigest: DEPENDENCIES,
        contractDigest: CONTRACT,
      },
    }),
  ];
  return { production, indexes };
}

test('resolves immutable baseline URIs by live Production source SHA and digest', () => {
  const value = fixture();
  assert.match(value.indexes[0].aggregateDigest, /^sha256:[a-f0-9]{64}$/u);
  assert.deepEqual(resolveBaselineArtifacts(value), {
    serverBundle: {
      uri: `oss://records/baselines/production-${SHA}/server.tgz`,
      digest: SERVER,
      size: 10,
    },
    webAssets: { uri: `oss://records/baselines/production-${SHA}/web.tgz`, digest: WEB, size: 11 },
    runtimeDependencies: {
      server: {
        uri: `oss://records/baselines/production-${SHA}/runtime-dependencies.json`,
        digest: RUNTIME,
        size: 13,
        sourceSha: SHA,
        identityDigest: IDENTITY,
        dependencyDigest: DEPENDENCIES,
        contractDigest: CONTRACT,
      },
      acs: {
        uri: `oss://records/baselines/production-${SHA}/runtime-dependencies.json`,
        digest: RUNTIME,
        size: 13,
        sourceSha: SHA,
        identityDigest: IDENTITY,
        dependencyDigest: DEPENDENCIES,
        contractDigest: CONTRACT,
      },
    },
    acsOrchestrator: {
      uri: `oss://records/baselines/production-${SHA}/acs.tgz`,
      digest: ACS,
      size: 12,
    },
    acsImage: { repository: 'registry.example.com/acs', digest: IMAGE },
  });
});

test('can resolve components from separate immutable indexes', () => {
  const value = fixture();
  const webSha = 'b'.repeat(40);
  value.production.components.web.gitSha = webSha;
  value.indexes.push(
    signIndex({
      ...structuredClone(value.indexes[0]),
      sourceSha: webSha,
      indexUri: `oss://records/baselines/production-${webSha}/artifact-index.json`,
    }),
  );
  assert.equal(resolveBaselineArtifacts(value).webAssets.uri.includes(webSha), true);
});

test('resolves available Server and ACS runtime identities from their selected component indexes', () => {
  const value = fixture();
  const acsSha = 'c'.repeat(40);
  const acsRuntime = `sha256:${'9'.repeat(64)}`;
  value.production.components.acs.gitSha = acsSha;
  value.indexes.push(
    signIndex({
      ...structuredClone(value.indexes[0]),
      sourceSha: acsSha,
      indexUri: `oss://records/baselines/production-${acsSha}/artifact-index.json`,
      runtimeDependencies: {
        ...value.indexes[0].runtimeDependencies,
        digest: acsRuntime,
        sourceSha: acsSha,
        identityDigest: `sha256:${'a'.repeat(64)}`,
      },
    }),
  );
  const resolved = resolveBaselineArtifacts(value);
  assert.equal(resolved.runtimeDependencies.server.sourceSha, SHA);
  assert.equal(resolved.runtimeDependencies.acs.sourceSha, acsSha);
  assert.equal(resolved.runtimeDependencies.acs.digest, acsRuntime);
});

test('rejects a v2 baseline index whose aggregate digest is stale', () => {
  const value = fixture();
  value.indexes[0].artifacts.serverBundle.size += 1;
  assert.throws(
    () => resolveBaselineArtifacts(value),
    /Baseline artifact index aggregate digest mismatch/u,
  );
});

test('rejects an index whose artifacts do not match live Production', () => {
  const value = fixture();
  value.indexes[0].artifacts.serverBundle.digest = `sha256:${'9'.repeat(64)}`;
  value.indexes[0] = signIndex(value.indexes[0]);
  assert.throws(() => resolveBaselineArtifacts(value), /No immutable serverBundle/u);
});

test('allows a matching v2 baseline artifact to omit Runtime identity until keep selection is known', () => {
  const value = fixture();
  value.indexes[0].runtimeDependencies = null;
  value.indexes[0] = signIndex(value.indexes[0]);
  assert.deepEqual(resolveBaselineArtifacts(value).runtimeDependencies, {});

  const legacy = fixture();
  legacy.indexes[0].schemaVersion = 1;
  delete legacy.indexes[0].runtimeDependencies;
  legacy.indexes[0] = signIndex(legacy.indexes[0]);
  assert.deepEqual(resolveBaselineArtifacts(legacy).runtimeDependencies, {});
});

test('rejects unsafe artifact paths before constructing an OSS URI', () => {
  const value = fixture();
  value.indexes[0].artifacts.webAssets.path = '../web.tgz';
  value.indexes[0] = signIndex(value.indexes[0]);
  assert.throws(() => resolveBaselineArtifacts(value), /webAssets path is invalid/u);
});
