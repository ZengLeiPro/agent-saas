import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import test from 'node:test';
import {
  hasSystemdEnvironment,
  parseReleaseEnvironment,
  readJson,
  selectConfigIdentitySummary,
  selectLiveConfigIdentity,
  validateLiveProductionComponents,
} from './read-live-production-components.mjs';

const SHA = 'a'.repeat(40);
const DIGEST = `sha256:${'b'.repeat(64)}`;

test('reads an independently attested production component matrix', () => {
  const components = validateLiveProductionComponents({
    api: {
      status: 'ok',
      release: {
        environment: 'production',
        safetyAttested: true,
        releaseSha: SHA,
        serverDigest: DIGEST,
      },
    },
    web: { schemaVersion: 1, environment: 'production', releaseSha: SHA, webDigest: DIGEST },
    workerReleaseEnvironment: {
      AGENT_SAAS_RELEASE_SHA: SHA,
      AGENT_SAAS_SERVER_DIGEST: DIGEST,
    },
    workerSystemdEnvironment:
      'NODE_ENV=production AGENT_SAAS_ENVIRONMENT=production AGENT_SAAS_PROCESS_ROLE=runtime-worker',
    acs: {
      environment: 'production',
      releaseIdentityAttested: true,
      namespace: 'agent-saas-coding',
      sourceSha: SHA,
      orchestratorArtifactDigest: DIGEST,
      sandboxImageDigest: DIGEST,
    },
  });
  assert.equal(components.runtimeWorker.artifactDigest, DIGEST);
  assert.equal(components.acs.gitSha, SHA);
});

test('rejects unknown identity and ambiguous release environment', () => {
  assert.throws(() => parseReleaseEnvironment('KEY=first\nKEY=second\n'), /repeats KEY/u);
  assert.throws(
    () =>
      validateLiveProductionComponents({
        api: { status: 'ok', release: { environment: 'production', safetyAttested: true } },
        web: {},
        workerReleaseEnvironment: {},
        workerSystemdEnvironment: '',
        acs: {},
      }),
    /Web release identity/u,
  );
});

test('trusts the running Worker systemd environment instead of a release env assertion', () => {
  assert.equal(
    hasSystemdEnvironment(
      'NODE_ENV=production AGENT_SAAS_ENVIRONMENT=production AGENT_SAAS_PROCESS_ROLE=runtime-worker',
      'AGENT_SAAS_ENVIRONMENT',
      'production',
    ),
    true,
  );
  assert.equal(
    hasSystemdEnvironment(
      'NODE_ENV=production AGENT_SAAS_ENVIRONMENT=staging',
      'AGENT_SAAS_ENVIRONMENT',
      'production',
    ),
    false,
  );

  const common = {
    api: {
      status: 'ok',
      release: {
        environment: 'production',
        safetyAttested: true,
        releaseSha: SHA,
        serverDigest: DIGEST,
      },
    },
    web: { schemaVersion: 1, environment: 'production', releaseSha: SHA, webDigest: DIGEST },
    workerReleaseEnvironment: {
      AGENT_SAAS_ENVIRONMENT: 'production',
      AGENT_SAAS_RELEASE_SHA: SHA,
      AGENT_SAAS_SERVER_DIGEST: DIGEST,
    },
    acs: {
      environment: 'production',
      releaseIdentityAttested: true,
      namespace: 'agent-saas-coding',
      sourceSha: SHA,
      orchestratorArtifactDigest: DIGEST,
      sandboxImageDigest: DIGEST,
    },
  };
  assert.throws(
    () =>
      validateLiveProductionComponents({
        ...common,
        workerSystemdEnvironment: 'AGENT_SAAS_ENVIRONMENT=staging',
      }),
    /Worker environment is not explicit/u,
  );
});

test('private ConfigIdentity is mandatory unless a strict legacy API identity summary is present', () => {
  const legacy = {
    schemaVersion: 1,
    status: 'not_collected',
    releaseId: 'legacy-release',
  };
  assert.deepEqual(selectConfigIdentitySummary(undefined, legacy), legacy);
  assert.deepEqual(selectConfigIdentitySummary(legacy, undefined), legacy);
  assert.throws(
    () => selectConfigIdentitySummary(undefined, { ...legacy, leaked: 'forbidden' }),
    /unknown fields/u,
  );
  assert.throws(
    () => selectConfigIdentitySummary(undefined, undefined),
    /unavailable from both private snapshot and legacy API summary/u,
  );
});

test('已移除的 legacy 重试协议与仅有公开摘要的现场不能进入生产', () => {
  assert.throws(
    () =>
      selectLiveConfigIdentity({
        apiReleaseId: 'active-release',
        configIdentityStage: 'legacy-api-upgrade-retry-baseline',
      }),
    /Unknown live ConfigIdentity stage/u,
  );
  for (const configIdentityStage of ['candidate-readback', 'steady-state']) {
    assert.throws(
      () =>
        selectLiveConfigIdentity({
          privateConfigIdentity: undefined,
          publicConfigIdentity: {
            schemaVersion: 1,
            status: 'not_collected',
            releaseId: 'active-release',
          },
          apiReleaseId: 'active-release',
          configIdentityStage,
        }),
      /Private Production ConfigIdentity snapshot is required/u,
    );
  }
});

test('live selection binds private ConfigIdentity to the active API release', () => {
  assert.throws(
    () =>
      selectLiveConfigIdentity({
        privateConfigIdentity: undefined,
        publicConfigIdentity: {
          schemaVersion: 1,
          status: 'not_collected',
          releaseId: 'legacy-release',
        },
        apiReleaseId: 'legacy-release',
        configIdentityStage: 'candidate-readback',
      }),
    /Private Production ConfigIdentity snapshot is required during candidate-readback/u,
  );
  const privateSummary = {
    schemaVersion: 1,
    status: 'not_collected',
    releaseId: 'active-kept-release',
  };
  assert.deepEqual(
    selectLiveConfigIdentity({
      privateConfigIdentity: privateSummary,
      publicConfigIdentity: { ...privateSummary, releaseId: 'public-release' },
      apiReleaseId: 'active-kept-release',
      configIdentityStage: 'steady-state',
    }),
    privateSummary,
  );
  assert.throws(
    () =>
      selectLiveConfigIdentity({
        privateConfigIdentity: privateSummary,
        publicConfigIdentity: undefined,
        apiReleaseId: 'different-active-release',
        configIdentityStage: 'steady-state',
      }),
    /releaseId disagrees with active API release identity/u,
  );
});

test('retry/readback validates ConfigIdentity without requiring stale trusted topology', async () => {
  const source = await readFile(
    new URL('./read-live-production-components.mjs', import.meta.url),
    'utf8',
  );
  assert.match(source, /\/etc\/agent-saas\/runtime-identity\.json/u);
  assert.match(source, /validateExpectedConfigIdentityObservers/u);
  assert.doesNotMatch(source, /readRuntimeIdentity\s*\(/u);
});

test('reads the strict ACS health route without a cache-busting query', async (t) => {
  const server = createServer((request, response) => {
    if (request.url !== '/health') {
      response.writeHead(404).end();
      return;
    }
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ status: 'ok' }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  assert.equal(typeof address, 'object');
  assert.deepEqual(
    await readJson(`http://127.0.0.1:${address.port}/health`, { cacheBust: false }),
    { status: 'ok' },
  );
});
