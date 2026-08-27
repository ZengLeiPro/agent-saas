import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { canonicalJson, digestBuffer } from './artifact-lib.mjs';
import { createEvidenceService } from './evidence-service.mjs';

const READ_TOKEN = 'evidence-service-read-token-32-bytes-long';
const WRITE_TOKEN = 'evidence-service-write-token-32-bytes-long';
const SHA = 'a'.repeat(40);
const RELEASE_ID = 'rc-20260827-01';
const MANIFEST_DIGEST = `sha256:${'d'.repeat(64)}`;
const NOW = Date.parse('2026-08-27T00:00:00.000Z');

function releaseEvidence() {
  const body = {
    ok: true,
    releaseSha: SHA,
    productionBaselineStatus: 'known',
    integrationCandidates: [{ candidateId: 'candidate' }],
    sourcePullRequests: [1],
    checks: { appCi: { status: 'success' } },
    productionBaseline: { web: {} },
    baselineArtifacts: { serverBundle: {} },
    affectedComponents: ['web'],
    migrationPlan: { planDigest: `sha256:${'b'.repeat(64)}` },
    compatibilityEvidenceDigest: `sha256:${'c'.repeat(64)}`,
  };
  return { ...body, evidenceDigest: digestBuffer(Buffer.from(canonicalJson(body))) };
}

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
    body: JSON.stringify(releaseEvidence()),
  });
  assert.equal(created.status, 201);
  const read = await fetch(url, { headers: readHeaders });
  assert.equal(read.status, 200);
  assert.equal((await read.json()).releaseSha, SHA);
  assert.equal((await fetch(url, { method: 'POST', headers: readHeaders })).status, 401);
  const divergent = releaseEvidence();
  divergent.sourcePullRequests = [2];
  const conflict = await fetch(url, {
    method: 'POST',
    headers: writeHeaders,
    body: JSON.stringify(divergent),
  });
  assert.notEqual(conflict.status, 201);
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
  const probeIds = [
    'database-role-cannot-read-or-write-production',
    'oss-identity-cannot-write-production-bucket',
    'nas-identity-cannot-traverse-production-root',
    'notification-delivery-reaches-test-sink-only',
    'api-worker-cannot-connect-production-hand-or-acs',
    'acs-service-account-cannot-read-production-namespace-resources',
    'sandbox-cannot-mount-or-traverse-production-workspace',
  ];
  const isolation = {
    schemaVersion: 1,
    environment: 'staging',
    probes: probeIds.map((id) => ({
      id,
      status: 'denied',
      sourceEnvironment: 'staging',
      targetEnvironment: 'production',
      evidenceDigest: `sha256:${'e'.repeat(64)}`,
      observedAt: new Date(NOW).toISOString(),
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
