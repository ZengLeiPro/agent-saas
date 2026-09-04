import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalJson, digestBuffer } from '../release/artifact-lib.mjs';
import {
  assertIsolationEvidence,
  REQUIRED_ISOLATION_PROBES,
  SHARED_NAS_RESIDUAL_RISK,
} from './assert-isolation.mjs';

const NOW = Date.parse('2026-08-26T10:00:00.000Z');

function resign(probe) {
  probe.evidenceDigest = digestBuffer(Buffer.from(canonicalJson(probe.observed ?? null)));
}

function evidence() {
  const probes = REQUIRED_ISOLATION_PROBES.map((id) => {
    const common = {
      id,
      observedAt: '2026-08-26T09:59:00.000Z',
    };
    if (id === 'nas-client-is-all-squashed-and-mounted-to-staging-subdirectory') {
      return {
        ...common,
        status: 'verified-with-accepted-residual-risk',
        sourceEnvironment: 'staging',
        targetEnvironment: 'staging',
        observed: {
          mountSource: '020ksw7nv1wjde1xy9c-jsu59.cn-shenzhen.nas.aliyuncs.com:/agent-saas-staging',
          mountTarget: '/mnt/agent-saas-staging',
          serverPath: '/agent-saas-staging',
          sourceCidr: '172.16.182.225/32',
          userAccess: 'all_squash',
          productionNamesVisible: false,
          residualRisk: SHARED_NAS_RESIDUAL_RISK,
        },
      };
    }
    if (id === 'sandbox-workspace-uses-staging-only-pvc-and-paths') {
      return {
        ...common,
        status: 'verified-with-accepted-residual-risk',
        sourceEnvironment: 'staging',
        targetEnvironment: 'staging',
        observed: {
          namespace: 'agent-saas-staging',
          pvc: 'agent-saas-staging-workspace',
          workspaceRoot: '/mnt/agent-saas-staging/workspaces',
          productionWorkspaceMounted: false,
          sharedFilesystemLogicalIsolation: true,
          residualRisk: SHARED_NAS_RESIDUAL_RISK,
        },
      };
    }
    return {
      ...common,
      status: 'denied',
      sourceEnvironment: 'staging',
      targetEnvironment: 'production',
      observed:
        id === 'oss-identity-cannot-write-production-bucket'
          ? {
              bucket: 'agent-saas-web',
              sentinelKey: 'index.html',
              sentinelExists: true,
              forbidOverwrite: true,
              responseStatus: 403,
              responseCode: 'AccessDenied',
            }
          : {},
    };
  });
  for (const probe of probes)
    probe.evidenceDigest = digestBuffer(Buffer.from(canonicalJson(probe.observed)));
  return { schemaVersion: 1, environment: 'staging', probes };
}

test('accepts fresh production denials and schema-bound shared NAS logical isolation', () => {
  const summary = assertIsolationEvidence(evidence(), { now: NOW });
  assert.equal(summary.status, 'verified-with-accepted-residual-risk');
  assert.deepEqual(summary.residualRisks, [SHARED_NAS_RESIDUAL_RISK]);
});

test('keeps the evidence digest stable across JSON field order and assertion time', () => {
  const original = evidence();
  const reordered = {
    probes: original.probes.map((probe) => Object.fromEntries(Object.entries(probe).reverse())),
    environment: original.environment,
    schemaVersion: original.schemaVersion,
  };
  const first = assertIsolationEvidence(original, { now: NOW });
  const second = assertIsolationEvidence(reordered, { now: NOW + 30_000 });

  assert.equal(first.evidenceDigest, second.evidenceDigest);
  assert.notEqual(first.observedAt, second.observedAt);
});

test('rejects a missing, allowed, or stale probe', () => {
  const missing = evidence();
  missing.probes.pop();
  assert.throws(() => assertIsolationEvidence(missing, { now: NOW }), /Missing isolation probe/u);
  const allowed = evidence();
  allowed.probes[0].status = 'allowed';
  assert.throws(() => assertIsolationEvidence(allowed, { now: NOW }), /did not prove/u);
  assert.throws(
    () => assertIsolationEvidence(evidence(), { now: NOW + 2 * 60 * 60_000 }),
    /missing a fresh evidence digest/u,
  );
});

test('rejects forged or incomplete Production OSS denial observations', () => {
  const cases = [{ responseStatus: 200 }, { responseCode: 'NoSuchKey' }, { missingObserved: true }];
  for (const change of cases) {
    const value = evidence();
    const probe = value.probes[1];
    if (change.missingObserved) delete probe.observed;
    else Object.assign(probe.observed, change);
    probe.evidenceDigest = digestBuffer(Buffer.from(canonicalJson(probe.observed ?? null)));
    assert.throws(() => assertIsolationEvidence(value, { now: NOW }), /Production OSS probe/u);
  }
  const forged = evidence();
  forged.probes[1].evidenceDigest = `sha256:${'f'.repeat(64)}`;
  assert.throws(() => assertIsolationEvidence(forged, { now: NOW }), /fresh evidence digest/u);
});

test('rejects a root NAS mount, privilege bypass, or visible production names', () => {
  const rootMount = evidence();
  rootMount.probes[2].observed.mountSource =
    '020ksw7nv1wjde1xy9c-jsu59.cn-shenzhen.nas.aliyuncs.com:/';
  resign(rootMount.probes[2]);
  assert.throws(() => assertIsolationEvidence(rootMount, { now: NOW }), /subdirectory mount/u);

  const noSquash = evidence();
  noSquash.probes[2].observed.userAccess = 'no_squash';
  resign(noSquash.probes[2]);
  assert.throws(() => assertIsolationEvidence(noSquash, { now: NOW }), /subdirectory mount/u);

  const productionVisible = evidence();
  productionVisible.probes[2].observed.productionNamesVisible = true;
  resign(productionVisible.probes[2]);
  assert.throws(
    () => assertIsolationEvidence(productionVisible, { now: NOW }),
    /subdirectory mount/u,
  );
});

test('rejects a sandbox outside the staging-only namespace, PVC, or workspace path', () => {
  const wrongPvc = evidence();
  wrongPvc.probes[6].observed.pvc = 'production-workspace';
  resign(wrongPvc.probes[6]);
  assert.throws(() => assertIsolationEvidence(wrongPvc, { now: NOW }), /staging-only PVC/u);

  const missingRisk = evidence();
  delete missingRisk.probes[6].observed.residualRisk;
  resign(missingRisk.probes[6]);
  assert.throws(() => assertIsolationEvidence(missingRisk, { now: NOW }), /residual risk/u);
});
