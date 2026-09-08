import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import test from 'node:test';
import { runCoreBusinessSmoke, validateSmokeInputs } from './core-business-smoke.mjs';
import { validateCoreSmokeEvidence } from '../release/staging-core-smoke-evidence.mjs';
import { validateAcceptanceBinding } from '../release/prepare-staging-acceptance.mjs';

const { WebSocketServer } = createRequire(new URL('../../server/package.json', import.meta.url))(
  'ws',
);
const manifest = {
  releaseId: 'rc-20260908-01',
  releaseSha: 'a'.repeat(40),
  digest: `sha256:${'b'.repeat(64)}`,
  components: { api: { sourceSha: 'a'.repeat(40) } },
};
const fixture = {
  releaseId: manifest.releaseId,
  migrationReadback: { status: 'present' },
  fixture: {
    username: 'staging-e2e-admin',
    taskId: 'staging-e2e-integration-task',
    sourceId: 'staging-e2e-integration-source',
    state: 'canceled',
  },
};

async function fixtureServer(t, failure) {
  let authenticatedConnections = 0;
  const server = createServer(async (req, res) => {
    const json = (status, value) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(value));
    };
    if (req.url === '/api/auth/login') {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks));
      return json(failure === 'login' || body.password !== 'local-only-password' ? 401 : 200, {
        token: 'local-token',
      });
    }
    if (req.url === '/api/healthz/ready')
      return json(200, {
        release: {
          releaseId: failure === 'changed-rc' ? 'rc-20260908-02' : manifest.releaseId,
          releaseSha: manifest.releaseSha,
        },
      });
    if (req.headers.authorization !== 'Bearer local-token')
      return json(failure === 'anonymous' ? 200 : 401, {});
    if (req.url === '/api/auth/me')
      return json(200, {
        id: 'test-actor',
        tenantId: 'isolated-test-tenant',
        username: 'staging-e2e-admin',
        authEpoch: 2,
        generation: 7,
      });
    if (req.url.startsWith('/api/sessions')) return json(200, { sessions: [] });
    if (req.url.endsWith('/integration-sources'))
      return json(200, [
        {
          id: fixture.fixture.sourceId,
          integrationTaskId: fixture.fixture.taskId,
          deliveryTaskId: 'staging-e2e-integration-delivery',
          repositoryId: 'staging-fixture:none',
          state: failure === 'persistence' ? 'running' : 'canceled',
        },
      ]);
    json(404, {});
  });
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) =>
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.on('message', (raw) => {
        const message = JSON.parse(String(raw));
        if (
          message.action === 'auth' &&
          message.token === 'local-token' &&
          message.authEpoch === 2 &&
          message.generation === 7
        ) {
          if (failure === 'websocket') return ws.close(4401, 'injected failure');
          if (failure === 'unauthenticated-pong')
            return ws.send(JSON.stringify({ data: { type: 'pong' } }));
          authenticatedConnections++;
          ws.send(JSON.stringify({ data: { type: 'auth_ok' } }));
        } else if (message.action === 'ping') ws.send(JSON.stringify({ data: { type: 'pong' } }));
        else ws.close(4401, 'auth required');
      });
    }),
  );
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    for (const ws of wss.clients) ws.terminate();
    await new Promise((resolve) => wss.close(resolve));
    await new Promise((resolve) => server.close(resolve));
  });
  return {
    input: {
      baseUrl: `http://127.0.0.1:${server.address().port}`,
      username: 'staging-e2e-admin',
      password: 'local-only-password',
      manifest,
      fixture,
      runId: '101',
      runAttempt: '2',
    },
    connections: () => authenticatedConnections,
  };
}

test('core smoke exercises real HTTP auth, persisted fixture reads and authenticated WS reconnect', async (t) => {
  const f = await fixtureServer(t);
  const evidence = await runCoreBusinessSmoke(f.input, { allowLoopback: true });
  assert.equal(f.connections(), 2);
  assert.equal(evidence.status, 'passed');
  assert.doesNotMatch(JSON.stringify(evidence), /local-token|local-only-password/u);
  validateCoreSmokeEvidence(evidence, { ...evidence });
  assert.throws(
    () => validateCoreSmokeEvidence(evidence, { ...evidence, stagingRunAttempt: '3' }),
    /binding mismatch/u,
  );
  assert.throws(
    () => validateCoreSmokeEvidence({ ...evidence, observedAt: '2000-01-01T00:00:00Z' }, evidence),
    /digest mismatch/u,
  );
  assert.throws(
    () => validateCoreSmokeEvidence(evidence, evidence, Date.now() + 25 * 3600000),
    /stale/u,
  );
  const binding = {
    manifest,
    smoke: evidence,
    deployment: {
      environment: 'staging',
      sha: manifest.releaseSha,
      payload: {
        releaseId: manifest.releaseId,
        manifestDigest: manifest.digest,
        stagingRunId: '101',
      },
    },
    run: {
      id: 101,
      head_sha: manifest.releaseSha,
      head_branch: 'main',
      event: 'workflow_dispatch',
      path: '.github/workflows/deploy-staging.yml',
      status: 'completed',
      conclusion: 'success',
      run_attempt: 2,
    },
    isolation: {
      schemaVersion: 1,
      environment: 'staging',
      status: 'verified-with-accepted-residual-risk',
      releaseId: manifest.releaseId,
      manifestDigest: manifest.digest,
      stagingRunId: '101',
      stagingRunAttempt: '2',
      evidenceDigest: `sha256:${'c'.repeat(64)}`,
    },
    final: { releaseId: manifest.releaseId, runtimeConverged: true, state: 'target_runtime' },
  };
  assert.equal(validateAcceptanceBinding(binding), true);
  assert.throws(() => validateAcceptanceBinding({ ...binding, isolation: undefined }), /missing/u);
  assert.throws(
    () => validateAcceptanceBinding({ ...binding, run: { ...binding.run, run_attempt: 3 } }),
    /binding mismatch/u,
  );
});

for (const failure of [
  'login',
  'anonymous',
  'persistence',
  'websocket',
  'unauthenticated-pong',
  'changed-rc',
]) {
  test(`core smoke refuses a real ${failure} failure instead of producing passed evidence`, async (t) => {
    const f = await fixtureServer(t, failure);
    await assert.rejects(runCoreBusinessSmoke(f.input, { allowLoopback: true }));
  });
}

test('core smoke rejects missing inputs and production targets before networking', () => {
  const input = {
    baseUrl: 'https://staging-agent-api.kaiyan.net',
    username: 'staging-e2e-admin',
    password: 'test',
    manifest,
    fixture,
    runId: '1',
    runAttempt: '1',
  };
  assert.doesNotThrow(() => validateSmokeInputs(input));
  assert.throws(() => validateSmokeInputs({ ...input, password: '' }), /credentials/u);
  assert.throws(() => validateSmokeInputs({ ...input, username: 'real-user' }), /credentials/u);
  assert.throws(
    () => validateSmokeInputs({ ...input, baseUrl: 'https://api.agent.kaiyan.net' }),
    /restricted/u,
  );
  assert.throws(
    () => validateSmokeInputs({ ...input, fixture: { ...fixture, releaseId: 'rc-20260908-02' } }),
    /same RC/u,
  );
});
