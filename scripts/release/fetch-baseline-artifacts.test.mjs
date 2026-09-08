import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalJson, digestBuffer } from './artifact-lib.mjs';
import { fetchBaselineArtifacts, listAllObjects } from './fetch-baseline-artifacts.mjs';

const root = 'oss://release-records';
const sha = 'a'.repeat(40);
const digest = (n) => `sha256:${String(n).repeat(64)}`;
const production = {
  environment: 'production',
  releaseId: 'rc-20260908-01',
  components: {
    api: { gitSha: sha, artifactDigest: digest(1) },
    runtimeWorker: { gitSha: sha, artifactDigest: digest(1) },
    web: { gitSha: sha, artifactDigest: digest(2) },
    acs: { gitSha: sha, orchestratorArtifactDigest: digest(3), sandboxImageDigest: digest(4) },
  },
};
const body = {
  schemaVersion: 1,
  sourceSha: sha,
  artifacts: {
    serverBundle: { path: 'server-bundle.tgz', digest: digest(1), size: 10 },
    webAssets: { path: 'web-assets.tgz', digest: digest(2), size: 11 },
    acsOrchestrator: { path: 'acs-orchestrator.tgz', digest: digest(3), size: 12 },
  },
  acsImage: { digest: digest(4), reference: `registry.example/acs@${digest(4)}` },
};
const index = { ...body, aggregateDigest: digestBuffer(Buffer.from(canonicalJson(body))) };

test('live release exact index avoids any history scan and retains source/digest selection', async () => {
  const uri = `${root}/${production.releaseId}/artifact-index.json`;
  const result = await fetchBaselineArtifacts({
    production,
    baseUri: root,
    readJson: async (path) => (path === uri ? index : null),
    listPage: () => {
      throw new Error('History must not be scanned');
    },
  });
  assert.equal(result.metrics.mode, 'exact');
  assert.equal(
    result.artifacts.serverBundle.uri,
    `${root}/${production.releaseId}/server-bundle.tgz`,
  );
});

test('complete fallback reads indexes beyond the first thousand objects and resolves record locations', async () => {
  const record = `${root}/records/rc-20260101-01/artifact-index.json`;
  const objects = Array.from(
    { length: 1000 },
    (_, i) => `${root}/records/old-${String(i).padStart(4, '0')}/attestation.json`,
  )
    .concat(record)
    .sort();
  const markers = [];
  const result = await fetchBaselineArtifacts({
    production,
    baseUri: root,
    readJson: async (path) => (path === record ? index : null),
    listPage: async (prefix, marker, limit) => {
      markers.push(marker);
      return objects
        .filter((uri) => uri.startsWith(prefix) && uri.split('/').slice(3).join('/') > marker)
        .slice(0, limit);
    },
  });
  assert.equal(result.metrics.mode, 'complete-history-fallback');
  assert.equal(result.metrics.listedObjects, 1001);
  assert.ok(markers.some(Boolean));
  assert.equal(result.artifacts.webAssets.uri, `${root}/rc-20260101-01/web-assets.tgz`);
});

test('baseline lookup refuses corrupted exact indexes and authentication errors', async () => {
  await assert.rejects(
    fetchBaselineArtifacts({
      production,
      baseUri: root,
      readJson: async (path) =>
        path.endsWith('/artifact-index.json') ? { ...index, aggregateDigest: digest(9) } : null,
      listPage: () => {
        throw new Error('Invalid digest must not fall back');
      },
    }),
    /digest mismatch/u,
  );
  await assert.rejects(
    fetchBaselineArtifacts({
      production,
      baseUri: root,
      readJson: async () => {
        throw new Error('AccessDenied');
      },
      listPage: async () => [],
    }),
    /AccessDenied/u,
  );
});

test('pagination refuses repeated pages instead of accepting a truncated history', async () => {
  const prefix = `${root}/records/`;
  await assert.rejects(
    listAllObjects(prefix, async () => [`${prefix}a`, `${prefix}b`], 2),
    /did not advance/u,
  );
});
