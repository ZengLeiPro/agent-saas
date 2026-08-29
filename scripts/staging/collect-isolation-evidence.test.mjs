import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';

import { assembleIsolationEvidence, readJsonStandardInput } from './collect-isolation-evidence.mjs';
import { assertIsolationEvidence, SHARED_NAS_RESIDUAL_RISK } from './assert-isolation.mjs';

const OBSERVED_AT = '2026-08-29T16:00:00.000Z';
const NOW = Date.parse(OBSERVED_AT);

function denied(id, observed = {}) {
  return {
    id,
    status: 'denied',
    sourceEnvironment: 'staging',
    targetEnvironment: 'production',
    observed,
    observedAt: OBSERVED_AT,
    evidenceDigest: `sha256:${'a'.repeat(64)}`,
  };
}

function hostEvidence() {
  return {
    schemaVersion: 1,
    environment: 'staging',
    releaseId: 'rc-20260829-20',
    manifestDigest: `sha256:${'b'.repeat(64)}`,
    observedAt: OBSERVED_AT,
    probes: [
      denied('database-role-cannot-read-or-write-production'),
      {
        id: 'nas-client-is-all-squashed-and-mounted-to-staging-subdirectory',
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
        observedAt: OBSERVED_AT,
        evidenceDigest: `sha256:${'c'.repeat(64)}`,
      },
      denied('notification-identity-cannot-deliver-to-production'),
      denied('api-worker-cannot-connect-production-hand-or-acs'),
      denied('acs-service-account-cannot-read-production-namespace-resources'),
      {
        id: 'sandbox-workspace-uses-staging-only-pvc-and-paths',
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
        observedAt: OBSERVED_AT,
        evidenceDigest: `sha256:${'d'.repeat(64)}`,
      },
    ],
  };
}

test('assembles the six host probes with the independent Production OSS denial', () => {
  const evidence = assembleIsolationEvidence(hostEvidence(), {
    bucket: 'agent-saas-web',
    sentinelKey: 'index.html',
    sentinelExists: true,
    forbidOverwrite: true,
    responseStatus: 403,
    responseCode: 'AccessDenied',
  });

  assert.equal(evidence.probes.length, 7);
  assert.equal(evidence.probes[1].id, 'oss-identity-cannot-write-production-bucket');
  assert.equal(
    assertIsolationEvidence(evidence, { now: NOW }).status,
    'verified-with-accepted-residual-risk',
  );
});

test('rejects incomplete host evidence before publishing an RC result', () => {
  const incomplete = hostEvidence();
  incomplete.probes.pop();
  assert.throws(
    () => assembleIsolationEvidence(incomplete, { responseStatus: 403 }),
    /Host isolation evidence is incomplete/u,
  );
});

test('reads JSON credentials from a chunked standard input stream', async () => {
  const credentials = await readJsonStandardInput(
    Readable.from(['{"accessKeyId":"staging-', 'id","accessKeySecret":"secret"}']),
  );
  assert.deepEqual(credentials, {
    accessKeyId: 'staging-id',
    accessKeySecret: 'secret',
  });
});
