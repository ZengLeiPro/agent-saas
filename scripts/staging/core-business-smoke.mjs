#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { canonicalJson, digestBuffer } from '../release/artifact-lib.mjs';
import {
  CORE_SMOKE_CHECKS,
  validateCoreSmokeEvidence,
} from '../release/staging-core-smoke-evidence.mjs';

export function validateSmokeInputs(
  { baseUrl, username, password, manifest, fixture, runId, runAttempt },
  { allowLoopback = false } = {},
) {
  const url = new URL(baseUrl);
  if (
    !(
      url.origin === 'https://staging-agent-api.kaiyan.net' ||
      (allowLoopback && url.protocol === 'http:' && url.hostname === '127.0.0.1')
    ) ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  )
    throw new Error('Core smoke is restricted to the fixed Staging API');
  if (username !== 'staging-e2e-admin' || !password?.trim())
    throw new Error('Dedicated Staging smoke credentials are required');
  if (
    !/^rc-\d{8}-\d{2,}$/u.test(manifest?.releaseId ?? '') ||
    !/^[a-f0-9]{40}$/u.test(manifest?.releaseSha ?? '') ||
    !/^sha256:[a-f0-9]{64}$/u.test(manifest?.digest ?? '') ||
    !/^[1-9][0-9]*$/u.test(String(runId)) ||
    !/^[1-9][0-9]*$/u.test(String(runAttempt))
  )
    throw new Error('Core smoke release/run identity is invalid');
  if (
    fixture?.releaseId !== manifest.releaseId ||
    fixture?.migrationReadback?.status !== 'present' ||
    fixture?.fixture?.username !== username ||
    fixture.fixture.taskId !== 'staging-e2e-integration-task' ||
    fixture.fixture.sourceId !== 'staging-e2e-integration-source' ||
    fixture.fixture.state !== 'canceled'
  )
    throw new Error('Core smoke requires the same RC isolated database fixture');
}

async function authenticatedWebSocket(baseUrl, token, binding) {
  const url = new URL('/ws', baseUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  await new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    let completed = false;
    let authenticated = false;
    const finish = (error) => {
      if (completed) return;
      completed = true;
      clearTimeout(timer);
      socket.close();
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(
      () => finish(new Error('Authenticated Staging WebSocket timed out')),
      10_000,
    );
    socket.addEventListener('open', () =>
      socket.send(JSON.stringify({ action: 'auth', token, ...binding })),
    );
    socket.addEventListener('message', (event) => {
      try {
        const data = JSON.parse(String(event.data)).data;
        if (data?.type === 'auth_ok') {
          authenticated = true;
          socket.send(JSON.stringify({ action: 'ping', ...binding }));
        } else if (data?.type === 'pong' && !data.probe)
          finish(
            authenticated ? undefined : new Error('WebSocket pong arrived before authentication'),
          );
        else if (data?.type === 'error')
          finish(new Error('Authenticated WebSocket rejected the request'));
      } catch {
        finish(new Error('Invalid Staging WebSocket response'));
      }
    });
    socket.addEventListener('error', () =>
      finish(new Error('Staging WebSocket connection failed')),
    );
    socket.addEventListener('close', () => {
      if (!completed) finish(new Error('Staging WebSocket closed before authenticated pong'));
    });
  });
}

/** Uses real auth, persisted fixture reads, and authenticated WS; no model/tool execution. */
export async function runCoreBusinessSmoke(input, options = {}) {
  validateSmokeInputs(input, options);
  const { baseUrl, username, password, manifest, fixture, runId, runAttempt } = input;
  const request = async (path, init = {}) => {
    const response = await fetch(`${baseUrl.replace(/\/$/u, '')}${path}`, {
      ...init,
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`Staging smoke ${path} returned HTTP ${response.status}`);
    return response.json();
  };
  const login = await request('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  if (typeof login.token !== 'string' || !login.token)
    throw new Error('Staging login did not issue a token');
  const headers = { authorization: `Bearer ${login.token}` };
  const actor = await request('/api/auth/me', { headers });
  if (actor.username !== username || !actor.id || !actor.tenantId)
    throw new Error('Staging login actor is not the dedicated test identity');
  if (
    !Number.isSafeInteger(actor.authEpoch) ||
    actor.authEpoch < 1 ||
    !Number.isSafeInteger(actor.generation) ||
    actor.generation < 1
  )
    throw new Error('Staging login did not expose a durable auth binding');
  const anonymous = await fetch(`${baseUrl.replace(/\/$/u, '')}/api/auth/me`, {
    signal: AbortSignal.timeout(15_000),
  });
  if (![401, 403].includes(anonymous.status))
    throw new Error('Anonymous authenticated-route access was not rejected');
  const sessions = await request('/api/sessions?limit=1', { headers });
  if (!Array.isArray(sessions.sessions))
    throw new Error('Authenticated session listing returned an invalid body');
  const sources = await request(
    `/api/taskboard/tasks/${fixture.fixture.taskId}/integration-sources`,
    { headers },
  );
  assert.equal(sources.length, 1, 'The isolated persisted source is missing or ambiguous');
  for (const [key, value] of Object.entries({
    id: fixture.fixture.sourceId,
    integrationTaskId: fixture.fixture.taskId,
    deliveryTaskId: 'staging-e2e-integration-delivery',
    repositoryId: 'staging-fixture:none',
    state: 'canceled',
  }))
    assert.equal(sources[0][key], value, `Persisted fixture ${key} mismatch`);
  const binding = { authEpoch: actor.authEpoch, generation: actor.generation };
  await authenticatedWebSocket(baseUrl, login.token, binding);
  await authenticatedWebSocket(baseUrl, login.token, binding); // Reconnect with the same durable auth generation.
  const readiness = await request('/api/healthz/ready');
  if (
    readiness.release?.releaseId !== manifest.releaseId ||
    readiness.release?.releaseSha !== manifest.components.api.sourceSha
  )
    throw new Error('Staging changed RC during core business smoke');
  const body = {
    schemaVersion: 1,
    environment: 'staging',
    status: 'passed',
    releaseId: manifest.releaseId,
    sourceSha: manifest.releaseSha,
    manifestDigest: manifest.digest,
    stagingRunId: String(runId),
    stagingRunAttempt: String(runAttempt),
    actor: username,
    checks: CORE_SMOKE_CHECKS,
    observedAt: new Date().toISOString(),
  };
  const evidence = { ...body, evidenceDigest: digestBuffer(Buffer.from(canonicalJson(body))) };
  validateCoreSmokeEvidence(evidence, body);
  return evidence;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [, , manifestPath, fixturePath, output] = process.argv;
  const input = {
    baseUrl: process.env.STAGING_API_URL,
    username: process.env.STAGING_E2E_USERNAME,
    password: process.env.STAGING_E2E_PASSWORD,
    runId: process.env.GITHUB_RUN_ID,
    runAttempt: process.env.GITHUB_RUN_ATTEMPT,
    manifest: JSON.parse(await readFile(manifestPath, 'utf8')),
    fixture: JSON.parse(await readFile(fixturePath, 'utf8')),
  };
  const result = await runCoreBusinessSmoke(input);
  await writeFile(output, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  process.stdout.write(
    `${JSON.stringify({ status: result.status, evidenceDigest: result.evidenceDigest })}\n`,
  );
}
