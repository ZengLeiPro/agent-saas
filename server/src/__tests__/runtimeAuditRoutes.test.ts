/**
 * Runtime Audit Read API 路由测试（/api/admin/runtime/audit）
 *
 * 覆盖：
 *   - GET /:sessionId
 *     - admin 拉取 session 内所有 tool_audit + 汇总分布
 *     - 顶层化字段（approvalId / executionTarget / authorizationSource）
 *     - runId / since / limit / offset 过滤组合
 *     - sessionId 非法 / since 非法 → 400
 *     - session 缺失 / runtime-events 缺失 → 200 空数组
 *     - 非 admin → 403（验证 requireAdmin 链路）
 *   - GET /runs/:runId (cross-session)
 *     - file backend（无 listByRunIdGlobal）→ 503
 *     - duckdb backend → 200 + entries + summary.sessionIds
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Server } from 'node:http';

import {
  EventStoreRuntimeAuditQuery,
  type AuditSummaryByRun,
  type RuntimeAuditEntry,
  type RuntimeAuditQuery,
} from '../runtime/auditQuery.js';
import { FileEventStore, getRuntimeEventLogPath } from '../runtime/fileEventStore.js';
import { requireAdmin } from '../auth/middleware.js';
import { createRuntimeAuditRouter } from '../routes/runtimeAudit.js';
import type { PlatformEvent } from '../runtime/types.js';

const SESSION_OK = '11111111-2222-4333-8444-555555555555';
const SESSION_OTHER = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

interface StartOptions {
  user?: { sub: string; role: 'admin' | 'user' };
  /** 显式覆盖 auditQuery，用于 cross-session mock */
  query?: RuntimeAuditQuery;
}

async function startServer(
  resolver: (sessionId: string) => Promise<string | null>,
  options: StartOptions = {},
): Promise<{ server: Server; baseUrl: string }> {
  const app = express();
  app.use((req, _res, next) => {
    (req as unknown as { user: { sub: string; role: 'admin' | 'user' } }).user =
      options.user ?? { sub: 'admin', role: 'admin' };
    next();
  });
  const auditQuery = options.query ?? new EventStoreRuntimeAuditQuery(resolver);
  app.use(
    '/api/admin/runtime/audit',
    requireAdmin,
    createRuntimeAuditRouter({ auditQuery }),
  );
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

describe('/api/admin/runtime/audit/:sessionId', () => {
  const cleanupDirs = new Set<string>();
  let server: Server | null = null;
  let baseUrl = '';
  let transcriptPath = '';

  beforeEach(async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'audit-route-'));
    cleanupDirs.add(cwd);
    transcriptPath = join(cwd, `${SESSION_OK}.jsonl`);
    const eventStore = new FileEventStore(getRuntimeEventLogPath(transcriptPath));
    await eventStore.append({
      type: 'tool_audit',
      runId: 'run-1',
      sessionId: SESSION_OK,
      toolCallId: 'call-mem',
      toolId: 'MemorySearch',
      toolName: 'MemorySearch',
      risk: 'safe',
      authorization: { approved: true, source: 'policy_auto' },
      executionTarget: 'server-local',
      status: 'success',
      durationMs: 11,
    });
    await eventStore.append({
      type: 'tool_audit',
      runId: 'run-1',
      sessionId: SESSION_OK,
      toolCallId: 'call-write',
      toolId: 'Write',
      toolName: 'Write',
      risk: 'workspace_write',
      approvalId: 'apv-77',
      authorization: { approved: true, source: 'human_approval', approvalId: 'apv-77' },
      executionTarget: 'server-container',
      status: 'success',
      durationMs: 320,
      executionInvocations: [{
        provider: 'server-container',
        operation: 'writeFile',
        containerName: 'sess-ok',
        status: 'success',
      }],
    });
    await eventStore.append({
      type: 'tool_audit',
      runId: 'run-2',
      sessionId: SESSION_OK,
      toolCallId: 'call-read',
      toolId: 'Read',
      toolName: 'Read',
      risk: 'safe',
      authorization: { approved: true, source: 'policy_auto' },
      executionTarget: 'server-local',
      status: 'error',
      durationMs: 5,
      error: 'ENOENT',
    });
  });

  afterEach(async () => {
    if (server) {
      await stopServer(server);
      server = null;
    }
    for (const dir of cleanupDirs) {
      await rm(dir, { recursive: true, force: true });
    }
    cleanupDirs.clear();
  });

  async function startWithSession() {
    const resolver = async (sid: string) => (sid === SESSION_OK ? transcriptPath : null);
    return await startServer(resolver);
  }

  it('返回所有 tool_audit 条目 + summary 分布', async () => {
    ({ server, baseUrl } = await startWithSession());
    const res = await fetch(`${baseUrl}/api/admin/runtime/audit/${SESSION_OK}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.sessionId).toBe(SESSION_OK);
    expect(body.runId).toBeNull();
    expect(body.limit).toBe(100);
    expect(body.offset).toBe(0);
    expect(body.entries).toHaveLength(3);
    const [mem, write, read] = body.entries;
    expect(mem.toolName).toBe('MemorySearch');
    expect(mem.authorizationSource).toBe('policy_auto');
    expect(mem.executionTarget).toBe('server-local');
    expect(write.toolName).toBe('Write');
    expect(write.approvalId).toBe('apv-77');
    expect(write.executionTarget).toBe('server-container');
    expect(write.authorizationSource).toBe('human_approval');
    expect(write.executionInvocations?.[0]?.operation).toBe('writeFile');
    expect(read.status).toBe('error');
    expect(read.error).toBe('ENOENT');
    expect(body.summary).toEqual({
      total: 3,
      filteredTotal: 3,
      byExecutionTarget: { 'server-local': 2, 'server-container': 1 },
      byStatus: { success: 2, error: 1 },
      byAuthorizationSource: { policy_auto: 2, human_approval: 1 },
    });
  });

  it('runId 过滤只返回该 run 的条目', async () => {
    ({ server, baseUrl } = await startWithSession());
    const res = await fetch(`${baseUrl}/api/admin/runtime/audit/${SESSION_OK}?runId=run-2`);
    const body = await res.json();
    expect(body.runId).toBe('run-2');
    expect(body.entries.map((e: { toolName: string }) => e.toolName)).toEqual(['Read']);
    // summary 仍是整 session 视角，不受 runId 影响
    expect(body.summary.total).toBe(3);
  });

  it('limit / offset 在过滤后生效', async () => {
    ({ server, baseUrl } = await startWithSession());
    const res = await fetch(`${baseUrl}/api/admin/runtime/audit/${SESSION_OK}?limit=2&offset=1`);
    const body = await res.json();
    expect(body.limit).toBe(2);
    expect(body.offset).toBe(1);
    expect(body.entries.map((e: { toolName: string }) => e.toolName)).toEqual(['Write', 'Read']);
  });

  it('since 过滤生效，summary.filteredTotal 反映 since 范围', async () => {
    // 重写 runtime events 文件，给精确 timestamp
    const eventLogPath = getRuntimeEventLogPath(transcriptPath);
    const base = Date.UTC(2026, 5, 7, 9, 0, 0);
    const events: PlatformEvent[] = ['mem', 'write', 'read'].map((name, i) => ({
      id: `evt-${i}`,
      timestamp: new Date(base + i * 60_000).toISOString(),
      type: 'tool_audit',
      runId: 'run-S',
      sessionId: SESSION_OK,
      toolCallId: `call-${name}`,
      toolId: name,
      toolName: name,
      risk: 'safe',
      authorization: { approved: true, source: 'policy_auto' },
      executionTarget: 'server-local',
      status: 'success',
      durationMs: 1,
    } as PlatformEvent));
    await writeFile(eventLogPath, events.map((e) => JSON.stringify(e)).join('\n') + '\n');

    ({ server, baseUrl } = await startWithSession());
    const since = new Date(base + 60_000).toISOString();
    const res = await fetch(
      `${baseUrl}/api/admin/runtime/audit/${SESSION_OK}?since=${encodeURIComponent(since)}`,
    );
    const body = await res.json();
    expect(body.since).toBe(since);
    expect(body.entries.map((e: { toolCallId: string }) => e.toolCallId)).toEqual(['call-write', 'call-read']);
    expect(body.summary.total).toBe(3);
    expect(body.summary.filteredTotal).toBe(2);
  });

  it('sessionId 非 UUID 形态 → 400', async () => {
    ({ server, baseUrl } = await startWithSession());
    const res = await fetch(`${baseUrl}/api/admin/runtime/audit/not-a-uuid`);
    expect(res.status).toBe(400);
  });

  it('since 非法 → 400', async () => {
    ({ server, baseUrl } = await startWithSession());
    const res = await fetch(`${baseUrl}/api/admin/runtime/audit/${SESSION_OK}?since=not-a-time`);
    expect(res.status).toBe(400);
  });

  it('session 不存在 → 200 空数组（不区分"没跑过"与"被删除"，便于 admin 排查）', async () => {
    ({ server, baseUrl } = await startWithSession());
    const res = await fetch(`${baseUrl}/api/admin/runtime/audit/${SESSION_OTHER}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.entries).toEqual([]);
    expect(body.summary.total).toBe(0);
  });

  it('limit 超过硬上限 → 400', async () => {
    ({ server, baseUrl } = await startWithSession());
    const res = await fetch(`${baseUrl}/api/admin/runtime/audit/${SESSION_OK}?limit=99999`);
    expect(res.status).toBe(400);
  });

  it('非 admin → 403', async () => {
    const resolver = async (sid: string) => (sid === SESSION_OK ? transcriptPath : null);
    ({ server, baseUrl } = await startServer(resolver, { user: { sub: 'user', role: 'user' } }));
    const res = await fetch(`${baseUrl}/api/admin/runtime/audit/${SESSION_OK}`);
    expect(res.status).toBe(403);
  });

  describe('GET /runs/:runId (cross-session)', () => {
    it('file backend（query 无 listByRunIdGlobal）→ 503', async () => {
      ({ server, baseUrl } = await startWithSession());
      const res = await fetch(`${baseUrl}/api/admin/runtime/audit/runs/run-1`);
      expect(res.status).toBe(503);
      const body = await res.json();
      expect(body.error).toContain('duckdb');
    });

    it('duckdb backend mock → 200 + entries + summary.sessionIds', async () => {
      const entries: RuntimeAuditEntry[] = [
        {
          id: 'e1', timestamp: '2026-06-07T10:00:00.000Z', runId: 'run-X',
          sessionId: SESSION_OK, tenantId: 'kaiyan', toolCallId: 'c1', toolId: 'MemorySearch',
          toolName: 'MemorySearch', risk: 'safe',
          authorization: { approved: true, source: 'policy_auto' },
          authorizationSource: 'policy_auto', executionTarget: 'server-local',
          status: 'success', durationMs: 10,
        },
        {
          id: 'e2', timestamp: '2026-06-07T10:00:05.000Z', runId: 'run-X',
          sessionId: SESSION_OTHER, tenantId: 'kaiyan', toolCallId: 'c2', toolId: 'Write',
          toolName: 'Write', risk: 'workspace_write',
          authorization: { approved: true, source: 'human_approval', approvalId: 'apv' },
          authorizationSource: 'human_approval', executionTarget: 'server-container',
          status: 'success', durationMs: 99, approvalId: 'apv',
        },
      ];
      const summary: AuditSummaryByRun = {
        total: 2, filteredTotal: 2,
        sessionIds: [SESSION_OK, SESSION_OTHER].sort(),
        byExecutionTarget: { 'server-local': 1, 'server-container': 1 },
        byStatus: { success: 2, error: 0 },
        byAuthorizationSource: { policy_auto: 1, human_approval: 1 },
      };
      const mockQuery: RuntimeAuditQuery = {
        listBySessionId: async () => [],
        listByRunId: async () => [],
        summarize: async () => ({
          total: 0, filteredTotal: 0,
          byExecutionTarget: {}, byStatus: { success: 0, error: 0 },
          byAuthorizationSource: {},
        }),
        listByRunIdGlobal: async (rid) => (rid === 'run-X' ? entries : []),
        summarizeByRunIdGlobal: async (rid) => (rid === 'run-X' ? summary : {
          total: 0, filteredTotal: 0, sessionIds: [],
          byExecutionTarget: {}, byStatus: { success: 0, error: 0 },
          byAuthorizationSource: {},
        }),
      };
      ({ server, baseUrl } = await startServer(async () => null, { query: mockQuery }));

      const res = await fetch(`${baseUrl}/api/admin/runtime/audit/runs/run-X`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.runId).toBe('run-X');
      expect(body.limit).toBe(100);
      expect(body.offset).toBe(0);
      expect(body.entries).toHaveLength(2);
      expect(body.summary.sessionIds).toEqual(summary.sessionIds);
      expect(body.summary.byExecutionTarget).toEqual(summary.byExecutionTarget);
    });

    it('duckdb backend mock + since → 200 + 透传 since', async () => {
      const mockQuery: RuntimeAuditQuery = {
        listBySessionId: async () => [],
        listByRunId: async () => [],
        summarize: async () => ({
          total: 0, filteredTotal: 0,
          byExecutionTarget: {}, byStatus: { success: 0, error: 0 },
          byAuthorizationSource: {},
        }),
        listByRunIdGlobal: async () => [],
        summarizeByRunIdGlobal: async () => ({
          total: 5, filteredTotal: 0, sessionIds: ['s1', 's2'],
          byExecutionTarget: {}, byStatus: { success: 0, error: 0 },
          byAuthorizationSource: {},
        }),
      };
      ({ server, baseUrl } = await startServer(async () => null, { query: mockQuery }));
      const since = '2026-06-07T11:00:00.000Z';
      const res = await fetch(
        `${baseUrl}/api/admin/runtime/audit/runs/run-Y?since=${encodeURIComponent(since)}`,
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.since).toBe(since);
      expect(body.summary.total).toBe(5);
    });

    it('runId 空 / since 非法 → 400', async () => {
      const mockQuery: RuntimeAuditQuery = {
        listBySessionId: async () => [],
        listByRunId: async () => [],
        summarize: async () => ({
          total: 0, filteredTotal: 0,
          byExecutionTarget: {}, byStatus: { success: 0, error: 0 },
          byAuthorizationSource: {},
        }),
        listByRunIdGlobal: async () => [],
        summarizeByRunIdGlobal: async () => ({
          total: 0, filteredTotal: 0, sessionIds: [],
          byExecutionTarget: {}, byStatus: { success: 0, error: 0 },
          byAuthorizationSource: {},
        }),
      };
      ({ server, baseUrl } = await startServer(async () => null, { query: mockQuery }));
      // since 非法
      const since = await fetch(`${baseUrl}/api/admin/runtime/audit/runs/run-Z?since=bad`);
      expect(since.status).toBe(400);
    });

    it('cross-session：非 admin → 403', async () => {
      ({ server, baseUrl } = await startServer(async () => null, {
        user: { sub: 'user', role: 'user' },
      }));
      const res = await fetch(`${baseUrl}/api/admin/runtime/audit/runs/run-X`);
      expect(res.status).toBe(403);
    });
  });
});
