/**
 * WP2b 目录变更日志 + 投影器的 PostgreSQL 合约（规范 §3.6、附录 L）。
 *
 * 覆盖四件必须真跑 PG 才能证明的事：
 * 1. v42 迁移在真实库上升级、幂等重跑，`employee_no` 列与索引都建出来；
 * 2. **单调 seq 的并发安全**——没有 SHARE 锁就会丢事件，这里同时钉死「裸读会丢」
 *    与「按本实现读不会丢」两侧；
 * 3. 三类源（users JSON / membership / directoryGroups）的变更都产生事件，
 *    其中 directoryGroups 的成员移除与分组删除必须补出删除墓碑；
 * 4. 30 天保留清理只删过期，不误删。
 */
import { randomUUID } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PgDirectoryGroupStore } from '../../data/directoryGroups/store.js';
import { PgKyAppDirectoryChangeLog } from './changeLog.js';
import {
  DirectoryProjector,
  GovernanceDirectorySource,
  type DirectoryUserReader,
  type DirectoryUserSourceRecord,
} from './projection.js';
import { DIRECTORY_FORBIDDEN_FIELD_PATTERN, type DirectoryUser } from './types.js';

const { Pool } = pg;
const testPgUrl = process.env.TEST_DATABASE_URL?.trim();
const describePg = testPgUrl ? describe : describe.skip;

const TENANT = 'tenant-wp2b';
const DAY_MS = 24 * 60 * 60 * 1000;

/** 刻意带上手机号等 PII 字段，验证白名单投影真的把它们挡在外面。 */
type ContaminatedUser = DirectoryUserSourceRecord & Record<string, unknown>;

class FakeUserReader implements DirectoryUserReader {
  records: ContaminatedUser[] = [];

  listAll(): readonly DirectoryUserSourceRecord[] {
    return this.records;
  }
}

function contaminate(record: DirectoryUserSourceRecord): ContaminatedUser {
  return {
    ...record,
    phone: '13800000000',
    phoneVerifiedAt: '2026-01-01T00:00:00.000Z',
    passwordHash: 'argon2id$fake',
    email: 'someone@example.com',
  };
}

describePg('定制项目组织目录变更日志与投影 PostgreSQL 合约', () => {
  const prefix = `kyappdir_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  let pool: InstanceType<typeof Pool>;
  let changeLog: PgKyAppDirectoryChangeLog;
  let users: FakeUserReader;
  let source: GovernanceDirectorySource;
  let projector: DirectoryProjector;
  let groupStore: PgDirectoryGroupStore;

  const membershipsTable = `${prefix}_tenant_memberships`;
  const changeLogTable = `${prefix}_ky_app_directory_change_log`;
  const stateTable = `${prefix}_ky_app_directory_state`;

  async function seedMembership(
    userId: string,
    persona: 'member' | 'org_admin' = 'member',
    status: 'active' | 'disabled' = 'active',
  ): Promise<void> {
    await pool.query(
      `INSERT INTO ${membershipsTable}
         (tenant_id,user_id,persona,is_owner,status,source,created_by,updated_by)
       VALUES ($1,$2,$3,FALSE,$4,'governance','system:test','system:test')
       ON CONFLICT (user_id) DO UPDATE SET persona=EXCLUDED.persona,status=EXCLUDED.status`,
      [TENANT, userId, persona, status],
    );
  }

  async function eventsAfter(
    seq: number,
  ): Promise<{ type: string; entityId: string; seq: number }[]> {
    const page = await changeLog.listAfter({ tenantId: TENANT, afterSeq: seq });
    return page.records.map((record) => ({
      type: record.type,
      entityId: record.entityId,
      seq: record.seq,
    }));
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: testPgUrl!, connectionTimeoutMillis: 5_000, max: 12 });
    changeLog = new PgKyAppDirectoryChangeLog({ pool, tablePrefix: prefix });
    await changeLog.init();
    users = new FakeUserReader();
    source = new GovernanceDirectorySource({ pool, tablePrefix: prefix, users });
    projector = new DirectoryProjector({ pool, tablePrefix: prefix, changeLog, source });
    groupStore = new PgDirectoryGroupStore({
      pool,
      tablePrefix: prefix,
      validateMember: async (tenantId, userId) => {
        const result = await pool.query(
          `SELECT 1 FROM ${membershipsTable} WHERE tenant_id=$1 AND user_id=$2 AND status='active'`,
          [tenantId, userId],
        );
        return result.rows.length > 0;
      },
    });
  }, 120_000);

  afterAll(async () => {
    if (!pool) return;
    try {
      const tables = await pool.query<{ tablename: string }>(
        `SELECT tablename FROM pg_tables
         WHERE schemaname=current_schema() AND LEFT(tablename,LENGTH($1))=$1`,
        [prefix],
      );
      for (const row of tables.rows) {
        await pool.query(`DROP TABLE IF EXISTS "${row.tablename}" CASCADE`);
      }
      const functions = await pool.query<{ proname: string; args: string }>(
        `SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS args
         FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
         WHERE n.nspname=current_schema() AND LEFT(p.proname,LENGTH($1))=$1`,
        [prefix],
      );
      for (const row of functions.rows) {
        await pool.query(`DROP FUNCTION IF EXISTS "${row.proname}"(${row.args}) CASCADE`);
      }
    } finally {
      await pool.end();
    }
  }, 60_000);

  it('v42 迁移真跑：两张新表、employee_no 列与三条索引齐备，且重复运行幂等', async () => {
    const version = await pool.query<{ version: number }>(
      `SELECT MAX(version) AS version FROM ${prefix}_governance_schema_versions`,
    );
    expect(Number(version.rows[0]?.version)).toBe(42);

    const column = await pool.query<{ data_type: string; is_nullable: string }>(
      `SELECT data_type,is_nullable FROM information_schema.columns
       WHERE table_schema=current_schema() AND table_name=$1 AND column_name='employee_no'`,
      [membershipsTable],
    );
    expect(column.rows[0]?.data_type).toBe('text');
    expect(column.rows[0]?.is_nullable).toBe('YES');

    const indexes = await pool.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE schemaname=current_schema()
         AND indexname IN ($1,$2,$3,$4)`,
      [
        `${changeLogTable}_tenant_seq_idx`,
        `${changeLogTable}_retention_idx`,
        `${stateTable}_watermark_idx`,
        `${membershipsTable}_employee_no_idx`,
      ],
    );
    expect(indexes.rows.map((row) => row.indexname).sort()).toHaveLength(4);

    // 幂等：再跑一次迁移不报错、版本不变。
    await changeLog.init();
    const again = await pool.query<{ version: number }>(
      `SELECT MAX(version) AS version FROM ${prefix}_governance_schema_versions`,
    );
    expect(Number(again.rows[0]?.version)).toBe(42);

    // employee_no 的长度上限与附录 L 对齐。
    await seedMembership('u-len');
    await expect(
      pool.query(`UPDATE ${membershipsTable} SET employee_no=$2 WHERE user_id=$1`, [
        'u-len',
        'E'.repeat(33),
      ]),
    ).rejects.toThrow();
    await pool.query(`DELETE FROM ${membershipsTable} WHERE user_id='u-len'`);
  }, 60_000);

  it('单调 seq：未提交的低号事件不会被跳过（裸读会丢，SHARE 锁读不会）', async () => {
    const tenant = `${TENANT}-lock`;
    const baseline = await changeLog.latestSeq(tenant);

    const holder = await pool.connect();
    try {
      await holder.query('BEGIN');
      // A 先拿号但不提交。
      const slow = await changeLog.appendWithin(holder, [
        { tenantId: tenant, source: 'governance', type: 'user.upsert', entityId: 'u-slow' },
      ]);
      expect(slow[0]!.seq).toBeGreaterThan(baseline);

      // B 后拿号并立即提交——这就是「后申请者先提交」的空洞现场。
      const fast = await changeLog.append([
        { tenantId: tenant, source: 'governance', type: 'user.upsert', entityId: 'u-fast' },
      ]);
      expect(fast[0]!.seq).toBeGreaterThan(slow[0]!.seq);

      // 裸读（不加 SHARE 锁）只看得见 B，游标一旦推到 B，A 就永远丢了。
      const naive = await pool.query<{ seq: string; entity_id: string }>(
        `SELECT seq,entity_id FROM ${changeLogTable} WHERE tenant_id=$1 AND seq > $2 ORDER BY seq`,
        [tenant, baseline],
      );
      expect(naive.rows.map((row) => row.entity_id)).toEqual(['u-fast']);

      // 本实现的读会等在 LOCK TABLE 上，A 提交前不返回。
      let settled = false;
      const guarded = changeLog.listAfter({ tenantId: tenant, afterSeq: baseline }).then((page) => {
        settled = true;
        return page;
      });
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(settled).toBe(false);

      await holder.query('COMMIT');
      const page = await guarded;
      expect(page.records.map((record) => record.entityId)).toEqual(['u-slow', 'u-fast']);
      expect(page.nextSeq).toBe(fast[0]!.seq);
    } finally {
      holder.release();
    }
  }, 60_000);

  it('单调 seq：并发写入时按 seq 续流读取无空洞、无丢失、无重复', async () => {
    const tenant = `${TENANT}-race`;
    const writers = 8;
    const perWriter = 12;
    const expected = writers * perWriter;

    let cursor = await changeLog.latestSeq(tenant);
    const collected: number[] = [];
    const seenEntities = new Set<string>();
    let writing = true;

    const consumer = (async () => {
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        const page = await changeLog.listAfter({ tenantId: tenant, afterSeq: cursor, limit: 5 });
        for (const record of page.records) {
          collected.push(record.seq);
          seenEntities.add(record.entityId);
        }
        cursor = page.nextSeq;
        if (!writing && !page.hasMore && page.records.length === 0) break;
        if (page.records.length === 0) await new Promise((resolve) => setTimeout(resolve, 10));
      }
    })();

    await Promise.all(
      Array.from({ length: writers }, async (_unused, writer) => {
        for (let index = 0; index < perWriter; index += 1) {
          await changeLog.append([
            {
              tenantId: tenant,
              source: 'governance',
              type: 'user.upsert',
              entityId: `w${writer}-${index}`,
            },
          ]);
        }
      }),
    );
    writing = false;
    await consumer;

    expect(seenEntities.size).toBe(expected);
    expect(collected).toHaveLength(expected);
    // 严格递增即「消费端视角无重复、无回头」。
    for (let index = 1; index < collected.length; index += 1) {
      expect(collected[index]!).toBeGreaterThan(collected[index - 1]!);
    }
    // 与库内实际行数逐一对齐即「无空洞、无丢失」。
    const stored = await pool.query<{ seq: string }>(
      `SELECT seq FROM ${changeLogTable} WHERE tenant_id=$1 ORDER BY seq`,
      [tenant],
    );
    expect(collected).toEqual(stored.rows.map((row) => Number(row.seq)));
  }, 90_000);

  it('三类源变更都产生事件：users JSON / membership / directoryGroups', async () => {
    users.records = [
      contaminate({
        id: 'u-1',
        username: 'zhangsan',
        realName: '张三',
        tenantId: TENANT,
        role: 'user',
      }),
      contaminate({
        id: 'u-2',
        username: 'lisi',
        realName: '李四',
        tenantId: TENANT,
        role: 'user',
      }),
      contaminate({ id: 'u-x', username: 'other', tenantId: 'tenant-other', role: 'user' }),
    ];
    await seedMembership('u-1');
    await seedMembership('u-2');

    let cursor = await changeLog.latestSeq(TENANT);
    const first = await projector.reconcileTenant(TENANT);
    expect(first.userUpserts).toBe(2);
    const initial = await eventsAfter(cursor);
    expect(initial.map((event) => `${event.type}:${event.entityId}`)).toEqual([
      'user.upsert:u-1',
      'user.upsert:u-2',
    ]);
    cursor = first.snapshotSeq;

    // 幂等：源端没变就不许再产生事件。
    const idle = await projector.reconcileTenant(TENANT);
    expect(idle.userUpserts + idle.userRemovals + idle.groupUpserts + idle.groupRemovals).toBe(0);
    expect(await eventsAfter(cursor)).toEqual([]);

    // ① users JSON 存储：改名 + 停用。
    users.records[0]!.realName = '张三丰';
    users.records[1]!.disabled = true;
    const renamed = await projector.reconcileTenant(TENANT);
    expect(renamed.userUpserts).toBe(2);
    const afterRename = await changeLog.listAfter({ tenantId: TENANT, afterSeq: cursor });
    const renamedUser = afterRename.records.find((record) => record.entityId === 'u-1')!
      .payload as DirectoryUser;
    expect(renamedUser.displayName).toBe('张三丰');
    const disabledUser = afterRename.records.find((record) => record.entityId === 'u-2')!
      .payload as DirectoryUser;
    expect(disabledUser.status).toBe('disabled');
    cursor = renamed.snapshotSeq;

    // ② membership：persona 升为组织管理员 + 工号录入。
    await seedMembership('u-1', 'org_admin');
    expect(await source.setEmployeeNo(TENANT, 'u-1', 'E-0007')).toBe(true);
    const promoted = await projector.reconcileTenant(TENANT);
    expect(promoted.userUpserts).toBe(1);
    const promotedEvents = await changeLog.listAfter({ tenantId: TENANT, afterSeq: cursor });
    const admin = promotedEvents.records[0]!.payload as DirectoryUser;
    expect(admin).toMatchObject({ userId: 'u-1', isTenantAdmin: true, employeeNo: 'E-0007' });
    cursor = promoted.snapshotSeq;

    // ③ directoryGroups：真实 upsertProjection（DELETE 全量重插）建组并挂人。
    await groupStore.upsertProjection({
      groupId: 'g-root',
      tenantId: TENANT,
      source: 'governance',
      displayName: '研发部',
      status: 'active',
      memberUserIds: ['u-1', 'u-2'],
    });
    const grouped = await projector.reconcileTenant(TENANT);
    expect(grouped.groupUpserts).toBe(1);
    expect(grouped.userUpserts).toBe(2);
    const groupedEvents = await changeLog.listAfter({ tenantId: TENANT, afterSeq: cursor });
    // 分组事件必须排在引用它的用户事件之前。
    expect(groupedEvents.records[0]!.type).toBe('group.upsert');
    const groupedUser = groupedEvents.records.find((record) => record.entityId === 'u-1')!
      .payload as DirectoryUser;
    expect(groupedUser.groupIds).toEqual(['g-root']);
    cursor = grouped.snapshotSeq;
  }, 90_000);

  it('directoryGroups 的成员移除与分组删除都补出删除墓碑', async () => {
    let cursor = await changeLog.latestSeq(TENANT);

    // upsertProjection 对成员表是 DELETE 全量 + 重插，被移除的成员在源表里不留痕；
    // 差分投影必须据此推出「u-2 的 groupIds 变空」。
    await groupStore.upsertProjection({
      groupId: 'g-root',
      tenantId: TENANT,
      source: 'governance',
      displayName: '研发部',
      status: 'active',
      memberUserIds: ['u-1'],
    });
    const removedMember = await projector.reconcileTenant(TENANT);
    expect(removedMember.userUpserts).toBe(1);
    const memberEvents = await changeLog.listAfter({ tenantId: TENANT, afterSeq: cursor });
    expect((memberEvents.records[0]!.payload as DirectoryUser).userId).toBe('u-2');
    expect((memberEvents.records[0]!.payload as DirectoryUser).groupIds).toEqual([]);
    cursor = removedMember.snapshotSeq;

    // 分组整个消失 → group.remove 墓碑（源表里同样只是一行没了）。
    await pool.query(`DELETE FROM ${prefix}_directory_groups WHERE tenant_id=$1 AND group_id=$2`, [
      TENANT,
      'g-root',
    ]);
    const removedGroup = await projector.reconcileTenant(TENANT);
    expect(removedGroup.groupRemovals).toBe(1);
    const groupEvents = await eventsAfter(cursor);
    expect(
      groupEvents.some((event) => event.type === 'group.remove' && event.entityId === 'g-root'),
    ).toBe(true);
    cursor = removedGroup.snapshotSeq;

    // 账号从 users.json 消失 → user.remove 墓碑；用户事件排在分组事件之前。
    users.records = users.records.filter((record) => record.id !== 'u-2');
    const removedUser = await projector.reconcileTenant(TENANT);
    expect(removedUser.userRemovals).toBe(1);
    const userEvents = await eventsAfter(cursor);
    expect(userEvents).toContainEqual(
      expect.objectContaining({ type: 'user.remove', entityId: 'u-2' }),
    );
    // 投影态同步清干净，重复对齐不会再发一次墓碑。
    const state = await pool.query(
      `SELECT 1 FROM ${stateTable} WHERE tenant_id=$1 AND entity_type='user' AND entity_id='u-2'`,
      [TENANT],
    );
    expect(state.rows).toHaveLength(0);
    const settled = await projector.reconcileTenant(TENANT);
    expect(settled.userRemovals + settled.groupRemovals).toBe(0);
  }, 90_000);

  it('落库的事件载荷只含附录 L 白名单字段，手机号等 PII 一个都不落库', async () => {
    const rows = await pool.query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM ${changeLogTable} WHERE tenant_id=$1 AND type='user.upsert'`,
      [TENANT],
    );
    expect(rows.rows.length).toBeGreaterThan(0);
    for (const row of rows.rows) {
      for (const key of Object.keys(row.payload)) {
        expect(key).not.toMatch(DIRECTORY_FORBIDDEN_FIELD_PATTERN);
        expect([
          'userId',
          'displayName',
          'employeeNo',
          'status',
          'isTenantAdmin',
          'groupIds',
        ]).toContain(key);
      }
    }
    const raw = await pool.query<{ blob: string }>(
      `SELECT COALESCE(string_agg(payload::text,''),'') AS blob FROM ${changeLogTable}`,
    );
    expect(raw.rows[0]!.blob).not.toContain('13800000000');
    expect(raw.rows[0]!.blob).not.toContain('argon2id');
    expect(raw.rows[0]!.blob).not.toContain('someone@example.com');

    // 投影态表同样不许沉淀 PII。
    const stateBlob = await pool.query<{ blob: string }>(
      `SELECT COALESCE(string_agg(payload::text,''),'') AS blob FROM ${stateTable}`,
    );
    expect(stateBlob.rows[0]!.blob).not.toContain('13800000000');
  }, 60_000);

  it('30 天保留清理只删过期事件，未过期的一条不动', async () => {
    const tenant = `${TENANT}-retention`;
    const now = new Date('2026-09-06T00:00:00.000Z');
    const stale = await changeLog.append([
      {
        tenantId: tenant,
        source: 'governance',
        type: 'user.upsert',
        entityId: 'old',
        occurredAt: new Date(now.getTime() - 31 * DAY_MS),
      },
    ]);
    const edge = await changeLog.append([
      {
        tenantId: tenant,
        source: 'governance',
        type: 'user.upsert',
        entityId: 'edge',
        occurredAt: new Date(now.getTime() - 29 * DAY_MS),
      },
    ]);
    const fresh = await changeLog.append([
      {
        tenantId: tenant,
        source: 'governance',
        type: 'user.upsert',
        entityId: 'fresh',
        occurredAt: now,
      },
    ]);

    const deleted = await changeLog.purgeExpired({ now });
    expect(deleted).toBe(1);
    const remaining = await changeLog.listAfter({ tenantId: tenant, afterSeq: 0 });
    expect(remaining.records.map((record) => record.entityId)).toEqual(['edge', 'fresh']);
    expect(remaining.records.map((record) => record.seq)).toEqual([edge[0]!.seq, fresh[0]!.seq]);

    // 保留期下界抬到被清理号段之后：消费端 after 落在它之前就必须重拉快照（Phase B 的 410）。
    expect(await changeLog.retentionFloorSeq(tenant)).toBe(edge[0]!.seq - 1);
    expect(await changeLog.retentionFloorSeq(tenant)).toBeGreaterThanOrEqual(stale[0]!.seq);

    // 再清一次不会误删未过期的。
    expect(await changeLog.purgeExpired({ now })).toBe(0);
    expect((await changeLog.listAfter({ tenantId: tenant, afterSeq: 0 })).records).toHaveLength(2);
  }, 60_000);
});
