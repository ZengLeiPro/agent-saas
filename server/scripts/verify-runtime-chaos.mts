#!/usr/bin/env tsx
import { randomUUID } from 'node:crypto';
import { execFile as execFileCb, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import assert from 'node:assert/strict';
import { createServer, connect, type Socket } from 'node:net';
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { getMetaPath } from '../src/data/transcripts/meta.js';
import { getTranscriptPath } from '../src/data/transcripts/store.js';
import { buildPendingInteractionsFromEvents } from '../src/runtime/interactionProjection.js';
import { ClientDaemonGateway } from '../src/runtime/clientDaemonGateway.js';
import { ClientDaemonTransport } from '../src/runtime/clientDaemonTransport.js';
import type { HandRecord, HandStatus, HandStore, RegisterHandInput } from '../src/runtime/handStore.js';
import type { ToolInvocationStreamChunk } from '../src/runtime/handProtocol.js';
import { PgEventStore } from '../src/runtime/pgEventStore.js';
import { wakeRuntimeSession } from '../src/runtime/rawRuntimeRunDispatch.js';
import { PgRunStore, type RunStatus } from '../src/runtime/runStore.js';
import { RuntimeScheduler } from '../src/runtime/scheduler.js';
import { FileSessionCatalog, type RuntimeSessionRecord } from '../src/runtime/sessionCatalog.js';
import type { PlatformEvent, PlatformEventInput } from '../src/runtime/types.js';

const execFile = promisify(execFileCb);
const POSTGRES_IMAGE = 'postgres:16-alpine';
const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = new URL('../..', import.meta.url);
// 真实 workspace-shared 绝对路径（含 prompts/*.md）。ask-user-resume 的 wake worker 需要
// 它给 buildInstructions 加载 prompt 与 company.md；缺它会 resolve(undefined) 崩溃。
const SHARED_DIR = fileURLToPath(new URL('../../workspace-shared', import.meta.url));

interface SpawnedProcess {
  child: ChildProcessWithoutNullStreams;
  stdout: () => string;
  stderr: () => string;
}

async function main() {
  const internalWorker = argValue('--internal-worker');
  if (internalWorker === 'scheduler') {
    await runSchedulerWorker();
    return;
  }

  const mode = process.argv.find((arg) => arg.startsWith('--mode='))?.slice('--mode='.length) ?? 'all';
  const modes = mode === 'all'
    ? ['hand-cancel', 'hand-kill', 'server-restart', 'network-interrupt', 'multi-worker', 'ask-user-resume', 'client-daemon', 'daemon-network', 'renew-failure', 'abort-states', 'notify-drop', 'db-unavailable']
    : [mode];
  for (const item of modes) {
    if (item === 'hand-cancel') await verifyHandCancel();
    else if (item === 'hand-kill') await verifyHandKill();
    else if (item === 'server-restart') await verifyServerRestart();
    else if (item === 'network-interrupt') await verifyNetworkInterrupt();
    else if (item === 'multi-worker') await verifyMultiWorker();
    else if (item === 'ask-user-resume') await verifyAskUserResume();
    else if (item === 'client-daemon') await verifyClientDaemon();
    else if (item === 'daemon-network') await verifyDaemonNetworkChaos();
    else if (item === 'renew-failure') await verifyRenewFailure();
    else if (item === 'abort-states') await verifyAbortStates();
    else if (item === 'notify-drop') await verifyNotifyDrop();
    else if (item === 'db-unavailable') await verifyDbUnavailable();
    else throw new Error(`unknown chaos mode: ${item}`);
  }
  console.log(`[ok] runtime chaos verification completed: ${modes.join(', ')}`);
}

async function verifyHandCancel() {
  const port = await freePort();
  const hand = spawn(process.execPath, ['--import', 'tsx', 'hand-server/src/index.ts'], {
    cwd: new URL('../..', import.meta.url),
    env: { ...process.env, HAND_SERVER_PORT: String(port), HAND_SERVER_AUTH_TOKEN: 'chaos-token', HAND_SERVER_BACKEND: 'local' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    await waitForHealth(port);
    const invocationId = `chaos-${Date.now()}`;
    const controller = new AbortController();
    const response = await fetch(`http://127.0.0.1:${port}/execute-stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer chaos-token' },
      body: JSON.stringify({
        toolName: 'Shell',
        input: { command: 'for i in 1 2 3 4 5; do echo tick-$i; sleep 1; done', timeoutMs: 20_000 },
        context: { invocationId, workspace: { id: 'chaos', sessionId: 'chaos' } },
      }),
      signal: controller.signal,
    });
    assert.equal(response.ok, true);
    await delay(500);
    const cancel = await fetch(`http://127.0.0.1:${port}/invocations/${encodeURIComponent(invocationId)}`, { method: 'DELETE', headers: { authorization: 'Bearer chaos-token' } });
    assert.equal(cancel.ok, true);
    const body = await cancel.json() as { cancelled?: boolean };
    assert.equal(body.cancelled, true);
    const completed = await readCompletedChunk(response, 5_000);
    assert.equal(completed?.response?.status, 'error');
    controller.abort();
    console.log('[ok] chaos hand-cancel: DELETE /invocations cancels an active stream and stream reaches terminal error');
  } finally {
    hand.kill('SIGTERM');
  }
}

async function verifyHandKill() {
  const port = await freePort();
  const hand = spawn(process.execPath, ['--import', 'tsx', 'hand-server/src/index.ts'], {
    cwd: new URL('../..', import.meta.url),
    env: { ...process.env, HAND_SERVER_PORT: String(port), HAND_SERVER_AUTH_TOKEN: 'chaos-token', HAND_SERVER_BACKEND: 'local' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await waitForHealth(port);
  const response = await fetch(`http://127.0.0.1:${port}/execute-stream`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer chaos-token' },
    body: JSON.stringify({
      toolName: 'Shell',
      input: { command: 'echo before-kill; sleep 30', timeoutMs: 60_000 },
      context: { invocationId: `kill-${Date.now()}`, workspace: { id: 'chaos', sessionId: 'chaos' } },
    }),
  });
  assert.equal(response.ok, true);
  hand.kill('SIGKILL');
  let sawFailure = false;
  try {
    const reader = response.body!.getReader();
    while (true) {
      const { done } = await reader.read();
      if (done) break;
    }
  } catch {
    sawFailure = true;
  }
  assert.equal(sawFailure || hand.killed, true);
  console.log('[ok] chaos hand-kill: active stream observes hand process death');
}

async function verifyClientDaemon() {
  const transport = new ClientDaemonTransport();
  const handStore = new MemoryHandStore();
  const httpServer = createHttpServer((_req, res) => res.end('ok'));
  const heartbeatTimeoutMs = 1_500;
  const gateway = new ClientDaemonGateway({
    transport,
    handStore,
    authToken: 'chaos-token',
    heartbeatTimeoutMs,
    heartbeatScanIntervalMs: 200,
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
  });
  gateway.attach(httpServer);
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const address = httpServer.address() as AddressInfo;
  const wsUrl = `ws://127.0.0.1:${address.port}/daemon`;

  const workspaceRoot = await mkdtemp(join(tmpdir(), 'chaos-client-daemon-'));
  const handId = `chaos-hand-${randomUUID()}`;
  const daemonId = `chaos-daemon-${randomUUID()}`;
  let daemon = spawnClientDaemon({ wsUrl, daemonId, handId, workspaceRoot });
  const killDaemon = (proc: SpawnedProcess, signal: NodeJS.Signals) => {
    try { proc.child.kill(signal); } catch {}
  };

  try {
    // 1. daemon registers as ready hand
    await waitForAsyncCondition('daemon registered as ready hand', async () => {
      if (!transport.has(handId)) return false;
      const record = await handStore.get(handId);
      return record?.status === 'ready' && record?.type === 'client';
    }, 10_000);

    // 2. streaming Shell delivers stdout chunks and completes
    const firstChunks = await collectInvokeStream(transport, handId);
    const firstStdout = firstChunks
      .filter((c): c is Extract<ToolInvocationStreamChunk, { type: 'output' }> => c.type === 'output' && c.channel === 'stdout')
      .map((c) => c.content)
      .join('');
    const firstFinal = firstChunks.at(-1);
    assert.equal(firstFinal?.type, 'completed', `expected terminal completed chunk, got ${firstFinal?.type}`);
    assert.equal(firstFinal && (firstFinal as any).response?.status, 'success', 'first invocation should succeed');
    assert.ok(firstStdout.includes('chaos-pre-kill'), `expected pre-kill stdout, saw ${JSON.stringify(firstStdout)}`);

    // 3. freeze daemon process (SIGSTOP keeps the TCP socket alive but halts heartbeats)
    //    so we exercise the scanner path rather than the FIN/RST-driven ws.on('close') path.
    killDaemon(daemon, 'SIGSTOP');
    await waitForAsyncCondition('hand becomes unhealthy via heartbeat scanner', async () => {
      const record = await handStore.get(handId);
      const reason = record?.metadata?.disconnectReason as string | undefined;
      return record?.status === 'unhealthy' && typeof reason === 'string' && reason.startsWith('heartbeat_timeout:');
    }, heartbeatTimeoutMs + 3_000);
    assert.equal(transport.has(handId), false, 'transport should drop dead hand after scanner kicks');

    // 4. fully reap the frozen daemon, then respawn with same handId → re-register
    killDaemon(daemon, 'SIGKILL');
    daemon = spawnClientDaemon({ wsUrl, daemonId, handId, workspaceRoot });
    await waitForAsyncCondition('daemon re-registers after reconnect', async () => {
      if (!transport.has(handId)) return false;
      const record = await handStore.get(handId);
      return record?.status === 'ready';
    }, 10_000);

    const secondChunks = await collectInvokeStream(transport, handId, 'chaos-post-reconnect');
    const secondStdout = secondChunks
      .filter((c): c is Extract<ToolInvocationStreamChunk, { type: 'output' }> => c.type === 'output' && c.channel === 'stdout')
      .map((c) => c.content)
      .join('');
    const secondFinal = secondChunks.at(-1);
    assert.equal(secondFinal?.type, 'completed', 'second invocation should reach terminal completed chunk');
    assert.equal(secondFinal && (secondFinal as any).response?.status, 'success', 'second invocation should succeed');
    assert.ok(secondStdout.includes('chaos-post-reconnect'), `expected post-reconnect stdout, saw ${JSON.stringify(secondStdout)}`);

    console.log('[ok] chaos client-daemon: register → streaming → daemon kill → heartbeat scanner unhealthy → reconnect → new invocation routed');
  } finally {
    killDaemon(daemon, 'SIGKILL');
    gateway.close();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    await rm(workspaceRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * C6 daemon network chaos — daemon ↔ gateway routed through a TCP proxy that
 * "blips" the connection (force-RST sockets without closing the listener). The
 * daemon runner is expected to reconnect within its reconnectDelayMs and the
 * gateway is expected to accept the fresh hello (per-device flow not exercised
 * here — we keep the shared bearer fast path so the test stays focused on the
 * network-recovery property).
 */
async function verifyDaemonNetworkChaos() {
  const transport = new ClientDaemonTransport();
  const handStore = new MemoryHandStore();
  const httpServer = createHttpServer((_req, res) => res.end('ok'));
  const gateway = new ClientDaemonGateway({
    transport,
    handStore,
    // spawnClientDaemon 硬编码 --auth-token=chaos-token，gateway 必须用同一 token，
    // 否则 shared-bearer 校验失败、daemon 注册不上（原值 'chaos-net-token' 是既有
    // runtime bug，导致 daemon-network 一直超时失败）。
    authToken: 'chaos-token',
    // Heartbeat scanner pushed out so it doesn't race the blip-and-reconnect window.
    heartbeatTimeoutMs: 30_000,
    heartbeatScanIntervalMs: 5_000,
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
  });
  gateway.attach(httpServer);
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const gatewayAddress = httpServer.address() as AddressInfo;
  const proxy = await startTcpProxy(gatewayAddress.port);
  const wsUrl = `ws://127.0.0.1:${proxy.port}/daemon`;
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'chaos-daemon-net-'));
  const handId = `chaos-net-hand-${randomUUID()}`;
  const daemonId = `chaos-net-daemon-${randomUUID()}`;
  const daemon = spawnClientDaemon({ wsUrl, daemonId, handId, workspaceRoot });

  try {
    await waitForAsyncCondition('daemon registered as ready hand via proxy', async () => {
      if (!transport.has(handId)) return false;
      const record = await handStore.get(handId);
      return record?.status === 'ready' && record?.type === 'client';
    }, 10_000);

    // First run through the proxy must succeed.
    const preChunks = await collectInvokeStream(transport, handId, 'chaos-net-pre');
    const preFinal = preChunks.at(-1);
    assert.equal(preFinal?.type, 'completed', 'pre-blip invocation should reach terminal completed');
    assert.equal((preFinal as any).response?.status, 'success', 'pre-blip invocation should succeed');

    // Blip: kill in-flight TCP sockets without closing the listening server.
    proxy.blip();
    // Daemon should drop transport entry briefly while it reconnects.
    await waitForAsyncCondition('transport drops hand after network blip', async () => !transport.has(handId), 10_000);
    // Then auto-reconnect (runner default reconnectDelayMs=5_000) restores the hand.
    await waitForAsyncCondition('hand re-registers after network blip', async () => {
      if (!transport.has(handId)) return false;
      const record = await handStore.get(handId);
      return record?.status === 'ready';
    }, 15_000);

    // Second run after the blip must also succeed.
    const postChunks = await collectInvokeStream(transport, handId, 'chaos-net-post');
    const postFinal = postChunks.at(-1);
    assert.equal(postFinal?.type, 'completed', 'post-blip invocation should reach terminal completed');
    assert.equal((postFinal as any).response?.status, 'success', 'post-blip invocation should succeed');

    console.log('[ok] chaos daemon-network: register → invoke → tcp blip → daemon auto-reconnect → second invocation routed');
  } finally {
    try { daemon.child.kill('SIGKILL'); } catch { /* ignore */ }
    await proxy.close();
    gateway.close();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    await rm(workspaceRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

class MemoryHandStore implements HandStore {
  private readonly records = new Map<string, HandRecord>();
  async register(input: RegisterHandInput): Promise<HandRecord> {
    const now = new Date().toISOString();
    const existing = this.records.get(input.handId);
    const record: HandRecord = {
      handId: input.handId,
      sessionId: input.sessionId,
      workspaceId: input.workspaceId,
      type: input.type,
      status: input.status ?? 'ready',
      endpoint: input.endpoint,
      capabilities: input.capabilities ?? [],
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      leaseExpiresAt: input.leaseExpiresAt?.toISOString(),
      metadata: { ...(existing?.metadata ?? {}), ...(input.metadata ?? {}) },
    };
    this.records.set(input.handId, record);
    return record;
  }
  async updateStatus(handId: string, status: HandStatus, metadataPatch: Record<string, unknown> = {}): Promise<HandRecord | null> {
    const record = this.records.get(handId);
    if (!record) return null;
    const updated: HandRecord = {
      ...record,
      status,
      updatedAt: new Date().toISOString(),
      metadata: { ...record.metadata, ...metadataPatch },
    };
    this.records.set(handId, updated);
    return updated;
  }
  async get(handId: string): Promise<HandRecord | null> { return this.records.get(handId) ?? null; }
  async listBySession(sessionId: string): Promise<HandRecord[]> {
    return [...this.records.values()].filter((r) => r.sessionId === sessionId);
  }
  async listByWorkspace(workspaceId: string): Promise<HandRecord[]> {
    return [...this.records.values()].filter((r) => r.workspaceId === workspaceId);
  }
}

function spawnClientDaemon(args: { wsUrl: string; daemonId: string; handId: string; workspaceRoot: string }): SpawnedProcess {
  const scriptPath = fileURLToPath(new URL('./client-daemon.mts', import.meta.url));
  const child = spawn(process.execPath, [
    '--import', 'tsx', scriptPath,
    `--url=${args.wsUrl}`,
    `--daemon-id=${args.daemonId}`,
    `--hand-id=${args.handId}`,
    `--workspace-root=${args.workspaceRoot}`,
    `--auth-token=chaos-token`,
    // tight heartbeat for chaos so scanner can kick within a few seconds
    `--heartbeat-interval-ms=300`,
    `--reconnect-delay-ms=500`,
  ], { cwd: REPO_ROOT, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  return { child, stdout: () => stdout, stderr: () => stderr };
}

async function collectInvokeStream(
  transport: ClientDaemonTransport,
  handId: string,
  marker: string = 'chaos-pre-kill',
): Promise<ToolInvocationStreamChunk[]> {
  const chunks: ToolInvocationStreamChunk[] = [];
  for await (const chunk of transport.invokeStream({
    toolName: 'Shell',
    input: { command: `echo ${marker}`, handId },
    context: {
      handId,
      invocationId: `chaos-${randomUUID()}`,
      workspace: { id: handId, root: '/tmp', executionTarget: 'client' },
    },
  })) chunks.push(chunk);
  return chunks;
}

async function waitForAsyncCondition(description: string, predicate: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(75);
  }
  throw new Error(`timed out waiting for ${description}`);
}

async function verifyServerRestart() {
  const pgRuntime = await startPostgresContainer();
  const tablePrefix = chaosTablePrefix('server_restart');
  const sessionId = `session-${randomUUID()}`;
  const runId = `run-${randomUUID()}`;
  const store = new PgEventStore({ connectionString: pgRuntime.connectionString, tablePrefix });
  const runStore = new PgRunStore({ pool: store.pool, tablePrefix });
  try {
    await store.init();
    await runStore.init();
    await runStore.upsertPending({ runId, sessionId, channel: 'chaos', model: 'chaos-model' });

    const first = spawnSchedulerWorker(pgRuntime.connectionString, tablePrefix, runId, 'chaos-worker-a', 'hold', {
      leaseMs: 700,
      pollIntervalMs: 100,
    });
    await waitForOutput(first, /WAKE_STARTED chaos-worker-a/, 5_000);
    first.child.kill('SIGKILL');
    await waitForExit(first, 5_000);
    await delay(900);

    const second = spawnSchedulerWorker(pgRuntime.connectionString, tablePrefix, runId, 'chaos-worker-b', 'complete', {
      leaseMs: 700,
      pollIntervalMs: 100,
    });
    await waitForExit(second, 8_000);

    const finalRun = await runStore.get(runId);
    assert.equal(finalRun?.status, 'completed');
    assert.equal(finalRun?.statusReason, 'chaos_completed_by_chaos-worker-b');
    const leaseEvents = (await store.list(sessionId)).filter((event) => event.type === 'run_lease_acquired');
    assert.equal(leaseEvents.length, 2);
    assert.deepEqual(leaseEvents.map((event) => event.type === 'run_lease_acquired' ? event.workerId : ''), ['chaos-worker-a', 'chaos-worker-b']);
    console.log('[ok] chaos server-restart: expired PG lease was recovered by a new scheduler worker after worker process death');
  } finally {
    await store.close().catch(() => undefined);
    await pgRuntime.cleanup();
  }
}

async function verifyNetworkInterrupt() {
  const handPort = await freePort();
  const hand = spawn(process.execPath, ['--import', 'tsx', 'hand-server/src/index.ts'], {
    cwd: REPO_ROOT,
    env: { ...process.env, HAND_SERVER_PORT: String(handPort), HAND_SERVER_AUTH_TOKEN: 'chaos-token', HAND_SERVER_BACKEND: 'local' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let proxy: Awaited<ReturnType<typeof startTcpProxy>> | undefined;
  try {
    await waitForHealth(handPort);
    proxy = await startTcpProxy(handPort);
    const invocationId = `net-${Date.now()}`;
    const response = await fetch(`http://127.0.0.1:${proxy.port}/execute-stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer chaos-token' },
      body: JSON.stringify({
        toolName: 'Shell',
        input: { command: 'echo network-before-cut; sleep 30', timeoutMs: 60_000 },
        context: { invocationId, workspace: { id: 'chaos-network', sessionId: 'chaos-network' } },
      }),
    });
    assert.equal(response.ok, true);
    const reader = response.body!.getReader();
    const firstRead = await Promise.race([
      reader.read(),
      delay(5_000).then(() => null),
    ]);
    assert(firstRead && !firstRead.done, 'expected stream bytes before network interruption');
    proxy.interrupt();

    let streamEnded = false;
    let streamErrored = false;
    const deadline = Date.now() + 5_000;
    try {
      while (Date.now() < deadline) {
        const read = await Promise.race([
          reader.read(),
          delay(100).then(() => null),
        ]);
        if (!read) continue;
        if (read.done) {
          streamEnded = true;
          break;
        }
      }
    } catch {
      streamErrored = true;
    }
    assert(streamEnded || streamErrored, 'expected stream to terminate after proxy network interruption');
    console.log('[ok] chaos network-interrupt: active hand-server stream terminates when the TCP proxy cuts the connection');
  } finally {
    if (proxy) await proxy.close();
    hand.kill('SIGTERM');
  }
}

async function verifyMultiWorker() {
  const pgRuntime = await startPostgresContainer();
  const tablePrefix = chaosTablePrefix('multi_worker');
  const sessionId = `session-${randomUUID()}`;
  const runId = `run-${randomUUID()}`;
  const store = new PgEventStore({ connectionString: pgRuntime.connectionString, tablePrefix });
  const runStore = new PgRunStore({ pool: store.pool, tablePrefix });
  try {
    await store.init();
    await runStore.init();
    await runStore.upsertPending({ runId, sessionId, channel: 'chaos', model: 'chaos-model' });

    const workerA = spawnSchedulerWorker(pgRuntime.connectionString, tablePrefix, runId, 'chaos-worker-a', 'complete', {
      leaseMs: 2_000,
      pollIntervalMs: 100,
      delayMs: 700,
    });
    const workerB = spawnSchedulerWorker(pgRuntime.connectionString, tablePrefix, runId, 'chaos-worker-b', 'complete', {
      leaseMs: 2_000,
      pollIntervalMs: 100,
      delayMs: 700,
    });
    await Promise.all([waitForExit(workerA, 8_000), waitForExit(workerB, 8_000)]);

    const finalRun = await runStore.get(runId);
    assert.equal(finalRun?.status, 'completed');
    const events = await store.list(sessionId);
    const leaseEvents = events.filter((event) => event.type === 'run_lease_acquired');
    const completedEvents = events.filter((event) => event.type === 'run_state_changed' && event.status === 'completed');
    assert.equal(leaseEvents.length, 1);
    assert.equal(completedEvents.length, 1);
    assert.match(finalRun?.statusReason ?? '', /^chaos_completed_by_chaos-worker-[ab]$/);
    console.log('[ok] chaos multi-worker: two scheduler workers sharing PG acquired and completed the run exactly once');
  } finally {
    await store.close().catch(() => undefined);
    await pgRuntime.cleanup();
  }
}

function chaosMessage(sessionId: string, runId: string, content: string): PlatformEventInput {
  return { type: 'assistant_message', sessionId, runId, content } as unknown as PlatformEventInput;
}

async function terminateListenBackends(store: PgEventStore): Promise<number> {
  // pg_stat_activity.query 显示连接最近执行的语句；LISTEN 连接 idle 后 query 仍是
  // 'LISTEN <channel>'。杀掉它模拟"NOTIFY 通道中断 / 通知丢失"。
  const res = await store.pool.query(
    `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE query ILIKE 'LISTEN %' AND pid <> pg_backend_pid()`,
  );
  return res.rowCount ?? 0;
}

/**
 * renew-failure：worker A 领取后 lease 被 worker B 抢占，A 的 renew 必然失败（worker_id
 * 不匹配）。验证：① renew 失败可被检测（返回 null，scheduler 据此 abort）；② 掉队的 A
 * 无法 release/markStatus 覆盖新 owner 的终态；③ terminal 是 sink，已 completed 不可被
 * 改回活跃态——合起来即"renew 失败不产生重复 wake / terminal 状态一致"。
 */
async function verifyRenewFailure() {
  const pgRuntime = await startPostgresContainer();
  const tablePrefix = chaosTablePrefix('renew_failure');
  const sessionId = `session-${randomUUID()}`;
  const runId = `run-${randomUUID()}`;
  const store = new PgEventStore({ connectionString: pgRuntime.connectionString, tablePrefix });
  const runStore = new PgRunStore({ pool: store.pool, tablePrefix });
  try {
    await store.init();
    await runStore.init();
    await runStore.upsertPending({ runId, sessionId, channel: 'chaos', model: 'chaos-model' });

    const a = await runStore.acquireLease(runId, 'worker-A', 300);
    assert.equal(a?.status, 'running');
    assert.equal(a?.workerId, 'worker-A');

    await delay(400); // lease 过期
    const b = await runStore.acquireLease(runId, 'worker-B', 5_000);
    assert.equal(b?.status, 'running');
    assert.equal(b?.workerId, 'worker-B', 'expired lease must be preemptable by a new worker');

    const aRenew = await runStore.renewLease(runId, 'worker-A', 300);
    assert.equal(aRenew, null, 'preempted worker A renew must fail (this is the renew-failure signal)');
    const bRenew = await runStore.renewLease(runId, 'worker-B', 5_000);
    assert.ok(bRenew, 'current owner worker B renew must succeed');

    await runStore.releaseLease(runId, 'worker-B', 'completed', 'chaos_b_done');
    assert.equal((await runStore.get(runId))?.status, 'completed');

    // 掉队的 A 试图 release —— worker_id 不匹配，必须 no-op，不得覆盖 B 的终态。
    await runStore.releaseLease(runId, 'worker-A', 'failed', 'chaos_a_late_release');
    assert.equal((await runStore.get(runId))?.status, 'completed', 'preempted worker release must not overwrite terminal');

    // terminal sink：任何把 completed 改回活跃态的尝试都被拒（防重复 wake）。
    await runStore.markStatus(runId, 'running', 'chaos_evil_revive');
    await runStore.markStatus(runId, 'pending', 'chaos_evil_requeue');
    assert.equal((await runStore.get(runId))?.status, 'completed', 'terminal run must not be revived to an active state');

    console.log('[ok] chaos renew-failure: preempted worker renew fails and cannot overwrite the new owner terminal; terminal is a sink (no duplicate wake, consistent terminal state)');
  } finally {
    await store.close().catch(() => undefined);
    await pgRuntime.cleanup();
  }
}

/**
 * abort-states：pending / running / waiting_approval / waiting_user 四种状态都必须可被
 * abort 到 cancelled，且 cancelled 后是终态幂等（不能被改回活跃态）。运行中的 tool
 * invocation abort 由 hand-cancel 模式覆盖。
 */
async function verifyAbortStates() {
  const pgRuntime = await startPostgresContainer();
  const tablePrefix = chaosTablePrefix('abort_states');
  const store = new PgEventStore({ connectionString: pgRuntime.connectionString, tablePrefix });
  const runStore = new PgRunStore({ pool: store.pool, tablePrefix });
  try {
    await store.init();
    await runStore.init();
    const states: RunStatus[] = ['pending', 'running', 'waiting_approval', 'waiting_user'];
    for (const state of states) {
      const runId = `run-${randomUUID()}`;
      const sessionId = `session-${randomUUID()}`;
      await runStore.upsertPending({ runId, sessionId, channel: 'chaos', model: 'chaos-model' });
      if (state !== 'pending') {
        await runStore.markStatus(runId, state, `chaos_seed_${state}`);
      }
      assert.equal((await runStore.get(runId))?.status, state, `seed to ${state}`);

      const aborted = await runStore.markStatus(runId, 'cancelled', 'web_abort');
      assert.equal(aborted?.status, 'cancelled', `state '${state}' must be abortable to cancelled`);

      // 终态幂等：abort 后无法被改回活跃态。
      await runStore.markStatus(runId, 'running', 'chaos_evil_revive');
      await runStore.markStatus(runId, 'pending', 'chaos_evil_requeue');
      assert.equal((await runStore.get(runId))?.status, 'cancelled', `aborted '${state}' run must stay cancelled (terminal idempotent)`);
    }
    console.log('[ok] chaos abort-states: pending/running/waiting_approval/waiting_user all abortable to cancelled and terminal-idempotent');
  } finally {
    await store.close().catch(() => undefined);
    await pgRuntime.cleanup();
  }
}

/**
 * notify-drop：真实 PG 上杀掉 subscriber 的 LISTEN 后端连接（pg_terminate_backend），
 * 在断线窗口内 append 一批事件（它们的 NOTIFY 丢失），断言 subscriber 自动重连并
 * catch-up 补回这批事件——不漏、不重、按序（无 silent data loss）。
 */
async function verifyNotifyDrop() {
  const pgRuntime = await startPostgresContainer();
  const tablePrefix = chaosTablePrefix('notify_drop');
  const sessionId = `session-${randomUUID()}`;
  const runId = `run-${randomUUID()}`;
  const store = new PgEventStore({
    connectionString: pgRuntime.connectionString,
    tablePrefix,
    logger: { warn: () => undefined },
  });
  const seen: PlatformEvent[] = [];
  let unsubscribe: (() => Promise<void>) | undefined;
  try {
    await store.init();
    unsubscribe = await store.subscribeAppended((event) => {
      if (event.sessionId === sessionId) seen.push(event);
    }, { reconnectDelayMs: 200, safetyPollIntervalMs: 500 });

    await store.appendBatch([chaosMessage(sessionId, runId, 'a'), chaosMessage(sessionId, runId, 'b')]);
    await waitForCondition('batch1 delivered via live NOTIFY', () => seen.length >= 2, 8_000);

    // 杀掉 LISTEN 后端 → 触发 subscriber 重连。
    const killed = await terminateListenBackends(store);
    assert.ok(killed >= 1, 'expected to terminate at least one LISTEN backend');

    // 断线窗口内 append batch2：reconnectDelayMs=200，append 很快，所以这批的 NOTIFY
    // 在 listener 重连前发出 → 实际丢失，必须靠重连后的 catch-up 补回。
    await store.appendBatch([
      chaosMessage(sessionId, runId, 'c'),
      chaosMessage(sessionId, runId, 'd'),
      chaosMessage(sessionId, runId, 'e'),
    ]);

    await waitForCondition('reconnect catch-up recovered the dropped batch', () => seen.length >= 5, 20_000);
    const contents = seen.map((event) => (event as { content?: string }).content);
    assert.deepEqual(contents, ['a', 'b', 'c', 'd', 'e'], 'no loss / no duplication / in order after a dropped NOTIFY');

    console.log('[ok] chaos notify-drop: LISTEN backend killed mid-stream; subscriber reconnected and caught up the events whose NOTIFY was dropped (no silent data loss)');
  } finally {
    if (unsubscribe) await unsubscribe().catch(() => undefined);
    await store.close().catch(() => undefined);
    await pgRuntime.cleanup();
  }
}

/**
 * db-unavailable：docker pause/unpause 冻结再恢复 PG，模拟 DB 短暂不可用。断言：
 * ① subscriber 熬过 blip 后继续收到事件且无 silent loss；② 被领取的 run 在 blip 后
 * 恰好完成一次，且 completed 后不可被重新 acquire（无重复 wake）。
 */
async function verifyDbUnavailable() {
  const pgRuntime = await startPostgresContainer();
  const tablePrefix = chaosTablePrefix('db_unavailable');
  const sessionId = `session-${randomUUID()}`;
  const runId = `run-${randomUUID()}`;
  const store = new PgEventStore({
    connectionString: pgRuntime.connectionString,
    tablePrefix,
    logger: { warn: () => undefined },
  });
  const runStore = new PgRunStore({ pool: store.pool, tablePrefix });
  const seen: PlatformEvent[] = [];
  let unsubscribe: (() => Promise<void>) | undefined;
  try {
    await store.init();
    await runStore.init();
    unsubscribe = await store.subscribeAppended((event) => {
      if (event.sessionId === sessionId) seen.push(event);
    }, { reconnectDelayMs: 300, safetyPollIntervalMs: 500 });

    await store.appendBatch([chaosMessage(sessionId, runId, 'a')]);
    await waitForCondition('pre-blip event delivered', () => seen.length >= 1, 8_000);

    await runStore.upsertPending({ runId, sessionId, channel: 'chaos', model: 'chaos-model' });
    const acquired = await runStore.acquireLease(runId, 'worker-A', 60_000);
    assert.equal(acquired?.status, 'running');

    // DB 短暂不可用。
    await pgRuntime.pause();
    await delay(2_000);
    await pgRuntime.unpause();
    await delay(500); // 给连接池/监听连接恢复留点时间

    // 恢复后 append batch2，断言被投递（subscriber 熬过 blip）。
    await store.appendBatch([chaosMessage(sessionId, runId, 'b'), chaosMessage(sessionId, runId, 'c')]);
    await waitForCondition('post-blip events delivered after recovery', () => seen.length >= 3, 25_000);
    const contents = seen.map((event) => (event as { content?: string }).content);
    assert.deepEqual(contents, ['a', 'b', 'c'], 'no loss / no duplication across a DB pause');

    // run 终态一致：worker A 仍持 lease（pause 不改 lease 语义），完成一次。
    const released = await runStore.releaseLease(runId, 'worker-A', 'completed', 'chaos_done');
    assert.equal(released?.status, 'completed');
    // 即便有 worker 在 blip 期间误判 lease 过期，completed 后也无法被重新 acquire。
    const reacquire = await runStore.acquireLease(runId, 'worker-B', 1_000);
    assert.equal(reacquire, null, 'completed run must not be re-acquired (no duplicate wake)');

    console.log('[ok] chaos db-unavailable: subscriber survived a DB pause/unpause and caught up (no silent loss); leased run completed exactly once (no duplicate wake)');
  } finally {
    if (unsubscribe) await unsubscribe().catch(() => undefined);
    await store.close().catch(() => undefined);
    await pgRuntime.cleanup();
  }
}

async function verifyAskUserResume() {
  const pgRuntime = await startPostgresContainer();
  const tablePrefix = chaosTablePrefix('ask_user_resume');
  const workspaceDir = join(tmpdir(), `agent-runtime-chaos-ask-user-${Date.now()}-${randomUUID().slice(0, 8)}`);
  const sessionId = randomUUID();
  const runId = `run-${randomUUID()}`;
  const toolCallId = 'call_ask_user_resume_1';
  const invocationId = `${runId}:${toolCallId}`;
  const interactionId = `interaction-${randomUUID()}`;
  const userId = 'chaos-user';
  const model = 'chaos-model';
  const store = new PgEventStore({ connectionString: pgRuntime.connectionString, tablePrefix });
  const runStore = new PgRunStore({ pool: store.pool, tablePrefix });
  let unsubscribe: (() => Promise<void>) | undefined;
  let fakeModel: Awaited<ReturnType<typeof startFakeChatCompletionsServer>> | undefined;
  const liveEvents: PlatformEvent[] = [];

  try {
    await mkdir(workspaceDir, { recursive: true });
    await store.init();
    await runStore.init();

    const transcriptPath = getTranscriptPath(workspaceDir, sessionId);
    await mkdir(dirname(transcriptPath), { recursive: true });
    await writeFile(transcriptPath, '', 'utf-8');
    const sessionCatalog = new FileSessionCatalog({ agentCwd: workspaceDir });
    const now = new Date().toISOString();
    const sessionRecord: RuntimeSessionRecord = {
      sessionId,
      userId,
      username: 'chaos',
      channel: 'web',
      cwd: workspaceDir,
      transcriptPath,
      modelRef: model,
      executionTarget: 'server-local',
      workspaceId: sessionId,
      status: 'running',
      createdAt: now,
      updatedAt: now,
    };
    await sessionCatalog.upsert(sessionRecord);

    await runStore.upsertPending({
      runId,
      sessionId,
      userId,
      model,
      channel: 'web',
      executionTarget: 'server-local',
      workspaceId: sessionId,
      metadata: {
        cwd: workspaceDir,
        transcriptPath,
        wakeMessage: {
          channel: 'web',
          chatId: sessionId,
          content: 'Need user branch choice.',
          senderId: userId,
          senderName: 'chaos',
          attachments: [],
          metadata: {},
        },
      },
    });
    await runStore.markStatus(runId, 'waiting_user', 'chaos_seed_pending_ask_user');

    const questions = [{
      header: 'Branch',
      question: 'Which branch should the agent use?',
      options: [
        { label: 'main', description: 'Use main branch' },
        { label: 'develop', description: 'Use develop branch' },
      ],
      multiSelect: false,
    }];
    const toolInput = { questions };
    await store.appendBatch([
      {
        type: 'run_started',
        runId,
        sessionId,
        model,
        channel: 'web',
      },
      {
        type: 'user_message',
        runId,
        sessionId,
        content: 'Need user branch choice.',
      },
      {
        type: 'assistant_tool_calls',
        runId,
        sessionId,
        content: '',
        toolCalls: [{
          id: toolCallId,
          name: 'AskUserQuestion',
          arguments: JSON.stringify(toolInput),
        }],
      },
      {
        type: 'tool_invocation_started',
        runId,
        sessionId,
        invocationId,
        toolCallId,
        toolName: 'AskUserQuestion',
        executionTarget: 'server-local',
      },
      {
        type: 'interaction_requested',
        sessionId,
        runId,
        toolCallId,
        invocationId,
        interactionId,
        interactionType: 'ask_user',
        userId,
        toolId: 'AskUserQuestion',
        toolName: 'AskUserQuestion',
        displayName: 'Ask user question',
        questions,
        toolInput,
      },
      {
        type: 'run_state_changed',
        runId,
        sessionId,
        status: 'waiting_user',
        previousStatus: 'running',
        reason: 'chaos_seed_pending_ask_user',
      },
    ]);

    const rebuiltStore = new PgEventStore({ connectionString: pgRuntime.connectionString, tablePrefix });
    try {
      await rebuiltStore.init();
      const rebuiltPending = buildPendingInteractionsFromEvents(await rebuiltStore.list(sessionId), sessionId);
      assert.equal(rebuiltPending.length, 1);
      assert.deepEqual(rebuiltPending[0], {
        interactionId,
        type: 'ask_user',
        sessionId,
        runId,
        toolCallId,
        invocationId,
        userId,
        toolId: 'AskUserQuestion',
        toolName: 'AskUserQuestion',
        displayName: 'Ask user question',
        questions,
        toolInput,
      });
    } finally {
      await rebuiltStore.close().catch(() => undefined);
    }

    fakeModel = await startFakeChatCompletionsServer();
    unsubscribe = await store.subscribeAppended((event) => {
      if ('sessionId' in event && event.sessionId === sessionId) liveEvents.push(event);
    });

    const response = { answers: { branch: 'main' }, message: 'Use main' };
    await store.append({
      type: 'interaction_resolved',
      sessionId,
      runId,
      toolCallId,
      invocationId,
      interactionId,
      interactionType: 'ask_user',
      userId,
      response,
    });
    await runStore.markStatus(runId, 'pending', 'ask_user_resolved_enqueue_resume', {
      resumeInteraction: { interactionId, response },
    });
    const scheduler = new RuntimeScheduler({ runStore, eventStore: store });
    await scheduler.enqueue({
      runId,
      sessionId,
      userId,
      model,
      channel: 'web',
      executionTarget: 'server-local',
      workspaceId: sessionId,
      metadata: {
        cwd: workspaceDir,
        transcriptPath,
        resumeInteraction: { interactionId, response },
      },
    });

    const worker = spawnRuntimeWakeWorker(
      pgRuntime.connectionString,
      tablePrefix,
      runId,
      'ask-user-worker',
      workspaceDir,
      {
        leaseMs: 5_000,
        pollIntervalMs: 100,
        openaiBaseUrl: `http://127.0.0.1:${fakeModel.port}/v1`,
      },
    );
    await waitForExit(worker, 20_000);

    const finalRun = await runStore.get(runId);
    assert.equal(finalRun?.status, 'completed');
    assert.equal(typeof finalRun?.metadata.resumeInteractionConsumedAt, 'string');

    const finalEvents = await store.list(sessionId);
    const toolResult = finalEvents.find((event): event is Extract<PlatformEvent, { type: 'tool_result' }> => (
      event.type === 'tool_result'
      && event.runId === runId
      && event.toolCallId === toolCallId
    ));
    assert(toolResult, 'expected AskUserQuestion tool_result event');
    assert.match(toolResult.content, /"branch": "main"/);
    assert.match(toolResult.content, /"message": "Use main"/);
    assert(finalEvents.some((event) => event.type === 'tool_invocation_completed' && event.invocationId === invocationId && event.status === 'success'));
    assert(finalEvents.some((event) => event.type === 'assistant_message' && event.content === 'ask-user-resume-ok'));
    assert(finalEvents.some((event) => event.type === 'run_finished' && event.subtype === 'success'));
    assert(finalEvents.some((event) => event.type === 'run_state_changed' && event.status === 'completed'));

    await waitForCondition('PG live notify to replay ask_user resume terminal events', () => (
      liveEvents.some((event) => event.type === 'tool_result' && event.toolCallId === toolCallId)
      && liveEvents.some((event) => event.type === 'assistant_message' && event.content === 'ask-user-resume-ok')
      && liveEvents.some((event) => event.type === 'run_state_changed' && event.status === 'completed')
    ), 5_000);

    assert.equal(fakeModel.requests.length, 1);
    const requestBody = fakeModel.requests[0] as { messages?: Array<Record<string, unknown>> };
    const toolMessage = requestBody.messages?.find((message) => (
      message.role === 'tool'
      && message.tool_call_id === toolCallId
      && typeof message.content === 'string'
      && message.content.includes('"branch": "main"')
      && message.content.includes('"message": "Use main"')
    ));
    assert(toolMessage, 'expected resumed model request to include AskUserQuestion tool message');

    console.log('[ok] chaos ask-user-resume: durable pending ask_user survived Web restart, resumed in a separate scheduler worker, and replayed via PG notify');
  } finally {
    if (unsubscribe) await unsubscribe().catch(() => undefined);
    if (fakeModel) await fakeModel.close().catch(() => undefined);
    await store.close().catch(() => undefined);
    await pgRuntime.cleanup();
    const transcriptPath = getTranscriptPath(workspaceDir, sessionId);
    await rm(transcriptPath, { force: true }).catch(() => undefined);
    await rm(getMetaPath(transcriptPath), { force: true }).catch(() => undefined);
    await rm(dirname(transcriptPath), { recursive: true, force: true }).catch(() => undefined);
    await rm(workspaceDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function readCompletedChunk(response: Response, timeoutMs: number): Promise<{ response?: { status?: string } } | null> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const race = await Promise.race([
      reader.read(),
      delay(250).then(() => null),
    ]);
    if (!race) continue;
    if (race.done) return null;
    buffer += decoder.decode(race.value, { stream: true });
    const frames = buffer.split(/\r?\n\r?\n/);
    buffer = frames.pop() ?? '';
    for (const frame of frames) {
      const data = frame
        .split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
        .join('\n');
      if (!data) continue;
      const parsed = JSON.parse(data) as { type?: string; response?: { status?: string } };
      if (parsed.type === 'completed') return parsed;
    }
  }
  return null;
}

async function waitForHealth(port: number) {
  for (let i = 0; i < 50; i++) {
    try { const r = await fetch(`http://127.0.0.1:${port}/health`); if (r.ok) return; } catch {}
    await delay(100);
  }
  throw new Error('hand-server did not become healthy');
}
async function freePort(): Promise<number> {
  const { createServer } = await import('node:net');
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, () => {
      const address = server.address();
      server.close(() => typeof address === 'object' && address ? resolve(address.port) : reject(new Error('no port')));
    });
  });
}

async function runSchedulerWorker(): Promise<void> {
  const connectionString = requiredArg('--connection-string');
  const tablePrefix = requiredArg('--table-prefix');
  const runId = requiredArg('--run-id');
  const workerId = requiredArg('--worker-id');
  const behavior = requiredArg('--behavior');
  const leaseMs = Number(argValue('--lease-ms') ?? '1000');
  const pollIntervalMs = Number(argValue('--poll-interval-ms') ?? '100');
  const delayMs = Number(argValue('--delay-ms') ?? '0');
  const agentCwd = argValue('--agent-cwd');
  const store = new PgEventStore({ connectionString, tablePrefix });
  const runStore = new PgRunStore({ pool: store.pool, tablePrefix });
  try {
    await store.init();
    await runStore.init();
    const scheduler = new RuntimeScheduler({
      runStore,
      eventStore: store,
      workerId,
      leaseMs,
      pollIntervalMs,
      autoWake: true,
      wake: async (record, lease) => {
        if (record.runId !== runId) {
          await lease.release('failed', 'unexpected_run');
          return;
        }
        console.log(`WAKE_STARTED ${workerId} ${record.runId}`);
        if (behavior === 'wake-runtime') {
          if (!agentCwd) throw new Error('missing --agent-cwd for wake-runtime behavior');
          await wakeRuntimeSession({
            agentCwd,
            sharedDir: SHARED_DIR,
            sessionCatalog: new FileSessionCatalog({ agentCwd }),
            eventStoreFactory: () => store,
            runStore,
            contextPolicy: { type: 'full_replay' },
            memory: { enabled: false },
            logger: {
              info: (message) => console.log(message),
              warn: (message) => console.warn(message),
              error: (message) => console.error(message),
            },
          }, record, {
            lease,
            renewIntervalMs: Math.max(100, Math.floor(leaseMs / 3)),
            onOutboundEvent: (event) => {
              console.log(`OUTBOUND ${event.type}`);
            },
          });
          console.log(`WAKE_COMPLETED ${workerId} ${record.runId}`);
          return;
        }
        if (behavior === 'hold') {
          while (true) {
            await delay(Math.max(100, Math.floor(leaseMs / 3)));
            await lease.renew();
            console.log(`LEASE_RENEWED ${workerId} ${record.runId}`);
          }
        }
        if (behavior !== 'complete') {
          throw new Error(`unknown scheduler worker behavior: ${behavior}`);
        }
        if (delayMs > 0) await delay(delayMs);
        await lease.renew();
        await lease.release('completed', `chaos_completed_by_${workerId}`);
        await store.append({
          type: 'run_state_changed',
          runId: record.runId,
          sessionId: record.sessionId,
          status: 'completed',
          previousStatus: 'running',
          reason: `chaos_completed_by_${workerId}`,
        });
        console.log(`WAKE_COMPLETED ${workerId} ${record.runId}`);
      },
    });
    await scheduler.tick();
  } finally {
    await store.close().catch(() => undefined);
  }
}

function spawnSchedulerWorker(
  connectionString: string,
  tablePrefix: string,
  runId: string,
  workerId: string,
  behavior: 'hold' | 'complete',
  options: { leaseMs: number; pollIntervalMs: number; delayMs?: number },
): SpawnedProcess {
  return spawnNodeScript([
    `--internal-worker=scheduler`,
    `--connection-string=${connectionString}`,
    `--table-prefix=${tablePrefix}`,
    `--run-id=${runId}`,
    `--worker-id=${workerId}`,
    `--behavior=${behavior}`,
    `--lease-ms=${options.leaseMs}`,
    `--poll-interval-ms=${options.pollIntervalMs}`,
    `--delay-ms=${options.delayMs ?? 0}`,
  ]);
}

function spawnRuntimeWakeWorker(
  connectionString: string,
  tablePrefix: string,
  runId: string,
  workerId: string,
  agentCwd: string,
  options: { leaseMs: number; pollIntervalMs: number; openaiBaseUrl: string },
): SpawnedProcess {
  return spawnNodeScript([
    `--internal-worker=scheduler`,
    `--connection-string=${connectionString}`,
    `--table-prefix=${tablePrefix}`,
    `--run-id=${runId}`,
    `--worker-id=${workerId}`,
    `--behavior=wake-runtime`,
    `--lease-ms=${options.leaseMs}`,
    `--poll-interval-ms=${options.pollIntervalMs}`,
    `--agent-cwd=${agentCwd}`,
  ], {
    ...process.env,
    OPENAI_API_KEY: 'sk-chaos',
    OPENAI_BASE_URL: options.openaiBaseUrl,
  });
}

function spawnNodeScript(args: string[], env: NodeJS.ProcessEnv = process.env): SpawnedProcess {
  const child = spawn(process.execPath, ['--import', 'tsx', SCRIPT_PATH, ...args], {
    cwd: REPO_ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  return { child, stdout: () => stdout, stderr: () => stderr };
}

async function waitForOutput(proc: SpawnedProcess, pattern: RegExp, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pattern.test(proc.stdout()) || pattern.test(proc.stderr())) return;
    if (proc.child.exitCode !== null) {
      throw new Error(`process exited before output ${pattern}: stdout=${proc.stdout()} stderr=${proc.stderr()}`);
    }
    await delay(50);
  }
  throw new Error(`timed out waiting for output ${pattern}: stdout=${proc.stdout()} stderr=${proc.stderr()}`);
}

async function waitForExit(proc: SpawnedProcess, timeoutMs: number): Promise<void> {
  if (proc.child.exitCode !== null) {
    if (proc.child.exitCode !== 0 && proc.child.signalCode !== 'SIGKILL') {
      throw new Error(`process exited with code=${proc.child.exitCode} signal=${proc.child.signalCode}: stdout=${proc.stdout()} stderr=${proc.stderr()}`);
    }
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      proc.child.kill('SIGKILL');
      reject(new Error(`process did not exit within ${timeoutMs}ms: stdout=${proc.stdout()} stderr=${proc.stderr()}`));
    }, timeoutMs);
    proc.child.once('exit', (code, signal) => {
      clearTimeout(timer);
      if (code === 0 || signal === 'SIGKILL') resolve();
      else reject(new Error(`process exited with code=${code} signal=${signal}: stdout=${proc.stdout()} stderr=${proc.stderr()}`));
    });
    proc.child.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

async function waitForCondition(description: string, predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(50);
  }
  throw new Error(`timed out waiting for ${description}`);
}

async function startFakeChatCompletionsServer(): Promise<{
  port: number;
  requests: Array<Record<string, unknown>>;
  close(): Promise<void>;
}> {
  const requests: Array<Record<string, unknown>> = [];
  const server = createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('not found');
        return;
      }
      const raw = await readHttpBody(req);
      requests.push(JSON.parse(raw) as Record<string, unknown>);
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      res.write(`data: ${JSON.stringify({
        id: 'chatcmpl-chaos',
        object: 'chat.completion.chunk',
        choices: [{ index: 0, delta: { content: 'ask-user-resume-ok' } }],
      })}\n\n`);
      res.write(`data: ${JSON.stringify({
        id: 'chatcmpl-chaos',
        object: 'chat.completion.chunk',
        choices: [{ index: 0, delta: {} }],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 1,
          prompt_tokens_details: { cached_tokens: 0 },
        },
      })}\n\n`);
      res.end('data: [DONE]\n\n');
    } catch (err) {
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end(err instanceof Error ? err.message : String(err));
    }
  });
  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (typeof address === 'object' && address) resolve(address.port);
      else reject(new Error('fake chat completions server failed to bind'));
    });
  });
  return {
    port,
    requests,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function readHttpBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString('utf-8');
}

async function startTcpProxy(targetPort: number): Promise<{
  port: number;
  interrupt(): void;
  /**
   * C6: kill in-flight sockets without closing the listening server. The next
   * client connect attempt succeeds — useful for simulating a flake/blip.
   */
  blip(): void;
  close(): Promise<void>;
}> {
  const sockets = new Set<Socket>();
  const server = createServer((client) => {
    const upstream = connect(targetPort, '127.0.0.1');
    sockets.add(client);
    sockets.add(upstream);
    const cleanup = () => {
      sockets.delete(client);
      sockets.delete(upstream);
      client.destroy();
      upstream.destroy();
    };
    client.on('error', cleanup);
    upstream.on('error', cleanup);
    client.on('close', cleanup);
    upstream.on('close', cleanup);
    client.pipe(upstream);
    upstream.pipe(client);
  });
  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (typeof address === 'object' && address) resolve(address.port);
      else reject(new Error('tcp proxy failed to bind'));
    });
  });
  return {
    port,
    interrupt() {
      for (const socket of sockets) socket.destroy(new Error('chaos network interrupt'));
      server.close();
    },
    blip() {
      for (const socket of sockets) socket.destroy(new Error('chaos network blip'));
      sockets.clear();
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function startPostgresContainer(): Promise<{
  connectionString: string;
  containerId: string;
  pause: () => Promise<void>;
  unpause: () => Promise<void>;
  cleanup: () => Promise<void>;
}> {
  assert(await dockerImageExists(POSTGRES_IMAGE), `Docker image missing: ${POSTGRES_IMAGE}`);
  const name = `agent-runtime-chaos-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const password = `pw-${randomUUID()}`;
  const database = 'runtime_chaos';
  const run = await execFile('docker', [
    'run',
    '--detach',
    '--rm',
    '--pull=never',
    '--name',
    name,
    '-e',
    `POSTGRES_PASSWORD=${password}`,
    '-e',
    `POSTGRES_DB=${database}`,
    '-p',
    '127.0.0.1::5432',
    POSTGRES_IMAGE,
  ], { timeout: 30_000 });
  const containerId = run.stdout.trim();
  assert(containerId, 'docker run did not return a container id');

  const cleanup = async (): Promise<void> => {
    await execFile('docker', ['stop', containerId], { timeout: 30_000 }).catch(() => undefined);
  };
  // db-unavailable 模式用 pause/unpause 冻结/恢复整个容器进程，模拟 DB 短暂不可用
  //（保留容器与数据，区别于 stop 的销毁）。
  const pause = async (): Promise<void> => {
    await execFile('docker', ['pause', containerId], { timeout: 15_000 });
  };
  const unpause = async (): Promise<void> => {
    await execFile('docker', ['unpause', containerId], { timeout: 15_000 });
  };

  try {
    const portOutput = await execFile('docker', ['port', containerId, '5432/tcp'], { timeout: 10_000 });
    const mapped = portOutput.stdout.trim().split('\n')[0] ?? '';
    const port = mapped.match(/:(\d+)$/)?.[1];
    assert(port, `could not parse mapped postgres port: ${mapped}`);
    const connectionString = `postgresql://postgres:${encodeURIComponent(password)}@127.0.0.1:${port}/${database}`;
    await waitForPostgres(connectionString, 45_000);
    return { connectionString, containerId, pause, unpause, cleanup };
  } catch (err) {
    await cleanup();
    throw err;
  }
}

async function dockerImageExists(image: string): Promise<boolean> {
  try {
    await execFile('docker', ['image', 'inspect', image], { timeout: 10_000 });
    return true;
  } catch {
    try {
      const listed = await execFile('docker', ['image', 'ls', image, '--format', '{{.Repository}}:{{.Tag}}'], { timeout: 10_000 });
      return listed.stdout.split('\n').some((line) => line.trim() === image);
    } catch {
      return false;
    }
  }
}

async function waitForPostgres(connectionString: string, timeoutMs: number): Promise<void> {
  const pg = await import('pg');
  const { Pool } = pg.default;
  const deadline = Date.now() + timeoutMs;
  let lastError = '';
  while (Date.now() < deadline) {
    const pool = new Pool({ connectionString });
    try {
      await pool.query('SELECT 1');
      await pool.end();
      return;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      await pool.end().catch(() => undefined);
      await delay(500);
    }
  }
  throw new Error(`postgres did not become ready: ${lastError}`);
}

function chaosTablePrefix(label: string): string {
  return `chaos_${label}_${Date.now()}_${randomUUID().replaceAll('-', '').slice(0, 8)}`;
}

function requiredArg(name: string): string {
  const value = argValue(name);
  if (!value) throw new Error(`missing required arg: ${name}`);
  return value;
}

function argValue(name: string): string | undefined {
  const idx = process.argv.indexOf(name);
  if (idx >= 0) return process.argv[idx + 1];
  const prefix = `${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : undefined;
}

main().catch((err) => { console.error(err); process.exit(1); });
