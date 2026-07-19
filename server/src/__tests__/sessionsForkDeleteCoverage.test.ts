/**
 * sessions.ts 残余分支补测：fork 截断 / 永久删除孤儿路径 / 来源索引容错 / stream-status
 *
 * 与既有 sessions 测试的分工（不重复）：
 * - sessionsRoutesMetaOnly.test.ts：列表 / 详情 / stats / meta-only 会话增强
 * - sessionsRoutesLifecycleCoverage.test.ts：PATCH 重命名、软删（meta 存在主路径）、
 *   restore 400/403/成功、permanent（.jsonl 存在主路径）、trash 列表、share 501
 * - sessionSharesRoutes.test.ts：公开分享快照
 * - sessionsInteractionsPendingAccess.test.ts：pending 交互守门
 *
 * 本文件专补（均为 A 类：纯文件后端可单测业务逻辑）：
 * 1. POST /sessions/:id/fork（sessions.ts L1946-2037 + data/transcripts/fork.ts）：
 *    - 按 blockId 截断复制：读取落盘的新 transcript，逐字节断言只含目标行之前的历史；
 *      新 meta 归属请求者身份并继承源 channel/model
 *    - 从第一条消息 fork → 空历史文件
 *    - 参数校验（非法 sessionId / 缺失或非法 blockId）、404、目标行非用户消息、行号越界
 *    - 非 owner 403（同租户他人 + 平台 admin 同样被 owner-gate 拦截），不产生副作用
 *    - 记忆轮询会话对非平台 admin 隐藏 → 404（hidesMemoryPollFrom 分支）
 * 2. GET /sessions/:id/stream-status（L2145-2187）：非法 sessionId 400；非 owner 降级
 *    active:false 且不触发 getStreamStatus；owner 透传注入的流状态
 * 3. buildDingtalkSessionIndex（L459-479，经 GET /sessions L1063-1066 触达）：
 *    dingtalk-sessions.json 损坏 JSON 容错（列表仍 200、source 回退 web）；
 *    合法索引 → source=dingtalk + senderNick；缺 senderNick 条目不建索引
 * 4. DELETE /sessions/:id 软删的「transcript 在但 meta 缺失」路径（L2468-2494）：
 *    owner 补 stub meta 后软删成功；他人（非 admin）403 且不写 stub；
 *    跨租户 org admin 收养孤儿 transcript（已知行为记录，详见用例注释）
 * 5. DELETE /sessions/:id/permanent 残余分支（L2356-2428）：孤儿 meta（无 .jsonl）走
 *    deleteSessionMetaOnly 物理删除 + groupStore 级联；非 owner / 平台 admin 403；
 *    meta 缺失（未软删过的裸 transcript）403；未认证 401；非法 id 400；不存在 404
 *
 * 模式照抄 sessionsRoutesLifecycleCoverage.test.ts：真 express + listen(0,'127.0.0.1') +
 * 全局 fetch；认证伪造 = 中间件注入 req.user(JwtPayload)；真 file-backed transcript/meta
 * 落盘（~/.agent-saas/legacy-transcripts/<tenant>/<userId>/）。每次运行生成随机用户 id
 * 隔离目录，afterEach server.close() + rm 递归清理。
 *
 * B/C 类不测：PG runtime event store（B，需真 PG）；路由在 app/routes.ts 的装配（C）。
 */
import express from 'express';
import { randomUUID } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createSessionsRouter } from '../routes/sessions.js';
import {
  getAgentTranscriptDir,
  getTranscriptPath,
  isValidSessionId,
} from '../data/transcripts/index.js';
import {
  getMetaPath,
  readSessionMeta,
  writeSessionMeta,
  type SessionMeta,
} from '../data/transcripts/meta.js';
import type { GroupStore } from '../data/groups/index.js';
import { DEFAULT_TENANT_ID } from '../data/tenants/types.js';
import { resolveUserCwd, type WorkspaceUser } from '../workspace/resolver.js';

interface StreamStatus {
  active: boolean;
  streamId?: string;
  runId?: string;
}

function stopServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

function userLine(sessionId: string, text: string): string {
  return JSON.stringify({
    type: 'user',
    sessionId,
    timestamp: new Date().toISOString(),
    message: { content: [{ type: 'text', text }] },
  });
}

function assistantLine(sessionId: string, text: string): string {
  return JSON.stringify({
    type: 'assistant',
    sessionId,
    timestamp: new Date().toISOString(),
    message: { content: [{ type: 'text', text }] },
  });
}

describe('sessions fork/permanent-delete/source-index residual coverage', () => {
  let agentCwd = '';
  let OWNER!: WorkspaceUser;
  let OTHER!: WorkspaceUser;
  /** 平台 admin（pantheon）：会话 owner-gate 对其同样生效 */
  let PLATFORM_ADMIN!: WorkspaceUser;
  /** 跨租户组织 admin（acme） */
  let ACME_ADMIN!: WorkspaceUser;
  const servers: Server[] = [];
  const cleanup = new Set<string>();

  beforeEach(async () => {
    agentCwd = await mkdtemp(join(tmpdir(), 'sessions-fork-del-'));
    cleanup.add(agentCwd);
    const uniq = randomUUID().slice(0, 8);
    OWNER = { id: `fdc-owner-${uniq}`, username: `fdc-owner-${uniq}`, role: 'user', tenantId: 'kaiyan' };
    OTHER = { id: `fdc-other-${uniq}`, username: `fdc-other-${uniq}`, role: 'user', tenantId: 'kaiyan' };
    PLATFORM_ADMIN = { id: `fdc-wain-${uniq}`, username: 'wain', role: 'admin', tenantId: DEFAULT_TENANT_ID };
    ACME_ADMIN = { id: `fdc-acme-${uniq}`, username: `fdc-acme-${uniq}`, role: 'admin', tenantId: 'acme' };
    for (const u of [OWNER, OTHER, PLATFORM_ADMIN, ACME_ADMIN]) {
      cleanup.add(getAgentTranscriptDir({ tenantId: u.tenantId!, userId: u.id }));
    }
  });

  afterEach(async () => {
    for (const s of servers.splice(0)) await stopServer(s);
    for (const target of cleanup) await rm(target, { recursive: true, force: true });
    cleanup.clear();
  });

  async function startServer(
    user: WorkspaceUser | null,
    opts: {
      dingtalkSessionsBasePath?: string;
      getStreamStatus?: (sessionId: string) => Promise<StreamStatus>;
      groupStore?: GroupStore;
    } = {},
  ): Promise<{ baseUrl: string }> {
    const app = express();
    app.use(express.json());
    if (user) {
      app.use((req, _res, next) => {
        req.user = {
          sub: user.id,
          username: user.username,
          role: user.role,
          tenantId: user.tenantId ?? DEFAULT_TENANT_ID,
        };
        next();
      });
    }
    app.use('/api', createSessionsRouter({
      agentCwd,
      ...(opts.dingtalkSessionsBasePath ? { dingtalkSessionsBasePath: opts.dingtalkSessionsBasePath } : {}),
      ...(opts.getStreamStatus ? { getStreamStatus: opts.getStreamStatus } : {}),
      ...(opts.groupStore ? { groupStore: opts.groupStore } : {}),
    }));

    return new Promise((resolve) => {
      const server = app.listen(0, '127.0.0.1', () => {
        servers.push(server);
        const addr = server.address();
        const port = typeof addr === 'object' && addr ? addr.port : 0;
        resolve({ baseUrl: `http://127.0.0.1:${port}` });
      });
    });
  }

  /**
   * 落盘一个真实会话：多行 JSONL transcript（可选）+ meta（可选）。
   * 归属以 meta.userId 为准；transcript 写入 owner 的 per-tenant/per-user 目录。
   */
  async function writeSession(
    owner: WorkspaceUser,
    opts: {
      turns?: Array<{ role: 'user' | 'assistant'; text: string }>;
      metaPatch?: Partial<SessionMeta>;
      skipMeta?: boolean;
      skipTranscript?: boolean;
    } = {},
  ): Promise<{ sessionId: string; transcriptPath: string; lines: string[] }> {
    const sessionId = randomUUID();
    const userCwd = resolveUserCwd(agentCwd, owner);
    const transcriptPath = getTranscriptPath(userCwd, sessionId, {
      tenantId: owner.tenantId,
      userId: owner.id,
    });
    cleanup.add(dirname(transcriptPath));
    await mkdir(dirname(transcriptPath), { recursive: true });

    const turns = opts.turns ?? [{ role: 'user' as const, text: 'hello world from residual coverage' }];
    const lines = turns.map((t) =>
      t.role === 'user' ? userLine(sessionId, t.text) : assistantLine(sessionId, t.text),
    );
    if (!opts.skipTranscript) {
      await writeFile(transcriptPath, lines.join('\n') + '\n');
    }
    if (!opts.skipMeta) {
      const createdAt = new Date().toISOString();
      await writeSessionMeta(transcriptPath, {
        userId: owner.id,
        username: owner.username,
        tenantId: owner.tenantId,
        channel: 'web',
        createdAt,
        updatedAt: createdAt,
        cwd: userCwd,
        transcriptPath,
        ...opts.metaPatch,
      });
    }
    return { sessionId, transcriptPath, lines };
  }

  // ---------------------------------------------------------------------------
  // POST /sessions/:sessionId/fork
  // ---------------------------------------------------------------------------

  it('fork：按 blockId 截断复制，新 transcript 只含目标行之前的历史，meta 归属请求者并继承 channel/model', async () => {
    const { sessionId, lines } = await writeSession(OWNER, {
      turns: [
        { role: 'user', text: '第一个问题' },
        { role: 'assistant', text: '第一个回答' },
        { role: 'user', text: '第二个问题' },
        { role: 'assistant', text: '第二个回答' },
        { role: 'user', text: '第三个问题' },
      ],
      metaPatch: { model: 'test-model-x' },
    });
    const { baseUrl } = await startServer(OWNER);

    // 从第 3 行（第二个用户消息）fork：保留第 1-2 行历史
    const res = await fetch(`${baseUrl}/api/sessions/${sessionId}/fork`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ blockId: 'line-3-user-0' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { newSessionId: string; forkMessage: string };
    expect(isValidSessionId(body.newSessionId)).toBe(true);
    expect(body.newSessionId).not.toBe(sessionId);
    expect(body.forkMessage).toBe('第二个问题');

    // 副作用：读落盘的新 transcript，内容必须严格等于源前 2 行（截断正确性）
    const forkDir = getAgentTranscriptDir({ tenantId: OWNER.tenantId!, userId: OWNER.id });
    const newTranscriptPath = join(forkDir, `${body.newSessionId}.jsonl`);
    const forkedContent = await readFile(newTranscriptPath, 'utf-8');
    expect(forkedContent).toBe(lines.slice(0, 2).join('\n') + '\n');

    // 副作用：新 meta 归属请求者身份，channel/model 继承源会话
    const newMeta = await readSessionMeta(newTranscriptPath);
    expect(newMeta).not.toBeNull();
    expect(newMeta!.userId).toBe(OWNER.id);
    expect(newMeta!.username).toBe(OWNER.username);
    expect(newMeta!.tenantId).toBe(OWNER.tenantId);
    expect(newMeta!.channel).toBe('web');
    expect(newMeta!.model).toBe('test-model-x');
    expect(Number.isFinite(Date.parse(newMeta!.createdAt))).toBe(true);
  });

  it('fork：从第一条消息 fork → 空历史新 transcript + forkMessage 为首条用户文本', async () => {
    const { sessionId } = await writeSession(OWNER, {
      turns: [
        { role: 'user', text: '开场白问题' },
        { role: 'assistant', text: '回答' },
      ],
    });
    const { baseUrl } = await startServer(OWNER);

    const res = await fetch(`${baseUrl}/api/sessions/${sessionId}/fork`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ blockId: 'line-1-user-0' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { newSessionId: string; forkMessage: string };
    expect(body.forkMessage).toBe('开场白问题');

    // 空历史也要落盘一个空文件（fork.ts L106：空数组时写入空字符串）
    const forkDir = getAgentTranscriptDir({ tenantId: OWNER.tenantId!, userId: OWNER.id });
    const forkedContent = await readFile(join(forkDir, `${body.newSessionId}.jsonl`), 'utf-8');
    expect(forkedContent).toBe('');
  });

  it('fork：参数校验——非法 sessionId 400、缺 blockId 400、非法 blockId 格式 400、会话不存在 404', async () => {
    const { baseUrl } = await startServer(OWNER);

    const badSession = await fetch(`${baseUrl}/api/sessions/not-a-uuid/fork`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ blockId: 'line-1' }),
    });
    expect(badSession.status).toBe(400);
    expect((await badSession.json() as { error: string }).error).toBe('Invalid sessionId format');

    const noBlockId = await fetch(`${baseUrl}/api/sessions/${randomUUID()}/fork`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(noBlockId.status).toBe(400);
    expect((await noBlockId.json() as { error: string }).error).toBe('Invalid or missing blockId');

    const badBlockId = await fetch(`${baseUrl}/api/sessions/${randomUUID()}/fork`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ blockId: 'block-3-user' }),
    });
    expect(badBlockId.status).toBe(400);
    expect((await badBlockId.json() as { error: string }).error).toBe('Invalid or missing blockId');

    const missing = await fetch(`${baseUrl}/api/sessions/${randomUUID()}/fork`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ blockId: 'line-1-user-0' }),
    });
    expect(missing.status).toBe(404);
    expect((await missing.json() as { error: string }).error).toBe('Session not found');
  });

  it('fork：目标行校验——非用户消息行 400、行号越界 400', async () => {
    const { sessionId } = await writeSession(OWNER, {
      turns: [
        { role: 'user', text: '问题' },
        { role: 'assistant', text: '回答' },
      ],
    });
    const { baseUrl } = await startServer(OWNER);

    // 第 2 行是 assistant 消息，不能作为 fork 锚点
    const notUser = await fetch(`${baseUrl}/api/sessions/${sessionId}/fork`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ blockId: 'line-2-assistant-0' }),
    });
    expect(notUser.status).toBe(400);
    expect((await notUser.json() as { error: string }).error).toContain('not a user message');

    // 行号超出文件长度
    const overflow = await fetch(`${baseUrl}/api/sessions/${sessionId}/fork`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ blockId: 'line-99-user-0' }),
    });
    expect(overflow.status).toBe(400);
    expect((await overflow.json() as { error: string }).error).toContain('not found');
  });

  it('fork：非 owner 403（同租户他人 + 平台 admin 均被 owner-gate 拦截），且不产生新 transcript', async () => {
    const { sessionId } = await writeSession(OWNER, {
      turns: [{ role: 'user', text: '私密问题' }],
    });

    // 同租户其他用户
    const { baseUrl: otherBase } = await startServer(OTHER);
    const foreign = await fetch(`${otherBase}/api/sessions/${sessionId}/fork`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ blockId: 'line-1-user-0' }),
    });
    expect(foreign.status).toBe(403);
    expect((await foreign.json() as { error: string }).error).toBe('Access denied');
    // 副作用检查：OTHER 的 transcript 目录从未被创建（fork 未执行）
    await expect(
      access(getAgentTranscriptDir({ tenantId: OTHER.tenantId!, userId: OTHER.id })),
    ).rejects.toThrow();

    // 平台 admin 也不是 owner → 同样 403（canAccessSession 仅认 meta.userId）
    const { baseUrl: adminBase } = await startServer(PLATFORM_ADMIN);
    const adminFork = await fetch(`${adminBase}/api/sessions/${sessionId}/fork`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ blockId: 'line-1-user-0' }),
    });
    expect(adminFork.status).toBe(403);
  });

  it('fork：记忆轮询会话对非平台 admin owner 隐藏 → 404', async () => {
    const { sessionId } = await writeSession(OWNER, {
      turns: [{ role: 'user', text: '轮询内容' }],
      metaPatch: { cronSystemKind: 'memory_poll' },
    });
    const { baseUrl } = await startServer(OWNER);

    const res = await fetch(`${baseUrl}/api/sessions/${sessionId}/fork`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ blockId: 'line-1-user-0' }),
    });
    expect(res.status).toBe(404);
    expect((await res.json() as { error: string }).error).toBe('Session not found');
  });

  // ---------------------------------------------------------------------------
  // GET /sessions/:sessionId/stream-status
  // ---------------------------------------------------------------------------

  it('stream-status：非法 sessionId 400；非 owner 降级 active:false 且不触发 getStreamStatus；owner 透传流状态', async () => {
    const { sessionId } = await writeSession(OWNER);

    const ownerCalls: string[] = [];
    const { baseUrl: ownerBase } = await startServer(OWNER, {
      getStreamStatus: async (id) => {
        ownerCalls.push(id);
        return { active: true, streamId: 'stream-1', runId: 'run-1' };
      },
    });

    // 非法 sessionId → 400
    const bad = await fetch(`${ownerBase}/api/sessions/not-a-uuid/stream-status`);
    expect(bad.status).toBe(400);
    expect((await bad.json() as { error: string }).error).toBe('Invalid sessionId');

    // owner → 透传注入的流状态
    const ok = await fetch(`${ownerBase}/api/sessions/${sessionId}/stream-status`);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ active: true, streamId: 'stream-1', runId: 'run-1' });
    expect(ownerCalls).toEqual([sessionId]);

    // 非 owner → 探活接口不暴露 403，降级 active:false，且 getStreamStatus 不被调用
    const otherCalls: string[] = [];
    const { baseUrl: otherBase } = await startServer(OTHER, {
      getStreamStatus: async (id) => {
        otherCalls.push(id);
        return { active: true, streamId: 'leak', runId: 'leak' };
      },
    });
    const foreign = await fetch(`${otherBase}/api/sessions/${sessionId}/stream-status`);
    expect(foreign.status).toBe(200);
    expect(await foreign.json()).toEqual({ active: false });
    expect(otherCalls).toEqual([]);
  });

  // ---------------------------------------------------------------------------
  // buildDingtalkSessionIndex（经 GET /sessions 触达）
  // ---------------------------------------------------------------------------

  it('dingtalk 索引：dingtalk-sessions.json 损坏 JSON 容错，列表仍 200 且 source 回退 web', async () => {
    const { sessionId } = await writeSession(OWNER);
    const dingtalkDir = join(agentCwd, 'dingtalk-broken');
    await mkdir(dingtalkDir, { recursive: true });
    await writeFile(join(dingtalkDir, 'dingtalk-sessions.json'), '{{{ this is not valid json');

    const { baseUrl } = await startServer(OWNER, { dingtalkSessionsBasePath: dingtalkDir });
    const res = await fetch(`${baseUrl}/api/sessions`);
    expect(res.status).toBe(200);
    const body = await res.json() as {
      sessions: Array<{ sessionId: string; source: { type: string; label: string } }>;
    };
    const entry = body.sessions.find((s) => s.sessionId === sessionId);
    expect(entry).toBeDefined();
    expect(entry!.source).toEqual({ type: 'web', label: 'WEB' });
  });

  it('dingtalk 索引：合法 JSON → source=dingtalk + senderNick；缺 senderNick 的条目不入索引', async () => {
    const { sessionId: dingtalkSession } = await writeSession(OWNER, {
      turns: [{ role: 'user', text: '钉钉进来的会话' }],
    });
    const { sessionId: incompleteSession } = await writeSession(OWNER, {
      turns: [{ role: 'user', text: '缺昵称的会话' }],
    });
    const dingtalkDir = join(agentCwd, 'dingtalk-ok');
    await mkdir(dingtalkDir, { recursive: true });
    await writeFile(
      join(dingtalkDir, 'dingtalk-sessions.json'),
      JSON.stringify({
        'conv-1': { agentSessionId: dingtalkSession, senderNick: '张三' },
        'conv-2': { agentSessionId: incompleteSession }, // 缺 senderNick → 不建索引
      }),
    );

    const { baseUrl } = await startServer(OWNER, { dingtalkSessionsBasePath: dingtalkDir });
    const res = await fetch(`${baseUrl}/api/sessions`);
    expect(res.status).toBe(200);
    const body = await res.json() as {
      sessions: Array<{ sessionId: string; source: { type: string; label: string } }>;
    };
    const tagged = body.sessions.find((s) => s.sessionId === dingtalkSession);
    expect(tagged?.source).toEqual({ type: 'dingtalk', label: '张三' });
    const fallback = body.sessions.find((s) => s.sessionId === incompleteSession);
    expect(fallback?.source).toEqual({ type: 'web', label: 'WEB' });
  });

  // ---------------------------------------------------------------------------
  // DELETE /sessions/:sessionId —— transcript 在但 meta 缺失（stub meta 补建分支）
  // ---------------------------------------------------------------------------

  it('软删：transcript 在但 meta 缺失 → owner 触发补 stub meta 并软删成功（落盘验证）', async () => {
    const { sessionId, transcriptPath } = await writeSession(OWNER, { skipMeta: true });
    // 前置：meta 确实不存在
    await expect(access(getMetaPath(transcriptPath))).rejects.toThrow();

    const { baseUrl } = await startServer(OWNER);
    const res = await fetch(`${baseUrl}/api/sessions/${sessionId}`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, softDeleted: true });

    // 副作用：stub meta 已落盘，归属请求者，且带软删标记
    const meta = await readSessionMeta(transcriptPath);
    expect(meta).not.toBeNull();
    expect(meta!.userId).toBe(OWNER.id);
    expect(meta!.username).toBe(OWNER.username);
    expect(meta!.channel).toBe('web');
    expect(meta!.deletedAt).toBeTruthy();
    expect(meta!.deletedBy).toBe(OWNER.username);
    // transcript 本体保留（软删不物理删除）
    await expect(access(transcriptPath)).resolves.toBeUndefined();
  });

  it('软删：transcript 在但 meta 缺失 → 他人（非 admin）403 且不写 stub meta', async () => {
    const { sessionId, transcriptPath } = await writeSession(OWNER, { skipMeta: true });

    const { baseUrl } = await startServer(OTHER);
    const res = await fetch(`${baseUrl}/api/sessions/${sessionId}`, { method: 'DELETE' });
    expect(res.status).toBe(403);
    expect((await res.json() as { error: string }).error).toBe('Access denied');

    // 副作用检查：既没有写 stub meta，transcript 也原样保留
    await expect(access(getMetaPath(transcriptPath))).rejects.toThrow();
    await expect(access(transcriptPath)).resolves.toBeUndefined();
  });

  it('软删：transcript 在但 meta 缺失 → 跨租户 org admin 403 且不收养（不写 stub meta）', async () => {
    // 修复后行为（sessions.ts stub-meta 分支的期望路径归属校验对所有角色生效）：
    // 任何非 owner——包括与会话毫无关系的其他租户组织 admin——都不能以自己
    // 身份补写 stub meta「收养」孤儿 transcript，统一 403 拒绝，所有权不被改写。
    const { sessionId, transcriptPath } = await writeSession(OWNER, { skipMeta: true });

    const { baseUrl } = await startServer(ACME_ADMIN);
    const res = await fetch(`${baseUrl}/api/sessions/${sessionId}`, { method: 'DELETE' });
    expect(res.status).toBe(403);
    expect((await res.json() as { error: string }).error).toBe('Access denied');

    // 副作用检查：stub meta 未被创建，transcript 原样保留
    await expect(access(getMetaPath(transcriptPath))).rejects.toThrow();
    await expect(access(transcriptPath)).resolves.toBeUndefined();
  });

  // ---------------------------------------------------------------------------
  // DELETE /sessions/:sessionId/permanent —— 残余分支
  // ---------------------------------------------------------------------------

  it('永久删除：孤儿 meta（无 .jsonl）走 metaOnly 分支物理删除，并级联 groupStore', async () => {
    const deletedAt = new Date().toISOString();
    const { sessionId, transcriptPath } = await writeSession(OWNER, {
      skipTranscript: true,
      metaPatch: { deletedAt, deletedBy: OWNER.username },
    });
    // 前置：只有 meta，没有 .jsonl
    await expect(access(transcriptPath)).rejects.toThrow();
    await expect(access(getMetaPath(transcriptPath))).resolves.toBeUndefined();

    const removedFromGroups: string[] = [];
    const groupStore = {
      removeSessionFromAllGroups: async (id: string) => {
        removedFromGroups.push(id);
      },
    } as unknown as GroupStore;

    const { baseUrl } = await startServer(OWNER, { groupStore });
    const res = await fetch(`${baseUrl}/api/sessions/${sessionId}/permanent`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, permanentlyDeleted: true });

    // 副作用：meta 文件被物理删除 + groupStore 级联清理被调用
    await expect(access(getMetaPath(transcriptPath))).rejects.toThrow();
    expect(removedFromGroups).toEqual([sessionId]);
  });

  it('永久删除：非 owner 与平台 admin 均 403（owner-self only），文件原样保留', async () => {
    const deletedAt = new Date().toISOString();
    const { sessionId, transcriptPath } = await writeSession(OWNER, {
      metaPatch: { deletedAt, deletedBy: OWNER.username },
    });

    const { baseUrl: otherBase } = await startServer(OTHER);
    const foreign = await fetch(`${otherBase}/api/sessions/${sessionId}/permanent`, { method: 'DELETE' });
    expect(foreign.status).toBe(403);
    expect((await foreign.json() as { error: string }).error).toBe('Access denied');

    // admin 代删除能力已收回：平台 admin 也 403
    const { baseUrl: adminBase } = await startServer(PLATFORM_ADMIN);
    const admin = await fetch(`${adminBase}/api/sessions/${sessionId}/permanent`, { method: 'DELETE' });
    expect(admin.status).toBe(403);

    // 副作用检查：transcript 与 meta 均未被删除
    await expect(access(transcriptPath)).resolves.toBeUndefined();
    const meta = await readSessionMeta(transcriptPath);
    expect(meta?.deletedAt).toBe(deletedAt);
  });

  it('永久删除：transcript 在但 meta 缺失 → owner 也 403（须先软删补 stub meta），文件保留', async () => {
    // 与侦察报告不同：stub meta 补建只存在于软删路由（L2468-2494）；
    // permanent 路由对 meta 缺失一律按 L2379 `!meta` → 403 处理。
    const { sessionId, transcriptPath } = await writeSession(OWNER, { skipMeta: true });

    const { baseUrl } = await startServer(OWNER);
    const res = await fetch(`${baseUrl}/api/sessions/${sessionId}/permanent`, { method: 'DELETE' });
    expect(res.status).toBe(403);
    expect((await res.json() as { error: string }).error).toBe('Access denied');
    await expect(access(transcriptPath)).resolves.toBeUndefined();
  });

  it('永久删除/恢复：未认证 401；永久删除非法 sessionId 400、不存在 404', async () => {
    const { baseUrl: anonBase } = await startServer(null);
    const anonPermanent = await fetch(`${anonBase}/api/sessions/${randomUUID()}/permanent`, { method: 'DELETE' });
    expect(anonPermanent.status).toBe(401);
    expect((await anonPermanent.json() as { error: string }).error).toBe('Authentication required');
    const anonRestore = await fetch(`${anonBase}/api/sessions/${randomUUID()}/restore`, { method: 'POST' });
    expect(anonRestore.status).toBe(401);

    const { baseUrl } = await startServer(OWNER);
    const badId = await fetch(`${baseUrl}/api/sessions/not-a-uuid/permanent`, { method: 'DELETE' });
    expect(badId.status).toBe(400);
    expect((await badId.json() as { error: string }).error).toBe('Invalid sessionId format');

    const missing = await fetch(`${baseUrl}/api/sessions/${randomUUID()}/permanent`, { method: 'DELETE' });
    expect(missing.status).toBe(404);
    expect((await missing.json() as { error: string }).error).toBe('Session not found');
  });
});
