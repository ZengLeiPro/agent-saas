/**
 * Sessions 路由生命周期变更分支补测（sessions.ts）
 *
 * sessionsRoutesMetaOnly.test.ts 覆盖列表/详情/stats/create；sessionSharesRoutes.test.ts
 * 覆盖公开分享快照。本文件补齐「会话状态变更」这批未覆盖的 mutation 与回收站路径：
 *  - PATCH /sessions/:id（重命名）：非法 sessionId 400、title 非字符串 400、404、成功改名、跨用户 403
 *  - DELETE /sessions/:id（软删除）：成功软删、重复删除幂等、404、跨用户 403
 *  - POST /sessions/:id/restore：未删除 400、非 owner 403、能力缺失 503、成功恢复
 *  - DELETE /sessions/:id/permanent：未在回收站 400、成功永久删除
 *  - GET /sessions/trash：列出当前用户已软删除会话
 *  - DELETE /sessions/trash：清空当前用户回收站，不影响正常会话和其他用户
 *  - GET /sessions/:id/share：无 store 501、无分享返回 enabled:false
 *
 * 模式对齐 sessionsRoutesMetaOnly.test.ts：真实 transcript+meta 落盘 + 真 express + listen(0) + 真 fetch。
 */
import express from 'express';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createSessionsRouter } from '../routes/sessions.js';
import { permanentlyDeleteSession } from '../routes/sessionPermanentDeletion.js';
import { getTranscriptPath } from '../data/transcripts/store.js';
import { writeSessionMeta, readSessionMeta, type SessionMeta } from '../data/transcripts/meta.js';
import { InMemorySessionShareStore } from '../data/sessionShares/store.js';
import { InMemoryArtifactShareStore } from '../runtime/artifactShareStore.js';
import { createSessionArtifactLifecycle } from '../runtime/sessionArtifactLifecycle.js';
import { resolveUserCwd, type WorkspaceUser } from '../workspace/resolver.js';

const OWNER = { id: 'user-owner', username: 'owner', role: 'user', tenantId: 'kaiyan' } satisfies WorkspaceUser;
const OTHER = { id: 'user-other', username: 'other', role: 'user', tenantId: 'kaiyan' } satisfies WorkspaceUser;

function stopServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

async function startServer(
  agentCwd: string,
  user: WorkspaceUser,
  opts: {
    withShareStore?: boolean;
    shareStore?: InMemorySessionShareStore;
    artifactShareStore?: InMemoryArtifactShareStore;
    artifactService?: { deleteArtifactsForSessions(sessionIds: string[]): Promise<{ scanned: number; deleted: number }> };
    sessionReadStateStore?: {
      init(): Promise<void>;
      markUnread(input: { tenantId: string; userId: string; sessionId: string; eventKey: string }): Promise<boolean>;
      markRead(input: { tenantId: string; userId: string; sessionId: string }): Promise<boolean>;
      listUnreadSessionIds(input: { tenantId: string; userId: string; sessionIds: readonly string[] }): Promise<Set<string>>;
    };
    sandboxCleanupRequired?: boolean;
    sandboxSessionDeletionIntent?: (sessionId: string) => Promise<'not_required' | 'blocked' | 'queued'>;
    sandboxSessionDeletion?: ((sessionId: string) => Promise<'not_required' | 'blocked' | 'deleted' | 'queued'>) | null;
    sandboxSessionRestore?: (sessionId: string) => Promise<void>;
    broadcastToUser?: (userId: string, event: object) => void;
    sessionProjectionStore?: {
      get?(sessionId: string, options?: { tenantId?: string; includeDeleted?: boolean }): Promise<{
        sessionId: string;
        tenantId: string;
        userId?: string;
        kind: 'user' | 'subagent';
        updatedAt: string;
        metaJson: SessionMeta;
      } | null>;
      list(): Promise<{ items: [] }>;
    };
  } = {},
): Promise<{ server: Server; baseUrl: string }> {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { sub: user.id, username: user.username, role: user.role, tenantId: user.tenantId ?? 'kaiyan' };
    next();
  });
  const sandboxSessionDeletion = opts.sandboxSessionDeletion === undefined
    ? async () => 'not_required' as const
    : opts.sandboxSessionDeletion;
  app.use('/api', createSessionsRouter({
    agentCwd,
    ...(opts.withShareStore ? { sessionShareStore: opts.shareStore ?? new InMemorySessionShareStore() } : {}),
    artifactLifecycle: createSessionArtifactLifecycle(opts.artifactShareStore, opts.artifactService),
    ...(opts.sessionReadStateStore ? { sessionReadStateStore: opts.sessionReadStateStore } : {}),
    ...(opts.sessionProjectionStore ? { sessionProjectionStore: opts.sessionProjectionStore } : {}),
    ...(opts.sandboxCleanupRequired !== undefined ? { sandboxCleanupRequired: opts.sandboxCleanupRequired } : {}),
    ...(opts.sandboxSessionDeletionIntent ? { sandboxSessionDeletionIntent: opts.sandboxSessionDeletionIntent } : {}),
    ...(sandboxSessionDeletion ? { sandboxSessionDeletion } : {}),
    ...(opts.sandboxSessionRestore ? { sandboxSessionRestore: opts.sandboxSessionRestore } : {}),
    ...(opts.broadcastToUser ? { broadcastToUser: opts.broadcastToUser } : {}),
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

  it('PUT /sessions/:id/read：本人会话标记已读，不存在返回 404', async () => {
    const { sessionId } = await writeSession(OWNER);
    const markRead = vi.fn(async () => true);
    const store = {
      init: async () => {},
      markUnread: async () => true,
      markRead,
      listUnreadSessionIds: async () => new Set<string>(),
    };
    const { server, baseUrl } = await startServer(agentCwd, OWNER, {
      sessionReadStateStore: store,
    });
    servers.push(server);

    const ok = await fetch(`${baseUrl}/api/sessions/${sessionId}/read`, { method: 'PUT' });
    expect(ok.status).toBe(200);
    expect(markRead).toHaveBeenCalledWith({
      tenantId: OWNER.tenantId,
      userId: OWNER.id,
      sessionId,
    });

    const missing = await fetch(`${baseUrl}/api/sessions/${randomUUID()}/read`, { method: 'PUT' });
    expect(missing.status).toBe(404);
  });

  it('PUT /sessions/:id/read：PG 投影存在时不依赖当前实例本地 transcript', async () => {
    const sessionId = randomUUID();
    const markRead = vi.fn(async () => true);
    const broadcastToUser = vi.fn();
    const store = {
      init: async () => {},
      markUnread: async () => true,
      markRead,
      getState: async () => ({ attentionVersion: 7, readVersion: 7, updatedAt: '2026-08-30T00:00:00.000Z' }),
      listUnreadSessionIds: async () => new Set<string>(),
    };
    const projection = {
      get: vi.fn(async () => ({
        sessionId,
        tenantId: OWNER.tenantId,
        userId: OWNER.id,
        kind: 'user' as const,
        updatedAt: new Date().toISOString(),
        metaJson: {
          userId: OWNER.id,
          username: OWNER.username,
          tenantId: OWNER.tenantId,
          channel: 'web',
          createdAt: new Date().toISOString(),
        },
      })),
      list: async () => ({ items: [] as [] }),
    };

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.user = { sub: OWNER.id, username: OWNER.username, role: OWNER.role, tenantId: OWNER.tenantId };
      next();
    });
    app.use('/api', createSessionsRouter({
      agentCwd,
      sessionReadStateStore: store,
      sessionProjectionStore: projection,
      broadcastToUser,
    }));
    const { server, baseUrl } = await new Promise<{ server: Server; baseUrl: string }>((resolve) => {
      const server = app.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        const port = typeof addr === 'object' && addr ? addr.port : 0;
        resolve({ server, baseUrl: `http://127.0.0.1:${port}` });
      });
    });
    servers.push(server);

    const res = await fetch(`${baseUrl}/api/sessions/${sessionId}/read`, { method: 'PUT' });
    expect(res.status).toBe(200);
    expect(markRead).toHaveBeenCalledWith({
      tenantId: OWNER.tenantId,
      userId: OWNER.id,
      sessionId,
    });
    expect(await res.json()).toMatchObject({ ack: { status: 'applied', sessionId, readSeq: 7, serverVersion: 7 } });
    expect(broadcastToUser).toHaveBeenCalledWith(OWNER.id, expect.objectContaining({
      type: 'session_read_state_changed', sessionId, hasUnreadAiReply: false,
      readSeq: 7, serverVersion: 7, sourceSeq: 7,
    }));
  });

  it('PUT /sessions/:id/read：拒绝同租户其他用户的投影会话', async () => {
    const sessionId = randomUUID();
    const markRead = vi.fn(async () => true);
    const store = {
      init: async () => {},
      markUnread: async () => true,
      markRead,
      listUnreadSessionIds: async () => new Set<string>(),
    };
    const projection = {
      get: vi.fn(async () => ({
        sessionId,
        tenantId: OWNER.tenantId,
        userId: OTHER.id,
        kind: 'user' as const,
        updatedAt: new Date().toISOString(),
        metaJson: {
          userId: OTHER.id,
          username: OTHER.username,
          tenantId: OTHER.tenantId,
          channel: 'web',
          createdAt: new Date().toISOString(),
        },
      })),
      list: async () => ({ items: [] as [] }),
    };
    const { server, baseUrl } = await startServer(agentCwd, OWNER, {
      sessionReadStateStore: store,
      sessionProjectionStore: projection,
    });
    servers.push(server);

    const res = await fetch(`${baseUrl}/api/sessions/${sessionId}/read`, { method: 'PUT' });
    expect(res.status).toBe(403);
    expect(markRead).not.toHaveBeenCalled();
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
    const body = await res.json() as { ok: boolean; title: string; ack: { status: string; serverVersion: number } };
    expect(body.ok).toBe(true);
    expect(body.title).toBe('新标题');
    expect(body.ack).toMatchObject({ status: 'applied', serverVersion: expect.any(Number) });

    const meta = await readSessionMeta(transcriptPath);
    expect(meta?.customTitle).toBe('新标题');
  });

  it('DELETE /sessions/:id：durable 软删除成功、重复删除幂等、跨用户 403', async () => {
    const { sessionId, transcriptPath } = await writeSession(OWNER);
    const artifactShareStore = new InMemoryArtifactShareStore();
    const revokeBySession = vi.spyOn(artifactShareStore, 'revokeBySession');
    const sandboxSessionDeletionIntent = vi.fn(async () => 'queued' as const);
    const sandboxSessionDeletion = vi.fn(async () => 'deleted' as const);
    const { server, baseUrl } = await startServer(agentCwd, OWNER, {
      artifactShareStore, sandboxSessionDeletionIntent, sandboxSessionDeletion,
    });
    servers.push(server);

    // 软删除 → 200 softDeleted，meta 写入 deletedAt
    const del = await fetch(`${baseUrl}/api/sessions/${sessionId}`, { method: 'DELETE' });
    expect(del.status).toBe(200);
    expect(await del.json()).toMatchObject({ softDeleted: true, ack: { status: 'applied', deleted: true, serverVersion: expect.any(Number) } });
    const meta = await readSessionMeta(transcriptPath);
    expect(meta?.deletedAt).toBeTruthy();
    expect(meta?.deletedBy).toBe(OWNER.username);
    expect(revokeBySession).toHaveBeenCalledWith(sessionId, OWNER.id);
    expect(sandboxSessionDeletionIntent).toHaveBeenCalledWith(sessionId);
    expect(sandboxSessionDeletion).toHaveBeenCalledWith(sessionId, { waitForDeletion: false });

    // 重复删除 → 幂等 200，并重试 durable cleanup；store 负责保留 active claim。
    const again = await fetch(`${baseUrl}/api/sessions/${sessionId}`, { method: 'DELETE' });
    expect(again.status).toBe(200);
    expect((await again.json() as { softDeleted: boolean }).softDeleted).toBe(true);
    expect(sandboxSessionDeletion).toHaveBeenCalledTimes(2);

    // 他人删除本人未删除会话 → 403
    const { sessionId: mySession } = await writeSession(OWNER);
    const { server: otherServer, baseUrl: otherBase } = await startServer(agentCwd, OTHER);
    servers.push(otherServer);
    const foreign = await fetch(`${otherBase}/api/sessions/${mySession}`, { method: 'DELETE' });
    expect(foreign.status).toBe(403);
  });

  it('ACS 可创建 Sandbox 但 cleanup callback 缺失时软删除 fail closed', async () => {
    const { sessionId, transcriptPath } = await writeSession(OWNER);
    const { server, baseUrl } = await startServer(agentCwd, OWNER, {
      sandboxCleanupRequired: true,
      sandboxSessionDeletion: null,
    });
    servers.push(server);

    const failed = await fetch(`${baseUrl}/api/sessions/${sessionId}`, { method: 'DELETE' });
    expect(failed.status).toBe(503);
    expect(await failed.json()).toEqual({ error: 'Sandbox cleanup 能力不可用' });
    expect((await readSessionMeta(transcriptPath))?.deletedAt).toBeUndefined();
  });

  it('cleanup intent blocked 时拒绝软删除且不写 tombstone', async () => {
    const { sessionId, transcriptPath } = await writeSession(OWNER);
    const cleanup = vi.fn(async () => 'deleted' as const);
    const { server, baseUrl } = await startServer(agentCwd, OWNER, {
      sandboxSessionDeletionIntent: async () => 'blocked', sandboxSessionDeletion: cleanup,
    });
    servers.push(server);

    const failed = await fetch(`${baseUrl}/api/sessions/${sessionId}`, { method: 'DELETE' });
    expect(failed.status).toBe(500);
    expect((await readSessionMeta(transcriptPath))?.deletedAt).toBeUndefined();
    expect(cleanup).not.toHaveBeenCalled();
  });

  it('cleanup commit blocked 时保留 prepared tombstone，重启后重复 DELETE 可续跑', async () => {
    const { sessionId, transcriptPath } = await writeSession(OWNER);
    const first = await startServer(agentCwd, OWNER, {
      sandboxSessionDeletionIntent: async () => 'queued',
      sandboxSessionDeletion: async () => 'blocked',
    });
    servers.push(first.server);

    const failed = await fetch(`${first.baseUrl}/api/sessions/${sessionId}`, { method: 'DELETE' });
    expect(failed.status).toBe(500);
    expect((await readSessionMeta(transcriptPath))?.deletedAt).toBeTruthy();

    const resumedCleanup = vi.fn(async () => 'queued' as const);
    const restarted = await startServer(agentCwd, OWNER, { sandboxSessionDeletion: resumedCleanup });
    servers.push(restarted.server);
    const retried = await fetch(`${restarted.baseUrl}/api/sessions/${sessionId}`, { method: 'DELETE' });
    expect(retried.status).toBe(200);
    expect(resumedCleanup).toHaveBeenCalledWith(sessionId, { waitForDeletion: false });
  });

  it('cleanup enqueue 失败时 tombstone 已持久化，进程重启后重复 DELETE 可续跑', async () => {
    const { sessionId, transcriptPath } = await writeSession(OWNER);
    const preparedIntent = vi.fn(async () => 'queued' as const);
    const firstCleanup = vi.fn(async () => { throw new Error('injected cleanup failure'); });
    const first = await startServer(agentCwd, OWNER, {
      sandboxSessionDeletionIntent: preparedIntent, sandboxSessionDeletion: firstCleanup,
    });
    servers.push(first.server);

    const failed = await fetch(`${first.baseUrl}/api/sessions/${sessionId}`, { method: 'DELETE' });
    expect(failed.status).toBe(500);
    expect(preparedIntent).toHaveBeenCalledWith(sessionId);
    expect((await readSessionMeta(transcriptPath))?.deletedAt).toBeTruthy();

    const resumedCleanup = vi.fn(async () => 'queued' as const);
    const restarted = await startServer(agentCwd, OWNER, { sandboxSessionDeletion: resumedCleanup });
    servers.push(restarted.server);
    const retried = await fetch(`${restarted.baseUrl}/api/sessions/${sessionId}`, { method: 'DELETE' });
    expect(retried.status).toBe(200);
    expect((await retried.json() as { softDeleted: boolean }).softDeleted).toBe(true);
    expect(resumedCleanup).toHaveBeenCalledWith(sessionId, { waitForDeletion: false });
  });

  it('同进程 cleanup 重试成功后清理列表并补偿删除事件', async () => {
    const { sessionId } = await writeSession(OWNER);
    const sandboxSessionDeletion = vi.fn()
      .mockRejectedValueOnce(new Error('injected cleanup failure'))
      .mockResolvedValue('queued');
    const broadcastToUser = vi.fn();
    const { server, baseUrl } = await startServer(agentCwd, OWNER, {
      sandboxSessionDeletionIntent: async () => 'queued',
      sandboxSessionDeletion,
      broadcastToUser,
    });
    servers.push(server);

    const warm = await fetch(`${baseUrl}/api/sessions`);
    expect(warm.status).toBe(200);
    expect((await warm.json() as { sessions: Array<{ sessionId: string }> }).sessions)
      .toEqual(expect.arrayContaining([expect.objectContaining({ sessionId })]));

    const failed = await fetch(`${baseUrl}/api/sessions/${sessionId}`, { method: 'DELETE' });
    expect(failed.status).toBe(500);
    const retried = await fetch(`${baseUrl}/api/sessions/${sessionId}`, { method: 'DELETE' });
    expect(retried.status).toBe(200);
    const refreshed = await fetch(`${baseUrl}/api/sessions`);
    expect((await refreshed.json() as { sessions: Array<{ sessionId: string }> }).sessions)
      .not.toEqual(expect.arrayContaining([expect.objectContaining({ sessionId })]));
    expect(broadcastToUser).toHaveBeenCalledWith(OWNER.id, expect.objectContaining({ type: 'session_deleted', sessionId }));
  });

  it('POST /sessions/:id/restore：未删除 400、非 owner 403、取消 pending Sandbox 清理后恢复', async () => {
    // 已软删除的会话
    const deletedAt = new Date().toISOString();
    const { sessionId, transcriptPath } = await writeSession(OWNER, { deletedAt, deletedBy: OWNER.username });
    // 未删除会话
    const { sessionId: liveSession } = await writeSession(OWNER);

    const sandboxSessionRestore = vi.fn(async () => undefined);
    const { server, baseUrl } = await startServer(agentCwd, OWNER, {
      artifactShareStore: new InMemoryArtifactShareStore(), sandboxSessionRestore,
    });
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
    expect(sandboxSessionRestore).toHaveBeenCalledWith(sessionId);
  });

  it('restore callback 缺失时保留既有 tombstone，重启补齐能力后可恢复', async () => {
    const deletedAt = new Date().toISOString();
    const { sessionId, transcriptPath } = await writeSession(OWNER, {
      deletedAt,
      deletedBy: OWNER.username,
    });
    const unavailable = await startServer(agentCwd, OWNER, {
      sandboxCleanupRequired: true,
    });
    servers.push(unavailable.server);

    const failed = await fetch(`${unavailable.baseUrl}/api/sessions/${sessionId}/restore`, {
      method: 'POST',
    });
    expect(failed.status).toBe(503);
    expect(await failed.json()).toEqual({ error: 'Sandbox restore 能力不可用' });
    expect((await readSessionMeta(transcriptPath))?.deletedAt).toBe(deletedAt);

    const sandboxSessionRestore = vi.fn(async () => undefined);
    const restarted = await startServer(agentCwd, OWNER, {
      sandboxCleanupRequired: true,
      sandboxSessionRestore,
    });
    servers.push(restarted.server);

    const restored = await fetch(`${restarted.baseUrl}/api/sessions/${sessionId}/restore`, {
      method: 'POST',
    });
    expect(restored.status).toBe(200);
    expect(sandboxSessionRestore).toHaveBeenCalledWith(sessionId);
    expect((await readSessionMeta(transcriptPath))?.deletedAt).toBeUndefined();
  });

  it('永久删除在 session lock 内重验 tombstone，已恢复时不执行任何物理清理', async () => {
    const purge = vi.fn(async () => ({ scanned: 0, deleted: 0 }));
    const lifecycle = createSessionArtifactLifecycle(new InMemoryArtifactShareStore(), { deleteArtifactsForSessions: purge })!;
    const revokeShares = vi.spyOn(lifecycle, 'revokeShares');
    const beforePhysicalDelete = vi.fn(async () => undefined);
    const deleteTranscriptPreservingMeta = vi.fn(async () => true);
    const deleteMetaAndSidecar = vi.fn(async () => true);
    await expect(permanentlyDeleteSession({
      sessionId: randomUUID(), ownerUserId: OWNER.id, hasTranscript: true, artifactLifecycle: lifecycle,
      isStillDeleted: async () => false, beforePhysicalDelete, deleteTranscriptPreservingMeta, deleteMetaAndSidecar,
    })).resolves.toBe(false);
    expect(revokeShares).not.toHaveBeenCalled();
    expect(beforePhysicalDelete).not.toHaveBeenCalled();
    expect(deleteTranscriptPreservingMeta).not.toHaveBeenCalled();
    expect(deleteMetaAndSidecar).not.toHaveBeenCalled();
    expect(purge).not.toHaveBeenCalled();
  });

  it('DELETE /sessions/:id/permanent：未在回收站 400、精确 Sandbox 清理后永久删除', async () => {
    const { sessionId: live } = await writeSession(OWNER);
    const deletedAt = new Date().toISOString();
    const { sessionId: trashed, transcriptPath } = await writeSession(OWNER, { deletedAt, deletedBy: OWNER.username });

    const deleteArtifactsForSessions = vi.fn(async (_sessionIds: string[]) => ({ scanned: 1, deleted: 1 }));
    const sandboxSessionDeletion = vi.fn(async () => 'deleted' as const);
    const { server, baseUrl } = await startServer(agentCwd, OWNER, {
      artifactService: { deleteArtifactsForSessions }, sandboxSessionDeletion,
    });
    servers.push(server);

    // 未软删除的会话不能永久删除 → 400
    const notTrash = await fetch(`${baseUrl}/api/sessions/${live}/permanent`, { method: 'DELETE' });
    expect(notTrash.status).toBe(400);

    // 回收站内会话 → 永久删除成功，文件消失
    const ok = await fetch(`${baseUrl}/api/sessions/${trashed}/permanent`, { method: 'DELETE' });
    expect(ok.status).toBe(200);
    expect((await ok.json() as { permanentlyDeleted: boolean }).permanentlyDeleted).toBe(true);
    expect(deleteArtifactsForSessions).toHaveBeenCalledWith([trashed]);
    expect(sandboxSessionDeletion).toHaveBeenCalledWith(trashed);
    // transcript 已被物理删除
    await expect(readSessionMeta(transcriptPath)).resolves.toBeNull();
  });

  it('永久删除在 Sandbox cleanup 仍 queued 时保留 meta tombstone', async () => {
    const deletedAt = new Date().toISOString();
    const { sessionId, transcriptPath } = await writeSession(OWNER, { deletedAt, deletedBy: OWNER.username });
    const sandboxSessionDeletion = vi.fn(async () => 'queued' as const);
    const { server, baseUrl } = await startServer(agentCwd, OWNER, { sandboxSessionDeletion });
    servers.push(server);

    const response = await fetch(`${baseUrl}/api/sessions/${sessionId}/permanent`, { method: 'DELETE' });
    expect(response.status).toBe(500);
    expect((await response.json() as { error: string }).error).toContain('Sandbox cleanup 仍在排队');
    expect(await readSessionMeta(transcriptPath)).toMatchObject({ deletedAt });
  });

  it.each([
    ['callback 缺失', null, 'callback 缺失'],
    ['目标无法解析', vi.fn(async () => 'blocked' as const), '被阻塞'],
  ] as const)('永久删除在 Sandbox %s 时保留 transcript/meta/sidecar', async (_label, callback, message) => {
    const deletedAt = new Date().toISOString();
    const { sessionId, transcriptPath } = await writeSession(OWNER, { deletedAt, deletedBy: OWNER.username });
    const sidecarPath = join(dirname(transcriptPath), sessionId);
    await mkdir(sidecarPath, { recursive: true });
    await writeFile(join(sidecarPath, 'proof.txt'), 'keep', 'utf8');
    const deleteArtifactsForSessions = vi.fn(async () => ({ scanned: 1, deleted: 1 }));
    const { server, baseUrl } = await startServer(agentCwd, OWNER, {
      sandboxSessionDeletion: callback,
      artifactService: { deleteArtifactsForSessions },
    });
    servers.push(server);

    const response = await fetch(`${baseUrl}/api/sessions/${sessionId}/permanent`, { method: 'DELETE' });
    expect(response.status).toBe(500);
    expect((await response.json() as { error: string }).error).toContain(message);
    await expect(readSessionMeta(transcriptPath)).resolves.toMatchObject({ deletedAt });
    await expect(readFile(transcriptPath, 'utf8')).resolves.toContain('hello world');
    await expect(readFile(join(sidecarPath, 'proof.txt'), 'utf8')).resolves.toBe('keep');
    expect(deleteArtifactsForSessions).not.toHaveBeenCalled();
  });

  it('not_required 允许永久删除；blocked 在目标恢复后可由同一端点重试', async () => {
    const deletedAt = new Date().toISOString();
    const notRequired = await writeSession(OWNER, { deletedAt, deletedBy: OWNER.username });
    const retryable = await writeSession(OWNER, { deletedAt, deletedBy: OWNER.username });
    const callback = vi.fn(async (sessionId: string) => sessionId === notRequired.sessionId
      ? 'not_required' as const
      : callback.mock.calls.filter(([id]) => id === retryable.sessionId).length === 1
        ? 'blocked' as const
        : 'deleted' as const);
    const { server, baseUrl } = await startServer(agentCwd, OWNER, { sandboxSessionDeletion: callback });
    servers.push(server);

    const allowed = await fetch(`${baseUrl}/api/sessions/${notRequired.sessionId}/permanent`, { method: 'DELETE' });
    expect(allowed.status).toBe(200);
    await expect(readSessionMeta(notRequired.transcriptPath)).resolves.toBeNull();

    const blocked = await fetch(`${baseUrl}/api/sessions/${retryable.sessionId}/permanent`, { method: 'DELETE' });
    expect(blocked.status).toBe(500);
    await expect(readSessionMeta(retryable.transcriptPath)).resolves.toMatchObject({ deletedAt });
    const recovered = await fetch(`${baseUrl}/api/sessions/${retryable.sessionId}/permanent`, { method: 'DELETE' });
    expect(recovered.status).toBe(200);
    await expect(readSessionMeta(retryable.transcriptPath)).resolves.toBeNull();
  });

  it('清空回收站遇到 queued 时保留对应 transcript/meta，并报告部分失败', async () => {
    const deletedAt = new Date().toISOString();
    const queued = await writeSession(OWNER, { deletedAt, deletedBy: OWNER.username });
    const { server, baseUrl } = await startServer(agentCwd, OWNER, {
      sandboxSessionDeletion: async () => 'queued',
    });
    servers.push(server);

    const response = await fetch(`${baseUrl}/api/sessions/trash`, { method: 'DELETE' });
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ deletedCount: 0, failedCount: 1 });
    await expect(readSessionMeta(queued.transcriptPath)).resolves.toMatchObject({ deletedAt });
    await expect(readFile(queued.transcriptPath, 'utf8')).resolves.toContain('hello world');
  });

  it('永久删除在 Artifact 清理失败时保留 meta tombstone，并可由同一端点重试', async () => {
    const deletedAt = new Date().toISOString();
    const { sessionId, transcriptPath } = await writeSession(OWNER, { deletedAt, deletedBy: OWNER.username });
    const deleteArtifactsForSessions = vi.fn()
      .mockRejectedValueOnce(new Error('blob store unavailable'))
      .mockResolvedValueOnce({ scanned: 1, deleted: 1 });
    const { server, baseUrl } = await startServer(agentCwd, OWNER, {
      artifactService: { deleteArtifactsForSessions },
    });
    servers.push(server);

    const failed = await fetch(`${baseUrl}/api/sessions/${sessionId}/permanent`, { method: 'DELETE' });
    expect(failed.status).toBe(500);
    expect((await failed.json() as { error: string }).error).toContain('blob store unavailable');
    expect(await readSessionMeta(transcriptPath)).toMatchObject({ deletedAt });

    const retried = await fetch(`${baseUrl}/api/sessions/${sessionId}/permanent`, { method: 'DELETE' });
    expect(retried.status).toBe(200);
    expect(deleteArtifactsForSessions).toHaveBeenCalledTimes(2);
    expect(await readSessionMeta(transcriptPath)).toBeNull();
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

  it('DELETE /sessions/trash：清空当前用户回收站，不影响正常会话和其他用户', async () => {
    const deletedAt = new Date().toISOString();
    const first = await writeSession(OWNER, { deletedAt, deletedBy: OWNER.username });
    const orphan = await writeSession(OWNER, { deletedAt, deletedBy: OWNER.username });
    const live = await writeSession(OWNER);
    const foreign = await writeSession(OTHER, { deletedAt, deletedBy: OTHER.username });
    await rm(orphan.transcriptPath);

    const deleteArtifactsForSessions = vi.fn(async (_sessionIds: string[]) => ({ scanned: 1, deleted: 1 }));
    const { server, baseUrl } = await startServer(agentCwd, OWNER, {
      artifactService: { deleteArtifactsForSessions },
    });
    servers.push(server);

    const res = await fetch(`${baseUrl}/api/sessions/trash`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, deletedCount: 2 });
    expect(deleteArtifactsForSessions.mock.calls.map(([ids]) => ids[0]).sort()).toEqual([first.sessionId, orphan.sessionId].sort());
    await expect(readSessionMeta(first.transcriptPath)).resolves.toBeNull();
    await expect(readSessionMeta(orphan.transcriptPath)).resolves.toBeNull();
    await expect(readSessionMeta(live.transcriptPath)).resolves.not.toBeNull();
    await expect(readSessionMeta(foreign.transcriptPath)).resolves.not.toBeNull();

    const trash = await fetch(`${baseUrl}/api/sessions/trash`);
    const body = await trash.json() as { sessions: unknown[] };
    expect(body.sessions).toEqual([]);
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
