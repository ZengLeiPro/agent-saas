import express from 'express';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createPlatformObservabilityRouter } from '../routes/platformObservability.js';
import { DEFAULT_TENANT_ID } from '../data/tenants/types.js';
import type { JwtPayload } from '../auth/types.js';
import type { RuntimeSessionProjectionRecord } from '../runtime/sessionProjectionStore.js';

const RUN_ID = '1783345640000-11111111-2222-4333-8444-555555555555';
const SESSION_ID = '11111111-2222-4333-8444-555555555555';

const PLATFORM_ADMIN: JwtPayload = {
  sub: 'root',
  username: 'admin',
  role: 'admin',
  tenantId: DEFAULT_TENANT_ID,
};

const WAIN_ADMIN: JwtPayload = {
  sub: 'u-wain-admin',
  username: 'wain_admin',
  role: 'admin',
  tenantId: 'wain',
};

const servers: Server[] = [];

const userStore = {
  findById: (id: string) => id === 'u-1'
    ? {
      id,
      username: 'alice',
      realName: 'Alice Chen',
      role: 'user',
      tenantId: 'wain',
      createdAt: '2026-07-06T10:00:00.000Z',
      createdBy: 'system',
      updatedAt: '2026-07-06T10:00:00.000Z',
    }
    : undefined,
  listAll: () => [],
} as any;

async function withApp<T>(
  user: JwtPayload,
  options: Partial<Parameters<typeof createPlatformObservabilityRouter>[0]>,
  fn: (baseUrl: string) => Promise<T>,
): Promise<T> {
  const app = express();
  app.use((req, _res, next) => {
    req.user = user;
    next();
  });
  app.use('/api/admin', createPlatformObservabilityRouter({
    config: { tenantRemoteHands: { hands: [] } } as any,
    ...options,
  }));
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  servers.push(server);
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('failed to bind test server');
  return fn(`http://127.0.0.1:${addr.port}`);
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

describe('platform observability router', () => {
  it('global search uses tenant-scoped SQL and returns empty instead of leaking cross-tenant run existence', async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    const runStore = { pool: { query }, runsTable: 'runtime_runs' } as any;

    await withApp(WAIN_ADMIN, { runStore }, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/admin/search?q=${encodeURIComponent(RUN_ID)}`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ matches: [] });
    });

    expect(query).toHaveBeenCalledTimes(1);
    const [sql, params] = query.mock.calls[0]! as unknown as [unknown, unknown[]];
    expect(String(sql)).toContain('tenant_id');
    expect(params).toContain('wain');
  });

  it('global search with mismatched tenantId returns empty without touching backend stores', async () => {
    const query = vi.fn(async () => ({ rows: [{ run_id: RUN_ID }] }));
    const runStore = { pool: { query }, runsTable: 'runtime_runs' } as any;

    await withApp(WAIN_ADMIN, { runStore }, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/admin/search?q=${encodeURIComponent(RUN_ID)}&tenantId=kaiyan`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ matches: [] });
    });

    expect(query).not.toHaveBeenCalled();
  });

  it('sessions list injects the caller tenant into projection query and defaults to user sessions', async () => {
    const list = vi.fn(async () => ({
      items: [sessionRecord({ tenantId: 'wain' })],
    }));
    const sessionProjectionStore = { list } as any;

    await withApp(WAIN_ADMIN, { sessionProjectionStore, userStore }, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/admin/sessions`);
      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.items[0]).toMatchObject({
        sessionId: SESSION_ID,
        tenantId: 'wain',
        username: 'alice',
        realName: 'Alice Chen',
      });
    });

    expect(list).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: 'wain',
      kind: 'user',
      includeDeleted: false,
    }));
  });

  it('sessions list forwards business filters to the projection store', async () => {
    const list = vi.fn(async () => ({ items: [] }));
    const sessionProjectionStore = { list } as any;
    const updatedFrom = '2026-07-01T00:00:00.000Z';

    await withApp(PLATFORM_ADMIN, { sessionProjectionStore }, async (baseUrl) => {
      const params = new URLSearchParams({
        tenantId: 'wain',
        userId: 'u-1',
        q: '采购',
        channel: 'dingtalk',
        model: 'glm-5.2',
        updatedFrom,
      });
      const res = await fetch(`${baseUrl}/api/admin/sessions?${params.toString()}`);
      expect(res.status).toBe(200);
    });

    expect(list).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: 'wain',
      userId: 'u-1',
      titleContains: '采购',
      channel: 'dingtalk',
      model: 'glm-5.2',
      updatedFrom,
    }));
  });

  it('global search finds conversations by partial title', async () => {
    const query = vi.fn(async () => ({
      rows: [{ session_id: SESSION_ID, tenant_id: 'wain', user_id: 'u-1', title: '采购合同复核' }],
    }));
    const sessionProjectionStore = { pool: { query }, sessionsTable: 'runtime_sessions' } as any;

    await withApp(PLATFORM_ADMIN, { sessionProjectionStore }, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/admin/search?q=${encodeURIComponent('采购')}`);
      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.matches).toContainEqual(expect.objectContaining({
        kind: 'session',
        id: SESSION_ID,
        title: '采购合同复核',
      }));
    });

    const [sql, params] = query.mock.calls[0]! as unknown as [unknown, unknown[]];
    expect(String(sql)).toContain('position(lower($1) in lower(title))');
    expect(params).toEqual(['采购']);
  });

  it('runs list pushes tenant slicing into SQL WHERE', async () => {
    const query = vi.fn(async () => ({
      rows: [{
        row_json: {
          run_id: RUN_ID,
          session_id: SESSION_ID,
          tenant_id: 'wain',
          user_id: 'u-1',
          status: 'running',
          requested_at: '2026-07-06T10:00:00.000Z',
          updated_at: '2026-07-06T10:01:00.000Z',
          metadata: {},
        },
      }],
    }));
    const runStore = { pool: { query }, runsTable: 'runtime_runs' } as any;

    await withApp(WAIN_ADMIN, { runStore, userStore }, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/admin/runs?status=active&reasonContains=${encodeURIComponent('quota exceeded')}`);
      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.items[0]).toMatchObject({
        runId: RUN_ID,
        tenantId: 'wain',
        username: 'alice',
        realName: 'Alice Chen',
      });
    });

    const [sql, params] = query.mock.calls[0]! as unknown as [unknown, unknown[]];
    expect(String(sql)).toContain('tenant_id');
    expect(String(sql)).toContain('status_reason');
    expect(params).toContain('wain');
    expect(params).toContain('quota exceeded');
  });

  it('tool invocation analysis forwards business filters and enforces caller tenant', async () => {
    const listForAdmin = vi.fn(async () => ({
      items: [{
        invocationId: 'inv-1',
        runId: RUN_ID,
        sessionId: SESSION_ID,
        tenantId: 'wain',
        userId: 'u-1',
        username: 'alice',
        toolName: 'Skill',
        skillName: 'ky-data-query',
        executionTarget: 'server-remote',
        status: 'failed',
        startedAt: '2026-07-06T10:00:00.000Z',
        completedAt: '2026-07-06T10:00:01.000Z',
        durationMs: 1000,
        error: 'quota exceeded',
      }],
      summary: { total: 1, failed: 1, affectedTenants: 1, affectedUsers: 1, skillCalls: 1, skillCallsTracked: 1 },
      byTool: [],
      bySkill: [],
    }));
    const toolInvocationStore = { listForAdmin } as any;

    await withApp(WAIN_ADMIN, { toolInvocationStore, userStore }, async (baseUrl) => {
      const params = new URLSearchParams({
        tenantId: 'wain',
        userId: 'u-1',
        toolName: 'Skill',
        skillName: 'ky-data-query',
        status: 'failed',
        reasonContains: 'quota',
        hours: '72',
      });
      const res = await fetch(`${baseUrl}/api/admin/tool-invocations?${params.toString()}`);
      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.items[0]).toMatchObject({ realName: 'Alice Chen', skillName: 'ky-data-query' });
    });

    expect(listForAdmin).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: 'wain',
      userId: 'u-1',
      toolName: 'Skill',
      skillName: 'ky-data-query',
      status: 'failed',
      reasonContains: 'quota',
      hours: 72,
    }));
  });

  it('overview snapshot exposes session meta projection health counters', async () => {
    await withApp(PLATFORM_ADMIN, {
      getDispatchMetrics: () => ({
        totalRuns: 0,
        totalErrors: 0,
        avgDurationMs: 0,
        avgFirstEventLatencyMs: null,
        byChannel: {},
      }),
    }, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/admin/overview/snapshot`);
      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.health.sessionMetaProjection).toMatchObject({
        failures: expect.any(Number),
        pending: expect.any(Number),
      });
      expect(body.health).toHaveProperty('dispatch');
    });
  });

  it('overview run health 以 runtime_runs.run_id/requested_at 为权威口径并返回元数据', async () => {
    const runQuery = vi.fn(async (sql: string) => {
      if (sql.includes("status = ANY")) return { rows: [{ status: 'running', count: '1' }] };
      if (sql.includes("status IN ('completed','failed','cancelled','orphaned')")) {
        return { rows: [
          { status: 'completed', count: '2' },
          { status: 'failed', count: '1' },
          { status: 'orphaned', count: '1' },
        ] };
      }
      if (sql.includes('requested_at >=') && sql.includes('count(*)::text AS count')) return { rows: [{ count: '4' }] };
      return { rows: [] };
    });

    await withApp(PLATFORM_ADMIN, {
      runStore: { pool: { query: runQuery }, runsTable: 'runtime_runs' } as any,
    }, async (baseUrl) => {
      const body = await (await fetch(`${baseUrl}/api/admin/overview/snapshot`)).json() as any;
      expect(body.health).toMatchObject({
        todayRuns: 4,
        completionRateToday: 2 / 4,
        runHealthScope: {
          source: 'runtime_runs', identity: 'run_id', initiatedAt: 'requested_at',
          timezone: 'Asia/Shanghai', completionDenominator: 'terminal_runs_requested_today',
        },
      });
    });

    const healthSql = runQuery.mock.calls.map((call) => String(call[0]))
      .filter((sql) => sql.includes('count(*)::text AS count'));
    expect(healthSql).toHaveLength(3);
    expect(healthSql.filter((sql) => sql.includes('requested_at'))).toHaveLength(2);
    expect(healthSql.join('\n')).toContain("status IN ('completed','failed','cancelled','orphaned')");
    expect(healthSql.every((sql) => sql.includes('sandboxCleanupCarrier'))).toBe(true);
    expect(healthSql.join('\n')).not.toContain('run_finished');
  });

  it('overview trends returns Beijing-day series and distinguishes missing sources', async () => {
    const today = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date());
    const runQuery = vi.fn(async () => ({ rows: [{
      day: today, runs: 4, active_users: 2, completed: 3, failed: 1, cancelled: 0,
    }] }));
    const sessionQuery = vi.fn(async () => ({ rows: [{ day: today, sessions: 2 }] }));

    await withApp(PLATFORM_ADMIN, {
      runStore: { pool: { query: runQuery }, runsTable: 'runtime_runs' } as any,
      sessionProjectionStore: { pool: { query: sessionQuery }, sessionsTable: 'runtime_sessions' } as any,
    }, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/admin/overview/trends?days=7`);
      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body).toMatchObject({ available: true, days: 7, timezone: 'Asia/Shanghai' });
      expect(body.daily).toHaveLength(7);
      expect(body.daily.at(-1)).toMatchObject({
        date: today, activeUsers: 2, sessions: 2, runs: 4, completionRate: 0.75,
      });
    });

    const [runSql] = runQuery.mock.calls[0]! as unknown as [unknown, unknown[]];
    const [sessionSql] = sessionQuery.mock.calls[0]! as unknown as [unknown, unknown[]];
    expect(String(runSql)).toContain("AT TIME ZONE 'Asia/Shanghai'");
    expect(String(runSql)).toContain('sandboxCleanupCarrier');
    expect(String(sessionSql)).toContain("AT TIME ZONE 'Asia/Shanghai'");
  });

  // ── TASK-318：overview snapshot 的 configIdentity 字段 ──

  const consistentIdentity: import('@agent/shared').ConfigIdentitySummary = {
    schemaVersion: 1,
    status: 'consistent',
    expected: { schemaVersion: 1, digest: `sha256:${'a'.repeat(64)}` },
    observed: {
      schemaVersion: 1,
      digest: `sha256:${'a'.repeat(64)}`,
      credentialVersionDigest: null,
      versionResolution: 'resolved',
      secretRefCount: 0,
    },
    releaseId: 'rc-20260829-01',
    lastObservedAt: '2026-08-29T12:00:00.000Z',
  };

  it('overview snapshot 等待异步 configIdentity 刷新，一致时不产生待关注项', async () => {
    await withApp(
      PLATFORM_ADMIN,
      {
        getConfigIdentitySummary: async () => consistentIdentity,
      },
      async (baseUrl) => {
        const res = await fetch(`${baseUrl}/api/admin/overview/snapshot`);
        expect(res.status).toBe(200);
        const body = (await res.json()) as any;
        expect(body.configIdentity).toEqual(consistentIdentity);
        expect(
          body.attention.filter((item: any) => item.kind.startsWith('config_identity')),
        ).toEqual([]);
      },
    );
  });

  it('configIdentity drifted -> snapshot 返回 drift 并追加高优待关注项', async () => {
    const drifted: import('@agent/shared').ConfigIdentitySummary = {
      ...consistentIdentity,
      status: 'drifted',
      observed: {
        schemaVersion: 1,
        digest: `sha256:${'b'.repeat(64)}`,
        credentialVersionDigest: null,
        versionResolution: 'resolved',
        secretRefCount: 0,
      },
      lastChangedAt: '2026-08-29T12:30:00.000Z',
    };
    await withApp(
      PLATFORM_ADMIN,
      {
        getConfigIdentitySummary: () => drifted,
      },
      async (baseUrl) => {
        const body = (await (await fetch(`${baseUrl}/api/admin/overview/snapshot`)).json()) as any;
        expect(body.configIdentity.status).toBe('drifted');
        const attention = body.attention.filter(
          (item: any) => item.kind === 'config_identity_drift',
        );
        expect(attention).toHaveLength(1);
        expect(attention[0].severity).toBe('high');
        expect(attention[0].occurredAt).toBe('2026-08-29T12:30:00.000Z');
      },
    );
  });

  it('configIdentity unverifiable -> 返回不可验证并追加待关注项', async () => {
    const unverifiable: import('@agent/shared').ConfigIdentitySummary = {
      ...consistentIdentity,
      status: 'unverifiable',
      reason: 'expected_not_bound',
      expected: undefined,
    };
    await withApp(
      PLATFORM_ADMIN,
      {
        getConfigIdentitySummary: () => unverifiable,
      },
      async (baseUrl) => {
        const body = (await (await fetch(`${baseUrl}/api/admin/overview/snapshot`)).json()) as any;
        expect(body.configIdentity.status).toBe('unverifiable');
        expect(
          body.attention.some((item: any) => item.kind === 'config_identity_unverifiable'),
        ).toBe(true);
      },
    );
  });

  it('后端未接入（无 getConfigIdentitySummary）时 snapshot.configIdentity 为 null 且不产生待关注项', async () => {
    await withApp(PLATFORM_ADMIN, {}, async (baseUrl) => {
      const body = (await (await fetch(`${baseUrl}/api/admin/overview/snapshot`)).json()) as any;
      expect(body.configIdentity).toBeNull();
      expect(body.attention.filter((item: any) => item.kind.startsWith('config_identity'))).toEqual(
        [],
      );
    });
  });

  it('configIdentity 载荷不合法时降级为 null 并追加告警待关注项，而不是 500', async () => {
    await withApp(
      PLATFORM_ADMIN,
      {
        // 旧 schema / 缺字段 / 伪造结构：wire 契约校验必须拒绝。
        getConfigIdentitySummary: () => ({ schemaVersion: 99, status: 'weird' }) as any,
      },
      async (baseUrl) => {
        const res = await fetch(`${baseUrl}/api/admin/overview/snapshot`);
        expect(res.status).toBe(200);
        const body = (await res.json()) as any;
        expect(body.configIdentity).toBeNull();
        const attention = body.attention.filter(
          (item: any) => item.kind === 'config_identity_invalid_payload',
        );
        expect(attention).toHaveLength(1);
        expect(attention[0].title).toContain('配置身份');
      },
    );
  });

  it('非 admin 用户访问 overview snapshot -> 403，看不到 configIdentity', async () => {
    const notAdmin = { ...PLATFORM_ADMIN, role: 'user' } as any;
    await withApp(
      notAdmin,
      {
        getConfigIdentitySummary: async () => consistentIdentity,
      },
      async (baseUrl) => {
        const res = await fetch(`${baseUrl}/api/admin/overview/snapshot`);
        expect(res.status).toBe(403);
      },
    );
  });

  it('configIdentity 摘要绝不含 secret / 路径 / 连接串（wire 契约禁入）', async () => {
    const withSecretProbe = {
      ...consistentIdentity,
      plaintextSecret: 'plaintext-secret-probe',
    };
    await withApp(
      PLATFORM_ADMIN,
      {
        getConfigIdentitySummary: () => withSecretProbe as any,
      },
      async (baseUrl) => {
        const body = (await (await fetch(`${baseUrl}/api/admin/overview/snapshot`)).json()) as any;
        expect(body.configIdentity).toBeNull();
        expect(JSON.stringify(body)).not.toContain('plaintext-secret-probe');
      },
    );
  });
});

function sessionRecord(input: { tenantId: string }): RuntimeSessionProjectionRecord {
  return {
    sessionId: SESSION_ID,
    tenantId: input.tenantId,
    userId: 'u-1',
    username: 'alice',
    channel: 'web',
    kind: 'user',
    title: 'Test session',
    runtimeStatus: 'idle',
    createdAt: '2026-07-06T10:00:00.000Z',
    updatedAt: '2026-07-06T10:01:00.000Z',
    metaJson: {
      userId: 'u-1',
      username: 'alice',
      tenantId: input.tenantId,
      channel: 'web',
      createdAt: '2026-07-06T10:00:00.000Z',
    },
  };
}
