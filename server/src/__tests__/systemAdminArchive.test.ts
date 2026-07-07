import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { auditLog } from '../data/login-logs/index.js';
import type { UserStore } from '../data/users/store.js';
import { createSystemAdminRouter } from '../routes/systemAdmin.js';
import type { PgSystemMetricsStore, WorkspaceUsageRecord } from '../runtime/systemMetricsStore.js';

vi.mock('../data/login-logs/index.js', () => ({
  auditLog: vi.fn(),
}));

const PLATFORM_ADMIN_USER = { sub: 'admin1', role: 'admin', tenantId: 'pantheon' };

async function startServer(options: { agentCwd: string; store: unknown; userStore?: unknown }) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { user: unknown }).user = PLATFORM_ADMIN_USER;
    next();
  });
  app.use('/api/admin/system', createSystemAdminRouter({
    agentCwd: options.agentCwd,
    systemMetricsStore: options.store as PgSystemMetricsStore,
    userStore: options.userStore as UserStore | undefined,
  }));
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const addr = server.address();
  const baseUrl = typeof addr === 'object' && addr ? `http://127.0.0.1:${addr.port}` : '';
  return {
    storage: () => fetch(`${baseUrl}/api/admin/system/storage`),
    archive: (body: unknown) => fetch(`${baseUrl}/api/admin/system/storage/archive`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

describe('system admin workspace archive route', () => {
  const servers: Array<{ close(): Promise<void> }> = [];
  const tmpRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()));
    await Promise.all(tmpRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
    vi.clearAllMocks();
  });

  function usageRecord(overrides: Partial<WorkspaceUsageRecord> = {}): WorkspaceUsageRecord {
    return {
      path: 'ghost/ky1',
      tenantId: 'ghost',
      userId: 'ky1',
      status: 'orphan_tenant',
      bytes: 1024,
      fileCount: null,
      scannedAt: new Date().toISOString(),
      archivedAt: null,
      ...overrides,
    };
  }

  it('enriches workspace storage rows with username and real name', async () => {
    const tmpRoot = await mkdtemp(join(tmpdir(), 'ws-storage-'));
    tmpRoots.push(tmpRoot);
    const agentCwd = join(tmpRoot, 'workspaces');
    const store = {
      getWorkspaceStorageSummary: vi.fn(async () => ({
        totalBytes: 1024,
        orphanBytes: 0,
        orphanCount: 0,
        byTenant: [{ tenantId: 'kaiyan', bytes: 1024, workspaceCount: 1 }],
        lastScanAt: '2026-07-08T00:00:00.000Z',
      })),
      listWorkspaceUsage: vi.fn(async () => [usageRecord({
        path: 'kaiyan/ky-user-1',
        tenantId: 'kaiyan',
        userId: 'ky-user-1',
        status: 'active',
      })]),
    };
    const userStore = {
      listAll: vi.fn(() => [{
        id: 'ky-user-1',
        username: 'zenglei',
        realName: '曾磊',
        role: 'admin',
        tenantId: 'kaiyan',
        createdAt: '2026-07-08T00:00:00.000Z',
        createdBy: 'system',
        updatedAt: '2026-07-08T00:00:00.000Z',
      }]),
    };
    const server = await startServer({ agentCwd, store, userStore });
    servers.push(server);

    const response = await server.storage();
    expect(response.status).toBe(200);
    const payload = await response.json() as { workspaces: Array<Record<string, unknown>> };
    expect(payload.workspaces[0]).toMatchObject({
      path: 'kaiyan/ky-user-1',
      username: 'zenglei',
      realName: '曾磊',
    });
  });

  it('archives via rename, deletes the usage row and writes the audit log', async () => {
    const tmpRoot = await mkdtemp(join(tmpdir(), 'ws-archive-'));
    tmpRoots.push(tmpRoot);
    const agentCwd = join(tmpRoot, 'workspaces');
    const sourceDir = join(agentCwd, 'ghost', 'ky1');
    await mkdir(sourceDir, { recursive: true });
    await writeFile(join(sourceDir, 'notes.txt'), 'keep me');

    const store = {
      getWorkspaceUsage: vi.fn(async () => usageRecord()),
      deleteWorkspaceUsage: vi.fn(async () => undefined),
    };
    const server = await startServer({ agentCwd, store });
    servers.push(server);

    const response = await server.archive({ path: 'ghost/ky1', confirm: 'ky1' });
    expect(response.status).toBe(200);
    const payload = await response.json() as { ok: boolean; result: { targetPath: string } };
    expect(payload.ok).toBe(true);

    // 归档 = mkdir + rename（零物理删除），源目录消失、数据完整搬到 archive 下
    expect(existsSync(sourceDir)).toBe(false);
    expect(payload.result.targetPath).toContain(join(tmpRoot, 'runtime', 'archive'));
    expect(payload.result.targetPath).toContain('ghost__ky1');
    await expect(readFile(join(payload.result.targetPath, 'notes.txt'), 'utf8')).resolves.toBe('keep me');

    // usage 行删除 + 审计落地
    expect(store.deleteWorkspaceUsage).toHaveBeenCalledWith('ghost/ky1');
    expect(vi.mocked(auditLog)).toHaveBeenCalledWith(
      expect.anything(),
      'workspace_archived',
      expect.stringContaining('ghost/ky1'),
    );
  });

  it('rejects stale scans with 409 and leaves the directory untouched', async () => {
    const tmpRoot = await mkdtemp(join(tmpdir(), 'ws-archive-'));
    tmpRoots.push(tmpRoot);
    const agentCwd = join(tmpRoot, 'workspaces');
    const sourceDir = join(agentCwd, 'ghost', 'ky1');
    await mkdir(sourceDir, { recursive: true });

    const store = {
      getWorkspaceUsage: vi.fn(async () => usageRecord({
        scannedAt: new Date(Date.now() - 48 * 60 * 60_000).toISOString(),
      })),
      deleteWorkspaceUsage: vi.fn(async () => undefined),
    };
    const server = await startServer({ agentCwd, store });
    servers.push(server);

    const response = await server.archive({ path: 'ghost/ky1', confirm: 'ky1' });
    expect(response.status).toBe(409);
    expect(existsSync(sourceDir)).toBe(true);
    expect(store.deleteWorkspaceUsage).not.toHaveBeenCalled();
    expect(vi.mocked(auditLog)).not.toHaveBeenCalled();
  });
});
