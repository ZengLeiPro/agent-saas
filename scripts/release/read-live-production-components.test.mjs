import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import {
  parseReleaseEnvironment,
  readJson,
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
    workerEnvironment: {
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
        workerEnvironment: {},
        acs: {},
      }),
    /Web release identity/u,
  );
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
