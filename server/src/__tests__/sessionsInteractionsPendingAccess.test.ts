/**
 * GET /chat/interactions/pending 会话归属守门防回归测试（routes/sessions.ts:2194-2293）
 *
 * 核实结论（assets/20260718/核实-platformObs跨租户.md，候选 S4）：
 * 该端点整段零覆盖，安全性完全押在 `canAccessSession` 一行 owner-self 校验上：
 *   - 非 admin 分支（2207）：getTranscriptPath(自己的 owner ref) → readSessionMeta → canAccessSession
 *   - admin 分支（2224）：findTranscriptPathBySessionId 全局扫描 → canAccessSession
 * canAccessSession（data/sessions/access.ts）无视 role，只认 meta.userId === reqUser.sub。
 * 一旦守门被误删或被加个 `|| isAdmin` 的「便利」分支，无测试会红。
 *
 * 本文件把「owner-self only、admin 不特权」钉死：断言各身份看他人 pending 恒 []。
 */
import express from 'express';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createSessionsRouter } from '../routes/sessions.js';
import { getTranscriptPath } from '../data/transcripts/store.js';
import { writeSessionMeta } from '../data/transcripts/meta.js';
import { FileEventStore, getRuntimeEventLogPath } from '../runtime/fileEventStore.js';
import { resolveUserCwd, type WorkspaceUser } from '../workspace/resolver.js';
import { interactionStore } from '../channels/web/interactionStore.js';

const OWNER: WorkspaceUser = { id: 'u-owner', username: 'owner', role: 'user', tenantId: 'kaiyan' };
const OTHER_USER: WorkspaceUser = { id: 'u-other', username: 'other', role: 'user', tenantId: 'kaiyan' };
// 组织 admin（同 kaiyan 租户，但非 owner）
const ORG_ADMIN: WorkspaceUser = { id: 'u-admin', username: 'org_admin', role: 'admin', tenantId: 'kaiyan' };
// 平台 admin（pantheon 租户 admin）——canAccessSession 也无视其特权
const PLATFORM_ADMIN: WorkspaceUser = { id: 'u-root', username: 'root', role: 'admin', tenantId: 'pantheon' };

const servers: Server[] = [];
// 记录所有注册到共享 interactionStore 的交互 id，afterEach 统一 reject 清理
const registeredInteractionIds = new Set<string>();

function jwtFor(user: WorkspaceUser) {
  return { sub: user.id, username: user.username, role: user.role, tenantId: user.tenantId! };
}

async function startServer(agentCwd: string, user: WorkspaceUser): Promise<{ server: Server; baseUrl: string }> {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = jwtFor(user);
    next();
  });
  app.use('/api', createSessionsRouter({
    agentCwd,
    runtimeEventStoreFor: (transcriptPath) => new FileEventStore(getRuntimeEventLogPath(transcriptPath)),
  }));
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({ server, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

function stopServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

/** 注册一个 SSE 断开后可存活的 ask_user 交互，归属指定 session。 */
function registerPending(sessionId: string, ownerUserId: string): string {
  const interactionId = randomUUID();
  // create() 返回一个不 resolve 的 Promise（等用户回答）；我们不 await。
  // afterEach 里 reject 清理，.catch 吞掉 rejection 避免 vitest 报 unhandled rejection。
  interactionStore.create(interactionId, 'ask_user', {
    sessionId,
    userId: ownerUserId,
    questions: [{ question: '继续？', header: '确认', options: [{ label: '是', description: '' }], multiSelect: false }],
  }).catch(() => { /* rejected on cleanup */ });
  registeredInteractionIds.add(interactionId);
  return interactionId;
}

describe('GET /chat/interactions/pending owner-self access guard', () => {
  let agentCwd = '';
  const cleanupPaths = new Set<string>();

  beforeEach(async () => {
    agentCwd = await mkdtemp(join(tmpdir(), 'sessions-pending-'));
    cleanupPaths.add(agentCwd);
  });

  afterEach(async () => {
    for (const id of registeredInteractionIds) interactionStore.reject(id, 'test cleanup');
    registeredInteractionIds.clear();
    for (const target of cleanupPaths) await rm(target, { recursive: true, force: true });
    cleanupPaths.clear();
  });

  /** 在 owner 的 canonical transcript 目录下落 meta + 真实 .jsonl（供 admin 分支全局扫描命中）。 */
  async function writeOwnedSession(sessionId: string): Promise<void> {
    const ownerCwd = resolveUserCwd(agentCwd, OWNER);
    const transcriptPath = getTranscriptPath(ownerCwd, sessionId, { tenantId: OWNER.tenantId, userId: OWNER.id });
    cleanupPaths.add(dirname(transcriptPath));
    await writeSessionMeta(transcriptPath, {
      userId: OWNER.id,
      username: OWNER.username,
      tenantId: OWNER.tenantId,
      channel: 'web',
      createdAt: new Date().toISOString(),
      cwd: ownerCwd,
      transcriptPath,
      runtimeStatus: 'running',
    });
    // 真实 transcript 文件：admin 分支的 findTranscriptPathBySessionId 只认 .jsonl
    await writeFile(transcriptPath, JSON.stringify({ type: 'user', message: { content: 'hi' } }) + '\n');
  }

  async function fetchPending(baseUrl: string, sessionId?: string): Promise<{ status: number; body: unknown }> {
    const qs = sessionId === undefined ? '' : `?sessionId=${encodeURIComponent(sessionId)}`;
    const res = await fetch(`${baseUrl}/api/chat/interactions/pending${qs}`);
    return { status: res.status, body: await res.json() };
  }

  it('owner 自看：返回本会话对应的 pending 交互', async () => {
    const sessionId = randomUUID();
    await writeOwnedSession(sessionId);
    const interactionId = registerPending(sessionId, OWNER.id);

    const { server, baseUrl } = await startServer(agentCwd, OWNER);
    try {
      const { status, body } = await fetchPending(baseUrl, sessionId);
      expect(status).toBe(200);
      expect(Array.isArray(body)).toBe(true);
      expect(body).toEqual([expect.objectContaining({ interactionId, type: 'ask_user' })]);
    } finally {
      await stopServer(server);
    }
  });

  it('他人普通 user 看 owner 会话：canAccessSession false → []', async () => {
    const sessionId = randomUUID();
    await writeOwnedSession(sessionId);
    registerPending(sessionId, OWNER.id); // pending 存在，但守门应挡住

    const { server, baseUrl } = await startServer(agentCwd, OTHER_USER);
    try {
      const { status, body } = await fetchPending(baseUrl, sessionId);
      expect(status).toBe(200);
      expect(body).toEqual([]);
    } finally {
      await stopServer(server);
    }
  });

  it('组织 admin 看他人会话：admin 分支全局扫描命中 + canAccessSession false → []（admin 无特权）', async () => {
    const sessionId = randomUUID();
    await writeOwnedSession(sessionId);
    registerPending(sessionId, OWNER.id);

    const { server, baseUrl } = await startServer(agentCwd, ORG_ADMIN);
    try {
      const { status, body } = await fetchPending(baseUrl, sessionId);
      expect(status).toBe(200);
      expect(body).toEqual([]);
    } finally {
      await stopServer(server);
    }
  });

  it('平台 admin 看他人会话：canAccessSession 同样无视 role → []', async () => {
    const sessionId = randomUUID();
    await writeOwnedSession(sessionId);
    registerPending(sessionId, OWNER.id);

    const { server, baseUrl } = await startServer(agentCwd, PLATFORM_ADMIN);
    try {
      const { status, body } = await fetchPending(baseUrl, sessionId);
      expect(status).toBe(200);
      expect(body).toEqual([]);
    } finally {
      await stopServer(server);
    }
  });

  it('缺 sessionId → 400', async () => {
    const { server, baseUrl } = await startServer(agentCwd, OWNER);
    try {
      const { status, body } = await fetchPending(baseUrl);
      expect(status).toBe(400);
      expect((body as { error: string }).error).toBe('sessionId required');
    } finally {
      await stopServer(server);
    }
  });
});
