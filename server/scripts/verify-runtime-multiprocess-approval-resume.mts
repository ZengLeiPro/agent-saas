#!/usr/bin/env tsx
/**
 * 跨进程 approval resume 端到端验收（疑点 5，2026-06-22）
 *
 * 验证用户最高频的"用户切走 / 重连 → 继续审批"链路在 ws-only / scheduler-only
 * 分离拓扑下完整成立：
 *
 *   ws-only 进程接受 chat → durable enqueue → scheduler-only wake fake model
 *   → fake model 返回 Shell tool_call → raw runtime 触发 permission_request
 *   → ws-only 把 permission_request 投递给 user → user 关闭 WS（模拟切走）
 *   → user 重新打开 WS → 发 respond approve → ws-only 写 interaction_resolved
 *   → 原 run 重新置 pending → scheduler-only 通过 approval_resume_wake 接管
 *   → 真跑 Shell（hand-server）→ 第二轮 fake model → final text + done
 *
 * 框架与 verify-runtime-multiprocess-e2e.mts 同源（同一 setup/teardown helpers），
 * 但 chat payload 不传 autoApproveRunShell（让 permission_request 真触发），
 * 且交互链路把"中途 ws 切换 + respond"作为核心 chaos 段。
 *
 * 运行：pnpm -F server verify:multiprocess:approval-resume
 */
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
  const rootDir = await mkdtemp(join(tmpdir(), `agent-saas-approval-resume-`));
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
  let firstWs: WebSocket | undefined;
  let secondWs: WebSocket | undefined;

  try {
    await mkdir(processCwd, { recursive: true });
    const connectionString = await startPostgres(pgName, pgPassword);
    pg = { child: { kill: () => true } as ChildProcessWithoutNullStreams, stdout: () => '', stderr: () => '' };
    fakeModel = createFakeOpenAI();
    await fakeModel.listen(fakeModelPort);

    await writeFixtureConfig({
      rootDir, processCwd, serverPort, handPort, fakeModelPort, handToken, jwtSecret,
      connectionString, tablePrefix,
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

    // —— Phase 1：用户第一次连接 → 发 chat → 等 permission_request ——
    firstWs = await openWs(serverPort, token);
    const clientMsgId = `mp-approval-${randomUUID()}`;
    firstWs.send(JSON.stringify({
      action: 'chat',
      client_msg_id: clientMsgId,
      message: 'Run the multiprocess approval resume probe via remote hand.',
      executionTarget: 'server-remote',
      // 关键：不传 autoApproveRunShell → permission_request 必须触发
    }));

    const phase1 = await collectUntil(
      firstWs,
      (events) => events.some((e) => e.data?.type === 'permission_request'),
      45_000,
    );
    const sessionId = String(phase1.find((e) => e.data?.type === 'session')?.data?.sessionId ?? '');
    const runId = String(phase1.find((e) => e.data?.type === 'stream_id')?.data?.runId ?? '');
    const permission = phase1.find((e) => e.data?.type === 'permission_request')!.data!;
    const interactionId = String(permission.interactionId ?? '');
    const toolName = String(permission.toolName ?? '');
    assert.ok(sessionId, 'expected session id from ws-only enqueue');
    assert.ok(runId, 'expected durable runId from stream_id event');
    assert.ok(interactionId, 'expected interactionId on permission_request');
    assert.equal(toolName, 'Shell', `expected permission for Shell, got ${toolName}`);
    console.log(`[step] phase1: permission_request received sid=${sessionId} runId=${runId} interactionId=${interactionId}`);

    // —— Phase 2：用户"切走" → 关 WS（模拟浏览器关闭 / 网络切换）——
    firstWs.close();
    firstWs = undefined;
    await sleep(1_000);
    console.log('[step] phase2: first WS closed (simulating user switching context)');

    // —— Phase 3：用户重新连接 → resume 看到 active_stream → send respond approve ——
    secondWs = await openWs(serverPort, token);
    secondWs.send(JSON.stringify({
      action: 'resume', sessionId, lastEventId: 0, lastEventCursor: '', skipReplay: false,
    }));

    // 等 resume 收到 active_stream（确认 PG cursor replay 在新 ws 上工作）
    const phase3 = await collectUntil(
      secondWs,
      (events) => events.some((e) => e.data?.type === 'active_stream'),
      15_000,
    );
    assert.ok(
      phase3.some((e) => e.data?.type === 'active_stream' && e.data?.runId === runId),
      'expected reconnect replay to bind active durable run',
    );
    console.log('[step] phase3: second WS resumed, active_stream confirmed');

    // 发 respond approve（runId-first 协议；wave streamId 容错）
    secondWs.send(JSON.stringify({
      action: 'respond',
      sessionId,
      interactionId,
      allow: true,
      message: 'approved by approval-resume probe',
    }));

    // 等 respond_ok（PR 10 即时 ACK）
    await collectUntil(
      secondWs,
      (events) => events.some((e) => e.data?.type === 'respond_ok' && e.data?.interactionId === interactionId),
      10_000,
    );
    console.log('[step] phase3: respond approved, waiting for scheduler-only approval_resume_wake');

    // —— Phase 4：scheduler-only 接管 approval_resume → 真跑 Shell → final done ——
    const phase4 = await collectUntil(
      secondWs,
      (events) => events.some((e) => e.data?.type === 'done'),
      60_000,
    );
    const doneEvents = phase4.filter((e) => e.data?.type === 'done');
    assert.equal(doneEvents.length, 1, `expected exactly one terminal done event after resume, got ${doneEvents.length}`);
    const done = doneEvents[0]!.data!;
    assert.ok(!done.error, `done(error) after approval resume: ${String(done.error)}`);

    // 断言工具真跑了（hand-server local backend 跑 echo APPROVAL_RESUME_OK_*）
    assert.ok(
      phase4.some((e) => e.data?.type === 'tool_result' && String(e.data?.content ?? '').includes('APPROVAL_RESUME_OK_')),
      'expected tool_result after approval resume contains marker',
    );
    // 断言第二轮 fake model 走完（final text）
    assert.ok(
      phase4.some((e) => e.data?.type === 'text' && String(e.data?.content ?? '').includes('APPROVAL_DONE')),
      'expected final assistant text after approval resume',
    );

    // 断言 PG 侧关键指纹：
    //  (1) runtime_runs.status === 'completed'（终态正确）
    //  (2) runtime_events 有 approval_resolved 且 sessionId/interactionId 一致（durable command 落库）
    //  (3) run_state_changed 事件链含 'approval:*' 和 'approval_resolved:*'（PR 10 enqueue-only 投影）
    // 注：approval_resume_wake_started 是 markStatus 的中间瞬态 reason，
    // run_state_changed 由 EventStore.afterAppend hook 从 approval_resolved 派生，
    // 不会带这个内部 reason 字符串；走 user-facing 信号更稳。
    const pgClient = await openAdminPg(connectionString);
    try {
      const runRow = await pgClient.query(
        `SELECT run_id, status FROM ${tablePrefix}_runs WHERE run_id = $1`,
        [runId],
      );
      assert.ok(runRow.rows.length === 1, `expected exactly one run record for ${runId}`);
      assert.equal(String(runRow.rows[0]!.status), 'completed', `expected run.status=completed, got ${runRow.rows[0]!.status}`);

      const resolved = await pgClient.query(
        `SELECT event_json FROM ${tablePrefix}_events
         WHERE session_id = $1 AND event_type = 'approval_resolved'
         ORDER BY session_sequence ASC`,
        [sessionId],
      );
      assert.ok(resolved.rows.length >= 1, `expected at least one approval_resolved event for session ${sessionId}`);
      const resolvedEvent = resolved.rows[0]!.event_json as { approvalId?: string; outcome?: string };
      assert.equal(resolvedEvent.approvalId, interactionId, `approval_resolved.approvalId mismatch: expected ${interactionId}, got ${resolvedEvent.approvalId}`);

      const stateChanges = await pgClient.query(
        `SELECT (event_json->>'reason') AS reason, (event_json->>'status') AS status
         FROM ${tablePrefix}_events
         WHERE session_id = $1 AND event_type = 'run_state_changed'
         ORDER BY session_sequence ASC`,
        [sessionId],
      );
      const reasons = stateChanges.rows.map((r) => String(r.reason ?? ''));
      const statuses = stateChanges.rows.map((r) => String(r.status ?? ''));
      assert.ok(
        reasons.some((r) => r.startsWith('approval:')),
        `expected run_state_changed reason to include approval:* (waiting_approval), got: ${JSON.stringify(reasons)}`,
      );
      assert.ok(
        reasons.some((r) => r.startsWith('approval_resolved:')),
        `expected run_state_changed reason to include approval_resolved:* (resume command), got: ${JSON.stringify(reasons)}`,
      );
      assert.ok(
        statuses.includes('completed'),
        `expected run_state_changed to record terminal completed status, got: ${JSON.stringify(statuses)}`,
      );
    } finally {
      await pgClient.end().catch(() => undefined);
    }

    // fake model 至少被调了 2 次（第一次 tool_call，第二次 final text）
    assert.ok(
      fakeModel.requestCount() >= 2,
      `expected fake model >=2 turns (tool + final), got ${fakeModel.requestCount()}`,
    );

    console.log(`[PASS] multiprocess approval-resume: ws-only enqueue + permission_request + WS switchover + respond + scheduler-only approval_resume_wake + tool_result + final done verified`);
  } finally {
    firstWs?.close();
    secondWs?.close();
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
    runtimeScheduler: { autoWake: true, pollIntervalMs: 200, leaseMs: 8_000, renewIntervalMs: 1_000 },
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
  const marker = `APPROVAL_RESUME_OK_${randomBytes(4).toString('hex')}`;
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
      // 第一轮：发 Shell 工具调用，触发 permission_request
      sendSse(res, {
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              id: `call-${randomUUID()}`,
              type: 'function',
              function: {
                name: 'Shell',
                arguments: JSON.stringify({
                  command: `echo ${marker}`,
                  timeoutMs: 10_000,
                }),
              },
            }],
          },
        }],
      });
      sendSse(res, { choices: [{ delta: {}, finish_reason: 'tool_calls' }] });
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }
    // 第二轮：approval resume 完成后 fake model 看到 tool output → final text
    for (const token of ['APPROVAL_', 'DONE']) {
      await sleep(80);
      sendSse(res, { choices: [{ delta: { content: token } }] });
    }
    sendSse(res, {
      choices: [{ delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
    });
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
    const timer = setTimeout(
      () => reject(new Error(`timed out waiting for websocket events; saw=${JSON.stringify(events.map((e) => e.data?.type))}`)),
      timeoutMs,
    );
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
      reject(new Error(`websocket closed before predicate; saw=${JSON.stringify(events.map((e) => e.data?.type))}`));
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

async function openAdminPg(connectionString: string): Promise<import('pg').Client> {
  const pg = await import('pg');
  const client = new pg.Client({ connectionString });
  await client.connect();
  return client;
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void main().catch((err) => {
    console.error('[FAIL]', err instanceof Error ? err.stack || err.message : String(err));
    process.exit(1);
  });
}
