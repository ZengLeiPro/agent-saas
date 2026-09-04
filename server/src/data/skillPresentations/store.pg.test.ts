import { randomUUID } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { governanceV38SkillPresentationStatements } from '../governance-schema/v38SkillPresentationMigration.js';
import { PgSkillPresentationStore } from './store.js';

const testPgUrl = process.env.TEST_DATABASE_URL?.trim();
const describePg = testPgUrl ? describe : describe.skip;
const { Pool } = pg;

describePg('技能展示信息 PostgreSQL 合约', () => {
  const prefix = `skill_meta_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const table = `${prefix}_skill_presentations`;
  let pool: InstanceType<typeof Pool>;
  let store: PgSkillPresentationStore;

  beforeAll(async () => {
    pool = new Pool({ connectionString: testPgUrl!, connectionTimeoutMillis: 5_000, max: 4 });
    for (const statement of governanceV38SkillPresentationStatements(prefix))
      await pool.query(statement);
    store = new PgSkillPresentationStore({ pool, tablePrefix: prefix });
    await store.ensureBuiltinDefaults();
  });

  afterAll(async () => {
    if (!pool) return;
    await pool.query(`DROP TABLE IF EXISTS ${table} CASCADE`);
    await pool.end();
  });

  it('种子不覆盖管理员值，组织覆盖优先且并发 revision 只有一笔成功', async () => {
    const base = await store.getExact({
      resourceScope: 'platform',
      resourceTenantId: '',
      skillId: 'archify',
      audienceTenantId: '',
      locale: 'zh-CN',
    });
    expect(base?.revision).toBe(1);
    const updated = await store.upsert({
      resourceScope: 'platform',
      resourceTenantId: '',
      skillId: 'archify',
      audienceTenantId: '',
      locale: 'zh-CN',
      displayName: '管理员名称',
      summary: '管理员保存的说明',
      expectedRevision: 1,
      updatedBy: 'admin',
    });
    await store.ensureBuiltinDefaults();
    expect((await store.getExact(updated))?.displayName).toBe('管理员名称');

    await store.upsert({
      resourceScope: 'platform',
      resourceTenantId: '',
      skillId: 'archify',
      audienceTenantId: 'wain',
      locale: 'zh-CN',
      displayName: '组织名称',
      summary: '组织覆盖说明',
      expectedRevision: 0,
      updatedBy: 'wain-admin',
    });
    expect(
      (await store.listEffectivePlatform(['archify'], 'wain')).get('archify')?.displayName,
    ).toBe('组织名称');

    const attempts = await Promise.allSettled([
      store.upsert({
        ...updated,
        displayName: '并发甲',
        summary: '甲',
        expectedRevision: 2,
        updatedBy: 'a',
      }),
      store.upsert({
        ...updated,
        displayName: '并发乙',
        summary: '乙',
        expectedRevision: 2,
        updatedBy: 'b',
      }),
    ]);
    expect(attempts.filter((attempt) => attempt.status === 'fulfilled')).toHaveLength(1);
    expect(attempts.filter((attempt) => attempt.status === 'rejected')).toHaveLength(1);
  });

  it('删除同样执行 revision 冲突保护', async () => {
    const key = {
      resourceScope: 'platform' as const,
      resourceTenantId: '',
      skillId: 'archify',
      audienceTenantId: 'wain',
      locale: 'zh-CN',
    };
    await expect(store.delete(key, 2)).rejects.toMatchObject({
      code: 'SKILL_PRESENTATION_VERSION_CONFLICT',
    });
    await store.delete(key, 1);
    expect(await store.getExact(key)).toBeNull();
  });
});
