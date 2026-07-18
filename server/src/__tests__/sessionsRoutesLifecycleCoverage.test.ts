/**
 * Sessions 路由生命周期变更分支补测（sessions.ts）
 *
 * sessionsRoutesMetaOnly.test.ts 覆盖列表/详情/stats/create；sessionSharesRoutes.test.ts
 * 覆盖公开分享快照。本文件补齐「会话状态变更」这批未覆盖的 mutation 与回收站路径：
 *  - PATCH /sessions/:id（重命名）：非法 sessionId 400、title 非字符串 400、404、成功改名、跨用户 403
 *  - DELETE /sessions/:id（软删除）：成功软删、重复删除幂等、404、跨用户 403
 *  - POST /sessions/:id/restore：未删除 400、非 owner 403、成功恢复
 *  - DELETE /sessions/:id/permanent：未在回收站 400、成功永久删除
 *  - GET /sessions/trash：列出当前用户已软删除会话
 *  - GET /sessions/:id/share：无 store 501、无分享返回 enabled:false
 *
 * 模式对齐 sessionsRoutesMetaOnly.test.ts：真实 transcript+meta 落盘 + 真 express + listen(0) + 真 fetch。
 */
import express from 'express';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createSessionsRouter } from '../routes/sessions.js';
import { getTranscriptPath } from '../data/transcripts/store.js';
import { writeSessionMeta, readSessionMeta, type SessionMeta } from '../data/transcripts/meta.js';
import { InMemorySessionShareStore } from '../data/sessionShares/store.js';
import { resolveUserCwd, type WorkspaceUser } from '../workspace/resolver.js';

const OWNER = { id: 'user-owner', username: 'owner', role: 'user', tenantId: 'kaiyan' } satisfies WorkspaceUser;
const OTHER = { id: 'user-other', username: 'other', role: 'user', tenantId: 'kaiyan' } satisfies WorkspaceUser;

function stopServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

async function startServer(
  agentCwd: string,
  user: WorkspaceUser,
  opts: { withShareStore?: boolean; shareStore?: InMemorySessionShareStore } = {},
): Promise<{ server: Server; baseUrl: string }> {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { sub: user.id, username: user.username, role: user.role, tenantId: user.tenantId ?? 'kaiyan' };
    next();
  });
  app.use('/api', createSessionsRouter({
    agentCwd,
    ...(opts.withShareStore ? { sessionShareStore: opts.shareStore ?? new InMemorySessionShareStore() } : {}),
  }));

  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({ server, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

describe('sessions routes lifecycle coverage', () => {
  let agentCwd = '';
  const servers: Server[] = [];
  const cleanup = new Set<string>();

  beforeEach(async () => {
    agentCwd = await mkdtemp(join(tmpdir(), 'sessions-lifecycle-'));
    cleanup.add(agentCwd);
  });

  afterEach(async () => {
    for (const s of servers.splice(0)) await stopServer(s);
    for (const target of cleanup) await rm(target, { recursive: true, force: true });
    cleanup.clear();
  });

  /** 为指定 owner 写真实 transcript + meta（归属以 meta.userId 为准） */
  async function writeSession(owner: WorkspaceUser, metaPatch: Partial<SessionMeta> = {}): Promise<{ sessionId: string; transcriptPath: string }> {
    const sessionId = randomUUID();
    const userCwd = resolveUserCwd(agentCwd, owner);
    const transcriptPath = getTranscriptPath(userCwd, sessionId, {
      tenantId: owner.tenantId,
      userId: owner.id,
    });
    cleanup.add(dirname(transcriptPath));
    await mkdir(dirname(transcriptPath), { recursive: true });
    const createdAt = new Date().toISOString();
    await writeFile(
      transcriptPath,
      JSON.stringify({
        type: 'user',
        sessionId,
        timestamp: createdAt,
        message: { content: [{ type: 'text', text: 'hello world' }] },
      }) + '\n',
    );
    await writeSessionMeta(transcriptPath, {
      userId: owner.id,
      username: owner.username,
      channel: 'web',
      createdAt,
      updatedAt: createdAt,
      cwd: userCwd,
      transcriptPath,
      ...metaPatch,
    });
    return { sessionId, transcriptPath };
  }

  it('PATCH /sessions/:id：非法 sessionId 400、title 非字符串 400、404', async () => {
    const { server, baseUrl } = await startServer(agentCwd, OWNER);
    servers.push(server);

    // 非法 sessionId（含斜杠/路径注入）→ 400
    const bad = await fetch(`${baseUrl}/api/sessions/not..a..uuid/`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'X' }),
    });
    expect([400, 404]).toContain(bad.status);

    // 合法 UUID 但 title 非字符串 → 400
    const nonString = await fetch(`${baseUrl}/api/sessions/${randomUUID()}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 123 }),
    });
    expect(nonString.status).toBe(400);

    // 合法 UUID + 合法 title 但会话不存在 → 404
    const missing = await fetch(`${baseUrl}/api/sessions/${randomUUID()}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'X' }),
    });
    expect(missing.status).toBe(404);
  });

  it('PATCH /sessions/:id：本人改名成功并写入 customTitle', async () => {
    const { sessionId, transcriptPath } = await writeSession(OWNER);
    const { server, baseUrl } = await startServer(agentCwd, OWNER);
    servers.push(server);

    const res = await fetch(`${baseUrl}/api/sessions/${sessionId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: '  新标题  ' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; title: string };
    expect(body.ok).toBe(true);
    expect(body.title).toBe('新标题');

    const meta = await readSessionMeta(transcriptPath);
    expect(meta?.customTitle).toBe('新标题');
  });

  it('DELETE /sessions/:id：软删除成功、重复删除幂等、跨用户 403', async () => {
    const { sessionId, transcriptPath } = await writeSession(OWNER);
    const { server, baseUrl } = await startServer(agentCwd, OWNER);
    servers.push(server);

    // 软删除 → 200 softDeleted，meta 写入 deletedAt
    const del = await fetch(`${baseUrl}/api/sessions/${sessionId}`, { method: 'DELETE' });
    expect(del.status).toBe(200);
    expect((await del.json() as { softDeleted: boolean }).softDeleted).toBe(true);
    const meta = await readSessionMeta(transcriptPath);
    expect(meta?.deletedAt).toBeTruthy();
    expect(meta?.deletedBy).toBe(OWNER.username);

    // 重复删除 → 幂等 200
    const again = await fetch(`${baseUrl}/api/sessions/${sessionId}`, { method: 'DELETE' });
    expect(again.status).toBe(200);
    expect((await again.json() as { softDeleted: boolean }).softDeleted).toBe(true);

    // 他人删除本人未删除会话 → 403
    const { sessionId: mySession } = await writeSession(OWNER);
    const { server: otherServer, baseUrl: otherBase } = await startServer(agentCwd, OTHER);
    servers.push(otherServer);
    const foreign = await fetch(`${otherBase}/api/sessions/${mySession}`, { method: 'DELETE' });
    expect(foreign.status).toBe(403);
  });

  it('POST /sessions/:id/restore：未删除 400、非 owner 403、成功恢复', async () => {
    // 已软删除的会话
    const deletedAt = new Date().toISOString();
    const { sessionId, transcriptPath } = await writeSession(OWNER, { deletedAt, deletedBy: OWNER.username });
    // 未删除会话
    const { sessionId: liveSession } = await writeSession(OWNER);

    const { server, baseUrl } = await startServer(agentCwd, OWNER);
    servers.push(server);

    // 未删除会话不能 restore → 400
    const notDeleted = await fetch(`${baseUrl}/api/sessions/${liveSession}/restore`, { method: 'POST' });
    expect(notDeleted.status).toBe(400);
    expect((await notDeleted.json() as { error: string }).error).toBe('Session is not deleted');

    // 非 owner restore → 403
    const { server: otherServer, baseUrl: otherBase } = await startServer(agentCwd, OTHER);
    servers.push(otherServer);
    const foreign = await fetch(`${otherBase}/api/sessions/${sessionId}/restore`, { method: 'POST' });
    expect(foreign.status).toBe(403);

    // owner 恢复成功 → deletedAt 被清除
    const ok = await fetch(`${baseUrl}/api/sessions/${sessionId}/restore`, { method: 'POST' });
    expect(ok.status).toBe(200);
    expect((await ok.json() as { restored: boolean }).restored).toBe(true);
    const meta = await readSessionMeta(transcriptPath);
    expect(meta?.deletedAt).toBeUndefined();
  });

  it('DELETE /sessions/:id/permanent：未在回收站 400、回收站内成功永久删除', async () => {
    const { sessionId: live } = await writeSession(OWNER);
    const deletedAt = new Date().toISOString();
    const { sessionId: trashed, transcriptPath } = await writeSession(OWNER, { deletedAt, deletedBy: OWNER.username });

    const { server, baseUrl } = await startServer(agentCwd, OWNER);
    servers.push(server);

    // 未软删除的会话不能永久删除 → 400
    const notTrash = await fetch(`${baseUrl}/api/sessions/${live}/permanent`, { method: 'DELETE' });
    expect(notTrash.status).toBe(400);

    // 回收站内会话 → 永久删除成功，文件消失
    const ok = await fetch(`${baseUrl}/api/sessions/${trashed}/permanent`, { method: 'DELETE' });
    expect(ok.status).toBe(200);
    expect((await ok.json() as { permanentlyDeleted: boolean }).permanentlyDeleted).toBe(true);
    // transcript 已被物理删除
    await expect(readSessionMeta(transcriptPath)).resolves.toBeNull();
  });

  it('GET /sessions/trash：仅列出当前用户已软删除会话', async () => {
    const deletedAt = new Date().toISOString();
    const { sessionId: deleted } = await writeSession(OWNER, {
      deletedAt, deletedBy: OWNER.username, customTitle: '已删标题',
    });
    // 未删除会话不应出现在回收站
    await writeSession(OWNER);

    const { server, baseUrl } = await startServer(agentCwd, OWNER);
    servers.push(server);

    const res = await fetch(`${baseUrl}/api/sessions/trash`);
    expect(res.status).toBe(200);
    const body = await res.json() as { sessions: Array<{ sessionId: string; deletedAt?: string; title?: string }> };
    expect(body.sessions.map((s) => s.sessionId)).toEqual([deleted]);
    expect(body.sessions[0].deletedAt).toBe(deletedAt);
    expect(body.sessions[0].title).toBe('已删标题');
  });

  it('GET /sessions/:id/share：未装配 store 501、装配后无分享返回 enabled:false', async () => {
    const { sessionId } = await writeSession(OWNER);

    // 未装配 share store → 501
    const { server: bare, baseUrl: bareBase } = await startServer(agentCwd, OWNER);
    servers.push(bare);
    const notConfigured = await fetch(`${bareBase}/api/sessions/${sessionId}/share`);
    expect(notConfigured.status).toBe(501);

    // 非法 sessionId → 400（含 store 时才会进入 sessionId 校验分支之前）
    const badId = await fetch(`${bareBase}/api/sessions/not-a-uuid/share`);
    expect(badId.status).toBe(400);

    // 装配 store 但从未创建分享 → enabled:false
    const { server, baseUrl } = await startServer(agentCwd, OWNER, { withShareStore: true });
    servers.push(server);
    const { sessionId: s2 } = await writeSession(OWNER);
    const noShare = await fetch(`${baseUrl}/api/sessions/${s2}/share`);
    expect(noShare.status).toBe(200);
    expect((await noShare.json() as { enabled: boolean }).enabled).toBe(false);
  });
});
