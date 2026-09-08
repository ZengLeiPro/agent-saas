import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { KyAppInstallationDirectory } from '../installations/queries.js';
import { KyAppHealthProber } from '../health/prober.js';

const url = process.env.TEST_DATABASE_URL?.trim();
const describePg = url ? describe : describe.skip;

describePg('首次接入探测 PostgreSQL 合约', () => {
  const table = `kyapp_probe_${randomUUID().replaceAll('-', '')}`;
  const pool = new pg.Pool({ connectionString: url, connectionTimeoutMillis: 5000 });
  const directory = new KyAppInstallationDirectory(pool as never, table);
  beforeAll(async () => {
    await pool.query(`CREATE TABLE ${table} (
      installation_id TEXT PRIMARY KEY,tenant_id TEXT,system_id TEXT,base_url TEXT,
      origin TEXT,status TEXT,state_version INTEGER,registered_digest TEXT,domain_verified_at TIMESTAMPTZ)`);
    for (const [id, status, verified] of [
      ['enabled', 'enabled', true],
      ['pending', 'pending', true],
      ['unverified', 'pending', false],
      ['disabled', 'disabled', true],
      ['deleted', 'deleted', true],
    ])
      await pool.query(
        `INSERT INTO ${table} VALUES ($1,'tenant-a','demo-system','https://demo.example.com','https://demo.example.com',$2,1,NULL,$3)`,
        [id, status, verified ? new Date() : null],
      );
  });
  afterAll(async () => {
    await pool.query(`DROP TABLE IF EXISTS ${table}`);
    await pool.end();
  });

  it('已验证 pending 可以取得首次 ready，未验证/停用/删除实例不探测，投递目录仍只有 enabled', async () => {
    expect((await directory.listProbeable()).map((item) => item.installationId)).toEqual([
      'enabled',
      'pending',
    ]);
    expect((await directory.listEnabled()).map((item) => item.installationId)).toEqual(['enabled']);
    const recordReady = vi.fn().mockResolvedValue({ consecutiveFailures: 0 });
    const prober = new KyAppHealthProber({
      config: { probe: { liveIntervalMs: 60000, readyIntervalMs: 300000, failureThreshold: 5 } },
      directory,
      runtimeStore: {
        get: vi.fn().mockResolvedValue(null),
        recordLive: vi.fn().mockResolvedValue({ consecutiveFailures: 0, alertedAt: null }),
        recordReady,
      },
      issuer: { issue: vi.fn().mockResolvedValue({ token: 'test-platform-sat' }) },
      outbound: {
        request: vi.fn().mockResolvedValue({
          status: 200,
          json: { status: 'ok', manifestDigest: 'a'.repeat(64) },
        }),
      },
      clearAlert: vi.fn(),
    } as never);
    const result = await prober.tick();
    expect(result.readyProbed).toBe(2);
    expect(recordReady).toHaveBeenCalledWith(
      expect.objectContaining({
        installationId: 'pending',
        status: 'ok',
        manifestDigest: 'a'.repeat(64),
      }),
    );
  });
});
