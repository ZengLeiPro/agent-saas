/**
 * Runtime Audit 路由跨组织隔离测试（PR 10）
 *
 * 覆盖目标：
 *   1. GET /:sessionId   - 组织 admin 只看本组织 entries；平台 admin 不传 tenantId 看全部
 *   2. GET /runs/:runId  - 同上（DuckDB cross-session）
 *   3. 组织 admin ?tenantId=<other> → 403
 *   4. tenantId 非法格式 → 400
 *
 * 用 mock RuntimeAuditQuery，验证路由层将 caller 的组织解析正确地 propagate 进 queryOpts.tenantId。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';

import {
  type AuditQueryOptions,
  type AuditSummary,
  type AuditSummaryByRun,
  type RuntimeAuditEntry,
  type RuntimeAuditQuery,
} from '../runtime/auditQuery.js';
import { createRuntimeAuditRouter } from '../routes/runtimeAudit.js';
import type { JwtPayload } from '../auth/types.js';
import { DEFAULT_TENANT_ID } from '../data/tenants/types.js';

const SESSION = '11111111-2222-4333-8444-555555555555';
const RUN_ID = 'run-X';

const PLATFORM_ADMIN: JwtPayload = { sub: 'u-platform', username: 'admin', role: 'admin', tenantId: DEFAULT_TENANT_ID };
const WAIN_ADMIN: JwtPayload = { sub: 'u-wa', username: 'wain_admin', role: 'admin', tenantId: 'wain' };

interface Captured {
  listBySessionId: Array<{ sessionId: string; options?: AuditQueryOptions }>;
  listByRunId: Array<{ sessionId: string; runId: string; options?: AuditQueryOptions }>;
  summarize: Array<{ sessionId: string; options?: AuditQueryOptions }>;
  listByRunIdGlobal: Array<{ runId: string; options?: AuditQueryOptions }>;
  summarizeByRunIdGlobal: Array<{ runId: string; options?: AuditQueryOptions }>;
}

function makeMockQuery(): { query: RuntimeAuditQuery; captured: Captured } {
  const captured: Captured = {
    listBySessionId: [], listByRunId: [], summarize: [],
    listByRunIdGlobal: [], summarizeByRunIdGlobal: [],
  };
  const emptyEntries: RuntimeAuditEntry[] = [];
  const emptySummary: AuditSummary = {
    total: 0, filteredTotal: 0,
    byExecutionTarget: {}, byStatus: { success: 0, error: 0 }, byAuthorizationSource: {},
  };
  const emptySummaryByRun: AuditSummaryByRun = { ...emptySummary, sessionIds: [] };
  const query: RuntimeAuditQuery = {
    async listBySessionId(sessionId, options) { captured.listBySessionId.push({ sessionId, options }); return emptyEntries; },
    async listByRunId(sessionId, runId, options) { captured.listByRunId.push({ sessionId, runId, options }); return emptyEntries; },
    async summarize(sessionId, options) { captured.summarize.push({ sessionId, options }); return emptySummary; },
    async listByRunIdGlobal(runId, options) { captured.listByRunIdGlobal.push({ runId, options }); return emptyEntries; },
    async summarizeByRunIdGlobal(runId, options) { captured.summarizeByRunIdGlobal.push({ runId, options }); return emptySummaryByRun; },
  };
  return { query, captured };
}

interface TestRig {
  baseUrl: string;
  captured: Captured;
  setCaller(c: JwtPayload): void;
  request(path: string): Promise<Response>;
  close(): Promise<void>;
}

async function makeTestRig(): Promise<TestRig> {
  const { query, captured } = makeMockQuery();
  const app = express();
  let currentCaller: JwtPayload = PLATFORM_ADMIN;
  app.use((req, _res, next) => { req.user = currentCaller; next(); });
  app.use('/api/admin/runtime/audit', createRuntimeAuditRouter({ auditQuery: query }));
  const server: Server = await new Promise(resolve => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const addr = server.address();
  const baseUrl = typeof addr === 'object' && addr ? `http://127.0.0.1:${addr.port}` : '';
  return {
    baseUrl,
    captured,
    setCaller(c) { currentCaller = c; },
    request: (path) => fetch(`${baseUrl}${path}`),
    close: () => new Promise<void>(resolve => server.close(() => resolve())),
  };
}

describe('Runtime Audit 路由组织隔离', () => {
  let h: TestRig;

  beforeEach(async () => { h = await makeTestRig(); });
  afterEach(async () => { await h.close(); });

  describe('GET /:sessionId', () => {
    it('平台 admin 不传 tenantId → 透传 undefined（跨组织）', async () => {
      h.setCaller(PLATFORM_ADMIN);
      const res = await h.request(`/api/admin/runtime/audit/${SESSION}`);
      expect(res.status).toBe(200);
      expect(h.captured.listBySessionId[0]?.options?.tenantId).toBeUndefined();
      expect(h.captured.summarize[0]?.options?.tenantId).toBeUndefined();
    });

    it('平台 admin 显式 ?tenantId=wain → 透传 wain', async () => {
      h.setCaller(PLATFORM_ADMIN);
      const res = await h.request(`/api/admin/runtime/audit/${SESSION}?tenantId=wain`);
      expect(res.status).toBe(200);
      expect(h.captured.listBySessionId[0]?.options?.tenantId).toBe('wain');
      expect(h.captured.summarize[0]?.options?.tenantId).toBe('wain');
    });

    it('组织 admin (wain) → 自动注入 wain', async () => {
      h.setCaller(WAIN_ADMIN);
      const res = await h.request(`/api/admin/runtime/audit/${SESSION}`);
      expect(res.status).toBe(200);
      expect(h.captured.listBySessionId[0]?.options?.tenantId).toBe('wain');
      expect(h.captured.summarize[0]?.options?.tenantId).toBe('wain');
    });

    it('组织 admin (wain) ?tenantId=kaiyan → 403', async () => {
      h.setCaller(WAIN_ADMIN);
      const res = await h.request(`/api/admin/runtime/audit/${SESSION}?tenantId=kaiyan`);
      expect(res.status).toBe(403);
    });

    it('tenantId 非法格式 (大写) → 400', async () => {
      h.setCaller(PLATFORM_ADMIN);
      const res = await h.request(`/api/admin/runtime/audit/${SESSION}?tenantId=KAIYAN`);
      expect(res.status).toBe(400);
    });
  });

  describe('GET /runs/:runId (cross-session)', () => {
    it('平台 admin 不传 tenantId → 透传 undefined', async () => {
      h.setCaller(PLATFORM_ADMIN);
      const res = await h.request(`/api/admin/runtime/audit/runs/${RUN_ID}`);
      expect(res.status).toBe(200);
      expect(h.captured.listByRunIdGlobal[0]?.options?.tenantId).toBeUndefined();
      expect(h.captured.summarizeByRunIdGlobal[0]?.options?.tenantId).toBeUndefined();
    });

    it('组织 admin (wain) → 自动注入 wain（限本组织视野）', async () => {
      h.setCaller(WAIN_ADMIN);
      const res = await h.request(`/api/admin/runtime/audit/runs/${RUN_ID}`);
      expect(res.status).toBe(200);
      expect(h.captured.listByRunIdGlobal[0]?.options?.tenantId).toBe('wain');
      expect(h.captured.summarizeByRunIdGlobal[0]?.options?.tenantId).toBe('wain');
    });

    it('组织 admin (wain) ?tenantId=kaiyan → 403', async () => {
      h.setCaller(WAIN_ADMIN);
      const res = await h.request(`/api/admin/runtime/audit/runs/${RUN_ID}?tenantId=kaiyan`);
      expect(res.status).toBe(403);
    });

    it('平台 admin 显式 ?tenantId=wain → 透传 wain', async () => {
      h.setCaller(PLATFORM_ADMIN);
      const res = await h.request(`/api/admin/runtime/audit/runs/${RUN_ID}?tenantId=wain`);
      expect(res.status).toBe(200);
      expect(h.captured.listByRunIdGlobal[0]?.options?.tenantId).toBe('wain');
    });
  });
});
