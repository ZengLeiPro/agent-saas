/**
 * 组织对话质检台路由测试（/api/admin/qa，计划用例 16）
 *
 * 16. 租户隔离：组织 admin 传他人 tenantId → 403；messages 跨租户 sessionId → 404
 *     （防枚举：projection get({tenantId}) 守卫）；同租户正常读通 + orgAgentId 过滤透传
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Server } from 'node:http';

import { createOrgQaRouter, type QaSessionProjectionReader } from '../routes/orgQa.js';
import { OrgAgentStore } from '../data/orgAgents/store.js';
import type { RuntimeSessionListQuery, RuntimeSessionProjectionRecord } from '../runtime/sessionProjectionStore.js';
import type { SessionMeta } from '../data/transcripts/meta.js';

const SESSION_A = '11111111-1111-4111-8111-111111111111';
const SESSION_B = '22222222-2222-4222-8222-222222222222';

interface TestUser {
  sub: string;
  username: string;
  role: 'admin' | 'user';
  tenantId: string;
}

function record(sessionId: string, tenantId: string, orgAgentId: string): RuntimeSessionProjectionRecord {
  return {
    sessionId,
    tenantId,
    userId: `u-${tenantId}`,
    username: `emp-${tenantId}`,
    kind: 'user',
    title: `会话 ${sessionId.slice(0, 8)}`,
    updatedAt: '2026-07-10T08:00:00.000Z',
    createdAt: '2026-07-10T07:00:00.000Z',
    metaJson: { userId: `u-${tenantId}`, username: `emp-${tenantId}`, tenantId, channel: 'web', createdAt: '2026-07-10T07:00:00.000Z', orgAgentId } as SessionMeta,
  };
}

/** 内存 projection reader：按 tenantId/orgAgentId 过滤，语义与 PG 实现对齐 */
function memoryProjection(records: RuntimeSessionProjectionRecord[]): QaSessionProjectionReader & { lastListQuery: RuntimeSessionListQuery | null } {
  const state = {
    lastListQuery: null as RuntimeSessionListQuery | null,
    async get(sessionId: string, options: { tenantId?: string; includeDeleted?: boolean } = {}) {
      const hit = records.find((r) => r.sessionId === sessionId);
      if (!hit) return null;
      if (options.tenantId && hit.tenantId !== options.tenantId) return null;
      return hit;
    },
    async list(query: RuntimeSessionListQuery = {}) {
      state.lastListQuery = query;
      const items = records.filter((r) => {
        if (query.tenantId && r.tenantId !== query.tenantId) return false;
        const orgAgentId = r.metaJson.orgAgentId;
        if (query.orgAgentId) return orgAgentId === query.orgAgentId;
        if (query.hasOrgAgent) return !!orgAgentId;
        return true;
      });
      return { items };
    },
  };
  return state;
}

async function startServer(deps: Parameters<typeof createOrgQaRouter>[0], user: TestUser): Promise<{ server: Server; baseUrl: string }> {
  const app = express();
  app.use((req, _res, next) => {
    (req as unknown as { user: TestUser }).user = user;
    next();
  });
  app.use('/api/admin/qa', createOrgQaRouter(deps));
  return new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => {
      const addr = s.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({ server: s, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

function stopServer(s: Server): Promise<void> {
  return new Promise((resolve) => s.close(() => resolve()));
}

describe('/api/admin/qa routes', () => {
  let dataDir: string;
  let server: Server | null = null;
  let baseUrl = '';
  let orgAgentStore: OrgAgentStore;
  let projection: ReturnType<typeof memoryProjection>;

  const orgAdminA: TestUser = { sub: 'admin-a', username: 'admin-a', role: 'admin', tenantId: 'tenant-a' };

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'org-qa-routes-test-'));
    orgAgentStore = new OrgAgentStore(join(dataDir, 'org-agents.json'));
    projection = memoryProjection([
      record(SESSION_A, 'tenant-a', 'oa-1'),
      record(SESSION_B, 'tenant-b', 'oa-2'),
    ]);
  });

  afterEach(async () => {
    if (server) {
      await stopServer(server);
      server = null;
    }
    await rm(dataDir, { recursive: true, force: true });
  });

  it('用例16: 组织 admin 传他人 tenantId → 403；messages 跨租户 sessionId → 404', async () => {
    const agent = await orgAgentStore.create({
      tenantId: 'tenant-a',
      name: '产品选型助手',
      instructions: '只回答产品选型问题',
      allowedSkills: [],
      audience: { exposure: 'all', usernames: [] },
      guardrail: { enabled: false, scopeDescription: '', rejectionMessage: '超范围', strictness: 'strict' },
      enabled: true,
    }, 'admin-a');
    // projection 里 tenant-a 的会话绑定到真实 agent id 以验证 name join
    projection = memoryProjection([
      record(SESSION_A, 'tenant-a', agent.id),
      record(SESSION_B, 'tenant-b', 'oa-2'),
    ]);
    ({ server, baseUrl } = await startServer({
      sessionProjectionStore: projection,
      orgAgentStore,
      resolveTranscriptPath: async () => null,
    }, orgAdminA));

    // 组织 admin 传他人 tenantId → 403（sessions / guardrail-events / feedback 三端点同口径）
    for (const path of ['/sessions', '/guardrail-events', '/feedback']) {
      const res = await fetch(`${baseUrl}/api/admin/qa${path}?tenantId=tenant-b`);
      expect(res.status).toBe(403);
    }

    // messages：跨租户 sessionId → 404（防枚举，不暴露存在性）
    const crossTenant = await fetch(`${baseUrl}/api/admin/qa/sessions/${SESSION_B}/messages`);
    expect(crossTenant.status).toBe(404);

    // 同租户会话列表：只见本租户 + orgAgentName join + 未指定 orgAgentId 时 hasOrgAgent 过滤
    const list = await fetch(`${baseUrl}/api/admin/qa/sessions`);
    expect(list.status).toBe(200);
    const listBody = await list.json() as { items: Array<{ sessionId: string; orgAgentId: string; orgAgentName: string }> };
    expect(listBody.items).toHaveLength(1);
    expect(listBody.items[0].sessionId).toBe(SESSION_A);
    expect(listBody.items[0].orgAgentId).toBe(agent.id);
    expect(listBody.items[0].orgAgentName).toBe('产品选型助手');
    expect(projection.lastListQuery?.tenantId).toBe('tenant-a');
    expect(projection.lastListQuery?.hasOrgAgent).toBe(true);

    // orgAgentId 过滤透传
    await fetch(`${baseUrl}/api/admin/qa/sessions?orgAgentId=${agent.id}`);
    expect(projection.lastListQuery?.orgAgentId).toBe(agent.id);

    // 同租户 messages 读通（transcript 缺失时空 blocks 兜底）
    const messages = await fetch(`${baseUrl}/api/admin/qa/sessions/${SESSION_A}/messages`);
    expect(messages.status).toBe(200);
    const detail = await messages.json() as { sessionId: string; blocks: unknown[]; owner?: { userId: string } };
    expect(detail.sessionId).toBe(SESSION_A);
    expect(detail.blocks).toEqual([]);
    expect(detail.owner?.userId).toBe('u-tenant-a');

    // store 未装配 → 503（PG 不可用红线）
    const bare = await startServer({ orgAgentStore }, orgAdminA);
    try {
      const res503 = await fetch(`${bare.baseUrl}/api/admin/qa/sessions`);
      expect(res503.status).toBe(503);
      const ge503 = await fetch(`${bare.baseUrl}/api/admin/qa/guardrail-events`);
      expect(ge503.status).toBe(503);
      const fb503 = await fetch(`${bare.baseUrl}/api/admin/qa/feedback`);
      expect(fb503.status).toBe(503);
    } finally {
      await stopServer(bare.server);
    }
  });
});
