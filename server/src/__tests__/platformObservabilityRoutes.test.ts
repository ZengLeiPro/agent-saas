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

    await withApp(WAIN_ADMIN, { sessionProjectionStore }, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/admin/sessions`);
      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.items[0]).toMatchObject({ sessionId: SESSION_ID, tenantId: 'wain' });
    });

    expect(list).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: 'wain',
      kind: 'user',
      includeDeleted: false,
    }));
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

    await withApp(WAIN_ADMIN, { runStore }, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/admin/runs?status=active`);
      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.items[0]).toMatchObject({ runId: RUN_ID, tenantId: 'wain' });
    });

    const [sql, params] = query.mock.calls[0]! as unknown as [unknown, unknown[]];
    expect(String(sql)).toContain('tenant_id');
    expect(params).toContain('wain');
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
