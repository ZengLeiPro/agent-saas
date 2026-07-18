/**
 * 员工申诉路由测试（/api/appeals + /api/tenant/appeals）
 *
 * 覆盖：
 *   1. 员工提申诉：合法路径落库 + 幂等 409 + 缺失 owner 403 + 未登录 401
 *   2. 越权保护：跨租户 event 探测返回 404；他人 event 提申诉 403（防越权）
 *   3. 管理员处理：pending → accepted/rejected；重复处理 409；组织 admin 强制自身租户
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import { randomUUID } from 'node:crypto';

import { createAppealsRouter, createTenantAppealsRouter } from '../routes/appeals.js';
import { DuplicateAppealError, type AppealStore } from '../data/appeals/store.js';
import type {
  AppealHandleInput,
  GuardrailAppealInsert,
  GuardrailAppealListFilter,
  GuardrailAppealListResult,
  GuardrailAppealRecord,
  GuardrailEventOwnerLookup,
} from '../data/appeals/types.js';
import type { JwtPayload } from '../auth/types.js';
import { DEFAULT_TENANT_ID } from '../data/tenants/types.js';

const PLATFORM_ADMIN: JwtPayload = { sub: 'u-platform', username: 'admin', role: 'admin', tenantId: DEFAULT_TENANT_ID };
const WAIN_ADMIN: JwtPayload = { sub: 'u-wa', username: 'wain_admin', role: 'admin', tenantId: 'wain' };
const WAIN_USER: JwtPayload = { sub: 'u-wu', username: 'wain_user', role: 'user', tenantId: 'wain' };
const WAIN_OTHER: JwtPayload = { sub: 'u-wo', username: 'wain_other', role: 'user', tenantId: 'wain' };
const KAIYAN_USER: JwtPayload = { sub: 'u-ku', username: 'kaiyan_user', role: 'user', tenantId: 'kaiyan' };
const KAIYAN_ADMIN: JwtPayload = { sub: 'u-ka', username: 'kaiyan_admin', role: 'admin', tenantId: 'kaiyan' };

/** 内存 AppealStore 实现 — 与 PG 语义对齐（UNIQUE guardrail_event_id + user_id 幂等） */
class MemoryAppealStore implements AppealStore {
  records: GuardrailAppealRecord[] = [];
  /** 预置的 guardrail_events owner 数据：eventId → owner */
  events = new Map<string, GuardrailEventOwnerLookup>();

  seedGuardrailEvent(id: string, owner: GuardrailEventOwnerLookup): void {
    this.events.set(id, owner);
  }

  async create(input: GuardrailAppealInsert): Promise<GuardrailAppealRecord> {
    if (this.records.some((r) => r.guardrailEventId === input.guardrailEventId && r.userId === input.userId)) {
      throw new DuplicateAppealError();
    }
    const record: GuardrailAppealRecord = {
      id: `ap-${randomUUID()}`,
      tenantId: input.tenantId,
      guardrailEventId: input.guardrailEventId,
      userId: input.userId,
      userMessage: input.userMessage,
      expertId: input.expertId,
      ...(input.appealReason ? { appealReason: input.appealReason } : {}),
      status: 'pending',
      createdAt: new Date().toISOString(),
    };
    this.records.push(record);
    return { ...record };
  }

  async getById(id: string, tenantId: string): Promise<GuardrailAppealRecord | null> {
    const found = this.records.find((r) => r.id === id && r.tenantId === tenantId);
    return found ? { ...found } : null;
  }

  async list(filter: GuardrailAppealListFilter): Promise<GuardrailAppealListResult> {
    let items = this.records.filter((r) => r.tenantId === filter.tenantId);
    if (filter.status) items = items.filter((r) => r.status === filter.status);
    if (filter.expertId) items = items.filter((r) => r.expertId === filter.expertId);
    if (filter.userId) items = items.filter((r) => r.userId === filter.userId);
    const total = items.length;
    const offset = filter.offset ?? 0;
    const limit = filter.limit ?? 50;
    return { items: items.slice(offset, offset + limit).map((r) => ({ ...r })), total };
  }

  async handle(id: string, tenantId: string, input: AppealHandleInput): Promise<GuardrailAppealRecord | null> {
    const idx = this.records.findIndex((r) => r.id === id && r.tenantId === tenantId && r.status === 'pending');
    if (idx < 0) return null;
    const record = this.records[idx];
    record.status = input.status;
    record.handledBy = input.handledBy;
    record.handledAt = new Date().toISOString();
    if (input.handleNote) record.handleNote = input.handleNote;
    return { ...record };
  }

  async getGuardrailEventOwner(guardrailEventId: string): Promise<GuardrailEventOwnerLookup | null> {
    return this.events.get(guardrailEventId) ?? null;
  }
}

interface TestRig {
  store: MemoryAppealStore;
  setCaller(caller: JwtPayload | null): void;
  request(path: string, init?: RequestInit): Promise<Response>;
  close(): Promise<void>;
}

async function makeRig(): Promise<TestRig> {
  const store = new MemoryAppealStore();
  const app = express();
  app.use(express.json());
  let currentCaller: JwtPayload | null = WAIN_USER;
  app.use((req, _res, next) => {
    if (currentCaller) req.user = currentCaller;
    next();
  });
  app.use('/api/appeals', createAppealsRouter({ appealStore: store }));
  app.use('/api/tenant/appeals', createTenantAppealsRouter({ appealStore: store }));
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const addr = server.address();
  const baseUrl = typeof addr === 'object' && addr ? `http://127.0.0.1:${addr.port}` : '';
  return {
    store,
    setCaller(c) { currentCaller = c; },
    request: (path, init) => fetch(`${baseUrl}${path}`, init),
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

function postJson(body: unknown): RequestInit {
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

describe('/api/appeals 员工申诉路由', () => {
  let h: TestRig;

  beforeEach(async () => { h = await makeRig(); });
  afterEach(async () => { await h.close(); });

  it('员工提申诉 → 落库；重复提交返回 409（UNIQUE 幂等）；未登录 401', async () => {
    // 预置一条属于 WAIN_USER 的 guardrail_event
    h.store.seedGuardrailEvent('evt-1', {
      tenantId: 'wain',
      userId: WAIN_USER.sub,
      orgAgentId: 'oa-quote',
      messageText: '帮我审这份报价单',
    });

    h.setCaller(WAIN_USER);
    const first = await h.request('/api/appeals', postJson({
      guardrailEventId: 'evt-1',
      appealReason: '这是关于报价的问题，我认为不应该被拒答',
    }));
    expect(first.status).toBe(201);
    const record = await first.json() as { id: string; status: string; expertId: string; userMessage: string; appealReason?: string; userId: string; tenantId: string };
    expect(record.status).toBe('pending');
    // 服务端从 guardrail_event 反查填 expertId + userMessage（不接受客户端伪造）
    expect(record.expertId).toBe('oa-quote');
    expect(record.userMessage).toBe('帮我审这份报价单');
    expect(record.appealReason).toBe('这是关于报价的问题，我认为不应该被拒答');
    expect(record.userId).toBe(WAIN_USER.sub);
    expect(record.tenantId).toBe('wain');

    // 同一员工对同一 event 重复申诉 → 409（UNIQUE 幂等）
    const dup = await h.request('/api/appeals', postJson({ guardrailEventId: 'evt-1' }));
    expect(dup.status).toBe(409);
    const dupBody = await dup.json() as { code?: string };
    expect(dupBody.code).toBe('DUPLICATE_APPEAL');
    expect(h.store.records).toHaveLength(1);

    // 未登录 → 401
    h.setCaller(null);
    const anon = await h.request('/api/appeals', postJson({ guardrailEventId: 'evt-1' }));
    expect(anon.status).toBe(401);
  });

  it('越权保护：他人的 guardrail_event → 403；跨租户 event → 404 防探测；未知 event → 404', async () => {
    // 属于 WAIN_OTHER（同租户其他员工）的 event
    h.store.seedGuardrailEvent('evt-other', {
      tenantId: 'wain',
      userId: WAIN_OTHER.sub,
      orgAgentId: 'oa-x',
      messageText: '别人的消息',
    });
    // 属于 kaiyan 租户的 event
    h.store.seedGuardrailEvent('evt-kaiyan', {
      tenantId: 'kaiyan',
      userId: KAIYAN_USER.sub,
      orgAgentId: 'oa-y',
      messageText: '跨租户消息',
    });
    // 匿名 event（未记 userId 的旧数据）
    h.store.seedGuardrailEvent('evt-anon', {
      tenantId: 'wain',
      orgAgentId: 'oa-z',
      messageText: '匿名拒答',
    });

    h.setCaller(WAIN_USER);

    // 同租户他人 event → 403
    const foreign = await h.request('/api/appeals', postJson({ guardrailEventId: 'evt-other' }));
    expect(foreign.status).toBe(403);

    // 跨租户 event → 404（不泄漏存在性）
    const cross = await h.request('/api/appeals', postJson({ guardrailEventId: 'evt-kaiyan' }));
    expect(cross.status).toBe(404);

    // 匿名 event（无 userId 记录）→ 403（无法验证归属，宁少不错）
    const anon = await h.request('/api/appeals', postJson({ guardrailEventId: 'evt-anon' }));
    expect(anon.status).toBe(403);

    // 完全不存在的 event → 404
    const unknown = await h.request('/api/appeals', postJson({ guardrailEventId: 'evt-nope' }));
    expect(unknown.status).toBe(404);

    // 均未落库
    expect(h.store.records).toHaveLength(0);
  });

  it('管理员处理申诉：list 分页 + status 过滤；pending → accepted；重复处理 409；跨租户 403/404', async () => {
    // 准备：wain 租户 2 条申诉、kaiyan 1 条
    h.store.seedGuardrailEvent('evt-w1', { tenantId: 'wain', userId: WAIN_USER.sub, orgAgentId: 'oa-quote', messageText: 'q1' });
    h.store.seedGuardrailEvent('evt-w2', { tenantId: 'wain', userId: WAIN_OTHER.sub, orgAgentId: 'oa-analyst', messageText: 'q2' });
    h.store.seedGuardrailEvent('evt-k1', { tenantId: 'kaiyan', userId: KAIYAN_USER.sub, orgAgentId: 'oa-contract', messageText: 'q3' });

    h.setCaller(WAIN_USER);
    const a1 = await (await h.request('/api/appeals', postJson({ guardrailEventId: 'evt-w1' }))).json() as { id: string };
    h.setCaller(WAIN_OTHER);
    const a2 = await (await h.request('/api/appeals', postJson({ guardrailEventId: 'evt-w2' }))).json() as { id: string };
    h.setCaller(KAIYAN_USER);
    await h.request('/api/appeals', postJson({ guardrailEventId: 'evt-k1' }));

    // 组织 admin：GET /api/tenant/appeals 强制自身租户，看到本租户 2 条
    h.setCaller(WAIN_ADMIN);
    const listRes = await h.request('/api/tenant/appeals?status=pending');
    expect(listRes.status).toBe(200);
    const listBody = await listRes.json() as { items: Array<{ id: string; tenantId: string }>; total: number };
    expect(listBody.total).toBe(2);
    expect(listBody.items.every((i) => i.tenantId === 'wain')).toBe(true);
    expect(new Set(listBody.items.map((i) => i.id))).toEqual(new Set([a1.id, a2.id]));

    // 普通员工调 /api/tenant/appeals → 403
    h.setCaller(WAIN_USER);
    expect((await h.request('/api/tenant/appeals')).status).toBe(403);

    // 组织 admin 传别人的 tenantId → 403
    h.setCaller(WAIN_ADMIN);
    const cross = await h.request('/api/tenant/appeals?tenantId=kaiyan');
    expect(cross.status).toBe(403);

    // 处理 a1：pending → accepted
    const handled = await h.request(`/api/tenant/appeals/${a1.id}/handle`, postJson({
      status: 'accepted',
      note: 'scope 确实太紧，已放宽',
    }));
    expect(handled.status).toBe(200);
    const handledBody = await handled.json() as { status: string; handledBy: string; handleNote?: string };
    expect(handledBody.status).toBe('accepted');
    expect(handledBody.handledBy).toBe(WAIN_ADMIN.sub);
    expect(handledBody.handleNote).toBe('scope 确实太紧，已放宽');

    // 重复处理 → 409
    const dup = await h.request(`/api/tenant/appeals/${a1.id}/handle`, postJson({ status: 'rejected' }));
    expect(dup.status).toBe(409);

    // 跨租户 admin 处理别人租户的申诉 → 404（组织 admin 强制自身租户 → getById 命中不到）
    h.setCaller(KAIYAN_ADMIN);
    const foreign = await h.request(`/api/tenant/appeals/${a2.id}/handle`, postJson({ status: 'accepted' }));
    expect(foreign.status).toBe(404);

    // 平台 admin 可用 body.tenantId 跨租户处理
    h.setCaller(PLATFORM_ADMIN);
    const platformHandle = await h.request(`/api/tenant/appeals/${a2.id}/handle`, postJson({
      status: 'rejected',
      tenantId: 'wain',
    }));
    expect(platformHandle.status).toBe(200);
    expect(((await platformHandle.json()) as { status: string }).status).toBe('rejected');
  });
});
