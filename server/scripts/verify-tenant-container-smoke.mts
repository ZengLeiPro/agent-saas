/**
 * 多组织端到端 server-container 隔离验收脚本
 *
 * 验证 A+C execution routing 真实生效：非平台用户（组织 admin / 普通 user）
 * 通过 WS 触发 Shell 时，默认被 routing 到 server-container 路径，
 * 子进程真实落在 Docker 容器内（cwd=/workspace + 非宿主 uid），
 * 且组织用户无权 override 到 server-local（chat_rejected access_denied）。
 *
 * 06-21 端到端测试只验证了"止血版 platform-admin-only"（wain_admin 直接 throw）；
 * 本脚本补 A+C 落地后的真实端到端覆盖（疑点 1）。
 *
 * 前置：launchd com.agent-saas.server 跑在 3200（PG backend，wain-test 组织与
 *       wain_admin/wain_user 用户已建好）；本机 Docker daemon 可用。
 *
 * 运行：
 *   pnpm -F server verify:tenant-container-smoke               # 默认跑 wain_admin
 *   pnpm -F server verify:tenant-container-smoke -- --user wain_user
 *   pnpm -F server verify:tenant-container-smoke -- --case negative-server-local
 */
import { randomUUID } from 'node:crypto';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import jwt from 'jsonwebtoken';
import { parse as parseJsonc } from 'jsonc-parser';
import pg from 'pg';
import { WebSocket } from 'ws';

const PROJECT_ROOT = resolve(import.meta.dirname, '..', '..');
const SERVER_DIR = join(PROJECT_ROOT, 'server');
const CONFIG_PATH = join(PROJECT_ROOT, 'config.json');
const DEFAULT_BASE_URL = 'http://127.0.0.1:3200';

type Config = {
  models?: { default?: string };
  auth?: { enabled?: boolean; jwtSecret?: string; usersFile?: string };
  runtimeEventStore?: { connectionString?: string; tablePrefix?: string };
};

type UserRecord = {
  id: string;
  username: string;
  role: 'admin' | 'user';
  tenantId?: string;
  disabled?: boolean;
};

type DownstreamEvent = Record<string, unknown> & { type?: string };

function argValue(name: string): string | undefined {
  const idx = process.argv.indexOf(name);
  if (idx >= 0) return process.argv[idx + 1];
  const prefix = `${name}=`;
  const match = process.argv.find((a) => a.startsWith(prefix));
  return match ? match.slice(prefix.length) : undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function loadConfig(): Config {
  return parseJsonc(readFileSync(CONFIG_PATH, 'utf-8')) as Config;
}

function loadUser(config: Config, username: string): UserRecord {
  if (!config.auth?.enabled || !config.auth.jwtSecret) {
    throw new Error('config.auth.enabled/jwtSecret 缺失');
  }
  const usersPath = resolve(SERVER_DIR, config.auth.usersFile || './data/users.json');
  const raw = JSON.parse(readFileSync(usersPath, 'utf-8')) as { users?: UserRecord[] };
  const user = raw.users?.find((u) => u.username === username && !u.disabled);
  if (!user) throw new Error(`未找到用户 ${username}（${usersPath}）`);
  if (!user.tenantId) throw new Error(`用户 ${username} 缺少 tenantId（请确认 PR 2 migration 已跑过）`);
  return user;
}

function signToken(config: Config, user: UserRecord): string {
  return jwt.sign(
    { sub: user.id, username: user.username, role: user.role, tenantId: user.tenantId },
    config.auth!.jwtSecret!,
    { expiresIn: '15m' },
  );
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
        event = 'data' in parsed && parsed.data ? (parsed.data as DownstreamEvent) : (parsed as DownstreamEvent);
      } catch (err) {
        this.rejectAll(new Error(`${this.label} WS 非 JSON: ${err instanceof Error ? err.message : String(err)}`));
        return;
      }
      this.events.push(event);
      for (const w of [...this.waiters]) {
        if (!w.predicate(event)) continue;
        clearTimeout(w.timer);
        this.waiters.delete(w);
        w.resolve(event);
      }
    });
    ws.on('error', (err) => this.rejectAll(new Error(`${this.label} WS error: ${err.message}`)));
  }

  static connect(baseUrl: string, token: string, label: string): Promise<WsProbe> {
    return new Promise((resolveConnect, rejectConnect) => {
      const ws = new WebSocket(wsUrl(baseUrl, token));
      const timer = setTimeout(() => {
        ws.close();
        rejectConnect(new Error(`${label} WS 连接超时`));
      }, 15_000);
      ws.once('open', () => { clearTimeout(timer); resolveConnect(new WsProbe(ws, label)); });
      ws.once('error', (err) => { clearTimeout(timer); rejectConnect(err); });
    });
  }

  send(message: object): void {
    this.ws.send(JSON.stringify(message));
  }

  waitFor(predicate: (e: DownstreamEvent) => boolean, description: string, timeoutMs: number): Promise<DownstreamEvent> {
    const existing = this.events.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolveWait, rejectWait) => {
      const w = {
        predicate, resolve: resolveWait, reject: rejectWait,
        timer: setTimeout(() => {
          this.waiters.delete(w);
          rejectWait(new Error(
            `${this.label} 等待 ${description} 超时。最近事件: ${this.events.slice(-8).map((e) => e.type).join(', ')}`,
          ));
        }, timeoutMs),
      };
      this.waiters.add(w);
    });
  }

  close(): void { this.ws.close(); }

  private rejectAll(err: Error): void {
    for (const w of this.waiters) { clearTimeout(w.timer); w.reject(err); }
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
  throw new Error(`等待 health 超时: ${lastError}`);
}

function assertDockerAvailable(): void {
  try {
    execSync('docker info', { stdio: 'ignore', timeout: 5000 });
  } catch (err) {
    throw new Error(`本机 Docker daemon 不可用（A+C 路径要求）: ${err instanceof Error ? err.message : String(err)}`);
  }
}

type ToolInvocationMetadataCheck = {
  autoRoutedHandId?: string;
  handId?: string;
};

async function assertAcsToolInvocationMetadata(
  config: Config,
  user: UserRecord,
  sessionId: string,
): Promise<ToolInvocationMetadataCheck | undefined> {
  const connectionString = config.runtimeEventStore?.connectionString;
  if (!connectionString) {
    console.warn('[warn] runtimeEventStore.connectionString 缺失，跳过 ACS hand metadata 断言');
    return undefined;
  }

  const prefix = config.runtimeEventStore?.tablePrefix ?? 'runtime';
  const pool = new pg.Pool({ connectionString });
  try {
    let rows: Array<{
      tenant_id: string;
      status: string;
      auto_routed_hand_id: string | null;
      hand_id: string | null;
    }> = [];
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const result = await pool.query(
        `SELECT tenant_id, status, metadata->>'autoRoutedHandId' AS auto_routed_hand_id, metadata->>'handId' AS hand_id
         FROM ${prefix}_tool_invocations
         WHERE session_id=$1 AND tool_name='Shell'
         ORDER BY started_at DESC
         LIMIT 5`,
        [sessionId],
      );
      rows = result.rows;
      if (rows.length > 0) break;
      await sleep(500);
    }

    if (rows.length === 0) {
      throw new Error(`PG 未找到 session=${sessionId} 的 Shell durable tool invocation`);
    }
    const wrongTenant = rows.find((row) => row.tenant_id !== user.tenantId);
    if (wrongTenant) {
      throw new Error(`Shell invocation tenant 错误：期望 ${user.tenantId}，实际 ${wrongTenant.tenant_id}`);
    }
    const acsRow = rows.find((row) => {
      const routedHand = row.auto_routed_hand_id ?? row.hand_id ?? '';
      return routedHand.endsWith(':agent-saas-acs');
    });
    if (!acsRow) {
      throw new Error(`Shell invocation 未落 ACS hand。最近记录: ${JSON.stringify(rows)}`);
    }
    return {
      ...(acsRow.auto_routed_hand_id ? { autoRoutedHandId: acsRow.auto_routed_hand_id } : {}),
      ...(acsRow.hand_id ? { handId: acsRow.hand_id } : {}),
    };
  } finally {
    await pool.end();
  }
}

/** 正向 case：wain_admin/wain_user 不指定 executionTarget，期望自动落到 server-container */
async function runPositiveCase(baseUrl: string, config: Config, username: string): Promise<void> {
  const user = loadUser(config, username);
  const token = signToken(config, user);
  const runMarker = `TENANT_CONTAINER_${user.username}_${randomUUID().slice(0, 8)}`;
  const model = argValue('--model') ?? config.models?.default;

  console.log(`[step] WS connect as ${user.username} (tenant=${user.tenantId}, role=${user.role})`);
  const ws = await WsProbe.connect(baseUrl, token, `ws-${user.username}`);

  // 显式不指定 executionTarget：依赖 A+C 默认 routing
  ws.send({
    action: 'chat',
    client_msg_id: runMarker,
    message: [
      '请严格执行下列指令，不要解释，不要先输出正文：',
      `1. 只调用一次 Shell 工具，command 精确为：echo ${runMarker} && pwd && uname -s && hostname`,
      '2. 等工具完成后，回复一句：完成。',
    ].join('\n'),
    ...(model ? { model } : {}),
  });

  const sessionEvent = await ws.waitFor(
    (e) => e.type === 'session' || e.type === 'chat_rejected' || e.type === 'done' || e.type === 'error',
    'session',
    60_000,
  );
  if (sessionEvent.type === 'chat_rejected') {
    throw new Error(`正向 case 被 chat_rejected：${String(sessionEvent.reason_code)} / ${String(sessionEvent.reason)}（说明 A+C 默认未生效）`);
  }
  if (sessionEvent.type !== 'session') {
    throw new Error(`未创建 session：${sessionEvent.type}`);
  }
  const sessionId = String(sessionEvent.sessionId ?? '');
  if (!sessionId) throw new Error('session 缺 sessionId');

  // approval
  const permission = await ws.waitFor(
    (e) => e.type === 'permission_request' || e.type === 'done' || e.type === 'error',
    'permission_request',
    180_000,
  );
  if (permission.type !== 'permission_request') {
    throw new Error(`模型未产生 permission_request，type=${permission.type}（可能 A+C gate 直接 throw 了）`);
  }
  if (permission.toolName !== 'Shell') {
    throw new Error(`期望 Shell permission，实际 toolName=${String(permission.toolName)}`);
  }
  const interactionId = String(permission.interactionId ?? '');
  if (!interactionId) throw new Error('permission 缺 interactionId');

  ws.send({
    action: 'respond',
    sessionId, interactionId,
    allow: true,
    message: 'approved by tenant-container-smoke',
  });

  const toolResult = await ws.waitFor(
    (e) => e.type === 'tool_result' && e.toolName === 'Shell',
    'Shell tool_result',
    120_000,
  );
  const content = String((toolResult as { content?: unknown }).content ?? '');

  // 断言 1：marker 出现，证明命令真跑了
  if (!content.includes(runMarker)) {
    throw new Error(`tool_result 缺少 marker ${runMarker}（命令未真执行？）。content: ${content.slice(0, 500)}`);
  }
  // 断言 2：cwd 在容器内 /workspace（ContainerExecutionProvider 用 DEFAULT_CONTAINER_WORKDIR=/workspace）
  if (!/\/workspace/.test(content)) {
    throw new Error(`tool_result 未包含容器 cwd /workspace（说明可能落到 server-local 而非容器）。content: ${content.slice(0, 800)}`);
  }
  // 断言 3：uname -s = Linux（容器）而非 Darwin（macOS 宿主）。
  // 这是最稳的"在容器内"判据 —— 与 uid/whoami 不同，uname 不依赖 /etc/passwd 解析。
  if (!/\bLinux\b/.test(content)) {
    throw new Error(`tool_result 未包含 uname Linux 标志（说明可能落到宿主 macOS）。content: ${content.slice(0, 800)}`);
  }
  // 显式断言不是宿主 Darwin
  if (/\bDarwin\b/.test(content)) {
    throw new Error(`tool_result 含 Darwin 标志（落到宿主 macOS，A+C 隔离失败！）。content: ${content.slice(0, 800)}`);
  }

  const done = await ws.waitFor((e) => e.type === 'done', 'done', 60_000);
  if ((done as { error?: unknown }).error) {
    throw new Error(`done(error): ${String((done as { error?: unknown }).error)}`);
  }

  const acsMetadata = await assertAcsToolInvocationMetadata(config, user, sessionId);

  ws.close();
  console.log(`[PASS] ${user.username} 默认走 server-container，stdout 含 /workspace + marker，ACS hand metadata 已确认`);
  console.log(JSON.stringify({
    user: user.username, tenantId: user.tenantId, sessionId, runMarker,
    acsMetadata,
    contentExcerpt: content.slice(0, 400),
  }, null, 2));
}

/** 负向 case：wain_admin 显式 executionTarget='server-local'，期望 chat_rejected access_denied */
async function runNegativeServerLocalCase(baseUrl: string, config: Config): Promise<void> {
  const user = loadUser(config, 'wain_admin');
  const token = signToken(config, user);
  const runMarker = `TENANT_NEG_${randomUUID().slice(0, 8)}`;

  console.log(`[step] WS connect as ${user.username}，显式 executionTarget=server-local（应被拒绝）`);
  const ws = await WsProbe.connect(baseUrl, token, `ws-${user.username}-neg`);

  ws.send({
    action: 'chat',
    client_msg_id: runMarker,
    message: '本消息预期被 chat_rejected，不应进入 session。',
    executionTarget: 'server-local',
  });

  const event = await ws.waitFor(
    (e) => e.type === 'chat_rejected' || e.type === 'session' || e.type === 'done' || e.type === 'error',
    'chat_rejected or session',
    20_000,
  );
  if (event.type !== 'chat_rejected') {
    throw new Error(`期望 chat_rejected（allowUserOverride=false），实际 type=${event.type}（A+C 安全边界失效！）`);
  }
  const reasonCode = String((event as { reason_code?: unknown }).reason_code ?? '');
  if (reasonCode !== 'access_denied') {
    throw new Error(`期望 reason_code=access_denied，实际=${reasonCode}`);
  }
  ws.close();
  console.log(`[PASS] wain_admin 显式 server-local 被 chat_rejected(access_denied)：${String((event as { reason?: unknown }).reason ?? '')}`);
}

async function main(): Promise<void> {
  const baseUrl = argValue('--base-url') ?? DEFAULT_BASE_URL;
  const caseType = argValue('--case') ?? 'positive';
  const userArg = argValue('--user') ?? 'wain_admin';
  const config = loadConfig();

  assertDockerAvailable();
  await waitForHealth(baseUrl, 20_000);

  if (caseType === 'negative-server-local') {
    await runNegativeServerLocalCase(baseUrl, config);
    return;
  }
  if (caseType === 'all') {
    await runPositiveCase(baseUrl, config, 'wain_admin');
    await runPositiveCase(baseUrl, config, 'wain_user');
    await runNegativeServerLocalCase(baseUrl, config);
    return;
  }
  await runPositiveCase(baseUrl, config, userArg);
}

main().catch((err) => {
  console.error('[FAIL]', err instanceof Error ? err.stack || err.message : String(err));
  process.exit(1);
});
