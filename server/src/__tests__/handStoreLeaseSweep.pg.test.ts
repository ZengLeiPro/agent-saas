import { randomUUID } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PgHandStore, SERVER_REMOTE_HAND_LEASE_MS } from '../runtime/handStore.js';

const { Pool } = pg;
const testPgUrl = process.env.TEST_DATABASE_URL?.trim();
const describePg = testPgUrl ? describe : describe.skip;

describePg('PgHandStore.sweepLeases（2026-08-03 P1 hands 租约治理）', () => {
  const prefix = `handsweep_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  let pool: InstanceType<typeof Pool>;
  let store: PgHandStore;

  beforeAll(async () => {
    pool = new Pool({ connectionString: testPgUrl!, connectionTimeoutMillis: 5_000, max: 4 });
    store = new PgHandStore({ pool, tablePrefix: prefix });
    await store.init();
    await pool.query(`CREATE TABLE ${prefix}_runs (run_id TEXT PRIMARY KEY, session_id TEXT, status TEXT, updated_at TIMESTAMPTZ)`);
  }, 30_000);

  afterAll(async () => {
    if (!pool) return;
    try {
      await pool.query(`DROP TABLE IF EXISTS ${prefix}_runs`);
      await pool.query(`DROP TABLE IF EXISTS ${prefix}_hands`);
    } finally {
      await pool.end();
    }
  }, 30_000);

  async function seed(handId: string, opts: {
    status?: string;
    leaseExpiresAt?: string | null;
    updatedAt?: string;
    type?: string;
    sessionId?: string;
  } = {}): Promise<void> {
    await pool.query(
      `INSERT INTO ${prefix}_hands (hand_id, session_id, workspace_id, type, status, endpoint, lease_expires_at, created_at, updated_at)
       VALUES ($1, $6, 'ws_t__u', $2, $3, 'http://127.0.0.1:3400', $4, $5, $5)
       ON CONFLICT (hand_id) DO UPDATE SET status = EXCLUDED.status, lease_expires_at = EXCLUDED.lease_expires_at, updated_at = EXCLUDED.updated_at`,
      [
        handId,
        opts.type ?? 'server-remote',
        opts.status ?? 'ready',
        opts.leaseExpiresAt === undefined ? null : opts.leaseExpiresAt,
        opts.updatedAt ?? new Date().toISOString(),
        opts.sessionId ?? null,
      ],
    );
  }

  it('backfill：无租约存量按 GREATEST(created,updated)+lease 补齐；老僵尸随后过期 destroyed', async () => {
    const fortyDaysAgo = new Date(Date.now() - 40 * 24 * 60 * 60_000).toISOString();
    await seed('zombie-old', { updatedAt: fortyDaysAgo });          // 40 天前 → 补租约即已过期
    await seed('active-new', { updatedAt: new Date().toISOString() }); // 活跃 → 补租约后未过期

    const first = await store.sweepLeases();
    expect(first.backfilled).toBe(2);
    expect(first.destroyed).toBe(1);
    expect(first.purged).toBe(0);

    const zombie = await store.get('zombie-old');
    expect(zombie?.status).toBe('destroyed');
    expect(zombie?.metadata.destroyReason).toBe('lease_expired');
    const active = await store.get('active-new');
    expect(active?.status).toBe('ready');
    expect(active?.leaseExpiresAt).toBeTruthy();
  });

  it('destroyed 超保留期物理清除；幂等重跑无副作用', async () => {
    const twentyDaysAgo = new Date(Date.now() - 20 * 24 * 60 * 60_000).toISOString();
    await seed('purge-me', { status: 'destroyed', updatedAt: twentyDaysAgo, leaseExpiresAt: twentyDaysAgo });

    const result = await store.sweepLeases();
    expect(result.purged).toBeGreaterThanOrEqual(1);
    expect(await store.get('purge-me')).toBeNull();

    const again = await store.sweepLeases();
    expect(again).toEqual({ backfilled: 0, destroyed: 0, purged: 0 });
  });

  it('非 server-remote 类型与显式未过期租约不受影响', async () => {
    const future = new Date(Date.now() + SERVER_REMOTE_HAND_LEASE_MS).toISOString();
    const fortyDaysAgo = new Date(Date.now() - 40 * 24 * 60 * 60_000).toISOString();
    await seed('container-hand', { type: 'server-container', updatedAt: fortyDaysAgo });
    await seed('leased-hand', { leaseExpiresAt: future });

    await store.sweepLeases();

    expect((await store.get('container-hand'))?.status).toBe('ready');
    expect((await store.get('container-hand'))?.leaseExpiresAt).toBeUndefined();
    expect((await store.get('leased-hand'))?.status).toBe('ready');
  });

  it('provision recovery claim/complete 只允许当前 token 原子更新', async () => {
    await seed('recover-race', { status: 'unhealthy' });
    await pool.query(
      `UPDATE ${prefix}_hands SET metadata = $2::jsonb WHERE hand_id = $1`,
      ['recover-race', JSON.stringify({ provisionFailure: 'old failure' })],
    );

    expect(await store.claimProvisionRecovery('recover-race', 'token-1')).not.toBeNull();
    expect(await store.claimProvisionRecovery('recover-race', 'token-2')).toBeNull();
    expect(await store.completeProvisionRecovery('recover-race', 'wrong-token', 'ready')).toBeNull();
    expect(await store.completeProvisionRecovery('recover-race', 'token-1', 'ready', {
      provisionFailure: null,
      provision: { lastStatus: 'ok' },
    })).not.toBeNull();

    const recovered = await store.get('recover-race');
    expect(recovered?.status).toBe('ready');
    expect(recovered?.metadata.provisionRecoveryToken).toBeNull();
    expect(recovered?.metadata.provisionFailure).toBeNull();

    await seed('recover-destroyed', { status: 'destroyed' });
    await pool.query(
      `UPDATE ${prefix}_hands SET metadata = $2::jsonb WHERE hand_id = $1`,
      ['recover-destroyed', JSON.stringify({ provisionFailure: 'stale failure' })],
    );
    expect(await store.claimProvisionRecovery('recover-destroyed', 'token-destroyed')).toBeNull();

    await seed('normal-generation', { status: 'ready' });
    await pool.query(
      `UPDATE ${prefix}_hands SET status = 'provisioning', metadata = $2::jsonb WHERE hand_id = $1`,
      ['normal-generation', JSON.stringify({ provisionGeneration: 'generation-2' })],
    );
    expect(await store.completeProvisionAttempt('normal-generation', 'generation-1', 'unhealthy')).toBeNull();
    expect(await store.completeProvisionAttempt('normal-generation', 'generation-2', 'ready')).not.toBeNull();
  });

  it('register upsert 可复活 destroyed 记录（lease 治理无永久误杀）', async () => {
    await seed('revive-me', { status: 'destroyed', leaseExpiresAt: new Date(Date.now() - 1000).toISOString() });

    await store.register({
      handId: 'revive-me',
      workspaceId: 'ws_t__u',
      type: 'server-remote',
      status: 'ready',
      endpoint: 'http://127.0.0.1:3400',
      leaseExpiresAt: new Date(Date.now() + SERVER_REMOTE_HAND_LEASE_MS),
    });

    const revived = await store.get('revive-me');
    expect(revived?.status).toBe('ready');
    expect(Date.parse(revived!.leaseExpiresAt!)).toBeGreaterThan(Date.now());
  });

  it('unhealthy 恢复队列只包含活跃会话并排除历史与 waiting_user', async () => {
    await seed('history-new', { status: 'unhealthy', sessionId: 'session-history' });
    await seed('active-old', { status: 'unhealthy', sessionId: 'session-active', updatedAt: '2026-01-01T00:00:00.000Z' });
    await seed('waiting-new', { status: 'unhealthy', sessionId: 'session-waiting' });
    await pool.query(
      `INSERT INTO ${prefix}_runs (run_id, session_id, status, updated_at) VALUES
       ('run-active', 'session-active', 'running', now()),
       ('run-waiting', 'session-waiting', 'waiting_user', now())`,
    );

    const ids = (await store.listByType('server-remote', { status: 'unhealthy' })).map((hand) => hand.handId);
    expect(ids).toEqual(['active-old']);
  });
});
