/**
 * Verify: 真实 WebSocket 跑 MemorySearch + Write（admin approve），
 * 然后调 GET /api/admin/runtime/audit/:sessionId 验证 audit 投影：
 *   - 至少 2 条 tool_audit（MemorySearch safe + Write workspace_write）
 *   - Write 顶层化字段：approvalId / authorizationSource=human_approval
 *   - summary.total >= 2 且 byAuthorizationSource 包含 policy_auto+human_approval
 *
 * 前置：
 *   - 副本 server 在 127.0.0.1:3200 运行，且代码已包含 /api/admin/runtime/audit
 *     路由（commit 7ffdcb27 及之后）。如果脚本在请求 audit API 时收到 404，
 *     大概率是 server 还跑在旧 binary，需要重启 server。
 *   - config.json 中 auth.enabled=true / jwtSecret / memory.index.enabled=true。
 *
 * 运行：
 *   PATH="$PATH:/usr/sbin" pnpm -C server run verify:audit-read -- --model openai-agents/gpt55
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import jwt from 'jsonwebtoken';
import { parse as parseJsonc } from 'jsonc-parser';
import { WebSocket } from 'ws';

const PROJECT_ROOT = resolve(import.meta.dirname, '..', '..');
const SERVER_DIR = join(PROJECT_ROOT, 'server');
const CONFIG_PATH = join(PROJECT_ROOT, 'config.json');
const DEFAULT_BASE_URL = 'http://127.0.0.1:3200';

type Config = {
  agent?: { cwd?: string };
  auth?: { enabled?: boolean; jwtSecret?: string; usersFile?: string };
  models?: { default?: string };
};
type UserRecord = { id: string; username: string; role: 'admin' | 'user'; disabled?: boolean };
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

function loadAdminUser(cfg: Config): UserRecord {
  if (!cfg.auth?.enabled || !cfg.auth.jwtSecret) {
    throw new Error('config.auth.enabled/jwtSecret 缺失');
  }
  const usersPath = resolve(SERVER_DIR, cfg.auth.usersFile || './data/users.json');
  const raw = JSON.parse(readFileSync(usersPath, 'utf-8')) as { users?: UserRecord[] };
  const admin = raw.users?.find((u) => u.role === 'admin' && !u.disabled);
  if (!admin) throw new Error(`未找到可用 admin 用户: ${usersPath}`);
  return admin;
}

function signToken(cfg: Config, user: UserRecord): string {
  return jwt.sign(
    { sub: user.id, username: user.username, role: user.role },
    cfg.auth!.jwtSecret!,
    { expiresIn: '15m' },
  );
}

function shanghaiDay(): string {
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const g = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${g('year')}${g('month')}${g('day')}`;
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
    predicate: (e: DownstreamEvent) => boolean;
    resolve: (e: DownstreamEvent) => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();

  constructor(readonly ws: WebSocket, private readonly label: string) {
    ws.on('message', (raw) => {
      let evt: DownstreamEvent;
      try {
        const parsed = JSON.parse(raw.toString()) as { data?: DownstreamEvent } | DownstreamEvent;
        evt = 'data' in parsed && parsed.data ? parsed.data : (parsed as DownstreamEvent);
      } catch (err) {
        this.rejectAll(new Error(`${label} WS 非 JSON 消息: ${err instanceof Error ? err.message : String(err)}`));
        return;
      }
      this.events.push(evt);
      for (const w of [...this.waiters]) {
        if (!w.predicate(evt)) continue;
        clearTimeout(w.timer);
        this.waiters.delete(w);
        w.resolve(evt);
      }
    });
    ws.on('error', (err) => this.rejectAll(new Error(`${label} WS error: ${err.message}`)));
  }

  static connect(baseUrl: string, token: string, label: string): Promise<WsProbe> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl(baseUrl, token));
      const timer = setTimeout(() => { ws.close(); reject(new Error(`${label} WS 连接超时`)); }, 15_000);
      ws.once('open', () => { clearTimeout(timer); resolve(new WsProbe(ws, label)); });
      ws.once('error', (err) => { clearTimeout(timer); reject(err); });
    });
  }

  send(message: object): void { this.ws.send(JSON.stringify(message)); }

  waitFor(predicate: (e: DownstreamEvent) => boolean, description: string, timeoutMs: number): Promise<DownstreamEvent> {
    const existing = this.events.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const waiter = {
        predicate, resolve, reject,
        timer: setTimeout(() => {
          this.waiters.delete(waiter);
          reject(new Error(`${this.label} 等待 ${description} 超时。最近事件: ${this.events.slice(-10).map((e) => e.type).join(', ')}`));
        }, timeoutMs),
      };
      this.waiters.add(waiter);
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
      const res = await fetch(`${baseUrl}/api/health`);
      const data = (await res.json().catch(() => ({}))) as { status?: string };
      if (res.ok && data.status === 'ok') return;
      lastError = `HTTP ${res.status}`;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    await sleep(750);
  }
  throw new Error(`等待 3200 health 超时: ${lastError}`);
}

interface AuditEntry {
  id: string;
  timestamp: string;
  runId: string;
  sessionId: string;
  toolCallId: string;
  toolId: string;
  toolName: string;
  risk: string;
  approvalId?: string;
  authorization: { approved: boolean; source: string; approvalId?: string };
  authorizationSource: string;
  executionTarget: string;
  status: string;
  durationMs: number;
  executionInvocations?: Array<{ operation: string; provider: string; status: string }>;
  error?: string;
}

interface AuditResponse {
  sessionId: string;
  runId: string | null;
  limit: number;
  offset: number;
  since?: string;
  entries: AuditEntry[];
  summary: {
    total: number;
    filteredTotal: number;
    byExecutionTarget: Record<string, number>;
    byStatus: Record<string, number>;
    byAuthorizationSource: Record<string, number>;
  };
}

async function fetchAudit(baseUrl: string, token: string, sessionId: string, qs = ''): Promise<AuditResponse> {
  const url = `${baseUrl}/api/admin/runtime/audit/${sessionId}${qs}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 404) {
    throw new Error(`audit API 404 — server 可能仍跑在旧 binary，需要 commit 7ffdcb27 之后的代码。URL=${url}`);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`audit API ${res.status}: ${text || '(no body)'}`);
  }
  return (await res.json()) as AuditResponse;
}

interface CrossSessionAuditResponse {
  runId: string;
  since?: string;
  limit: number;
  offset: number;
  entries: AuditEntry[];
  summary: {
    total: number;
    filteredTotal: number;
    sessionIds: string[];
    byExecutionTarget: Record<string, number>;
    byStatus: Record<string, number>;
    byAuthorizationSource: Record<string, number>;
  };
}

/**
 * 调 GET /api/admin/runtime/audit/runs/:runId。
 * 返回：
 *   - `{ kind: 'ok', body }` 当 backend=duckdb（200）
 *   - `{ kind: 'unsupported' }` 当 backend=file（503）
 *   - throw on 其它错误
 */
async function fetchCrossSessionAudit(
  baseUrl: string,
  token: string,
  runId: string,
): Promise<{ kind: 'ok'; body: CrossSessionAuditResponse } | { kind: 'unsupported' }> {
  const url = `${baseUrl}/api/admin/runtime/audit/runs/${encodeURIComponent(runId)}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 503) return { kind: 'unsupported' };
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`cross-session audit API ${res.status}: ${text || '(no body)'}`);
  }
  return { kind: 'ok', body: (await res.json()) as CrossSessionAuditResponse };
}

async function main(): Promise<void> {
  const baseUrl = argValue('--base-url') ?? DEFAULT_BASE_URL;
  const config = loadConfig();
  const model = argValue('--model') ?? config.models?.default;
  const admin = loadAdminUser(config);
  const token = signToken(config, admin);
  const workspaceRoot = resolve(config.agent?.cwd || '/Users/admin/workspace-openai-runtime', admin.username);

  const runId = `audit-read-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const day = shanghaiDay();
  const relativePath = `assets/${day}/${runId}.txt`;
  const targetPath = join(workspaceRoot, relativePath);
  const expectedContent = `AUDIT_READ_OK ${runId}`;
  await rm(targetPath, { force: true });

  await waitForHealth(baseUrl, 20_000);
  console.log(`[step] 连接 WS，发起含 MemorySearch + Write 的 chat: ${relativePath}`);
  const ws = await WsProbe.connect(baseUrl, token, 'ws-audit-read');
  ws.send({
    action: 'chat',
    client_msg_id: runId,
    message: [
      '请严格按顺序、不要解释、不要先输出正文：',
      '1. 先调用一次 MemorySearch，query 用「曾磊在开沿科技担任什么角色」检索一次即可。',
      `2. 再调用一次 Write，path 精确为 ${relativePath}，content 精确为 ${expectedContent}。`,
      `3. 等工具完成后只回复：audit-read 写入完成: ${runId}`,
    ].join('\n'),
    ...(model ? { model } : {}),
  });

  const sessionEvent = await ws.waitFor(
    (e) => e.type === 'session' || e.type === 'done' || e.type === 'error',
    'session', 60_000,
  );
  if (sessionEvent.type !== 'session') {
    throw new Error(`未创建 session，实际事件=${sessionEvent.type} error=${String(sessionEvent.error ?? sessionEvent.message ?? '')}`);
  }
  const sessionId = String(sessionEvent.sessionId ?? '');
  if (!sessionId) throw new Error('未收到有效 sessionId');

  const permEvt = await ws.waitFor(
    (e) => e.type === 'permission_request' || e.type === 'done' || e.type === 'error',
    'permission_request', 120_000,
  );
  if (permEvt.type !== 'permission_request') {
    throw new Error(`没有 permission_request，实际 type=${permEvt.type}`);
  }
  const approvalId = String(permEvt.interactionId ?? '');
  if (!approvalId) throw new Error('permission_request 缺少 interactionId');
  if (permEvt.toolName !== 'Write') {
    throw new Error(`期望 Write permission_request，实际 toolName=${String(permEvt.toolName)}`);
  }

  ws.send({
    action: 'respond', sessionId, interactionId: approvalId, allow: true,
    message: 'approved by audit-read verify script',
  });
  await ws.waitFor((e) => e.type === 'respond_ok' && e.interactionId === approvalId, 'respond_ok', 15_000);
  await ws.waitFor((e) => e.type === 'tool_result' && e.toolName === 'Write', 'Write tool_result', 60_000);
  const done = await ws.waitFor((e) => e.type === 'done', 'done', 120_000);
  if (done.error) throw new Error(`done(error): ${String(done.error)}`);

  const content = await readFile(targetPath, 'utf-8');
  if (content !== expectedContent) {
    throw new Error(`写入内容不匹配: expected=${expectedContent} actual=${content}`);
  }

  console.log(`[step] 调 GET /api/admin/runtime/audit/${sessionId}`);
  const audit = await fetchAudit(baseUrl, token, sessionId);
  if (audit.sessionId !== sessionId) throw new Error(`audit.sessionId 不匹配`);

  const memEntry = audit.entries.find((e) => e.toolName === 'MemorySearch');
  if (!memEntry) {
    throw new Error(`audit 缺少 MemorySearch 条目。entries=${audit.entries.map((e) => e.toolName).join(', ')}`);
  }
  if (memEntry.authorizationSource !== 'policy_auto') {
    throw new Error(`MemorySearch authorizationSource 期望 policy_auto，实际=${memEntry.authorizationSource}`);
  }
  if (memEntry.risk !== 'safe' || memEntry.status !== 'success') {
    throw new Error(`MemorySearch risk/status 异常: ${JSON.stringify({ risk: memEntry.risk, status: memEntry.status })}`);
  }

  const writeEntry = audit.entries.find((e) => e.toolName === 'Write');
  if (!writeEntry) throw new Error(`audit 缺少 Write 条目`);
  if (writeEntry.authorizationSource !== 'human_approval') {
    throw new Error(`Write authorizationSource 期望 human_approval，实际=${writeEntry.authorizationSource}`);
  }
  if (writeEntry.approvalId !== approvalId) {
    throw new Error(`Write approvalId 不匹配: expected=${approvalId} actual=${writeEntry.approvalId}`);
  }
  if (writeEntry.executionTarget !== 'server-local' && writeEntry.executionTarget !== 'server-container') {
    throw new Error(`Write executionTarget 异常: ${writeEntry.executionTarget}`);
  }
  if (writeEntry.risk !== 'workspace_write' || writeEntry.status !== 'success') {
    throw new Error(`Write risk/status 异常: ${JSON.stringify({ risk: writeEntry.risk, status: writeEntry.status })}`);
  }

  // 字段完整性：每条必须有 id / timestamp / runId / durationMs / authorization
  for (const e of [memEntry, writeEntry]) {
    for (const key of ['id', 'timestamp', 'runId', 'durationMs', 'authorization']) {
      if (!(key in e) || (e as Record<string, unknown>)[key] === undefined) {
        throw new Error(`audit entry ${e.toolName} 缺少字段 ${key}`);
      }
    }
  }

  if (audit.summary.total < 2) {
    throw new Error(`summary.total 期望 >= 2，实际=${audit.summary.total}`);
  }
  if ((audit.summary.byAuthorizationSource.policy_auto ?? 0) < 1) {
    throw new Error(`summary 缺少 policy_auto 计数`);
  }
  if ((audit.summary.byAuthorizationSource.human_approval ?? 0) < 1) {
    throw new Error(`summary 缺少 human_approval 计数`);
  }

  // runId 过滤：取 MemorySearch 的 runId（与 Write 同一 run），断言条目数 >= 2
  const filteredByRun = await fetchAudit(baseUrl, token, sessionId, `?runId=${encodeURIComponent(memEntry.runId)}`);
  if (filteredByRun.runId !== memEntry.runId) {
    throw new Error(`runId filter 响应 runId 错位: expected=${memEntry.runId} actual=${filteredByRun.runId}`);
  }
  if (filteredByRun.entries.length < 2) {
    throw new Error(`按 runId=${memEntry.runId} 过滤期望 >= 2 条，实际=${filteredByRun.entries.length}`);
  }

  // 非 admin 应被拒（403）—— 用伪 token（非 admin role）
  const userToken = jwt.sign(
    { sub: 'nobody', username: 'nobody', role: 'user' },
    config.auth!.jwtSecret!,
    { expiresIn: '5m' },
  );
  const denyRes = await fetch(`${baseUrl}/api/admin/runtime/audit/${sessionId}`, {
    headers: { Authorization: `Bearer ${userToken}` },
  });
  if (denyRes.status !== 403) {
    throw new Error(`非 admin 应 403，实际=${denyRes.status}`);
  }

  // Cross-session audit search：仅 audit.projection=duckdb 才支持。
  // file backend 返回 503 → log + skip；duckdb backend 返回 200 → 额外断言。
  console.log(`[step] 调 GET /api/admin/runtime/audit/runs/${memEntry.runId}（dual-backend）`);
  const cross = await fetchCrossSessionAudit(baseUrl, token, memEntry.runId);
  let backend: 'file' | 'duckdb';
  if (cross.kind === 'unsupported') {
    backend = 'file';
    console.log('[info] cross-session search 不支持（audit.projection=file，跳过 cross-session 断言）');
  } else {
    backend = 'duckdb';
    const xs = cross.body;
    if (xs.runId !== memEntry.runId) {
      throw new Error(`cross-session.runId 错位: expected=${memEntry.runId} actual=${xs.runId}`);
    }
    if (xs.entries.length < 2) {
      throw new Error(`cross-session entries 期望 >= 2 (memory + write 同 run)，实际=${xs.entries.length}`);
    }
    if (!xs.summary.sessionIds.includes(sessionId)) {
      throw new Error(`cross-session summary.sessionIds 不含当前 ${sessionId}：${xs.summary.sessionIds.join(', ')}`);
    }
    if (xs.summary.total < 2) {
      throw new Error(`cross-session summary.total 期望 >= 2，实际=${xs.summary.total}`);
    }
    if ((xs.summary.byAuthorizationSource.policy_auto ?? 0) < 1) {
      throw new Error('cross-session summary 缺少 policy_auto 计数');
    }
    if ((xs.summary.byAuthorizationSource.human_approval ?? 0) < 1) {
      throw new Error('cross-session summary 缺少 human_approval 计数');
    }

    // 非 admin 应 403
    const userToken2 = jwt.sign(
      { sub: 'nobody', username: 'nobody', role: 'user' },
      config.auth!.jwtSecret!,
      { expiresIn: '5m' },
    );
    const denyCross = await fetch(
      `${baseUrl}/api/admin/runtime/audit/runs/${encodeURIComponent(memEntry.runId)}`,
      { headers: { Authorization: `Bearer ${userToken2}` } },
    );
    if (denyCross.status !== 403) {
      throw new Error(`cross-session 非 admin 应 403，实际=${denyCross.status}`);
    }
  }

  ws.close();
  console.log('[PASS] runtime audit read API e2e passed');
  console.log(JSON.stringify({
    sessionId,
    approvalId,
    backend,
    auditTotal: audit.summary.total,
    memoryRunId: memEntry.runId,
    writeRunId: writeEntry.runId,
    summary: audit.summary,
    ...(backend === 'duckdb' && cross.kind === 'ok' ? {
      crossSessionEntries: cross.body.entries.length,
      crossSessionSessionIds: cross.body.summary.sessionIds,
    } : {}),
  }, null, 2));
}

main().catch((err) => {
  console.error('[FAIL]', err instanceof Error ? err.stack || err.message : String(err));
  process.exit(1);
});
