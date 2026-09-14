import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { InstallationBinding } from '@kaiyan/ky-app-contract';

import { ensureKyAppSchema } from '../pg/schema.js';
import { PgInstallationBindingProvider } from './pgBindingProvider.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const enabled = typeof databaseUrl === 'string' && databaseUrl !== '';
if (!enabled) console.warn('[ky-app-server] 跳过 V2 多副本 PG 用例：未设置 TEST_DATABASE_URL');

const value = (generation: number): InstallationBinding => ({
  installationId: 'v2-pg-inst',
  tenantId: 'tenant-1',
  systemId: 'system-1',
  deploymentId: 'deployment-1',
  origin: 'https://business.example.com',
  platformIssuer: 'https://platform.example.com',
  platformApiBaseUrl: 'https://api.example.com',
  keyId: `key-${generation}`,
  grantedScopes: ['directory.snapshot'],
  registeredDigest: 'a'.repeat(64),
  generation,
  state: 'activating',
  updatedAt: new Date().toISOString(),
});

describe.skipIf(!enabled)('PgInstallationBindingProvider 多副本 CAS', () => {
  let pool: pg.Pool;
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: databaseUrl, max: 4 });
    await ensureKyAppSchema(pool);
  });
  afterAll(async () => pool?.end());
  beforeEach(async () => {
    await pool.query(
      `DELETE FROM ky_app_installation_binding_stages WHERE installation_id='v2-pg-inst'`,
    );
    await pool.query(`DELETE FROM ky_app_installation_bindings WHERE installation_id='v2-pg-inst'`);
  });

  it('两个进程竞争同 generation 时只有一个 commit，失败候选不覆盖旧 binding', async () => {
    const processA = new PgInstallationBindingProvider(pool);
    const processB = new PgInstallationBindingProvider(pool);
    await processA.stage(value(1));
    await processA.activate('v2-pg-inst', 1);
    await Promise.all([processA.stage(value(2)), processB.stage(value(2))]);
    const results = await Promise.allSettled([
      processA.activate('v2-pg-inst', 2),
      processB.activate('v2-pg-inst', 2),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect((await processA.get('v2-pg-inst'))?.generation).toBe(2);
  });
});
