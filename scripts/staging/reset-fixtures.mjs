#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { deleteSandboxAfterBusyRelease } from './reset-fixtures-lib.mjs';

const [baseUrl, releaseId] = process.argv.slice(2);
const username = process.env.STAGING_E2E_USERNAME?.trim();
const password = process.env.STAGING_E2E_PASSWORD?.trim();
if (
  !baseUrl ||
  !username ||
  !password ||
  !/^rc-\d{8}-\d{2,}$/u.test(releaseId ?? '') ||
  new URL(baseUrl).hostname !== 'staging-agent-api.kaiyan.net'
) {
  throw new Error(
    'usage: STAGING_E2E_USERNAME=... STAGING_E2E_PASSWORD=... reset-fixtures.mjs <staging-api-url> <release-id>',
  );
}

const loginResponse = await fetch(`${baseUrl}/api/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ username, password }),
});
if (!loginResponse.ok)
  throw new Error(`Unable to login for Staging cleanup: ${loginResponse.status}`);
const token = String((await loginResponse.json()).token ?? '');
if (!token) throw new Error('Staging cleanup login did not return a token');
const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
const meResponse = await fetch(`${baseUrl}/api/auth/me`, { headers });
if (!meResponse.ok) throw new Error(`Unable to identify Staging E2E actor: ${meResponse.status}`);
const actor = await meResponse.json();
if (actor.username !== username || !actor.id || !actor.tenantId)
  throw new Error('Staging cleanup actor identity does not match the dedicated E2E account');
const safeUserId =
  /^[A-Za-z0-9_-]{1,80}$/u.test(actor.id) && !actor.id.includes('..')
    ? actor.id
    : `h${createHash('sha256').update(String(actor.id)).digest('base64url').slice(0, 16)}`;
const actorWorkspaceId = `ws_${actor.tenantId}__${safeUserId}`;

async function inventory() {
  const response = await fetch(`${baseUrl}/api/admin/runtime-operations/acs/sandboxes`, {
    headers,
  });
  if (!response.ok) throw new Error(`Unable to list Staging sandboxes: ${response.status}`);
  const body = await response.json();
  return Array.isArray(body.sandboxes)
    ? body.sandboxes
    : Array.isArray(body.items)
      ? body.items
      : [];
}

async function activeWorkerRuns() {
  const response = await fetch(`${baseUrl}/api/admin/runtime-operations`, { headers });
  if (!response.ok) throw new Error(`Unable to read Staging Worker leases: ${response.status}`);
  const body = await response.json();
  if (body?.runtimeEventStore?.status !== 'ok')
    throw new Error('Staging Worker lease store did not return an authoritative snapshot');
  if (!Array.isArray(body.runtimeEventStore.activeRunDetails))
    throw new Error('Staging Worker lease snapshot is missing activeRunDetails');
  return body.runtimeEventStore.activeRunDetails;
}

function belongsToE2eActor(item) {
  return item?.owner?.username === username;
}

const before = await inventory();
const targets = before.filter(belongsToE2eActor);
for (const target of targets) {
  if (!/^as-[a-z0-9-]{1,60}$/u.test(String(target.name ?? '')))
    throw new Error('Staging cleanup refused an invalid sandbox identity');
  await deleteSandboxAfterBusyRelease({ baseUrl, name: target.name, headers });
}
const cleanup = await fetch(`${baseUrl}/api/admin/runtime-operations/acs/lifecycle-cleanup`, {
  method: 'POST',
  headers,
  body: '{}',
});
if (!cleanup.ok) throw new Error(`Staging lifecycle cleanup failed: ${cleanup.status}`);
const cleanupBody = await cleanup.json();
if (cleanupBody.status !== 'ok' || !cleanupBody.report)
  throw new Error('Staging lifecycle cleanup did not return an authoritative report');

const after = await inventory();
const residuals = after.filter(belongsToE2eActor);
if (residuals.length)
  throw new Error(`Staging E2E sandbox readback found ${residuals.length} orphan(s)`);
for (const target of targets) {
  const response = await fetch(
    `${baseUrl}/api/admin/runtime-operations/acs/sandboxes/${encodeURIComponent(target.name)}`,
    { headers },
  );
  if (response.status !== 404)
    throw new Error(`Deleted Staging sandbox ${target.name} still has a Pod/lifecycle record`);
}
const targetSessionIds = new Set(
  targets.map((target) => String(target.sessionId ?? '')).filter(Boolean),
);
const targetWorkspaceIds = new Set([
  actorWorkspaceId,
  ...targets.map((target) => String(target.workspaceId ?? '')).filter(Boolean),
]);
const residualWorkerRuns = (await activeWorkerRuns()).filter(
  (run) =>
    targetSessionIds.has(String(run.session_id ?? '')) ||
    targetWorkspaceIds.has(String(run.workspace_id ?? '')),
);
if (residualWorkerRuns.length)
  throw new Error(`Staging E2E Worker lease readback found ${residualWorkerRuns.length} orphan(s)`);
process.stdout.write(
  `${JSON.stringify({
    schemaVersion: 1,
    releaseId,
    actor: { username, userId: actor.id, tenantId: actor.tenantId, workspaceId: actorWorkspaceId },
    deletedSandboxes: targets.map((item) => ({
      name: item.name,
      sessionId: item.sessionId ?? null,
      workspaceId: item.workspaceId ?? null,
    })),
    lifecycleReport: cleanupBody.report,
    readBack: { sandboxCount: 0, podLifecycleRecords: 0, workerLeases: 0 },
    observedAt: new Date().toISOString(),
  })}\n`,
);
