#!/usr/bin/env node

import { copyFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const baseUrl = required('ACS_ORCH_URL').replace(/\/$/, '');
const authToken = required('ACS_ORCH_AUTH_TOKEN');
const workspaceId = required('ACS_SMOKE_WORKSPACE_ID');
const sessionId = required('ACS_SMOKE_SESSION_ID');
const mountSubPath = required('ACS_SMOKE_MOUNT_SUBPATH');
const workspaceDir = required('ACS_SMOKE_WORKSPACE_DIR');
const appDir = required('ACS_APP_DIR');
const runId = required('GITHUB_RUN_ID').replace(/[^A-Za-z0-9-]/g, '-');
const taskId = `shell-bg-ci-${runId}`;
const leaseId = `ci-browser-${runId}`;
const profileId = `ci-browser-${runId}`;
const helperRelativePath = '.ci/acs_browser.py';
const snapshotRelativePath = `.ci/${leaseId}-snapshot.txt`;
const testPage = 'data:text/html,%3Ctitle%3EACS%20Lease%20E2E%3C/title%3E%3Ch1%3EACS%20Lease%20Ready%3C/h1%3E';
const workspace = { id: workspaceId, sessionId, mountSubPath };
let backgroundStarted = false;

await mkdir(join(workspaceDir, '.ci'), { recursive: true });
await copyFile(
  join(appDir, 'workspace-shared/.ky-agent/skills-pool/browser/scripts/acs_browser.py'),
  join(workspaceDir, helperRelativePath),
);

try {
  const started = await execute('Shell', {
    command: `python3 ${quote(helperRelativePath)} lease-serve --lease-id ${quote(leaseId)} --profile-id ${quote(profileId)} --lease-ttl-seconds 180 --url ${quote(testPage)}`,
    mode: 'background',
    timeoutMs: 240_000,
    taskId,
  });
  backgroundStarted = true;
  const startView = parseContentJson(started);
  assert(startView.taskId === taskId, `unexpected taskId: ${startView.taskId}`);
  assert(['starting', 'running'].includes(startView.status), `unexpected start status: ${startView.status}`);

  await poll(async () => {
    const status = await leaseStatus();
    if (status.status === 'error' || status.status === 'stale') {
      throw new Error(`browser lease failed before ready: ${JSON.stringify(status)}`);
    }
    return status.status === 'ready' && status.alive === true;
  }, 'browser lease ready');

  // 独立 HTTP 工具调用之间显式等待，模拟模型结束一轮、后续轮次重新进入同一 Sandbox。
  await sleep(1_000);
  await shell(
    `python3 ${quote(helperRelativePath)} snapshot --lease-id ${quote(leaseId)} --run-id ${quote(`ci-action-${runId}`)} --out ${quote(snapshotRelativePath)}`,
  );
  const snapshot = await readFile(join(workspaceDir, snapshotRelativePath), 'utf8');
  assert(snapshot.includes('ACS Lease Ready'), 'cross-turn browser action did not observe the deterministic test page');

  await stopLease();
  await poll(async () => {
    const status = await leaseStatus();
    return status.status === 'stopped' && status.alive === false;
  }, 'browser lease stopped');

  await poll(async () => {
    const response = await execute('BashOutput', {
      task_id: taskId,
      stdout_offset: 0,
      stderr_offset: 0,
      limit_bytes: 20_000,
      wait_ms: 1_000,
    });
    const view = parseContentJson(response);
    if (['failed', 'lost', 'timed_out'].includes(view.status)) {
      throw new Error(`background shell ended unexpectedly: ${JSON.stringify(view)}`);
    }
    return view.status === 'completed';
  }, 'background shell completed');

  const reconciled = parseContentJson(await execute('__BackgroundShellReconcile', {}));
  assert(!reconciled.activeTaskIds?.includes(taskId), 'background shell remained active after lease-stop');
  assert(!reconciled.protectedUntil, 'Sandbox lifecycle protection remained after lease-stop');
  console.log(`ACS_BROWSER_LEASE_E2E_OK task=${taskId} lease=${leaseId}`);
} finally {
  if (backgroundStarted) {
    await stopLease().catch(() => undefined);
    await execute('KillBash', { task_id: taskId }).catch(() => undefined);
    await execute('__BackgroundShellReconcile', {}).catch(() => undefined);
  }
}

async function leaseStatus() {
  return parseContentJson(await shell(
    `python3 ${quote(helperRelativePath)} lease-status --lease-id ${quote(leaseId)}`,
  ));
}

async function stopLease() {
  return await shell(`python3 ${quote(helperRelativePath)} lease-stop --lease-id ${quote(leaseId)}`);
}

async function shell(command) {
  return await execute('Shell', { command, timeoutMs: 120_000 });
}

async function execute(toolName, input) {
  const response = await fetch(`${baseUrl}/execute`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${authToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ toolName, input, context: { workspace } }),
    signal: AbortSignal.timeout(180_000),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${toolName} HTTP ${response.status}: ${text.slice(0, 2_000)}`);
  const body = JSON.parse(text);
  if (body.status !== 'success') throw new Error(`${toolName} failed: ${body.error ?? text}`);
  return body;
}

function parseContentJson(response) {
  if (typeof response.content !== 'string') throw new Error(`missing response content: ${JSON.stringify(response)}`);
  return JSON.parse(response.content);
}

async function poll(check, label) {
  const deadline = Date.now() + 90_000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      if (await check()) return;
      lastError = undefined;
    } catch (error) {
      lastError = error;
    }
    await sleep(500);
  }
  throw lastError ?? new Error(`timed out waiting for ${label}`);
}

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`missing ${name}`);
  return value;
}

function quote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
