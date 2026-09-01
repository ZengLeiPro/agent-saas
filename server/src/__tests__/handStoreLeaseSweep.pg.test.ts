import { randomUUID } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { deriveTenantQualifiedClientDaemonHandId } from '../runtime/clientDaemonProtocol.js';
import { PgHandStore, SERVER_REMOTE_HAND_LEASE_MS } from '../runtime/handStore.js';
import { deriveTenantHandId } from '../runtime/runtimeHandRegistration.js';

const { Pool } = pg;
const testPgUrl = process.env.TEST_DATABASE_URL?.trim();
const describePg = testPgUrl ? describe : describe.skip;

describePg('PgHandStore lease 与 provision authority 治理', () => {
  const TENANT_ID = 't';
  const prefix = `handsweep_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  let pool: InstanceType<typeof Pool>;
  let store: PgHandStore;

  beforeAll(async () => {
    pool = new Pool({ connectionString: testPgUrl!, connectionTimeoutMillis: 5_000, max: 4 });
    store = new PgHandStore({ pool, tablePrefix: prefix });
    await store.init();
    await pool.query(`CREATE TABLE ${prefix}_runs (run_id TEXT PRIMARY KEY, tenant_id TEXT, session_id TEXT, status TEXT, updated_at TIMESTAMPTZ)`);
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
    tenantId?: string;
  } = {}): Promise<void> {
    await pool.query(
      `INSERT INTO ${prefix}_hands (hand_id, session_id, workspace_id, tenant_id, type, status, endpoint, lease_expires_at, created_at, updated_at)
       VALUES ($1, $6, 'ws_t__u', $7, $2, $3, 'http://127.0.0.1:3400', $4, $5, $5)
       ON CONFLICT (hand_id) DO UPDATE SET status = EXCLUDED.status, lease_expires_at = EXCLUDED.lease_expires_at, updated_at = EXCLUDED.updated_at`,
      [
        handId,
        opts.type ?? 'server-remote',
        opts.status ?? 'ready',
        opts.leaseExpiresAt === undefined ? null : opts.leaseExpiresAt,
        opts.updatedAt ?? new Date().toISOString(),
        opts.sessionId ?? null,
        opts.tenantId ?? TENANT_ID,
      ],
    );
  }


  const getHand = (handId: string, tenantId = TENANT_ID) => store.get(handId, tenantId);
  const claimProvisionRecovery = (handId: string, token: string, patch?: Record<string, unknown>, updatedAt?: string, generation?: string, tenantId = TENANT_ID) =>
    store.claimProvisionRecovery(handId, token, patch, updatedAt, generation, tenantId);
  const completeProvisionRecovery = (handId: string, token: string, status: 'provisioning' | 'ready' | 'unhealthy' | 'destroyed', patch?: Record<string, unknown>, tenantId = TENANT_ID) =>
    store.completeProvisionRecovery(handId, token, status, patch, tenantId);
  const completeProvisionAttempt = (handId: string, generation: string, status: 'provisioning' | 'ready' | 'unhealthy' | 'destroyed', patch?: Record<string, unknown>, tenantId = TENANT_ID) =>
    store.completeProvisionAttempt(handId, generation, status, patch, tenantId);
  const claimProvisionDispatch = (handId: string, generation: string, token: string, updatedAt: string, tenantId = TENANT_ID) =>
    store.claimProvisionDispatch(handId, generation, token, updatedAt, tenantId);
  const completeProvisionDispatch = (handId: string, generation: string, token: string, status: 'ready' | 'unhealthy', patch?: Record<string, unknown>, tenantId = TENANT_ID) =>
    store.completeProvisionDispatch(handId, generation, token, status, patch, tenantId);

  it('backfill：无租约存量按 GREATEST(created,updated)+lease 补齐；老僵尸随后过期 destroyed', async () => {
    const fortyDaysAgo = new Date(Date.now() - 40 * 24 * 60 * 60_000).toISOString();
    await seed('zombie-old', { updatedAt: fortyDaysAgo });          // 40 天前 → 补租约即已过期
    await seed('active-new', { updatedAt: new Date().toISOString() }); // 活跃 → 补租约后未过期

    const first = await store.sweepLeases();
    expect(first.backfilled).toBe(2);
    expect(first.destroyed).toBe(1);
    expect(first.purged).toBe(0);

    const zombie = await getHand('zombie-old');
    expect(zombie?.status).toBe('destroyed');
    expect(zombie?.metadata.destroyReason).toBe('lease_expired');
    const active = await getHand('active-new');
    expect(active?.status).toBe('ready');
    expect(active?.leaseExpiresAt).toBeTruthy();
  });

  it('destroyed 超保留期物理清除；幂等重跑无副作用', async () => {
    const twentyDaysAgo = new Date(Date.now() - 20 * 24 * 60 * 60_000).toISOString();
    await seed('purge-me', { status: 'destroyed', updatedAt: twentyDaysAgo, leaseExpiresAt: twentyDaysAgo });

    const result = await store.sweepLeases();
    expect(result.purged).toBeGreaterThanOrEqual(1);
    expect(await getHand('purge-me')).toBeNull();

    const again = await store.sweepLeases();
    expect(again).toEqual({ backfilled: 0, destroyed: 0, purged: 0 });
  });

  it('非 server-remote 类型与显式未过期租约不受影响', async () => {
    const future = new Date(Date.now() + SERVER_REMOTE_HAND_LEASE_MS).toISOString();
    const fortyDaysAgo = new Date(Date.now() - 40 * 24 * 60 * 60_000).toISOString();
    await seed('container-hand', { type: 'server-container', updatedAt: fortyDaysAgo });
    await seed('leased-hand', { leaseExpiresAt: future });

    await store.sweepLeases();

    expect((await getHand('container-hand'))?.status).toBe('ready');
    expect((await getHand('container-hand'))?.leaseExpiresAt).toBeUndefined();
    expect((await getHand('leased-hand'))?.status).toBe('ready');
  });

  it('provision recovery claim/complete 只允许当前 token 且排除 reconcileRequired', async () => {
    await seed('recover-race', { status: 'unhealthy' });
    await pool.query(
      `UPDATE ${prefix}_hands SET metadata = $2::jsonb WHERE hand_id = $1`,
      ['recover-race', JSON.stringify({ provisionFailure: 'old failure' })],
    );

    expect(await claimProvisionRecovery('recover-race', 'token-1')).not.toBeNull();
    expect(await claimProvisionRecovery('recover-race', 'token-2')).toBeNull();
    expect(await completeProvisionRecovery('recover-race', 'wrong-token', 'ready')).toBeNull();
    expect(await completeProvisionRecovery('recover-race', 'token-1', 'ready', {
      provisionFailure: null,
      provision: { lastStatus: 'ok' },
    })).not.toBeNull();

    const recovered = await getHand('recover-race');
    expect(recovered?.status).toBe('ready');
    expect(recovered?.metadata.provisionRecoveryToken).toBeNull();
    expect(recovered?.metadata.provisionFailure).toBeNull();

    await seed('recover-destroyed', { status: 'destroyed' });
    await pool.query(
      `UPDATE ${prefix}_hands SET metadata = $2::jsonb WHERE hand_id = $1`,
      ['recover-destroyed', JSON.stringify({ provisionFailure: 'stale failure' })],
    );
    expect(await claimProvisionRecovery('recover-destroyed', 'token-destroyed')).toBeNull();

    await seed('recover-reconcile-required', { status: 'unhealthy' });
    await pool.query(
      `UPDATE ${prefix}_hands SET metadata = $2::jsonb WHERE hand_id = $1`,
      ['recover-reconcile-required', JSON.stringify({
        provisionFailure: 'result unknown', provisionResult: 'result_unknown', reconcileRequired: true,
      })],
    );
    expect(await claimProvisionRecovery('recover-reconcile-required', 'scanner-token')).toBeNull();
    expect((await getHand('recover-reconcile-required'))?.metadata.reconcileRequired).toBe(true);

    await seed('normal-generation', { status: 'ready' });
    await pool.query(
      `UPDATE ${prefix}_hands SET status = 'provisioning', metadata = $2::jsonb WHERE hand_id = $1`,
      ['normal-generation', JSON.stringify({ provisionGeneration: 'generation-2' })],
    );
    expect(await completeProvisionAttempt('normal-generation', 'generation-1', 'unhealthy')).toBeNull();
    expect(await completeProvisionAttempt('normal-generation', 'generation-2', 'ready')).not.toBeNull();
  });

  it('dispatch claim 原子持久化未知结果且只有同 generation/token 可按结果确定性完成', async () => {
    await seed('dispatch-authority', { status: 'provisioning' });
    await pool.query(
      `UPDATE ${prefix}_hands SET metadata = $2::jsonb WHERE hand_id = $1`,
      ['dispatch-authority', JSON.stringify({ provisionGeneration: 'generation-1' })],
    );
    const before = await getHand('dispatch-authority');
    const claimed = await claimProvisionDispatch(
      'dispatch-authority', 'generation-1', 'dispatch-token-1', before!.updatedAt,
    );
    expect(claimed).toMatchObject({ status: 'unhealthy', metadata: {
      provisionDispatchClaim: 'dispatch-token-1', provisionResult: 'result_unknown',
      reconcileRequired: true, dispatchAuthorized: true,
    } });
    expect(await claimProvisionDispatch(
      'dispatch-authority', 'generation-1', 'dispatch-token-2', claimed!.updatedAt,
    )).toBeNull();
    expect(await completeProvisionDispatch(
      'dispatch-authority', 'generation-1', 'wrong-token', 'ready',
    )).toBeNull();
    expect(await completeProvisionDispatch(
      'dispatch-authority', 'generation-1', 'dispatch-token-1', 'ready', {
        provisionDispatchClaim: null, dispatchAuthorized: false,
        provisionResult: 'ok', reconcileRequired: false,
      },
    )).toMatchObject({ status: 'ready', metadata: {
      provisionDispatchClaim: null, dispatchAuthorized: false,
      provisionResult: 'ok', reconcileRequired: false,
    } });

    await seed('dispatch-known-error', { status: 'provisioning' });
    await pool.query(
      `UPDATE ${prefix}_hands SET metadata = $2::jsonb WHERE hand_id = $1`,
      ['dispatch-known-error', JSON.stringify({ provisionGeneration: 'generation-error' })],
    );
    const errorBefore = await getHand('dispatch-known-error');
    await claimProvisionDispatch(
      'dispatch-known-error', 'generation-error', 'dispatch-token-error', errorBefore!.updatedAt,
    );
    expect(await completeProvisionDispatch(
      'dispatch-known-error', 'generation-error', 'dispatch-token-error', 'unhealthy', {
        provisionFailure: 'provider rejected', provisionResult: 'error', reconcileRequired: false,
      },
    )).toMatchObject({ status: 'unhealthy', metadata: {
      provisionDispatchClaim: null, dispatchAuthorized: false,
      provisionFailure: 'provider rejected', provisionResult: 'error', reconcileRequired: false,
    } });
  });

  it('register upsert 可复活 destroyed 记录（lease 治理无永久误杀）', async () => {
    await seed('revive-me', { status: 'destroyed', leaseExpiresAt: new Date(Date.now() - 1000).toISOString() });

    await store.register({
      handId: 'revive-me',
      tenantId: TENANT_ID,
      workspaceId: 'ws_t__u',
      type: 'server-remote',
      status: 'ready',
      endpoint: 'http://127.0.0.1:3400',
      leaseExpiresAt: new Date(Date.now() + SERVER_REMOTE_HAND_LEASE_MS),
    });

    const revived = await getHand('revive-me');
    expect(revived?.status).toBe('ready');
    expect(Date.parse(revived!.leaseExpiresAt!)).toBeGreaterThan(Date.now());
  });

  it('相同 session/provider 跨租户并发注册互不覆盖且错误 tenant fence 无法读写', async () => {
    const sessionId = 'shared-session';
    const providerId = 'shared-provider';
    const tenantA = 'tenant-a';
    const tenantB = 'tenant-b';
    const handA = deriveTenantHandId(tenantA, sessionId, providerId);
    const handB = deriveTenantHandId(tenantB, sessionId, providerId);

    await Promise.all([
      store.register({
        handId: handA, tenantId: tenantA, sessionId, workspaceId: 'ws_tenant-a__user',
        providerId, type: 'server-remote', endpoint: 'https://a.example', metadata: { owner: 'a' },
      }),
      store.register({
        handId: handB, tenantId: tenantB, sessionId, workspaceId: 'ws_tenant-b__user',
        providerId, type: 'server-remote', endpoint: 'https://b.example', metadata: { owner: 'b' },
      }),
    ]);

    expect(handA).not.toBe(handB);
    expect(await store.get(handA, tenantA)).toMatchObject({ tenantId: tenantA, endpoint: 'https://a.example' });
    expect(await store.get(handB, tenantB)).toMatchObject({ tenantId: tenantB, endpoint: 'https://b.example' });
    expect(await store.get(handA, tenantB)).toBeNull();
    await expect(store.register({
      handId: handA, tenantId: tenantB, sessionId, workspaceId: 'ws_tenant-b__user',
      providerId, type: 'server-remote', endpoint: 'https://overwrite.example',
    })).rejects.toThrow('Hand tenant fence rejected registration');
    expect(await store.updateStatus(handA, 'destroyed', { attacker: true }, tenantB)).toBeNull();
    expect(await store.get(handA, tenantA)).toMatchObject({ status: 'ready', metadata: { owner: 'a' } });
    expect(await store.listBySession(sessionId, tenantA)).toEqual([
      expect.objectContaining({ handId: handA, tenantId: tenantA }),
    ]);
  });

  it('并发跨租户注册只允许一个 tenant-qualified client Hand 继承 tenant-less legacy metadata', async () => {
    const rawHandId = 'shared-legacy-client';
    const tenantA = 'legacy-tenant-a';
    const tenantB = 'legacy-tenant-b';
    const handA = deriveTenantQualifiedClientDaemonHandId(tenantA, rawHandId);
    const handB = deriveTenantQualifiedClientDaemonHandId(tenantB, rawHandId);
    const legacyMetadata = {
      secret: 'must-have-a-single-owner',
      metadata: { migrated: true },
    };

    await pool.query(
      `INSERT INTO ${prefix}_hands
         (hand_id, workspace_id, tenant_id, type, status, capabilities, metadata)
       VALUES ($1, 'legacy-workspace', NULL, 'client', 'unhealthy', '[]'::jsonb, $2::jsonb)`,
      [rawHandId, JSON.stringify(legacyMetadata)],
    );

    const [registeredA, registeredB] = await Promise.all([
      store.registerClientDaemon({
        handId: handA, tenantId: tenantA, workspaceId: 'ws_legacy-tenant-a__user',
        type: 'client', metadata: { rawHandId, registrant: 'a' },
      }, [rawHandId]),
      store.registerClientDaemon({
        handId: handB, tenantId: tenantB, workspaceId: 'ws_legacy-tenant-b__user',
        type: 'client', metadata: { rawHandId, registrant: 'b' },
      }, [rawHandId]),
    ]);

    const inheritors = [registeredA, registeredB].filter(
      (hand) => hand.metadata.secret === legacyMetadata.secret,
    );
    const freshRegistrations = [registeredA, registeredB].filter(
      (hand) => hand.metadata.secret === undefined,
    );

    expect(inheritors).toHaveLength(1);
    expect(inheritors[0]?.metadata).toMatchObject(legacyMetadata);
    expect(freshRegistrations).toHaveLength(1);
    expect(freshRegistrations[0]?.metadata).toEqual({
      rawHandId,
      registrant: freshRegistrations[0]?.tenantId === tenantA ? 'a' : 'b',
    });
    expect(await store.get(handA, tenantA)).toEqual(registeredA);
    expect(await store.get(handB, tenantB)).toEqual(registeredB);
    expect((await pool.query(
      `SELECT hand_id FROM ${prefix}_hands WHERE hand_id = $1 AND tenant_id IS NULL`,
      [rawHandId],
    )).rows).toEqual([]);
  });

  it('unhealthy 恢复队列只包含活跃会话并排除历史与 waiting_user', async () => {
    await seed('history-new', { status: 'unhealthy', sessionId: 'session-history' });
    await seed('active-old', { status: 'unhealthy', sessionId: 'session-active', updatedAt: '2026-01-01T00:00:00.000Z' });
    await seed('waiting-new', { status: 'unhealthy', sessionId: 'session-waiting' });
    await pool.query(
      `INSERT INTO ${prefix}_runs (run_id, tenant_id, session_id, status, updated_at) VALUES
       ('run-active', 't', 'session-active', 'running', now()),
       ('run-waiting', 't', 'session-waiting', 'waiting_user', now())`,
    );

    const ids = (await store.listByType('server-remote', { status: 'unhealthy' })).map((hand) => hand.handId);
    expect(ids).toEqual(['active-old']);
  });
});
