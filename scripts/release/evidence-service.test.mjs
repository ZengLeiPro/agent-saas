import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createEvidenceService } from './evidence-service.mjs';
import { canonicalJson, digestBuffer } from './artifact-lib.mjs';
import {
  createValidLegacyReleaseEvidence,
  createValidReleaseEvidence,
  RELEASE_EVIDENCE_SHA,
} from './release-evidence-fixture.test-helper.mjs';
import {
  RELEASE_EVIDENCE_SCHEMA_VERSION,
  SUPPORTED_RELEASE_EVIDENCE_SCHEMA_VERSIONS,
} from './release-evidence-schema.mjs';
import {
  REQUIRED_ISOLATION_PROBES,
  SHARED_NAS_RESIDUAL_RISK,
} from '../staging/assert-isolation.mjs';

const READ_TOKEN = 'evidence-service-read-token-32-bytes-long';
const WRITE_TOKEN = 'evidence-service-write-token-32-bytes-long';
const SHA = RELEASE_EVIDENCE_SHA;
const RELEASE_ID = 'rc-20260827-01';
const MANIFEST_DIGEST = `sha256:${'d'.repeat(64)}`;
const NOW = Date.parse('2026-08-27T00:00:00.000Z');

test('advertises authenticated Release Evidence schema capabilities', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'evidence-service-capabilities-'));
  const server = createEvidenceService({ root, readToken: READ_TOKEN, writeToken: WRITE_TOKEN });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const { port } = server.address();
  const url = `http://127.0.0.1:${port}/capabilities`;

  assert.equal((await fetch(url)).status, 401);
  assert.equal(
    (await fetch(url, { headers: { authorization: `Bearer ${WRITE_TOKEN}` } })).status,
    401,
  );
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${READ_TOKEN}` },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    schemaVersion: 1,
    service: 'agent-saas-release-evidence',
    currentReleaseEvidenceSchemaVersion: RELEASE_EVIDENCE_SCHEMA_VERSION,
    supportedReleaseEvidenceSchemaVersions: [...SUPPORTED_RELEASE_EVIDENCE_SCHEMA_VERSIONS],
  });
});

test('serves an authenticated immutable release-evidence producer endpoint', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'evidence-service-'));
  const server = createEvidenceService({ root, readToken: READ_TOKEN, writeToken: WRITE_TOKEN });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  const url = `http://127.0.0.1:${address.port}/release-evidence?sha=${SHA}`;
  const writeHeaders = {
    authorization: `Bearer ${WRITE_TOKEN}`,
    'content-type': 'application/json',
  };
  const readHeaders = { authorization: `Bearer ${READ_TOKEN}` };
  const created = await fetch(url, {
    method: 'POST',
    headers: writeHeaders,
    body: JSON.stringify(createValidReleaseEvidence()),
  });
  assert.equal(created.status, 201);
  const read = await fetch(url, { headers: readHeaders });
  assert.equal(read.status, 200);
  assert.equal((await read.json()).releaseSha, SHA);
  assert.equal((await fetch(url, { method: 'POST', headers: readHeaders })).status, 401);
  const divergent = createValidReleaseEvidence({ sourcePullRequests: [202] });
  const conflict = await fetch(url, {
    method: 'POST',
    headers: writeHeaders,
    body: JSON.stringify(divergent),
  });
  assert.notEqual(conflict.status, 201);
});

test('continues to write and read historical v1 Release Evidence', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'evidence-service-v1-'));
  const server = createEvidenceService({ root, readToken: READ_TOKEN, writeToken: WRITE_TOKEN });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const { port } = server.address();
  const url = `http://127.0.0.1:${port}/release-evidence?sha=${SHA}`;
  const evidence = createValidLegacyReleaseEvidence();

  const created = await fetch(url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${WRITE_TOKEN}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(evidence),
  });
  assert.equal(created.status, 201);
  const read = await fetch(url, {
    headers: { authorization: `Bearer ${READ_TOKEN}` },
  });
  assert.equal(read.status, 200);
  assert.deepEqual(await read.json(), evidence);
});

test('rejects incomplete evidence before immutable persistence without poisoning the SHA', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'evidence-service-poison-'));
  const server = createEvidenceService({ root, readToken: READ_TOKEN, writeToken: WRITE_TOKEN });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const { port } = server.address();
  const url = `http://127.0.0.1:${port}/release-evidence?sha=${SHA}`;
  const headers = {
    authorization: `Bearer ${WRITE_TOKEN}`,
    'content-type': 'application/json',
  };
  const placeholder = {
    ok: true,
    releaseSha: SHA,
    productionBaselineStatus: 'known',
    integrationCandidates: [{ candidateId: 'candidate' }],
    sourcePullRequests: [1],
    checks: { appCi: { status: 'success' } },
    productionBaseline: { web: {} },
    baselineArtifacts: { serverBundle: {} },
    affectedComponents: ['web'],
    migrationPlan: { planDigest: `sha256:${'7'.repeat(64)}` },
    compatibilityEvidenceDigest: `sha256:${'8'.repeat(64)}`,
    evidenceDigest: `sha256:${'9'.repeat(64)}`,
  };
  const rejected = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(placeholder),
  });
  assert.equal(rejected.status, 400);

  const created = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(createValidReleaseEvidence()),
  });
  assert.equal(created.status, 201);
});

test('produces fresh Staging isolation and Production observation responses', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'evidence-service-live-'));
  const server = createEvidenceService({
    root,
    readToken: READ_TOKEN,
    writeToken: WRITE_TOKEN,
    now: () => NOW,
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const { port } = server.address();
  const writeHeaders = {
    authorization: `Bearer ${WRITE_TOKEN}`,
    'content-type': 'application/json',
  };
  const readHeaders = { authorization: `Bearer ${READ_TOKEN}` };
  const isolationUrl = `http://127.0.0.1:${port}/staging-isolation?releaseId=${RELEASE_ID}`;
  const isolation = {
    schemaVersion: 1,
    environment: 'staging',
    probes: REQUIRED_ISOLATION_PROBES.map((id) => {
      const common = {
        id,
        observedAt: new Date(NOW).toISOString(),
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
    }).map((probe) => ({
      ...probe,
      evidenceDigest: digestBuffer(Buffer.from(canonicalJson(probe.observed))),
    })),
  };
  assert.equal(
    (
      await fetch(isolationUrl, {
        method: 'POST',
        headers: writeHeaders,
        body: JSON.stringify(isolation),
      })
    ).status,
    201,
  );
  assert.equal((await fetch(isolationUrl, { headers: readHeaders })).status, 200);

  const observationUrl = `http://127.0.0.1:${port}/production-observation?releaseId=${RELEASE_ID}&manifestDigest=${MANIFEST_DIGEST}`;
  const checkIds = [
    'http',
    'websocket',
    'agentFirstToken',
    'agentCompletion',
    'runRecovery',
    'workerLease',
    'integrationReleaseGate',
    'sandboxLifecycle',
    'cronDeduplication',
    'login',
    'sessionRead',
    'taskboardRead',
    'businessAcceptance',
  ];
  const observation = {
    releaseId: RELEASE_ID,
    manifestDigest: MANIFEST_DIGEST,
    observedAt: new Date(NOW).toISOString(),
    checks: Object.fromEntries(checkIds.map((id) => [id, { status: 'ok' }])),
    metrics: { httpErrorRate: 0, duplicateExecutions: 0 },
  };
  observation.checks.businessAcceptance.evidenceDigest = `sha256:${'b'.repeat(64)}`;
  assert.equal(
    (
      await fetch(observationUrl, {
        method: 'POST',
        headers: writeHeaders,
        body: JSON.stringify(observation),
      })
    ).status,
    201,
  );
  assert.equal((await fetch(observationUrl, { headers: readHeaders })).status, 200);
});
