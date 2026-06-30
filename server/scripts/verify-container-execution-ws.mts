/**
 * 真实 WebSocket 验收 server-container 执行后端：
 * Write pending -> approve -> container 写 workspace 文件 -> 模型 done
 * 并确认 runtime event log 中 tool_audit.executionTarget=server-container。
 *
 * 运行：
 *   pnpm -C /Users/admin/code/product/agent-saas/server run verify:container-smoke -- --model openai-agents/gpt55
 */
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import jwt from 'jsonwebtoken';
import { parse as parseJsonc } from 'jsonc-parser';
import { WebSocket } from 'ws';

import { getTranscriptPath } from '../src/data/transcripts/store.js';
import { getRuntimeEventLogPath } from '../src/runtime/fileEventStore.js';

const PROJECT_ROOT = resolve(import.meta.dirname, '..', '..');
const SERVER_DIR = join(PROJECT_ROOT, 'server');
const CONFIG_PATH = join(PROJECT_ROOT, 'config.json');
const DEFAULT_BASE_URL = 'http://127.0.0.1:3200';

type Config = {
  agent?: { cwd?: string };
  auth?: { enabled?: boolean; jwtSecret?: string; usersFile?: string };
  models?: { default?: string };
};

type UserRecord = {
  id: string;
  username: string;
  role: 'admin' | 'user';
  disabled?: boolean;
};

type DownstreamEvent = Record<string, unknown> & { type?: string };

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

function assertRuntimeToolAudit(transcriptPath: string): void {
  const eventPath = getRuntimeEventLogPath(transcriptPath);
  const lines = readFileSync(eventPath, 'utf-8').split('\n').filter(Boolean);
  const auditEvent = lines.map((line) => {
    try {
      return JSON.parse(line) as Record<string, unknown>;
    } catch {
      return {};
    }
  }).find((event) => (
    event.type === 'tool_audit'
    && event.toolName === 'Write'
    && event.executionTarget === 'server-container'
    && event.status === 'success'
  ));
  if (!auditEvent) {
    throw new Error(`runtime event log 缺少 Write tool_audit executionTarget=server-container: ${eventPath}`);
  }
  const invocations = Array.isArray(auditEvent.executionInvocations)
    ? auditEvent.executionInvocations as Array<Record<string, unknown>>
    : [];
  const invocation = invocations.find((item) => item.operation === 'writeFile');
  if (!invocation) {
    throw new Error(`runtime event log 缺少 writeFile container invocation 明细: ${eventPath}`);
  }
  for (const key of ['image', 'containerName', 'timeoutMs', 'stdoutBytes', 'stderrBytes', 'exitCode', 'signal']) {
    if (!(key in invocation)) {
      throw new Error(`container invocation 缺少字段 ${key}: ${JSON.stringify(invocation)}`);
    }
  }
  if (invocation.provider !== 'server-container' || invocation.status !== 'success' || invocation.exitCode !== 0) {
    throw new Error(`container invocation 状态异常: ${JSON.stringify(invocation)}`);
  }
}

async function main(): Promise<void> {
  const baseUrl = argValue('--base-url') ?? DEFAULT_BASE_URL;
  const config = loadConfig();
  const model = argValue('--model') ?? config.models?.default;
  const admin = loadAdminUser(config);
  const token = signToken(config, admin);
  const workspaceRoot = resolve(config.agent?.cwd || '/Users/admin/workspace-openai-runtime', admin.username);
  const runId = `container-smoke-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const day = shanghaiDay();
  const relativePath = `assets/${day}/${runId}.txt`;
  const expectedContent = `SERVER_CONTAINER_OK ${runId}`;
  const targetPath = join(workspaceRoot, relativePath);
  await rm(targetPath, { force: true });

  await waitForHealth(baseUrl, 20_000);
  console.log(`[step] 连接 WS，发起 server-container Write: ${relativePath}`);
  const ws = await WsProbe.connect(baseUrl, token, 'ws-container-smoke');
  ws.send({
    action: 'chat',
    client_msg_id: runId,
    message: [
      '请严格执行，不要解释，不要先输出正文：',
      `1. 只调用一次 Write 工具，path 精确为 ${relativePath}`,
      `2. content 精确为 ${expectedContent}`,
      `3. 等工具完成后，只回复：container 写入完成: ${runId}`,
    ].join('\n'),
    executionTarget: 'server-container',
    ...(model ? { model } : {}),
  });

  const sessionEvent = await ws.waitFor(
    (event) => event.type === 'session' || event.type === 'done' || event.type === 'error',
    'session',
    60_000,
  );
  if (sessionEvent.type !== 'session') {
    throw new Error(`未创建 session，实际事件=${sessionEvent.type} error=${String(sessionEvent.error ?? sessionEvent.message ?? '')}`);
  }
  const sessionId = String(sessionEvent.sessionId ?? '');
  if (!sessionId) throw new Error('未收到有效 sessionId');

  const permissionEvent = await ws.waitFor(
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

  ws.send({
    action: 'respond',
    sessionId,
    interactionId: approvalId,
    allow: true,
    message: 'approved by container smoke script',
  });

  await ws.waitFor((event) => event.type === 'respond_ok' && event.interactionId === approvalId, 'respond_ok', 15_000);
  await ws.waitFor((event) => event.type === 'tool_result' && event.toolName === 'Write', 'Write tool_result', 60_000);
  const done = await ws.waitFor((event) => event.type === 'done', 'done', 120_000);
  if (done.error) throw new Error(`container smoke done(error): ${String(done.error)}`);

  const content = await readFile(targetPath, 'utf-8');
  if (content !== expectedContent) {
    throw new Error(`文件内容不匹配: expected=${expectedContent} actual=${content}`);
  }

  const transcriptPath = getTranscriptPath(workspaceRoot, sessionId);
  assertRuntimeToolAudit(transcriptPath);

  ws.close();
  console.log('[PASS] raw runtime server-container WebSocket smoke passed');
  console.log(JSON.stringify({
    sessionId,
    approvalId,
    transcriptPath,
    targetPath,
    executionTarget: 'server-container',
  }, null, 2));
}

main().catch((err) => {
  console.error('[FAIL]', err instanceof Error ? err.stack || err.message : String(err));
  process.exit(1);
});
