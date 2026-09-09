import express from 'express';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  generateSuggestion: vi.fn(),
  readSessionMeta: vi.fn(),
  extractTitleContext: vi.fn(),
  listSessions: vi.fn(),
}));
vi.mock('../agent/titleGenerator.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../agent/titleGenerator.js')>()),
  extractTitleContext: mocks.extractTitleContext,
}));
vi.mock('../agent/sessionGroupGenerator.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../agent/sessionGroupGenerator.js')>()),
  generateSessionGroupingSuggestion: mocks.generateSuggestion,
}));
vi.mock('../data/transcripts/meta.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../data/transcripts/meta.js')>()),
  readSessionMeta: mocks.readSessionMeta,
}));
vi.mock('../data/transcripts/store.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../data/transcripts/store.js')>()),
  listSessions: mocks.listSessions,
}));

import { GroupStore } from '../data/groups/index.js';
import { UserStore } from '../data/users/store.js';
import { getTranscriptPath } from '../data/transcripts/store.js';
import { resolveUserCwd } from '../workspace/resolver.js';
import { createGroupsRouter } from '../routes/groups.js';

function stop(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

describe('smart grouping routes', () => {
  let root = '';
  let transcriptDir = '';
  let store: GroupStore;
  let users: UserStore;
  let user: { id: string; username: string; role: 'user'; tenantId: string };
  let server: Server | undefined;

  beforeEach(async () => {
    mocks.generateSuggestion.mockReset();
    mocks.readSessionMeta.mockReset();
    mocks.extractTitleContext.mockReset();
    mocks.listSessions.mockReset();
    root = await mkdtemp(join(tmpdir(), 'smart-groups-route-'));
    store = new GroupStore(join(root, 'groups.json'));
    users = new UserStore(join(root, 'users.json'));
    const created = await users.create({
      username: 'alice',
      password: 'password123',
      role: 'user',
      tenantId: 'kaiyan',
      createdBy: 'system',
    });
    user = { id: created.id, username: created.username, role: 'user', tenantId: created.tenantId };
    const cwd = resolveUserCwd(root, user);
    const sessionId = '11111111-1111-4111-8111-111111111111';
    const transcriptPath = getTranscriptPath(cwd, sessionId, {
      tenantId: user.tenantId,
      userId: user.id,
    });
    transcriptDir = dirname(transcriptPath);
    await mkdir(transcriptDir, { recursive: true });
    await writeFile(
      transcriptPath,
      JSON.stringify({ type: 'user', message: { content: '客户甲采购报价'.repeat(400) } }) + '\n',
    );
    mocks.readSessionMeta.mockResolvedValue({
      userId: user.id,
      username: user.username,
      channel: 'web',
      createdAt: new Date().toISOString(),
      cwd,
    });
    mocks.extractTitleContext.mockResolvedValue({
      userMessages: ['客户甲采购报价'],
      assistantReplies: ['已整理报价信息'],
    });
    mocks.listSessions.mockResolvedValue({
      items: [{ sessionId, updatedAtMs: Date.now(), transcriptPath }],
      hasMore: false,
    });

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.user = {
        sub: user.id,
        username: user.username,
        role: user.role,
        tenantId: user.tenantId,
      };
      next();
    });
    app.use(
      '/api',
      createGroupsRouter({
        groupStore: store,
        agentCwd: root,
        userStore: users,
        titleGeneratorConfigs: [{ model: 'test', connection: { apiKey: 'test' } }],
        getSessionGroupingSystemPrompt: () => '平台分组规则',
      }),
    );
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => resolve());
    });
  });

  afterEach(async () => {
    if (server) await stop(server);
    await rm(root, { recursive: true, force: true });
    await rm(transcriptDir, { recursive: true, force: true });
  });

  const url = (path: string) => {
    const address = server!.address();
    return `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}/api${path}`;
  };

  it('先只读生成方案，再确认应用并复用状态指纹', async () => {
    mocks.generateSuggestion.mockResolvedValue({
      groups: [{ name: '客户项目', sessionIds: ['11111111-1111-4111-8111-111111111111'] }],
      ungroupedSessionIds: [],
    });
    const planned = await fetch(url('/groups/smart-plan'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scope: 'ungrouped' }),
    });
    expect(planned.status).toBe(200);
    const plan = (await planned.json()) as any;
    expect(store.listByUserId(user.id)).toEqual([]);
    expect(mocks.generateSuggestion).toHaveBeenCalledWith(
      expect.objectContaining({ systemPrompt: '平台分组规则' }),
    );

    const applied = await fetch(url('/groups/smart-apply'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        fingerprint: plan.fingerprint,
        targetSessionIds: plan.sessions.map((item: any) => item.sessionId),
        groups: plan.groups,
      }),
    });
    expect(applied.status).toBe(200);
    expect(store.listByUserId(user.id)[0]).toMatchObject({
      name: '客户项目',
      sessionIds: ['11111111-1111-4111-8111-111111111111'],
    });
  });

  it('预览后分组变化时返回 409，且不创建建议分组', async () => {
    mocks.generateSuggestion.mockResolvedValue({
      groups: [{ name: '建议组', sessionIds: ['11111111-1111-4111-8111-111111111111'] }],
      ungroupedSessionIds: [],
    });
    const plan = (await (
      await fetch(url('/groups/smart-plan'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ scope: 'all' }),
      })
    ).json()) as any;
    await store.create({ userId: user.id, name: '并发新组', sessionIds: [] });
    const response = await fetch(url('/groups/smart-apply'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        fingerprint: plan.fingerprint,
        targetSessionIds: plan.sessions.map((item: any) => item.sessionId),
        groups: plan.groups,
      }),
    });
    expect(response.status).toBe(409);
    expect(store.listByUserId(user.id).some((group) => group.name === '建议组')).toBe(false);
  });
});
