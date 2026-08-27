import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertIsolationEvidence,
  REQUIRED_ISOLATION_PROBES,
  SHARED_NAS_RESIDUAL_RISK,
} from './assert-isolation.mjs';

const NOW = Date.parse('2026-08-26T10:00:00.000Z');

function evidence() {
  return {
    schemaVersion: 1,
    environment: 'staging',
    probes: REQUIRED_ISOLATION_PROBES.map((id) => {
      const common = {
        id,
        evidenceDigest: `sha256:${'a'.repeat(64)}`,
        observedAt: '2026-08-26T09:59:00.000Z',
      };
      if (id === 'nas-client-is-all-squashed-and-mounted-to-staging-subdirectory') {
        return {
          ...common,
          status: 'verified-with-accepted-residual-risk',
          sourceEnvironment: 'staging',
          targetEnvironment: 'staging',
          observed: {
            mountSource:
              '020ksw7nv1wjde1xy9c-jsu59.cn-shenzhen.nas.aliyuncs.com:/agent-saas-staging',
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
      };
    }),
  };
}

test('accepts fresh production denials and schema-bound shared NAS logical isolation', () => {
  const summary = assertIsolationEvidence(evidence(), { now: NOW });
  assert.equal(summary.status, 'verified-with-accepted-residual-risk');
  assert.deepEqual(summary.residualRisks, [SHARED_NAS_RESIDUAL_RISK]);
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

test('rejects a root NAS mount, privilege bypass, or visible production names', () => {
  const rootMount = evidence();
  rootMount.probes[2].observed.mountSource =
    '020ksw7nv1wjde1xy9c-jsu59.cn-shenzhen.nas.aliyuncs.com:/';
  assert.throws(() => assertIsolationEvidence(rootMount, { now: NOW }), /subdirectory mount/u);

  const noSquash = evidence();
  noSquash.probes[2].observed.userAccess = 'no_squash';
  assert.throws(() => assertIsolationEvidence(noSquash, { now: NOW }), /subdirectory mount/u);

  const productionVisible = evidence();
  productionVisible.probes[2].observed.productionNamesVisible = true;
  assert.throws(
    () => assertIsolationEvidence(productionVisible, { now: NOW }),
    /subdirectory mount/u,
  );
});

test('rejects a sandbox outside the staging-only namespace, PVC, or workspace path', () => {
  const wrongPvc = evidence();
  wrongPvc.probes[6].observed.pvc = 'production-workspace';
  assert.throws(() => assertIsolationEvidence(wrongPvc, { now: NOW }), /staging-only PVC/u);

  const missingRisk = evidence();
  delete missingRisk.probes[6].observed.residualRisk;
  assert.throws(() => assertIsolationEvidence(missingRisk, { now: NOW }), /residual risk/u);
});
