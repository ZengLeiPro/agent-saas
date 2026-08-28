import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveBaselineArtifacts } from './resolve-baseline-artifacts.mjs';

const SHA = 'a'.repeat(40);
const SERVER = `sha256:${'1'.repeat(64)}`;
const WEB = `sha256:${'2'.repeat(64)}`;
const ACS = `sha256:${'3'.repeat(64)}`;
const IMAGE = `sha256:${'4'.repeat(64)}`;

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
    {
      schemaVersion: 1,
      sourceSha: SHA,
      indexUri: `oss://records/baselines/production-${SHA}/artifact-index.json`,
      artifacts: {
        serverBundle: { path: 'server.tgz', digest: SERVER, size: 10 },
        webAssets: { path: 'web.tgz', digest: WEB, size: 11 },
        acsOrchestrator: { path: 'acs.tgz', digest: ACS, size: 12 },
      },
      acsImage: { reference: `registry.example.com/acs@${IMAGE}`, digest: IMAGE },
    },
  ];
  return { production, indexes };
}

test('resolves immutable baseline URIs by live Production source SHA and digest', () => {
  const value = fixture();
  assert.deepEqual(resolveBaselineArtifacts(value), {
    serverBundle: {
      uri: `oss://records/baselines/production-${SHA}/server.tgz`,
      digest: SERVER,
      size: 10,
    },
    webAssets: { uri: `oss://records/baselines/production-${SHA}/web.tgz`, digest: WEB, size: 11 },
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
  value.indexes.push({
    ...structuredClone(value.indexes[0]),
    sourceSha: webSha,
    indexUri: `oss://records/baselines/production-${webSha}/artifact-index.json`,
  });
  assert.equal(resolveBaselineArtifacts(value).webAssets.uri.includes(webSha), true);
});

test('rejects an index whose artifacts do not match live Production', () => {
  const value = fixture();
  value.indexes[0].artifacts.serverBundle.digest = `sha256:${'9'.repeat(64)}`;
  assert.throws(() => resolveBaselineArtifacts(value), /No immutable serverBundle/u);
});

test('rejects unsafe artifact paths before constructing an OSS URI', () => {
  const value = fixture();
  value.indexes[0].artifacts.webAssets.path = '../web.tgz';
  assert.throws(() => resolveBaselineArtifacts(value), /webAssets path is invalid/u);
});
