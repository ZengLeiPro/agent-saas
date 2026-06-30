#!/usr/bin/env tsx
import assert from 'node:assert/strict';
import { createServer, type ServerResponse } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { execFile as execFileCb, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import bcrypt from 'bcrypt';
import WebSocket from 'ws';

const execFile = promisify(execFileCb);
const require = createRequire(import.meta.url);
const TSX_IMPORT = require.resolve('tsx/esm');
const REPO_ROOT = new URL('../..', import.meta.url).pathname;
const SERVER_ENTRY = new URL('../src/index.ts', import.meta.url).pathname;
const HAND_ENTRY = new URL('../../hand-server/src/index.ts', import.meta.url).pathname;
const POSTGRES_IMAGE = 'postgres:16-alpine';

type Scenario = 'minimal' | 'e2e' | 'notify-drop' | 'db-unavailable' | 'scheduler-restart' | 'hand-kill';

interface SpawnedProcess {
  child: ChildProcessWithoutNullStreams;
  stdout: () => string;
  stderr: () => string;
}

interface WsEnvelope {
  eventId?: number;
  eventCursor?: string;
  data?: Record<string, unknown>;
}

async function main(): Promise<void> {
  const raw = argValue('--scenario') ?? 'e2e';
  if (raw !== 'minimal' && raw !== 'e2e' && raw !== 'notify-drop' && raw !== 'db-unavailable' && raw !== 'scheduler-restart' && raw !== 'hand-kill') {
    throw new Error(`Unknown scenario "${raw}". Expected one of: minimal, e2e, notify-drop, db-unavailable, scheduler-restart, hand-kill`);
  }
  await runScenario(raw);
}

export async function runScenario(scenario: Scenario): Promise<void> {
  const rootDir = await mkdtemp(join(tmpdir(), `agent-saas-mp-${scenario}-`));
  const processCwd = join(rootDir, 'server');
  const pgName = `agent-saas-mp-pg-${randomUUID()}`;
  const pgPassword = `pg-${randomBytes(8).toString('hex')}`;
  const handToken = `hand-${randomBytes(8).toString('hex')}`;
  const jwtSecret = `jwt-${randomBytes(32).toString('hex')}`;
  const serverPort = await freePort();
  const handPort = await freePort();
  const fakeModelPort = await freePort();
  const tablePrefix = `mp_${Date.now().toString(36)}_${randomBytes(3).toString('hex')}`;
  let pg: SpawnedProcess | undefined;
  let fakeModel: ReturnType<typeof createFakeOpenAI> | undefined;
  let hand: SpawnedProcess | undefined;
  let wsServer: SpawnedProcess | undefined;
  let scheduler: SpawnedProcess | undefined;
  let ws: WebSocket | undefined;
  let replayWs: WebSocket | undefined;

  try {
    await mkdir(processCwd, { recursive: true });
    const connectionString = await startPostgres(pgName, pgPassword);
    pg = { child: { kill: () => true } as ChildProcessWithoutNullStreams, stdout: () => '', stderr: () => '' };
    fakeModel = createFakeOpenAI();
    await fakeModel.listen(fakeModelPort);

    await writeFixtureConfig({
      rootDir,
      processCwd,
      serverPort,
      handPort,
      fakeModelPort,
      handToken,
      jwtSecret,
      connectionString,
      tablePrefix,
      // scheduler-restart 用短 lease 加速 lease 过期 → 第二个 worker 接管
      ...(scenario === 'scheduler-restart' ? { leaseMs: 3_000, renewIntervalMs: 1_000 } : {}),
    });

    hand = spawnNodeTs(HAND_ENTRY, {
      cwd: REPO_ROOT,
      env: {
        HAND_SERVER_PORT: String(handPort),
        HAND_SERVER_AUTH_TOKEN: handToken,
        HAND_SERVER_BACKEND: 'local',
        HAND_SERVER_SANDBOX_ROOT: join(rootDir, 'hand-sandbox'),
      },
      label: 'hand',
    });
    await waitForHttp(`http://127.0.0.1:${handPort}/health`, 'hand-server');

    wsServer = spawnNodeTs(SERVER_ENTRY, {
      cwd: processCwd,
      env: {
        AGENT_SAAS_PROCESS_ROLE: 'ws-only',
        PORT: String(serverPort),
        OPENAI_API_KEY: 'fake-key',
        OPENAI_BASE_URL: `http://127.0.0.1:${fakeModelPort}/v1`,
        OPENAI_MODEL: 'fake-chat-model',
      },
      label: 'ws',
    });
    await waitForHttp(`http://127.0.0.1:${serverPort}/api/health`, 'ws-only server');

    scheduler = spawnNodeTs(SERVER_ENTRY, {
      cwd: processCwd,
      env: {
        AGENT_SAAS_PROCESS_ROLE: 'scheduler-only',
        OPENAI_API_KEY: 'fake-key',
        OPENAI_BASE_URL: `http://127.0.0.1:${fakeModelPort}/v1`,
        OPENAI_MODEL: 'fake-chat-model',
      },
      label: 'sched',
    });
    await waitForLog(scheduler, /RuntimeScheduler started: autoWake=true/, 'scheduler worker start');

    const token = await login(serverPort);
    ws = await openWs(serverPort, token);
    const clientMsgId = `mp-${scenario}-${randomUUID()}`;
    ws.send(JSON.stringify({
      action: 'chat',
      client_msg_id: clientMsgId,
      message: 'Run the multiprocess smoke command using the remote hand, then summarize.',
      executionTarget: 'server-remote',
      approvalPolicy: { autoApproveRunShell: true },
    }));

    const first = await collectUntil(ws, (events) => events.some((e) => e.data?.type === 'session'), 10_000);
    const sessionId = String(first.find((e) => e.data?.type === 'session')?.data?.sessionId ?? '');
    const runId = String(first.find((e) => e.data?.type === 'stream_id')?.data?.runId ?? '');
    assert.ok(sessionId, 'expected session id from ws-only process');
    assert.ok(runId, 'expected run id from durable enqueue');

    if (scenario === 'e2e') {
      // Reconnect while the scheduler-only process is still executing the remote hand.
      ws.close();
      ws = undefined;
      replayWs = await openWs(serverPort, token);
      replayWs.send(JSON.stringify({ action: 'resume', sessionId, lastEventId: 0, lastEventCursor: '', skipReplay: false }));
      const replayActive = await collectUntil(replayWs, (events) => events.some((e) => e.data?.type === 'active_stream' && e.data?.active === true), 10_000);
      assert.ok(replayActive.some((e) => e.data?.type === 'active_stream' && e.data?.runId === runId), 'expected reconnect replay to bind active durable run');
      const replayDone = await collectUntil(replayWs, (events) => events.some((e) => e.data?.type === 'done'), 30_000);
      assert.ok(replayDone.some((e) => e.data?.type === 'tool_result' && String(e.data?.content ?? '').includes('MP_E2E_')), 'expected replay/live tool output from remote hand');
      assert.ok(replayDone.some((e) => e.data?.type === 'text' && String(e.data?.content ?? '').includes('MULTIPROCESS_DONE')), 'expected final assistant text replayed through PG bridge');
    } else if (scenario === 'notify-drop' || scenario === 'db-unavailable') {
      // Chaos 场景：用一条 long-lived listener 累积事件，避免 collectUntil 切换间隙
      // 丢失（EventEmitter 同步派发，gap 期间 message 被丢弃）。第一次看到 tool_input
      // 时立即触发 chaos：notify-drop 杀 ws 进程的 PG LISTEN backend；db-unavailable
      // docker pause/unpause PG 2s。随后等 done，断言完整 tool_result + final text 仍
      // 到达，且终态 done 只发一次（无重复 wake）。
      const events: WsEnvelope[] = [...first];
      let chaosTriggered = false;
      const runChaos = async (): Promise<void> => {
        if (scenario === 'notify-drop') {
          const killed = await terminateListenBackends(connectionString);
          assert.ok(killed >= 1, `expected to terminate at least one LISTEN backend, got ${killed}`);
          console.log(`[chaos] notify-drop: terminated ${killed} LISTEN backend(s) on ws-only process while run is active`);
        } else {
          console.log('[chaos] db-unavailable: pausing PG container for 2s mid-run');
          await execFile('docker', ['pause', pgName], { timeout: 15_000 });
          await sleep(2_000);
          await execFile('docker', ['unpause', pgName], { timeout: 15_000 });
          console.log('[chaos] db-unavailable: PG container unpaused; waiting for run to complete');
        }
      };
      await new Promise<void>((resolve, reject) => {
        const timeoutMs = scenario === 'db-unavailable' ? 60_000 : 45_000;
        const timer = setTimeout(
          () => reject(new Error(`chaos ${scenario} timed out; saw=${JSON.stringify(events.map((e) => e.data?.type))}`)),
          timeoutMs,
        );
        const onMessage = (raw: WebSocket.RawData) => {
          let parsed: WsEnvelope;
          try { parsed = JSON.parse(raw.toString()) as WsEnvelope; } catch { return; }
          events.push(parsed);
          if (!chaosTriggered && parsed.data?.type === 'tool_input') {
            chaosTriggered = true;
            runChaos().catch((err) => {
              clearTimeout(timer);
              ws!.off('message', onMessage);
              reject(err);
            });
          }
          if (parsed.data?.type === 'done') {
            clearTimeout(timer);
            ws!.off('message', onMessage);
            resolve();
          }
        };
        ws!.on('message', onMessage);
        ws!.once('close', () => {
          clearTimeout(timer);
          reject(new Error(`ws closed before chaos done; saw=${JSON.stringify(events.map((e) => e.data?.type))}`));
        });
      });
      assert.ok(chaosTriggered, `expected chaos to have been triggered by tool_input; saw=${JSON.stringify(events.map((e) => e.data?.type))}`);
      assert.ok(events.some((e) => e.data?.type === 'tool_result' && String(e.data?.content ?? '').includes('MP_E2E_')), `expected tool_result to survive ${scenario}`);
      assert.ok(events.some((e) => e.data?.type === 'text' && String(e.data?.content ?? '').includes('MULTIPROCESS_DONE')), `expected final assistant text to survive ${scenario}`);
      const doneEvents = events.filter((e) => e.data?.type === 'done');
      assert.equal(doneEvents.length, 1, `expected exactly one terminal done event (no duplicate wake), got ${doneEvents.length}`);
    } else if (scenario === 'scheduler-restart' || scenario === 'hand-kill') {
      // scheduler-restart：active wake 期间 SIGKILL scheduler-only A，等 lease 过期后
      // spawn 第二个 scheduler-only B；断言 lease 接管后 run 收敛到唯一 terminal done
      //（terminal-sink 守卫阻止重复完成，scheduler.stop drain + lease expiry 保证幂等）。
      // hand-kill：active tool 期间 SIGKILL hand-server；断言 ws 客户端收到唯一终态
      // done/error，scheduler 不卡 lease，run 不悬挂。
      // 这两个场景的中间状态（tool_result / final text）可能丢失，但终态契约必须成立。
      const events: WsEnvelope[] = [...first];
      let chaosTriggered = false;
      const runChaos = async (): Promise<void> => {
        if (scenario === 'scheduler-restart') {
          console.log('[chaos] scheduler-restart: SIGKILL scheduler-only A mid-wake');
          scheduler!.child.kill('SIGKILL');
          scheduler = undefined; // 让 finally 不重复 kill
          // 等 lease (3s) 过期 + 缓冲
          await sleep(4_500);
          console.log('[chaos] scheduler-restart: spawning scheduler-only B');
          scheduler = spawnNodeTs(SERVER_ENTRY, {
            cwd: processCwd,
            env: {
              AGENT_SAAS_PROCESS_ROLE: 'scheduler-only',
              OPENAI_API_KEY: 'fake-key',
              OPENAI_BASE_URL: `http://127.0.0.1:${fakeModelPort}/v1`,
              OPENAI_MODEL: 'fake-chat-model',
            },
            label: 'sched2',
          });
          await waitForLog(scheduler, /RuntimeScheduler started: autoWake=true/, 'scheduler-only B start');
          console.log('[chaos] scheduler-restart: B started, expecting lease takeover');
        } else {
          console.log('[chaos] hand-kill: SIGKILL hand-server during active tool stream');
          hand!.child.kill('SIGKILL');
          hand = undefined; // 让 finally 不重复 kill
        }
      };
      await new Promise<void>((resolve, reject) => {
        const timeoutMs = scenario === 'scheduler-restart' ? 90_000 : 60_000;
        const timer = setTimeout(
          () => reject(new Error(`chaos ${scenario} timed out; saw=${JSON.stringify(events.map((e) => e.data?.type))}`)),
          timeoutMs,
        );
        const onMessage = (raw: WebSocket.RawData) => {
          let parsed: WsEnvelope;
          try { parsed = JSON.parse(raw.toString()) as WsEnvelope; } catch { return; }
          events.push(parsed);
          if (!chaosTriggered && parsed.data?.type === 'tool_input') {
            chaosTriggered = true;
            runChaos().catch((err) => {
              clearTimeout(timer);
              ws!.off('message', onMessage);
              reject(err);
            });
          }
          if (parsed.data?.type === 'done') {
            clearTimeout(timer);
            ws!.off('message', onMessage);
            resolve();
          }
        };
        ws!.on('message', onMessage);
        ws!.once('close', () => {
          clearTimeout(timer);
          reject(new Error(`ws closed before chaos done; saw=${JSON.stringify(events.map((e) => e.data?.type))}`));
        });
      });
      assert.ok(chaosTriggered, `expected chaos to have been triggered by tool_input; saw=${JSON.stringify(events.map((e) => e.data?.type))}`);
      const doneEvents = events.filter((e) => e.data?.type === 'done');
      assert.equal(doneEvents.length, 1, `expected exactly one terminal done event (terminal-sink guard / no double-wake), got ${doneEvents.length}`);
      console.log(`[chaos] ${scenario}: events=${JSON.stringify(events.map((e) => e.data?.type))}`);
    } else {
      const done = await collectUntil(ws, (events) => events.some((e) => e.data?.type === 'done'), 30_000);
      assert.ok(done.some((e) => e.data?.type === 'tool_result' && String(e.data?.content ?? '').includes('MP_E2E_')), 'expected live tool output from remote hand');
      assert.ok(done.some((e) => e.data?.type === 'text' && String(e.data?.content ?? '').includes('MULTIPROCESS_DONE')), 'expected final assistant text');
    }

    // hand-kill / scheduler-restart 不强制要求 fake model 调 2 轮（tool error 仍走第二轮，
    // 但若 scheduler-restart B 接管时直接走 ToolInvocationRecovery 截断也可能只 1 轮）。
    if (scenario !== 'scheduler-restart' && scenario !== 'hand-kill') {
      assert.ok(fakeModel.requestCount() >= 2, 'expected fake model to handle tool turn and final turn');
    }
    console.log(`[PASS] runtime multiprocess ${scenario}: ws-only enqueue + scheduler-only wake + hand-server + PG live/replay/done verified`);
  } finally {
    ws?.close();
    replayWs?.close();
    for (const proc of [scheduler, wsServer, hand]) await stopProcess(proc);
    await fakeModel?.close();
    await execFile('docker', ['rm', '-f', pgName]).catch(() => undefined);
    await rm(rootDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function writeFixtureConfig(input: {
  rootDir: string;
  processCwd: string;
  serverPort: number;
  handPort: number;
  fakeModelPort: number;
  handToken: string;
  jwtSecret: string;
  connectionString: string;
  tablePrefix: string;
  leaseMs?: number;
  renewIntervalMs?: number;
}): Promise<void> {
  await mkdir(join(input.processCwd, 'data'), { recursive: true });
  await writeFile(join(input.processCwd, 'data', 'users.json'), JSON.stringify({
    version: 1,
    users: [{
      id: 'mp-admin-id',
      username: 'admin',
      passwordHash: await bcrypt.hash('admin-pass', 10),
      role: 'admin',
      tenantId: 'kaiyan',
      createdAt: new Date().toISOString(),
      createdBy: 'fixture',
      updatedAt: new Date().toISOString(),
    }],
  }, null, 2));
  await writeFile(join(input.rootDir, 'config.json'), JSON.stringify({
    agent: {
      cwd: './workspace',
      // 指向 repo 真实 workspace-shared/，避免每个 tmp cwd 都要拷模板
      // （与 runtimeStage2.test.ts 同样做法）
      sharedDir: join(REPO_ROOT, 'workspace-shared'),
      permissionMode: 'dontAsk',
      maxTurns: 4,
    },
    server: { port: input.serverPort, timezone: 'UTC' },
    cron: { enabled: false },
    auth: {
      enabled: true,
      jwtSecret: input.jwtSecret,
      usersFile: './data/users.json',
      tokenExpiresIn: '1h',
    },
    observability: { logging: { level: 'info', timestamp: false, colorEnabled: false } },
    memory: { enabled: false },
    runtimeEventStore: {
      backend: 'pg',
      connectionString: input.connectionString,
      tablePrefix: input.tablePrefix,
    },
    runtimeScheduler: { autoWake: true, pollIntervalMs: 200, leaseMs: input.leaseMs ?? 8_000, renewIntervalMs: input.renewIntervalMs ?? 1_000 },
    runtimeHandHealthScanner: { enabled: false },
    serverRemote: {
      baseUrl: `http://127.0.0.1:${input.handPort}`,
      authToken: input.handToken,
      invokeTimeoutMs: 20_000,
    },
  }, null, 2));
}

function createFakeOpenAI() {
  let count = 0;
  const server = createServer(async (req, res) => {
    if (req.method !== 'POST' || !req.url?.endsWith('/chat/completions')) {
      res.writeHead(404).end('not found');
      return;
    }
    count += 1;
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw || '{}') as { messages?: Array<{ role?: string }> };
    const hasToolOutput = body.messages?.some((m) => m.role === 'tool') ?? false;
    writeSseHeaders(res);
    if (!hasToolOutput) {
      sendSse(res, {
        choices: [{ delta: { tool_calls: [{ index: 0, id: `call-${randomUUID()}`, type: 'function', function: { name: 'Shell', arguments: JSON.stringify({ command: 'for i in 1 2 3; do echo MP_E2E_$i; sleep 1; done', timeoutMs: 15_000 }) } }] } }],
      });
      sendSse(res, { choices: [{ delta: {}, finish_reason: 'tool_calls' }] });
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }
    for (const token of ['MULTIPROCESS_', 'DONE']) {
      await sleep(80);
      sendSse(res, { choices: [{ delta: { content: token } }] });
    }
    sendSse(res, { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } });
    res.write('data: [DONE]\n\n');
    res.end();
  });
  return {
    listen: (port: number) => new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve)),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    requestCount: () => count,
  };
}

function writeSseHeaders(res: ServerResponse): void {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
}

function sendSse(res: ServerResponse, data: unknown): void {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

async function login(port: number): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin-pass' }),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`login failed: ${res.status} ${errText}`);
  }
  const body = await res.json() as { token?: string };
  assert.ok(body.token, 'login response should include token');
  return body.token;
}

async function openWs(port: number, token: string): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${encodeURIComponent(token)}`);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('ws open timeout')), 5_000);
    ws.once('open', () => { clearTimeout(timer); resolve(); });
    ws.once('error', reject);
  });
  return ws;
}

async function collectUntil(ws: WebSocket, predicate: (events: WsEnvelope[]) => boolean, timeoutMs: number): Promise<WsEnvelope[]> {
  const events: WsEnvelope[] = [];
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for websocket events; saw=${JSON.stringify(events.map((e) => e.data))}`)), timeoutMs);
    const onMessage = (raw: WebSocket.RawData) => {
      const parsed = JSON.parse(raw.toString()) as WsEnvelope;
      events.push(parsed);
      if (predicate(events)) {
        clearTimeout(timer);
        ws.off('message', onMessage);
        resolve(events);
      }
    };
    ws.on('message', onMessage);
    ws.once('close', () => {
      clearTimeout(timer);
      reject(new Error(`websocket closed before predicate; saw=${JSON.stringify(events.map((e) => e.data))}`));
    });
  });
}

function spawnNodeTs(entry: string, opts: { cwd: string; env: Record<string, string>; label: string }): SpawnedProcess {
  const child = spawn(process.execPath, ['--import', TSX_IMPORT, entry], {
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); process.stderr.write(`[${opts.label}] ${chunk}`); });
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); process.stderr.write(`[${opts.label}!] ${chunk}`); });
  return { child, stdout: () => stdout, stderr: () => stderr };
}

async function stopProcess(proc?: SpawnedProcess): Promise<void> {
  if (!proc || proc.child.killed) return;
  proc.child.kill('SIGTERM');
  await sleep(500);
  if (!proc.child.killed) proc.child.kill('SIGKILL');
}

/**
 * Connect to PG with a one-off admin client and terminate every backend that is
 * sitting on a `LISTEN <channel>` query. The ws-only process subscribes via
 * `pgEventStore.subscribeAppended` which holds a dedicated LISTEN connection;
 * killing it from outside simulates the "PG NOTIFY delivery interrupted" failure
 * mode. Used by the `notify-drop` chaos scenario.
 */
async function terminateListenBackends(connectionString: string): Promise<number> {
  const pg = await import('pg');
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    const res = await client.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE query ILIKE 'LISTEN %' AND pid <> pg_backend_pid()`,
    );
    return res.rowCount ?? 0;
  } finally {
    await client.end().catch(() => undefined);
  }
}

async function startPostgres(name: string, password: string): Promise<string> {
  await execFile('docker', ['run', '--rm', '--pull=never', '--name', name, '-e', `POSTGRES_PASSWORD=${password}`, '-e', 'POSTGRES_DB=agent_runtime', '-p', '127.0.0.1::5432', '-d', POSTGRES_IMAGE]);
  const { stdout } = await execFile('docker', ['port', name, '5432/tcp']);
  const match = stdout.match(/127\.0\.0\.1:(\d+)/) ?? stdout.match(/0\.0\.0\.0:(\d+)/);
  assert.ok(match?.[1], `could not parse mapped postgres port: ${stdout}`);
  const port = Number(match[1]);
  const connectionString = `postgresql://postgres:${encodeURIComponent(password)}@127.0.0.1:${port}/agent_runtime`;
  for (let i = 0; i < 80; i++) {
    try {
      const pg = await import('pg');
      const client = new pg.Client({ connectionString });
      await client.connect();
      await client.query('select 1');
      await client.end();
      return connectionString;
    } catch {
      await sleep(250);
    }
  }
  throw new Error('postgres did not become ready');
}

async function waitForHttp(url: string, label: string): Promise<void> {
  for (let i = 0; i < 80; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {}
    await sleep(250);
  }
  throw new Error(`${label} did not become healthy at ${url}`);
}

async function waitForLog(proc: SpawnedProcess, pattern: RegExp, label: string): Promise<void> {
  for (let i = 0; i < 80; i++) {
    if (pattern.test(proc.stdout()) || pattern.test(proc.stderr())) return;
    await sleep(250);
  }
  throw new Error(`${label} log timeout; stdout=${proc.stdout()} stderr=${proc.stderr()}`);
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

function argValue(name: string): string | undefined {
  const prefix = `${name}=`;
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void main().catch((err) => {
    console.error('[FAIL]', err instanceof Error ? err.stack || err.message : String(err));
    process.exit(1);
  });
}
