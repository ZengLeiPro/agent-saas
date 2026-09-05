/**
 * PG 存储实现的行为对齐测试：执行记录、安装实例状态与事件去重、组织目录、兜底登录。
 *
 * 需要 `TEST_DATABASE_URL`；缺失时整组 skip 并打印原因。
 */
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { DirectoryUser } from '@kaiyan/ky-app-contract';

import { PgBreakGlassStore } from '../breakGlass/pgStore.js';
import { PgDirectoryStore } from '../directory/pgStore.js';
import { PgExecutionStore } from '../capabilities/pgExecutionStore.js';
import { PgInstallationStateStore } from '../events/pgStore.js';
import { EXECUTION_RETENTION_MS, type ExecutionRecord } from '../capabilities/executionStore.js';
import { ensureKyAppSchema } from './schema.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const enabled = typeof databaseUrl === 'string' && databaseUrl !== '';

if (!enabled) {
  console.warn(
    '[ky-app-server] 跳过 PG 存储用例：未设置 TEST_DATABASE_URL（CI 的 postgres 任务会提供）',
  );
}

const NOW = Date.parse('2026-09-05T00:00:00.000Z');
const IID = 'tsi_pg';

function user(userId: string, overrides: Partial<DirectoryUser> = {}): DirectoryUser {
  return {
    userId,
    displayName: `员工${userId}`,
    status: 'active',
    isTenantAdmin: false,
    groupIds: ['g1'],
    ...overrides,
  };
}

function record(overrides: Partial<ExecutionRecord> = {}): ExecutionRecord {
  return {
    installationId: IID,
    capabilityId: 'order.create',
    sub: 'u_1',
    lcid: 'lc_1',
    inputHash: 'a'.repeat(64),
    status: 'in_progress',
    createdAt: NOW,
    updatedAt: NOW,
    expiresAt: NOW + EXECUTION_RETENTION_MS,
    ...overrides,
  };
}

describe.skipIf(!enabled)('PG 存储实现（需要 TEST_DATABASE_URL）', () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: databaseUrl, max: 8 });
    // 与另一份 PG 测试文件可能并行建表，`CREATE TABLE IF NOT EXISTS` 撞车时重试一次。
    try {
      await ensureKyAppSchema(pool);
    } catch {
      await ensureKyAppSchema(pool);
    }
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
  });

  beforeEach(async () => {
    await pool.query(
      `TRUNCATE ky_app_execution, ky_app_event_ack, ky_app_directory_user,
                ky_app_directory_group, ky_app_directory_checkpoint,
                ky_app_break_glass_record, ky_app_break_glass_session,
                ky_app_break_glass_employee_code, ky_app_break_glass_audit`,
    );
    await pool.query(
      `INSERT INTO ky_app_installation_state (id, state, state_version, updated_at)
       VALUES (1,'enabled',0, now())
       ON CONFLICT (id) DO UPDATE SET state = 'enabled', state_version = 0`,
    );
  });

  describe('PgExecutionStore', () => {
    it('begin 是原子的：并发 10 次只有 1 次 created', async () => {
      const store = new PgExecutionStore(pool);
      const results = await Promise.all(Array.from({ length: 10 }, () => store.begin(record())));
      expect(results.filter((item) => item.created)).toHaveLength(1);
      expect(results.every((item) => item.record.inputHash === 'a'.repeat(64))).toBe(true);
    });

    it('finish 落终态，get / findByLcid 读回一致', async () => {
      const store = new PgExecutionStore(pool);
      await store.begin(record());
      await store.finish(record(), { status: 'done', result: { orderId: 'SO-9' }, at: NOW + 10 });
      const stored = await store.get(record());
      expect(stored).toMatchObject({ status: 'done', result: { orderId: 'SO-9' } });

      const other = await store.findByLcid({
        installationId: IID,
        capabilityId: 'order.create',
        lcid: 'lc_1',
      });
      expect(other?.sub).toBe('u_1');
      expect(await store.get({ ...record(), sub: 'u_other' })).toBeNull();
    });

    it('failed 记录保留错误；expireOverdue 把过保留期的终态改成 expired', async () => {
      const store = new PgExecutionStore(pool);
      await store.begin(record({ lcid: 'lc_fail' }));
      await store.finish(record({ lcid: 'lc_fail' }), {
        status: 'failed',
        error: { code: 'internal', message: '下游拒绝' },
        at: NOW,
      });
      expect(await store.get(record({ lcid: 'lc_fail' }))).toMatchObject({
        status: 'failed',
        error: { code: 'internal' },
      });

      expect(await store.expireOverdue(NOW + EXECUTION_RETENTION_MS + 1)).toBe(1);
      const expired = await store.get(record({ lcid: 'lc_fail' }));
      expect(expired?.status).toBe('expired');
      expect(expired?.result).toBeUndefined();
    });
  });

  describe('PgInstallationStateStore', () => {
    it('状态与 ack 同事务提交，eventId 幂等', async () => {
      const store = new PgInstallationStateStore(pool);
      expect(await store.getState()).toEqual({ state: 'enabled', stateVersion: 0 });
      expect(await store.findAck('ev_1')).toBeNull();

      const ack = { eventId: 'ev_1', ack: true as const, stateVersion: 1 };
      await store.commit({ eventId: 'ev_1', ack, state: { state: 'disabled', stateVersion: 1 } });
      expect(await store.getState()).toEqual({ state: 'disabled', stateVersion: 1 });
      expect(await store.findAck('ev_1')).toEqual(ack);
    });
  });

  describe('PgDirectoryStore', () => {
    it('快照单事务应用并推进 checkpoint', async () => {
      const store = new PgDirectoryStore(pool);
      await store.applySnapshot({
        snapshotSeq: 10,
        users: [user('u1'), user('u2', { isTenantAdmin: true })],
        groups: [{ groupId: 'g1', displayName: '销售部', status: 'active' }],
        at: NOW,
      });
      expect(await store.getCheckpoint()).toEqual({ seq: 10, at: NOW });
      expect(await store.listUsers()).toHaveLength(2);
      expect((await store.getUser('u2'))?.isTenantAdmin).toBe(true);
      expect(await store.listGroups()).toHaveLength(1);
    });

    it('快照里消失的用户标离职；disabled → suspended 且不自动复活', async () => {
      const store = new PgDirectoryStore(pool);
      await store.applySnapshot({
        snapshotSeq: 10,
        users: [user('u1'), user('u2')],
        groups: [],
        at: NOW,
      });
      await store.applyChanges({
        events: [
          {
            seq: 11,
            eventId: 'e11',
            type: 'user.upsert',
            user: user('u1', { status: 'disabled' }),
          },
        ],
        nextSeq: 11,
        at: NOW + 1,
      });
      expect((await store.getUser('u1'))?.localStatus).toBe('suspended');

      await store.applyChanges({
        events: [
          { seq: 12, eventId: 'e12', type: 'user.upsert', user: user('u1', { status: 'active' }) },
        ],
        nextSeq: 12,
        at: NOW + 2,
      });
      expect((await store.getUser('u1'))?.localStatus).toBe('suspended');
      await store.reinstateUser('u1', NOW + 3);
      expect((await store.getUser('u1'))?.localStatus).toBe('active');

      await store.applySnapshot({ snapshotSeq: 20, users: [user('u1')], groups: [], at: NOW + 4 });
      expect(await store.getUser('u2')).toMatchObject({ removed: true, localStatus: 'suspended' });
    });

    it('seq ≤ checkpoint 的事件被忽略；SAT tadm 可覆盖 isTenantAdmin', async () => {
      const store = new PgDirectoryStore(pool);
      await store.applySnapshot({ snapshotSeq: 10, users: [user('u1')], groups: [], at: NOW });
      await store.applyChanges({
        events: [{ seq: 5, eventId: 'old', type: 'user.remove', userId: 'u1' }],
        nextSeq: 10,
        at: NOW + 1,
      });
      expect((await store.getUser('u1'))?.removed).toBe(false);

      await store.setTenantAdmin('u1', true, NOW + 2);
      expect((await store.getUser('u1'))?.isTenantAdmin).toBe(true);
    });
  });

  describe('PgBreakGlassStore', () => {
    it('恢复记录 / 会话 / 员工码 / 审计往返一致，关闭会话即删行', async () => {
      const store = new PgBreakGlassStore(pool);
      await store.saveRecord({
        sub: 'u_admin',
        passwordHash: '$argon2id$fake',
        codes: [{ hash: 'h1', usedAt: null }],
        failedAttempts: 1,
        lockedUntil: NOW + 1000,
        createdAt: NOW,
        updatedAt: NOW,
      });
      expect(await store.getRecord('u_admin')).toMatchObject({
        passwordHash: '$argon2id$fake',
        failedAttempts: 1,
        lockedUntil: NOW + 1000,
      });

      await store.saveSession({ enabledBy: 'u_admin', enabledAt: NOW, expiresAt: NOW + 1000 });
      expect(await store.getSession()).toEqual({
        enabledBy: 'u_admin',
        enabledAt: NOW,
        expiresAt: NOW + 1000,
      });
      await store.saveSession(null);
      expect(await store.getSession()).toBeNull();

      await store.saveEmployeeCode({
        loginId: 'E1024',
        sub: 'u_member',
        hash: 'h2',
        expiresAt: NOW + 900_000,
        usedAt: null,
        failedAttempts: 0,
        lockedUntil: null,
      });
      expect(await store.getEmployeeCode('E1024')).toMatchObject({ sub: 'u_member', usedAt: null });

      await store.appendAudit({ at: NOW, action: 'enable', outcome: 'success', sub: 'u_admin' });
      await store.appendAudit({
        at: NOW + 1,
        action: 'login',
        outcome: 'failure',
        loginId: 'E1024',
      });
      const audit = await store.listAudit();
      expect(audit.map((entry) => `${entry.action}:${entry.outcome}`)).toEqual([
        'enable:success',
        'login:failure',
      ]);
    });
  });
});
