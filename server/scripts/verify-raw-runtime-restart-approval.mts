/**
 * 真实端到端验收 raw runtime 的持久化审批恢复：
 * Write pending -> 重启 3200 -> reload pending -> approve -> 文件落盘 -> 模型继续。
 *
 * 运行：
 *   pnpm -C /Users/admin/code/product/agent-saas/server exec tsx scripts/verify-raw-runtime-restart-approval.mts
 *   pnpm -C /Users/admin/code/product/agent-saas/server run verify:container-restart-approval -- --model openai-agents/gpt55
 */
import { randomUUID } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';

import jwt from 'jsonwebtoken';
import { parse as parseJsonc } from 'jsonc-parser';
import { WebSocket } from 'ws';

import { EventBackedApprovalStore } from '../src/runtime/approvalStore.js';
import { getTranscriptPath } from '../src/data/transcripts/store.js';
import { FileEventStore, getRuntimeEventLogPath } from '../src/runtime/fileEventStore.js';
import { PgEventStore } from '../src/runtime/pgEventStore.js';
import type { EventStore } from '../src/runtime/types.js';

const execFile = promisify(execFileCb);
const PROJECT_ROOT = resolve(import.meta.dirname, '..', '..');
const SERVER_DIR = join(PROJECT_ROOT, 'server');
const CONFIG_PATH = join(PROJECT_ROOT, 'config.json');
const DEFAULT_BASE_URL = 'http://127.0.0.1:3200';
const SERVICE_LABEL = 'com.agent-saas.server';
const SCREEN_SESSION = 'agent-saas-server';

type Config = {
  agent?: { cwd?: string };
  auth?: { enabled?: boolean; jwtSecret?: string; usersFile?: string };
  models?: { default?: string };
  runtimeEventStore?:
    | { backend?: 'file' }
    | { backend: 'pg'; connectionString: string; tablePrefix?: string };
};

type UserRecord = {
  id: string;
  username: string;
  role: 'admin' | 'user';
  disabled?: boolean;
};

type DownstreamEvent = Record<string, unknown> & { type?: string };
type ScriptExecutionTarget = 'server-local' | 'server-container';

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index >= 0) return process.argv[index + 1];
  const prefix = `${name}=`;
  const match = process.argv.find((arg) => arg.startsWith(prefix));
  return match ? match.slice(prefix.length) : undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function loadConfig(): Config {
  return parseJsonc(readFileSync(CONFIG_PATH, 'utf-8')) as Config;
}

function loadAdminUser(config: Config): UserRecord {
  if (!config.auth?.enabled || !config.auth.jwtSecret) {
    throw new Error('config.auth.enabled/jwtSecret 缺失，无法生成 WS 验收 token。');
  }
  const usersPath = resolve(SERVER_DIR, config.auth.usersFile || './data/users.json');
  const raw = JSON.parse(readFileSync(usersPath, 'utf-8')) as { users?: UserRecord[] };
  const admin = raw.users?.find((user) => user.role === 'admin' && !user.disabled);
  if (!admin) throw new Error(`未找到可用 admin 用户: ${usersPath}`);
  return admin;
}

function signToken(config: Config, user: UserRecord): string {
  return jwt.sign(
    { sub: user.id, username: user.username, role: user.role },
    config.auth!.jwtSecret!,
    { expiresIn: '15m' },
  );
}

function shanghaiDay(): string {
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  return `${get('year')}${get('month')}${get('day')}`;
}

function wsUrl(baseUrl: string, token: string): string {
  const url = new URL(baseUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = '/ws';
  url.search = '';
  url.searchParams.set('token', token);
  return url.toString();
}

class WsProbe {
  private readonly events: DownstreamEvent[] = [];
  private readonly waiters = new Set<{
    predicate: (event: DownstreamEvent) => boolean;
    resolve: (event: DownstreamEvent) => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();

  constructor(readonly ws: WebSocket, private readonly label: string) {
    ws.on('message', (raw) => {
      let event: DownstreamEvent;
      try {
        const parsed = JSON.parse(raw.toString()) as { data?: DownstreamEvent } | DownstreamEvent;
        event = 'data' in parsed && parsed.data ? parsed.data : parsed as DownstreamEvent;
      } catch (err) {
        this.rejectAll(new Error(`${label} 收到非 JSON WS 消息: ${err instanceof Error ? err.message : String(err)}`));
        return;
      }
      this.events.push(event);
      for (const waiter of [...this.waiters]) {
        if (!waiter.predicate(event)) continue;
        clearTimeout(waiter.timer);
        this.waiters.delete(waiter);
        waiter.resolve(event);
      }
    });
    ws.on('error', (err) => this.rejectAll(new Error(`${label} WS error: ${err.message}`)));
  }

  static connect(baseUrl: string, token: string, label: string): Promise<WsProbe> {
    return new Promise((resolveConnect, rejectConnect) => {
      const ws = new WebSocket(wsUrl(baseUrl, token));
      const timer = setTimeout(() => {
        ws.close();
        rejectConnect(new Error(`${label} WS 连接超时`));
      }, 15_000);
      ws.once('open', () => {
        clearTimeout(timer);
        resolveConnect(new WsProbe(ws, label));
      });
      ws.once('error', (err) => {
        clearTimeout(timer);
        rejectConnect(err);
      });
    });
  }

  send(message: object): void {
    this.ws.send(JSON.stringify(message));
  }

  waitFor(
    predicate: (event: DownstreamEvent) => boolean,
    description: string,
    timeoutMs: number,
  ): Promise<DownstreamEvent> {
    const existing = this.events.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolveWait, rejectWait) => {
      const waiter = {
        predicate,
        resolve: resolveWait,
        reject: rejectWait,
        timer: setTimeout(() => {
          this.waiters.delete(waiter);
          rejectWait(new Error(`${this.label} 等待 ${description} 超时。最近事件: ${this.events.slice(-8).map((e) => e.type).join(', ')}`));
        }, timeoutMs),
      };
      this.waiters.add(waiter);
    });
  }

  close(): void {
    this.ws.close();
  }

  private rejectAll(err: Error): void {
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(err);
    }
    this.waiters.clear();
  }
}

async function waitForHealth(baseUrl: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = '';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      const data = await response.json().catch(() => ({})) as { status?: string };
      if (response.ok && data.status === 'ok') return;
      lastError = `HTTP ${response.status}`;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    await sleep(750);
  }
  throw new Error(`等待 3200 health 超时: ${lastError}`);
}

async function fetchPending(baseUrl: string, token: string, sessionId: string): Promise<Array<Record<string, unknown>>> {
  const url = `${baseUrl}/api/chat/interactions/pending?sessionId=${encodeURIComponent(sessionId)}`;
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    throw new Error(`pending API HTTP ${response.status}: ${await response.text()}`);
  }
  return await response.json() as Array<Record<string, unknown>>;
}

async function waitForPending(
  baseUrl: string,
  token: string,
  sessionId: string,
  interactionId: string,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const pending = await fetchPending(baseUrl, token, sessionId);
    const found = pending.find((item) => item.interactionId === interactionId);
    if (found) return found;
    await sleep(750);
  }
  throw new Error(`pending API 未返回 interactionId=${interactionId}`);
}

/**
 * verify 的事件读取后端抽象。
 *
 * Stage 2 把 EventStore 外部化到 PG 后，本脚本不能再假设 runtime 事件落在磁盘
 * *.runtime-events.jsonl —— PG backend 下 jsonl 是空的，老逻辑会误报 fail。
 * 因此按 config.runtimeEventStore.backend 分流：
 *   - file backend：FileEventStore 读 transcriptPath 派生的 .runtime-events.jsonl
 *   - pg   backend：PgEventStore 按 sessionId 读 runtime_events 表
 * 两者都实现 EventStore，list() / EventBackedApprovalStore 语义一致
 * （FileEventStore.list 忽略 sessionId 读整份文件；PgEventStore.list 按 session_id 过滤）。
 */
interface VerifyEventReader {
  approvalStatus(approvalId: string): Promise<string | undefined>;
  listEvents(): Promise<Array<Record<string, unknown>>>;
  close(): Promise<void>;
}

function createEventReader(config: Config, transcriptPath: string, sessionId: string): VerifyEventReader {
  const esConfig = config.runtimeEventStore;
  if (esConfig?.backend === 'pg') {
    const store = new PgEventStore({
      connectionString: esConfig.connectionString,
      tablePrefix: esConfig.tablePrefix,
    });
    let initialized = false;
    const ensureInit = async (): Promise<void> => {
      if (!initialized) {
        await store.init();
        initialized = true;
      }
    };
    return {
      async approvalStatus(approvalId) {
        await ensureInit();
        return (await new EventBackedApprovalStore(store, sessionId).get(approvalId))?.status;
      },
      async listEvents() {
        await ensureInit();
        return (await store.list(sessionId)) as unknown as Array<Record<string, unknown>>;
      },
      async close() {
        if (initialized) await store.close();
      },
    };
  }

  const store: EventStore = new FileEventStore(getRuntimeEventLogPath(transcriptPath));
  return {
    async approvalStatus(approvalId) {
      return (await new EventBackedApprovalStore(store, sessionId).get(approvalId))?.status;
    },
    async listEvents() {
      return (await store.list(sessionId)) as unknown as Array<Record<string, unknown>>;
    },
    async close() {
      // file backend 无持久连接，无需关闭
    },
  };
}

function parseExecutionTarget(): ScriptExecutionTarget {
  const raw = argValue('--execution-target') ?? 'server-local';
  if (raw === 'server-local' || raw === 'server-container') return raw;
  throw new Error(`未知 --execution-target: ${raw}`);
}

async function assertRuntimeAudit(
  reader: VerifyEventReader,
  executionTarget: ScriptExecutionTarget,
): Promise<void> {
  const events = await reader.listEvents();
  const approvalEvent = events.find((event) => event.type === 'approval_requested' && event.toolName === 'Write');
  if (!approvalEvent) {
    throw new Error('runtime 事件流缺少 Write approval_requested（按当前 EventStore backend + sessionId 查询为空）');
  }
  if (approvalEvent.executionTarget !== executionTarget) {
    throw new Error(`approval_requested.executionTarget 不匹配: expected=${executionTarget} actual=${String(approvalEvent.executionTarget)}`);
  }

  const auditEvent = events.find((event) => (
    event.type === 'tool_audit'
    && event.toolName === 'Write'
    && event.status === 'success'
  ));
  if (!auditEvent) {
    throw new Error('runtime 事件流缺少成功 Write tool_audit（按当前 EventStore backend + sessionId 查询为空）');
  }
  if (auditEvent.executionTarget !== executionTarget) {
    throw new Error(`tool_audit.executionTarget 不匹配: expected=${executionTarget} actual=${String(auditEvent.executionTarget)}`);
  }

  if (executionTarget === 'server-container') {
    const invocations = Array.isArray(auditEvent.executionInvocations)
      ? auditEvent.executionInvocations as Array<Record<string, unknown>>
      : [];
    const invocation = invocations.find((item) => item.operation === 'writeFile');
    if (!invocation) {
      throw new Error('server-container tool_audit 缺少 writeFile executionInvocations 明细');
    }
    for (const key of ['image', 'containerName', 'timeoutMs', 'stdoutBytes', 'stderrBytes', 'exitCode', 'signal']) {
      if (!(key in invocation)) {
        throw new Error(`server-container invocation 缺少字段: ${key}`);
      }
    }
    if (invocation.provider !== 'server-container' || invocation.status !== 'success' || invocation.exitCode !== 0) {
      throw new Error(`server-container invocation 状态异常: ${JSON.stringify(invocation)}`);
    }
  }
}

async function isHealthy(baseUrl: string): Promise<boolean> {
  try {
    const response = await fetch(`${baseUrl}/api/health`);
    const data = await response.json().catch(() => ({})) as { status?: string };
    return response.ok && data.status === 'ok';
  } catch {
    return false;
  }
}

async function waitForHealthDown(baseUrl: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!await isHealthy(baseUrl)) return;
    await sleep(500);
  }
  throw new Error('等待旧 3200 进程退出超时');
}

async function screenSessionExists(name: string): Promise<boolean> {
  try {
    const result = await execFile('screen', ['-ls'], { timeout: 10_000 });
    return result.stdout.includes(name);
  } catch (err) {
    const output = err && typeof err === 'object' && 'stdout' in err
      ? String((err as { stdout?: unknown }).stdout ?? '')
      : '';
    return output.includes(name);
  }
}

async function terminateProjectProcessOnBaseUrl(baseUrl: string): Promise<void> {
  const url = new URL(baseUrl);
  const port = url.port || (url.protocol === 'https:' ? '443' : '80');
  const result = await execFile('lsof', ['-nP', `-tiTCP:${port}`, '-sTCP:LISTEN'], { timeout: 10_000 });
  const pids = result.stdout.split(/\s+/).filter(Boolean);
  if (pids.length === 0) throw new Error(`未找到监听端口 ${port} 的进程`);

  for (const pid of pids) {
    const ps = await execFile('ps', ['-p', pid, '-o', 'command='], { timeout: 10_000 });
    if (!ps.stdout.includes(PROJECT_ROOT)) {
      throw new Error(`拒绝终止非本项目进程: pid=${pid} command=${ps.stdout.trim()}`);
    }
  }

  for (const pid of pids) {
    await execFile('kill', ['-TERM', pid], { timeout: 10_000 });
  }
}

async function launchdManagesService(): Promise<boolean> {
  try {
    const result = await execFile('launchctl', ['list', SERVICE_LABEL], { timeout: 10_000 });
    // launchctl list <label> 返回 plist 文本 + PID 行，存在即 launchd 在管
    return result.stdout.includes('"Label"');
  } catch {
    return false;
  }
}

async function restartLaunchdService(baseUrl: string): Promise<boolean> {
  if (!await launchdManagesService()) return false;
  // 不用 `launchctl kickstart -k`——观察到它在 verify 长流程里偶发非 0 exit 但 stderr
  // 空，单独跑又 exit=0，是个 fragile 子命令。改成更简单的契约：SIGTERM 端口 PID
  // （项目路径校验过），launchd KeepAlive 6-13s 内自动拉新进程，等 health 即可。
  console.log(`[step] launchd 接管 ${SERVICE_LABEL}，SIGTERM 端口 PID 触发 KeepAlive 重启`);
  await terminateProjectProcessOnBaseUrl(baseUrl);
  await waitForHealthDown(baseUrl, 30_000);
  await waitForHealth(baseUrl, 60_000);
  return true;
}

async function restartScreenService(baseUrl: string): Promise<void> {
  if (!await screenSessionExists(SCREEN_SESSION)) {
    throw new Error(`未找到 screen session: ${SCREEN_SESSION}`);
  }
  console.log(`[step] 重启 screen session: ${SCREEN_SESSION}`);
  await execFile('screen', ['-S', SCREEN_SESSION, '-X', 'stuff', '\x03'], { timeout: 10_000 });
  try {
    await waitForHealthDown(baseUrl, 10_000);
  } catch {
    console.log('[step] screen Ctrl-C 未让 3200 退出，改用端口 PID + 项目路径校验后 SIGTERM');
    await terminateProjectProcessOnBaseUrl(baseUrl);
    await waitForHealthDown(baseUrl, 30_000);
  }
  for (let i = 0; i < 10 && await screenSessionExists(SCREEN_SESSION); i++) {
    await sleep(500);
  }
  if (await screenSessionExists(SCREEN_SESSION)) {
    await execFile('screen', ['-S', SCREEN_SESSION, '-X', 'quit'], { timeout: 10_000 });
    for (let i = 0; i < 10 && await screenSessionExists(SCREEN_SESSION); i++) {
      await sleep(500);
    }
  }
  await execFile('screen', [
    '-dmS',
    SCREEN_SESSION,
    'bash',
    '-lc',
    `cd ${PROJECT_ROOT} && pnpm -F server start >> logs/server.log 2>> logs/server.error.log`,
  ], { timeout: 10_000 });
  await waitForHealth(baseUrl, 60_000);
}

async function restartServer(baseUrl: string): Promise<void> {
  if (await restartLaunchdService(baseUrl)) return;
  await restartScreenService(baseUrl);
}

async function main(): Promise<void> {
  const baseUrl = argValue('--base-url') ?? DEFAULT_BASE_URL;
  const executionTarget = parseExecutionTarget();
  const config = loadConfig();
  const model = argValue('--model') ?? config.models?.default;
  const admin = loadAdminUser(config);
  const token = signToken(config, admin);
  const workspaceRoot = resolve(config.agent?.cwd || '/Users/admin/workspace-openai-runtime', admin.username);
  const runIdPrefix = executionTarget === 'server-container' ? 'container-restart' : 'raw-restart';
  const runId = `${runIdPrefix}-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const day = shanghaiDay();
  const relativePath = `assets/${day}/${runId}.txt`;
  const expectedContent = `${executionTarget === 'server-container' ? 'SERVER_CONTAINER_RESTART_APPROVAL_OK' : 'RAW_RUNTIME_RESTART_APPROVAL_OK'} ${runId}`;
  const targetPath = join(workspaceRoot, relativePath);
  await rm(targetPath, { force: true });

  await waitForHealth(baseUrl, 20_000);
  console.log(`[step] 连接 WS，发起 Write pending(${executionTarget}): ${relativePath}`);
  const ws1 = await WsProbe.connect(baseUrl, token, 'ws-before-restart');
  ws1.send({
    action: 'chat',
    client_msg_id: runId,
    message: [
      '请严格执行，不要解释，不要先输出正文：',
      `1. 只调用一次 Write 工具，path 精确为 ${relativePath}`,
      `2. content 精确为 ${expectedContent}`,
      `3. 等工具完成后，只回复：写入完成: ${runId}`,
    ].join('\n'),
    executionTarget,
    ...(model ? { model } : {}),
  });

  const sessionEvent = await ws1.waitFor(
    (event) => event.type === 'session' || event.type === 'done' || event.type === 'error',
    'session',
    60_000,
  );
  if (sessionEvent.type !== 'session') {
    throw new Error(`未创建 session，实际事件=${sessionEvent.type} error=${String(sessionEvent.error ?? sessionEvent.message ?? '')}`);
  }
  const sessionId = String(sessionEvent.sessionId ?? '');
  if (!sessionId) throw new Error('未收到有效 sessionId');
  const permissionEvent = await ws1.waitFor(
    (event) => event.type === 'permission_request' || event.type === 'done' || event.type === 'error',
    'permission_request',
    120_000,
  );
  if (permissionEvent.type !== 'permission_request') {
    throw new Error(`模型没有产生 permission_request，实际事件 type=${permissionEvent.type}`);
  }
  const approvalId = String(permissionEvent.interactionId ?? '');
  if (!approvalId) throw new Error('permission_request 缺少 interactionId');
  if (permissionEvent.toolName !== 'Write') {
    throw new Error(`期望 Write permission_request，实际 toolName=${String(permissionEvent.toolName)}`);
  }
  if (existsSync(targetPath)) {
    throw new Error(`审批前文件已经落盘，违反 pending 语义: ${targetPath}`);
  }

  const transcriptPath = getTranscriptPath(workspaceRoot, sessionId);
  const eventReader = createEventReader(config, transcriptPath, sessionId);
  await waitForPending(baseUrl, token, sessionId, approvalId, 15_000);
  const beforeStatus = await eventReader.approvalStatus(approvalId);
  if (beforeStatus !== 'pending') throw new Error(`重启前 approval 状态不是 pending: ${beforeStatus}`);
  console.log(`[step] pending 已持久化: session=${sessionId} approval=${approvalId}`);

  await restartServer(baseUrl);
  ws1.close();

  const afterStatus = await eventReader.approvalStatus(approvalId);
  if (afterStatus !== 'pending') {
    throw new Error(`重启后 approval 状态不是 pending: ${afterStatus}`);
  }
  const reloaded = await waitForPending(baseUrl, token, sessionId, approvalId, 30_000);
  console.log(`[step] 重启后 pending reload 成功: ${JSON.stringify({
    interactionId: reloaded.interactionId,
    toolName: reloaded.toolName,
    displayName: reloaded.displayName,
  })}`);

  console.log('[step] 重新连接 WS，approve pending approval');
  const ws2 = await WsProbe.connect(baseUrl, token, 'ws-after-restart');
  ws2.send({
    action: 'respond',
    sessionId,
    interactionId: approvalId,
    allow: true,
    message: 'approved by restart approval e2e script',
  });

  await ws2.waitFor((event) => event.type === 'respond_ok' && event.interactionId === approvalId, 'respond_ok', 15_000);
  await ws2.waitFor((event) => event.type === 'tool_result' && event.toolName === 'Write', 'Write tool_result', 60_000);
  const done = await ws2.waitFor((event) => event.type === 'done', 'done', 120_000);
  if (done.error) throw new Error(`resume 后 done(error): ${String(done.error)}`);

  const content = await readFile(targetPath, 'utf-8');
  if (content !== expectedContent) {
    throw new Error(`文件内容不匹配: expected=${expectedContent} actual=${content}`);
  }
  const finalStatus = await eventReader.approvalStatus(approvalId);
  if (finalStatus !== 'approved') throw new Error(`approve 后 approval 状态不是 approved: ${finalStatus}`);
  await assertRuntimeAudit(eventReader, executionTarget);
  await eventReader.close();
  ws2.close();

  console.log(`[PASS] raw runtime restart approval e2e passed (${executionTarget})`);
  console.log(JSON.stringify({
    sessionId,
    approvalId,
    transcriptPath,
    targetPath,
    finalStatus,
    executionTarget,
  }, null, 2));
}

main().catch((err) => {
  console.error('[FAIL]', err instanceof Error ? err.stack || err.message : String(err));
  process.exit(1);
});
