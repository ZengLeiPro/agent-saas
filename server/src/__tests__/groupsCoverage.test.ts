/**
 * Groups 路由未覆盖分支补测（groups.ts）
 *
 * 现有 groupsRoutes.test.ts 仅覆盖「软删除会话从分组列表剔除」一条路径。
 * 本文件补齐真实 HTTP 行为的 CRUD、权限边界与 session 归属校验分支：
 *  - GET /groups：只返回本人分组
 *  - POST /groups：name 必填(400)、forUser 禁止代建(403)、session 归属失败(400)、成功(201)
 *  - PATCH /groups/:id：404、跨用户 403、更新名称成功
 *  - DELETE /groups/:id：404、跨用户 403、成功
 *  - POST/DELETE /groups/:id/sessions：空数组 400、归属失败 400、成功
 *  - GET /groups/:id/sessions：空成员返回 []、404
 *
 * 模式对齐 feedbackRoutes.test.ts：内存/真实 store 依赖注入 + 真 express + app.listen(0) + 真 fetch。
 */
import express from 'express';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { GroupStore } from '../data/groups/index.js';
import { UserStore } from '../data/users/store.js';
import { getTranscriptPath } from '../data/transcripts/store.js';
import { writeSessionMeta } from '../data/transcripts/meta.js';
import { resolveUserCwd } from '../workspace/resolver.js';
import { createGroupsRouter } from '../routes/groups.js';

interface TestUser {
  id: string;
  username: string;
  role: 'admin' | 'user';
  tenantId: string;
}

const OWNER: TestUser = { id: 'user-owner', username: 'owner', role: 'user', tenantId: 'kaiyan' };
const OTHER: TestUser = { id: 'user-other', username: 'other', role: 'user', tenantId: 'kaiyan' };

function stopServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

async function startServer(
  agentCwd: string,
  groupStore: GroupStore,
  user: TestUser,
  userStore?: UserStore,
): Promise<{ server: Server; baseUrl: string }> {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { sub: user.id, username: user.username, role: user.role, tenantId: user.tenantId };
    next();
  });
  app.use('/api', createGroupsRouter({ groupStore, agentCwd, userStore }));

  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({ server, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

describe('groups routes coverage', () => {
  let agentCwd = '';
  let groupStore: GroupStore;
  let userStore: UserStore;
  const servers: Server[] = [];
  const cleanup = new Set<string>();

  beforeEach(async () => {
    agentCwd = await mkdtemp(join(tmpdir(), 'groups-cov-'));
    cleanup.add(agentCwd);
    groupStore = new GroupStore(join(agentCwd, 'groups.json'));
    userStore = new UserStore(join(agentCwd, 'users.json'));
    // 直接向 store 注入用户记录（避免 create 触发密码 hash 等副作用无关本测试）
    await userStore.create({
      username: OWNER.username,
      password: 'password123',
      role: OWNER.role,
      tenantId: OWNER.tenantId,
      createdBy: 'system',
    });
  });

  afterEach(async () => {
    for (const s of servers.splice(0)) await stopServer(s);
    for (const target of cleanup) await rm(target, { recursive: true, force: true });
    cleanup.clear();
  });

  /** 为指定 owner 写一条真实 transcript + meta（归属校验以 meta.userId 为准） */
  async function writeSession(owner: TestUser): Promise<string> {
    const sessionId = randomUUID();
    const ownerRecord = userStore.findByUsername(owner.username);
    const userCwd = resolveUserCwd(agentCwd, {
      id: ownerRecord?.id ?? owner.id,
      username: owner.username,
      role: owner.role,
      tenantId: owner.tenantId,
    });
    const transcriptPath = getTranscriptPath(userCwd, sessionId, {
      tenantId: owner.tenantId,
      userId: ownerRecord?.id ?? owner.id,
    });
    cleanup.add(dirname(transcriptPath));
    await mkdir(dirname(transcriptPath), { recursive: true });
    await writeFile(
      transcriptPath,
      JSON.stringify({
        type: 'user',
        sessionId,
        timestamp: new Date().toISOString(),
        message: { content: [{ type: 'text', text: 'hello' }] },
      }) + '\n',
    );
    await writeSessionMeta(transcriptPath, {
      userId: ownerRecord?.id ?? owner.id,
      username: owner.username,
      channel: 'web',
      createdAt: new Date().toISOString(),
      cwd: userCwd,
      transcriptPath,
    });
    return sessionId;
  }

  it('GET /groups 只返回本人分组', async () => {
    const ownerRecord = userStore.findByUsername(OWNER.username)!;
    await groupStore.create({ name: 'Mine', userId: ownerRecord.id, sessionIds: [] });
    await groupStore.create({ name: 'Theirs', userId: OTHER.id, sessionIds: [] });

    const { server, baseUrl } = await startServer(agentCwd, groupStore, { ...OWNER, id: ownerRecord.id }, userStore);
    servers.push(server);

    const res = await fetch(`${baseUrl}/api/groups`);
    expect(res.status).toBe(200);
    const body = await res.json() as { groups: Array<{ name: string; userId: string }> };
    expect(body.groups.map((g) => g.name)).toEqual(['Mine']);
  });

  it('GET /groups 不暴露记忆轮询系统分组', async () => {
    const ownerRecord = userStore.findByUsername(OWNER.username)!;
    await groupStore.create({ name: '客户项目', userId: ownerRecord.id, sessionIds: [] });
    await groupStore.create({ name: '每日简报', kind: 'cron', cronJobId: 'daily', userId: ownerRecord.id, sessionIds: [] });
    await groupStore.create({ name: '记忆轮询', kind: 'cron', cronJobId: 'memory', userId: ownerRecord.id, sessionIds: [] });

    const { server, baseUrl } = await startServer(agentCwd, groupStore, { ...OWNER, id: ownerRecord.id }, userStore);
    servers.push(server);

    const res = await fetch(`${baseUrl}/api/groups`);
    expect(res.status).toBe(200);
    const body = await res.json() as { groups: Array<{ name: string }> };
    expect(body.groups.map((group) => group.name)).toEqual(['客户项目', '每日简报']);
  });

  it('POST /groups：name 必填 400、forUser 代建 403、成功 201', async () => {
    const ownerRecord = userStore.findByUsername(OWNER.username)!;
    const { server, baseUrl } = await startServer(agentCwd, groupStore, { ...OWNER, id: ownerRecord.id }, userStore);
    servers.push(server);

    // name 空白 → 400
    const noName = await fetch(`${baseUrl}/api/groups`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '   ' }),
    });
    expect(noName.status).toBe(400);
    expect((await noName.json() as { error: string }).error).toBe('name is required');

    // forUser 代其他人创建 → 403
    const forUser = await fetch(`${baseUrl}/api/groups`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'X', forUser: 'someone' }),
    });
    expect(forUser.status).toBe(403);

    // 成功创建（无初始 session）→ 201
    const ok = await fetch(`${baseUrl}/api/groups`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Work' }),
    });
    expect(ok.status).toBe(201);
    const created = await ok.json() as { id: string; name: string; userId: string };
    expect(created.name).toBe('Work');
    expect(created.userId).toBe(ownerRecord.id);
  });

  it('POST /groups：初始 session 归属校验失败 → 400', async () => {
    const ownerRecord = userStore.findByUsername(OWNER.username)!;
    const foreignSession = await writeSession(OTHER); // 归属 OTHER，OWNER 不能带入
    const { server, baseUrl } = await startServer(agentCwd, groupStore, { ...OWNER, id: ownerRecord.id }, userStore);
    servers.push(server);

    const res = await fetch(`${baseUrl}/api/groups`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Bad', sessionIds: [foreignSession] }),
    });
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toContain('does not belong to group owner');
  });

  it('POST /groups：带本人 session 创建成功并落盘', async () => {
    const ownerRecord = userStore.findByUsername(OWNER.username)!;
    const ownSession = await writeSession({ ...OWNER, id: ownerRecord.id });
    const { server, baseUrl } = await startServer(agentCwd, groupStore, { ...OWNER, id: ownerRecord.id }, userStore);
    servers.push(server);

    const res = await fetch(`${baseUrl}/api/groups`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'WithSession', sessionIds: [ownSession] }),
    });
    expect(res.status).toBe(201);
    const created = await res.json() as { id: string; sessionIds: string[] };
    expect(created.sessionIds).toContain(ownSession);
  });

  it('PATCH /groups/:id：404、跨用户 403、改名成功', async () => {
    const ownerRecord = userStore.findByUsername(OWNER.username)!;
    const mine = await groupStore.create({ name: 'Old', userId: ownerRecord.id, sessionIds: [] });
    const theirs = await groupStore.create({ name: 'Foreign', userId: OTHER.id, sessionIds: [] });

    const { server, baseUrl } = await startServer(agentCwd, groupStore, { ...OWNER, id: ownerRecord.id }, userStore);
    servers.push(server);

    // 不存在 → 404
    const missing = await fetch(`${baseUrl}/api/groups/does-not-exist`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'X' }),
    });
    expect(missing.status).toBe(404);

    // 他人分组 → 403
    const foreign = await fetch(`${baseUrl}/api/groups/${theirs.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Hijack' }),
    });
    expect(foreign.status).toBe(403);

    // 本人改名 → 200
    const ok = await fetch(`${baseUrl}/api/groups/${mine.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'New' }),
    });
    expect(ok.status).toBe(200);
    expect((await ok.json() as { name: string }).name).toBe('New');
  });

  it('DELETE /groups/:id：404、跨用户 403、成功', async () => {
    const ownerRecord = userStore.findByUsername(OWNER.username)!;
    const mine = await groupStore.create({ name: 'Del', userId: ownerRecord.id, sessionIds: [] });
    const theirs = await groupStore.create({ name: 'Foreign', userId: OTHER.id, sessionIds: [] });

    const { server, baseUrl } = await startServer(agentCwd, groupStore, { ...OWNER, id: ownerRecord.id }, userStore);
    servers.push(server);

    expect((await fetch(`${baseUrl}/api/groups/nope`, { method: 'DELETE' })).status).toBe(404);
    expect((await fetch(`${baseUrl}/api/groups/${theirs.id}`, { method: 'DELETE' })).status).toBe(403);

    const ok = await fetch(`${baseUrl}/api/groups/${mine.id}`, { method: 'DELETE' });
    expect(ok.status).toBe(200);
    expect((await ok.json() as { ok: boolean }).ok).toBe(true);
    expect(groupStore.findById(mine.id)).toBeUndefined();
  });

  it('POST /groups/:id/sessions：空数组 400、归属失败 400、成功', async () => {
    const ownerRecord = userStore.findByUsername(OWNER.username)!;
    const group = await groupStore.create({ name: 'G', userId: ownerRecord.id, sessionIds: [] });
    const ownSession = await writeSession({ ...OWNER, id: ownerRecord.id });
    const foreignSession = await writeSession(OTHER);

    const { server, baseUrl } = await startServer(agentCwd, groupStore, { ...OWNER, id: ownerRecord.id }, userStore);
    servers.push(server);

    // 空数组 → 400
    const empty = await fetch(`${baseUrl}/api/groups/${group.id}/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionIds: [] }),
    });
    expect(empty.status).toBe(400);

    // 归属失败 → 400
    const bad = await fetch(`${baseUrl}/api/groups/${group.id}/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionIds: [foreignSession] }),
    });
    expect(bad.status).toBe(400);

    // 本人 session 加入 → 200
    const ok = await fetch(`${baseUrl}/api/groups/${group.id}/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionIds: [ownSession] }),
    });
    expect(ok.status).toBe(200);
    const body = await ok.json() as { group: { sessionIds: string[] } };
    expect(body.group.sessionIds).toContain(ownSession);
  });

  it('DELETE /groups/:id/sessions：空数组 400、移除成功', async () => {
    const ownerRecord = userStore.findByUsername(OWNER.username)!;
    const ownSession = await writeSession({ ...OWNER, id: ownerRecord.id });
    const group = await groupStore.create({ name: 'G', userId: ownerRecord.id, sessionIds: [ownSession] });

    const { server, baseUrl } = await startServer(agentCwd, groupStore, { ...OWNER, id: ownerRecord.id }, userStore);
    servers.push(server);

    const empty = await fetch(`${baseUrl}/api/groups/${group.id}/sessions`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionIds: [] }),
    });
    expect(empty.status).toBe(400);

    const ok = await fetch(`${baseUrl}/api/groups/${group.id}/sessions`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionIds: [ownSession] }),
    });
    expect(ok.status).toBe(200);
    const body = await ok.json() as { group: { sessionIds: string[] } };
    expect(body.group.sessionIds).not.toContain(ownSession);
  });

  it('GET /groups/:id/sessions：空成员返回 []、404、跨用户 403', async () => {
    const ownerRecord = userStore.findByUsername(OWNER.username)!;
    const empty = await groupStore.create({ name: 'Empty', userId: ownerRecord.id, sessionIds: [] });
    const theirs = await groupStore.create({ name: 'Foreign', userId: OTHER.id, sessionIds: [] });

    const { server, baseUrl } = await startServer(agentCwd, groupStore, { ...OWNER, id: ownerRecord.id }, userStore);
    servers.push(server);

    // 空成员 → { sessions: [] }
    const emptyRes = await fetch(`${baseUrl}/api/groups/${empty.id}/sessions`);
    expect(emptyRes.status).toBe(200);
    expect((await emptyRes.json() as { sessions: unknown[] }).sessions).toEqual([]);

    // 不存在 → 404
    expect((await fetch(`${baseUrl}/api/groups/nope/sessions`)).status).toBe(404);

    // 他人分组 → 403
    expect((await fetch(`${baseUrl}/api/groups/${theirs.id}/sessions`)).status).toBe(403);
  });
});
