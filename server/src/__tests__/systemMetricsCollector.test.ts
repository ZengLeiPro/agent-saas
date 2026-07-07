import { resolve } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const readdirMock = vi.hoisted(() => vi.fn());

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, readdir: readdirMock };
});

import {
  CommandTimeoutError,
  SystemMetricsCollector,
  classifyWorkspacePath,
  parseSoftDeletedSegment,
  runDu,
} from '../runtime/systemMetricsCollector.js';
import type { PgSystemMetricsStore } from '../runtime/systemMetricsStore.js';

describe('workspace usage classification', () => {
  const tenants = new Set(['kaiyan']);
  const users = new Set(['kaiyan:ky123']);

  it('classifies active workspaces', () => {
    expect(classifyWorkspacePath('kaiyan/ky123', tenants, users)).toEqual({
      tenantId: 'kaiyan',
      userId: 'ky123',
      status: 'active',
    });
  });

  it('classifies soft-deleted user workspaces before orphan user', () => {
    expect(classifyWorkspacePath('kaiyan/ky999-deleted-1730000000000', tenants, users)).toEqual({
      tenantId: 'kaiyan',
      userId: 'ky999',
      status: 'soft_deleted',
    });
  });

  it('classifies orphan tenant and orphan user workspaces', () => {
    expect(classifyWorkspacePath('ghost/ky123', tenants, users).status).toBe('orphan_tenant');
    expect(classifyWorkspacePath('kaiyan/ky404', tenants, users).status).toBe('orphan_user');
  });

  it('parses soft-delete suffixes', () => {
    expect(parseSoftDeletedSegment('ky123-deleted-1730000000000')).toEqual({
      userId: 'ky123',
      softDeleted: true,
    });
    expect(parseSoftDeletedSegment('ky123')).toEqual({ userId: 'ky123', softDeleted: false });
  });
});

describe('workspace scan failure handling (FIX-1 / FIX-4)', () => {
  const AGENT_CWD = '/mnt/agent-saas/workspaces';

  afterEach(() => {
    readdirMock.mockReset();
  });

  function dirent(name: string, isDirectory = true) {
    return { name, isDirectory: () => isDirectory };
  }

  function createFakeStore() {
    return {
      upsertWorkspaceUsage: vi.fn(async () => undefined),
      countWorkspaceUsage: vi.fn(async () => 0),
      insertMetric: vi.fn(async () => undefined),
      pruneSystemMetrics: vi.fn(async () => 0),
    };
  }

  function createCollector(store: ReturnType<typeof createFakeStore>, warns: string[] = []) {
    return new SystemMetricsCollector({
      store: store as unknown as PgSystemMetricsStore,
      agentCwd: AGENT_CWD,
      processCwd: '/srv/server',
      duExecutor: async () => ({ bytes: 10, fileCount: null }),
      logger: { info: () => {}, warn: (msg) => warns.push(msg), error: () => {} },
    });
  }

  it('aborts the round with zero store writes when the top-level readdir fails', async () => {
    readdirMock.mockRejectedValue(new Error('EIO: NAS offline'));
    const store = createFakeStore();
    const warns: string[] = [];
    const collector = createCollector(store, warns);

    await expect(collector.scanWorkspacesOnce()).rejects.toThrow('EIO: NAS offline');
    expect(store.upsertWorkspaceUsage).not.toHaveBeenCalled();
    expect(store.insertMetric).not.toHaveBeenCalled();
    expect(warns.some((msg) => msg.includes('aborted'))).toBe(true);
  });

  it('aborts when readdir returns 0 directories while usage rows already exist', async () => {
    readdirMock.mockResolvedValue([]);
    const store = createFakeStore();
    store.countWorkspaceUsage.mockResolvedValue(3);
    const collector = createCollector(store);

    await expect(collector.scanWorkspacesOnce()).rejects.toThrow(/0 directories/);
    expect(store.upsertWorkspaceUsage).not.toHaveBeenCalled();
  });

  it('allows 0 directories with an empty table (legal initial state)', async () => {
    readdirMock.mockResolvedValue([]);
    const store = createFakeStore();
    const collector = createCollector(store);

    const result = await collector.scanWorkspacesOnce();
    expect(result.dirs).toBe(0);
    expect(store.upsertWorkspaceUsage).toHaveBeenCalledTimes(1);
    expect(store.upsertWorkspaceUsage).toHaveBeenCalledWith(
      [],
      expect.any(Date),
      { durationMs: expect.any(Number) },
      { partial: false },
    );
  });

  it('marks the round partial and skips deletes when a tenant readdir fails', async () => {
    const root = resolve(AGENT_CWD);
    readdirMock.mockImplementation(async (path: unknown) => {
      const p = String(path);
      if (p === root) return [dirent('t1'), dirent('t2')];
      if (p.endsWith('t1')) return [dirent('u1')];
      throw new Error('EACCES: tenant dir unreadable');
    });
    const store = createFakeStore();
    const warns: string[] = [];
    const collector = createCollector(store, warns);

    const result = await collector.scanWorkspacesOnce();
    expect(result.dirs).toBe(1);
    expect(store.upsertWorkspaceUsage).toHaveBeenCalledTimes(1);
    const [records, , detailPatch, options] = store.upsertWorkspaceUsage.mock.calls[0]! as unknown as [
      Array<{ path: string }>, Date, Record<string, unknown>, { partial?: boolean },
    ];
    expect(records.map((record) => record.path)).toEqual(['t1/u1']);
    expect(detailPatch).toMatchObject({ partial: true });
    expect(options).toEqual({ partial: true });
    expect(warns.some((msg) => msg.includes('partial'))).toBe(true);
  });

  it('records -1 bytes when du fails and excludes it from totals', async () => {
    const root = resolve(AGENT_CWD);
    readdirMock.mockImplementation(async (path: unknown) => {
      const p = String(path);
      if (p === root) return [dirent('t1')];
      return [dirent('u1'), dirent('u2')];
    });
    const store = createFakeStore();
    const collector = new SystemMetricsCollector({
      store: store as unknown as PgSystemMetricsStore,
      agentCwd: AGENT_CWD,
      processCwd: '/srv/server',
      duExecutor: async (path) => {
        if (path.endsWith('u1')) throw new CommandTimeoutError('du', 120_000);
        return { bytes: 42, fileCount: null };
      },
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    });

    const result = await collector.scanWorkspacesOnce();
    const [records] = store.upsertWorkspaceUsage.mock.calls[0]! as unknown as [Array<{ path: string; bytes: number }>];
    expect(records.find((record) => record.path === 't1/u1')?.bytes).toBe(-1);
    expect(records.find((record) => record.path === 't1/u2')?.bytes).toBe(42);
    expect(result.totalBytes).toBe(42);
  });
});

describe('runDu fallback semantics (FIX-4)', () => {
  it('does not fall back to du -sk when du -sb times out', async () => {
    const exec = vi.fn(async () => { throw new CommandTimeoutError('du', 5); });

    await expect(runDu('/x', 5, exec)).rejects.toBeInstanceOf(CommandTimeoutError);
    expect(exec).toHaveBeenCalledTimes(1);
    expect(exec).toHaveBeenCalledWith('du', ['-sb', '/x'], 5);
  });

  it('falls back to du -sk only when du -sb errors immediately', async () => {
    const exec = vi.fn()
      .mockRejectedValueOnce(new Error('du: illegal option -- b'))
      .mockResolvedValueOnce('4\t/x\n');

    await expect(runDu('/x', 5, exec)).resolves.toEqual({ bytes: 4096, fileCount: null });
    expect(exec).toHaveBeenCalledTimes(2);
    expect(exec).toHaveBeenNthCalledWith(2, 'du', ['-sk', '/x'], 5);
  });
});
