import { randomUUID } from 'node:crypto';

import pg, { type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PgEventStore } from '../runtime/pgEventStore.js';
import { PgRunStore } from '../runtime/runStore.js';
import { PgSandboxLifecycleStore } from '../runtime/sandboxLifecycleService.js';
import { PgToolInvocationStore } from '../runtime/toolInvocationStore.js';

const { Pool } = pg;
const testPgUrl = process.env.TEST_DATABASE_URL?.trim();
const describePg = testPgUrl ? describe : describe.skip;
if (!testPgUrl) console.warn('[sandboxScopeActivity.pg] SKIPPED: TEST_DATABASE_URL is not configured');

interface AdvisoryLockId { classid: string; objid: string; objsubid: number }

async function waitForAdvisoryWaiters(
  client: PoolClient,
  lock: AdvisoryLockId,
  expected: number,
): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const result = await client.query<{ count: string }>(`
      SELECT COUNT(*)::text AS count FROM pg_locks
      WHERE locktype='advisory' AND NOT granted
        AND classid=$1::oid AND objid=$2::oid AND objsubid=$3
    `, [lock.classid, lock.objid, lock.objsubid]);
    if (Number(result.rows[0]?.count ?? 0) >= expected) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`expected at least ${expected} waiter(s) for the sandbox lifecycle advisory lock`);
}

async function waitForBlockedSession(client: PoolClient): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const result = await client.query<{ waiting: boolean }>(`
      SELECT EXISTS (
        SELECT 1 FROM pg_stat_activity AS activity
        WHERE pg_backend_pid() = ANY(pg_blocking_pids(activity.pid))
      ) AS waiting
    `);
    if (result.rows[0]?.waiting === true) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('expected a PostgreSQL session blocked by the lifecycle test transaction');
}

describePg('Sandbox lifecycle PostgreSQL locking, admission and ordering contract', () => {
  const prefix = `scope_activity_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  let pool: InstanceType<typeof Pool>;
  let runStore: PgRunStore;
  let eventStore: PgEventStore;

  beforeAll(async () => {
    pool = new Pool({ connectionString: testPgUrl!, connectionTimeoutMillis: 5_000, max: 4 });
    eventStore = new PgEventStore({ connectionString: testPgUrl!, tablePrefix: prefix, poolMax: 2 });
    await eventStore.init();
    runStore = new PgRunStore({ pool, tablePrefix: prefix });
    await runStore.init();
    await new PgToolInvocationStore({ pool, tablePrefix: prefix }).init();
  }, 30_000);

  afterAll(async () => {
    if (!pool) return;
    try {
      await pool.query(`DROP TABLE IF EXISTS ${prefix}_tool_invocations`);
      await pool.query(`DROP TABLE IF EXISTS ${prefix}_steering_inputs`);
      await pool.query(`DROP TABLE IF EXISTS ${prefix}_steering_sessions`);
      await pool.query(`DROP TABLE IF EXISTS ${prefix}_message_submissions`);
      await pool.query(`DROP TABLE IF EXISTS ${prefix}_runs`);
      await pool.query(`DROP TABLE IF EXISTS ${prefix}_events`);
      await pool.query(`DROP TABLE IF EXISTS ${prefix}_event_cursors`);
    } finally {
      await eventStore.close();
      await pool.end();
    }
  }, 30_000);

  it('queued background wake 由继承 scope 的 pending wake Run 持续保护，store 重建后仍可见', async () => {
    const tenantId = 'tenant-1';
    const topLevelSessionId = 'session-top';
    const sandboxScopeId = 'scope-top';
    await runStore.upsertPending({
      runId: 'background-1', sessionId: 'session-background', tenantId,
      sandboxScopeId, metadata: {
        backgroundTask: true, topLevelSessionId, sandboxScopeId, wakeState: 'pending',
      },
    });
    await runStore.markStatus('background-1', 'completed', undefined, { wakeState: 'queued' });
    await runStore.upsertPending({
      runId: 'bg-wake-background-1', sessionId: topLevelSessionId, tenantId,
      sandboxScopeId, metadata: { backgroundTaskWake: true, topLevelSessionId, sandboxScopeId },
    });

    const rebuilt = new PgSandboxLifecycleStore(
      pool as never, `${prefix}_runs`, `${prefix}_steering_inputs`,
    );
    await expect(rebuilt.hasActivity({
      sandboxScopeId, sessionId: topLevelSessionId, tenantId,
    })).resolves.toBe(true);

    await runStore.markStatus('bg-wake-background-1', 'completed');
    await expect(rebuilt.hasActivity({
      sandboxScopeId, sessionId: topLevelSessionId, tenantId,
    })).resolves.toBe(false);
  });

  it('delivered cleanup fences admission and every explicit restore advances generation', async () => {
    const runId = 'delivered-fence-carrier';
    const sessionId = 'delivered-fence-session';
    const sandboxScopeId = 'delivered-fence-scope';
    await runStore.upsertPending({
      runId, sessionId, tenantId: 'tenant-1', workspaceId: 'workspace-delivered', sandboxScopeId, metadata: {},
    });
    await runStore.markStatus(runId, 'cancelled', 'session deleted');
    await pool.query(`UPDATE ${prefix}_runs SET metadata=jsonb_set(metadata,
      '{sandboxCleanupOutbox}', $2::jsonb) WHERE run_id=$1`, [runId, JSON.stringify({
      state: 'delivered', workspaceId: 'workspace-delivered', sessionId, sandboxScopeId,
      tenantId: 'tenant-1', targetHandId: 'agent-saas-acs', deletionGeneration: 'generation-delivered',
    })]);

    await expect(runStore.upsertPending({
      runId: 'delivered-fence-blocked', sessionId: 'delivered-fence-child', tenantId: 'tenant-1',
      workspaceId: 'workspace-delivered', sandboxScopeId, metadata: { topLevelSessionId: sessionId },
    })).rejects.toThrow(/Sandbox cleanup is active/u);

    const store = new PgSandboxLifecycleStore(pool as never, `${prefix}_runs`, `${prefix}_steering_inputs`);
    await expect(store.cancelCleanup(sessionId, 'tenant-1', 'generation-restored')).resolves.toEqual([
      expect.objectContaining({
        runId, previousDeletionGeneration: 'generation-delivered', deletionGeneration: 'generation-restored',
      }),
    ]);
    await expect(store.cancelCleanup(sessionId, 'tenant-1', 'generation-restored-again')).resolves.toEqual([
      expect.objectContaining({
        runId, previousDeletionGeneration: 'generation-restored', deletionGeneration: 'generation-restored-again',
      }),
    ]);
    await expect(runStore.upsertPending({
      runId: 'delivered-fence-restored', sessionId: 'delivered-fence-child', tenantId: 'tenant-1',
      workspaceId: 'workspace-delivered', sandboxScopeId, metadata: { topLevelSessionId: sessionId },
    })).resolves.toEqual(expect.objectContaining({ runId: 'delivered-fence-restored' }));
  });

  it('新子 Run admission 会重新打开已 delivered 的顶层 terminal carrier', async () => {
    const sessionId = 'terminal-reopen-session';
    const sandboxScopeId = 'terminal-reopen-scope';
    await runStore.upsertPending({
      runId: 'terminal-reopen-top', sessionId, tenantId: 'tenant-1',
      workspaceId: 'workspace-reopen', sandboxScopeId, metadata: {
        sandboxWorkloadTopLevel: true, sandboxWorkloadDescriptor: { kind: 'cron' },
      },
    });
    await runStore.markStatus('terminal-reopen-top', 'completed');
    const store = new PgSandboxLifecycleStore(pool as never, `${prefix}_runs`, `${prefix}_steering_inputs`);
    await store.markTerminalDelivered('terminal-reopen-top', new Date().toISOString());
    await expect(store.isTerminalCandidateCurrent('terminal-reopen-top')).resolves.toBe(false);

    await runStore.upsertPending({
      runId: 'terminal-reopen-child', sessionId: 'terminal-reopen-child-session', tenantId: 'tenant-1',
      workspaceId: 'workspace-reopen', sandboxScopeId, metadata: { topLevelSessionId: sessionId },
    });
    await runStore.markStatus('terminal-reopen-child', 'completed');

    await expect(store.isTerminalCandidateCurrent('terminal-reopen-top')).resolves.toBe(true);
    await expect(store.listTerminalCandidates(500)).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ runId: 'terminal-reopen-top' }),
    ]));
  });

  it('legacy null-tenant cleanup 仅约束 canonical kaiyan tenant，直到显式 restore', async () => {
    const sessionId = 'legacy-cleanup-session';
    const sandboxScopeId = 'legacy-cleanup-scope';
    await runStore.upsertPending({
      runId: 'legacy-staged-run', sessionId, tenantId: 'kaiyan',
      workspaceId: 'workspace-legacy', sandboxScopeId,
      metadata: { schedulerState: 'staged' },
    });
    await runStore.upsertPending({
      runId: 'legacy-cleanup-carrier', sessionId: 'legacy-cleanup-carrier-session', tenantId: 'kaiyan',
      workspaceId: 'workspace-legacy', sandboxScopeId: 'legacy-cleanup-carrier-scope', metadata: {},
    });
    await runStore.markStatus('legacy-cleanup-carrier', 'cancelled', 'legacy cleanup');
    // 旧部署曾允许 NULL tenant_id；临时放宽约束以构造真实 legacy carrier，测试后恢复当前 schema。
    await pool.query(`ALTER TABLE ${prefix}_runs ALTER COLUMN tenant_id DROP NOT NULL`);
    try {
      await pool.query(`UPDATE ${prefix}_runs SET tenant_id=NULL, metadata=jsonb_set(metadata,
        '{sandboxCleanupOutbox}', $2::jsonb) WHERE run_id=$1`, ['legacy-cleanup-carrier', JSON.stringify({
        state: 'delivered', workspaceId: 'workspace-legacy', sessionId, sandboxScopeId,
        targetHandId: 'agent-saas-acs', deletionGeneration: 'generation-legacy',
      })]);

      await expect(runStore.activateStagedRun('legacy-staged-run')).rejects.toThrow(/Sandbox cleanup is active/u);
      await expect(runStore.upsertPending({
        runId: 'legacy-other-tenant-run', sessionId, tenantId: 'tenant-2',
        workspaceId: 'workspace-legacy', sandboxScopeId, metadata: {},
      })).resolves.toEqual(expect.objectContaining({ runId: 'legacy-other-tenant-run' }));

      const store = new PgSandboxLifecycleStore(pool as never, `${prefix}_runs`, `${prefix}_steering_inputs`);
      await expect(store.hasActivity({ sandboxScopeId, sessionId, tenantId: 'tenant-2' })).resolves.toBe(true);
      await expect(store.cancelCleanup(sessionId, 'tenant-1', 'wrong-tenant-generation')).resolves.toEqual([]);
      await expect(store.cancelCleanup(sessionId, 'kaiyan', 'generation-legacy-restored')).resolves.toEqual([
        expect.objectContaining({
          runId: 'legacy-cleanup-carrier', previousDeletionGeneration: 'generation-legacy',
          deletionGeneration: 'generation-legacy-restored',
        }),
      ]);
      await expect(runStore.activateStagedRun('legacy-staged-run')).resolves.toEqual(expect.objectContaining({
        runId: 'legacy-staged-run', status: 'pending', metadata: expect.objectContaining({ schedulerState: 'ready' }),
      }));
    } finally {
      await pool.query(`UPDATE ${prefix}_runs SET tenant_id='kaiyan' WHERE tenant_id IS NULL`);
      await pool.query(`ALTER TABLE ${prefix}_runs ALTER COLUMN tenant_id SET NOT NULL`);
    }
  });

  it('prepared cleanup fences late admission，且 guarded cancellation 避免 carrier Run self-lock', async () => {
    await runStore.upsertPending({
      runId: 'intent-run-1', sessionId: 'intent-session-1', tenantId: 'tenant-1',
      workspaceId: 'workspace-intent', sandboxScopeId: 'scope-intent', metadata: {},
    });
    await runStore.upsertPending({
      runId: 'identity-move-run', sessionId: 'identity-child', tenantId: 'tenant-1',
      workspaceId: 'workspace-other', sandboxScopeId: 'scope-other',
      metadata: { topLevelSessionId: 'unrelated-session' },
    });
    const store = new PgSandboxLifecycleStore(
      pool as never, `${prefix}_runs`, `${prefix}_steering_inputs`,
    );
    const enqueued = await store.enqueueCleanup({
      workspaceId: 'workspace-intent', sessionId: 'intent-session-1', sandboxScopeId: 'scope-intent',
      tenantId: 'tenant-1', targetHandId: 'acs-old', deletionGeneration: 'generation-intent-1',
    }, { prepared: true });
    const cleanupRunId = enqueued!.runId;
    expect(cleanupRunId).toMatch(/^sandbox-cleanup-/u);
    await expect(store.listPreparedCleanupCandidates()).resolves.toEqual([
      expect.objectContaining({ runId: cleanupRunId, sessionId: 'intent-session-1' }),
    ]);
    await expect(store.listCleanupCandidates()).resolves.toEqual([]);
    await expect(runStore.upsertPending({
      runId: 'intent-late-child', sessionId: 'intent-child-session', tenantId: 'tenant-1',
      workspaceId: 'workspace-intent', sandboxScopeId: 'scope-intent',
      metadata: { topLevelSessionId: 'intent-session-1' },
    })).rejects.toThrow(/Sandbox cleanup is active/u);
    await expect(runStore.upsertPending({
      runId: 'identity-move-run', sessionId: 'identity-child', tenantId: 'tenant-1',
      workspaceId: 'workspace-other', sandboxScopeId: 'scope-other',
      metadata: { topLevelSessionId: 'intent-session-1' },
    })).rejects.toThrow(/Sandbox cleanup is active/u);

    const [first, second] = await Promise.all([
      store.claimPreparedCleanup(cleanupRunId, 'worker-a'),
      store.claimPreparedCleanup(cleanupRunId, 'worker-b'),
    ]);
    const owner = first ?? second;
    expect([first, second].filter(Boolean)).toHaveLength(1);
    expect(owner).toEqual(expect.objectContaining({ claimGeneration: 1 }));
    await expect(store.listCleanupCandidates()).resolves.toEqual([]);

    const rebuilt = new PgSandboxLifecycleStore(
      pool as never, `${prefix}_runs`, `${prefix}_steering_inputs`,
    );
    await expect(rebuilt.completePreparedCleanup(
      cleanupRunId, owner!.claimId!, owner!.claimGeneration!,
    )).resolves.toBeUndefined();
    const reason = 'session_deleted:intent-session-1';
    await expect(runStore.cancelSteeringBeforeDispatchBySessionWithEvent(
      'intent-session-1', reason, 'intent-run-1', {
        type: 'run_cancel_requested', sessionId: 'intent-session-1', runId: 'intent-run-1', reason,
      }, 'tenant-1', {
        cleanupRunId, sessionId: 'intent-session-1', sandboxScopeId: 'scope-intent',
        claimId: owner!.claimId!, claimGeneration: owner!.claimGeneration!,
      },
    )).resolves.toEqual(expect.objectContaining({ targetCancelled: true }));
    await expect(rebuilt.completePreparedCleanup(
      cleanupRunId, owner!.claimId!, owner!.claimGeneration!,
    )).resolves.toEqual(expect.objectContaining({ runId: cleanupRunId }));
    await expect(rebuilt.listCleanupCandidates()).resolves.toEqual([
      expect.objectContaining({ runId: cleanupRunId, sessionId: 'intent-session-1' }),
    ]);
  });

  it('prepared intent takeover serializes with stale expiry and survives restart without another DELETE', async () => {
    const runId = 'prepared-refresh-run';
    const sessionId = 'aaa-prepared-refresh-session';
    const sandboxScopeId = 'zzz-prepared-refresh-scope';
    await runStore.upsertPending({
      runId, sessionId, tenantId: 'tenant-1', workspaceId: 'workspace-prepared-refresh',
      sandboxScopeId, metadata: {},
    });
    await pool.query(`UPDATE ${prefix}_runs SET metadata=jsonb_set(metadata,
      '{sandboxCleanupOutbox}', $2::jsonb) WHERE run_id=$1`, [runId, JSON.stringify({
      state: 'delivered', deletionGeneration: 'delete-generation-root',
    })]);
    const store = new PgSandboxLifecycleStore(pool as never, `${prefix}_runs`, `${prefix}_steering_inputs`);
    const prepared = await store.enqueueCleanup({
      workspaceId: 'workspace-prepared-refresh', sessionId, sandboxScopeId,
      tenantId: 'tenant-1', targetHandId: 'acs-old', deletionGeneration: 'delete-generation-old',
    }, { prepared: true });
    const cleanupRunId = prepared!.runId;
    expect(cleanupRunId).not.toBe(runId);
    await pool.query(`UPDATE ${prefix}_runs SET metadata=jsonb_set(metadata,
      '{sandboxCleanupOutbox,queuedAt}', to_jsonb($2::text)) WHERE run_id=$1`, [
      cleanupRunId, '2000-01-01T00:00:00.000Z',
    ]);

    const blocker = await pool.connect();
    let committed = false;
    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [sessionId]);
      const held = await blocker.query<AdvisoryLockId>(`
        SELECT classid::text, objid::text, objsubid FROM pg_locks
        WHERE pid=pg_backend_pid() AND locktype='advisory' AND granted
      `);
      const lock = held.rows[0];
      expect(lock).toBeDefined();
      const takeover = store.enqueueCleanup({
        workspaceId: 'workspace-prepared-refresh', sessionId, sandboxScopeId,
        tenantId: 'tenant-1', targetHandId: 'acs-new', deletionGeneration: 'delete-generation-new',
      }, { prepared: true });
      await waitForAdvisoryWaiters(blocker, lock!, 1);
      const expiry = store.expireUncommittedPreparedCleanup(cleanupRunId);
      await waitForAdvisoryWaiters(blocker, lock!, 2);
      await blocker.query('COMMIT');
      committed = true;

      await expect(takeover).resolves.toEqual(expect.objectContaining({
        runId: cleanupRunId, previousDeletionGeneration: 'delete-generation-root',
        deletionGeneration: 'delete-generation-new', targetHandId: 'acs-new',
      }));
      await expect(expiry).resolves.toBe(false);
    } finally {
      if (!committed) await blocker.query('ROLLBACK').catch(() => undefined);
      blocker.release();
    }

    const rebuilt = new PgSandboxLifecycleStore(pool as never, `${prefix}_runs`, `${prefix}_steering_inputs`);
    await expect(rebuilt.listPreparedCleanupCandidates()).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({
        runId: cleanupRunId, previousDeletionGeneration: 'delete-generation-root',
        deletionGeneration: 'delete-generation-new',
      }),
    ]));
    await runStore.markStatus(runId, 'cancelled', 'session deleted before restart');
    const claimed = await rebuilt.claimPreparedCleanup(cleanupRunId, 'restarted-scanner');
    expect(claimed?.claimGeneration).toBe(1);
    await expect(rebuilt.completePreparedCleanup(
      cleanupRunId, claimed!.claimId!, claimed!.claimGeneration!,
    )).resolves.toEqual(expect.objectContaining({
      runId: cleanupRunId, deletionGeneration: 'delete-generation-new',
    }));
    await expect(rebuilt.listCleanupCandidates()).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({
        runId: cleanupRunId, previousDeletionGeneration: 'delete-generation-root',
        deletionGeneration: 'delete-generation-new',
      }),
    ]));
  }, 30_000);

  it('cancelling owner 崩溃后可按 lease/generation 接管，restore 可使自身旧 owner CAS 失效', async () => {
    await runStore.upsertPending({
      runId: 'takeover-run-1', sessionId: 'takeover-session-1', tenantId: 'tenant-1',
      workspaceId: 'workspace-takeover', sandboxScopeId: 'scope-takeover', metadata: {},
    });
    const store = new PgSandboxLifecycleStore(pool as never, `${prefix}_runs`, `${prefix}_steering_inputs`);
    const prepared = await store.enqueueCleanup({
      workspaceId: 'workspace-takeover', sessionId: 'takeover-session-1', sandboxScopeId: 'scope-takeover',
      tenantId: 'tenant-1', targetHandId: 'acs-old', deletionGeneration: 'delete-generation-1',
    }, { prepared: true });
    const cleanupRunId = prepared!.runId;
    expect(cleanupRunId).not.toBe('takeover-run-1');
    const crashed = await store.claimPreparedCleanup(cleanupRunId, 'crashed-worker');
    expect(crashed?.claimGeneration).toBe(1);
    await pool.query(`UPDATE ${prefix}_runs SET metadata=jsonb_set(metadata,
      '{sandboxCleanupOutbox,claimedAt}', to_jsonb($2::text)) WHERE run_id=$1`, [
      cleanupRunId, '2000-01-01T00:00:00.000Z',
    ]);
    const rebuilt = new PgSandboxLifecycleStore(
      pool as never, `${prefix}_runs`, `${prefix}_steering_inputs`,
    );
    const takeover = await rebuilt.claimPreparedCleanup(cleanupRunId, 'restarted-worker');
    expect(takeover?.claimGeneration).toBe(2);
    await rebuilt.cancelCleanup('takeover-session-1', 'tenant-1', 'restore-generation-1');
    await expect(rebuilt.completePreparedCleanup(
      cleanupRunId, takeover!.claimId!, takeover!.claimGeneration!,
    )).resolves.toBeUndefined();
    await expect(rebuilt.listCleanupCandidates()).resolves.not.toEqual(expect.arrayContaining([
      expect.objectContaining({ runId: cleanupRunId }),
    ]));
  });

  it.each(['completed', 'failed', 'cancelled', 'orphaned'] as const)(
    '同终态 %s 重写保留首次 lifecycle terminalAt',
    async (status) => {
      const runId = `write-once-${status}`;
      await runStore.upsertPending({
        runId,
        sessionId: `session-${runId}`,
        tenantId: 'tenant-1',
        workspaceId: 'workspace-write-once',
        sandboxScopeId: `scope-${runId}`,
        metadata: {
          sandboxWorkloadTopLevel: true,
          sandboxWorkloadDescriptor: { kind: 'memory' },
        },
      });
      await runStore.markStatus(runId, status, 'first');
      const store = new PgSandboxLifecycleStore(
        pool as never, `${prefix}_runs`, `${prefix}_steering_inputs`,
      );
      const first = (await store.listTerminalCandidates()).find((candidate) => candidate.runId === runId);
      expect(first).toBeDefined();

      await pool.query('SELECT pg_sleep(0.01)');
      await runStore.markStatus(runId, status, 'late-rewrite', { lateRewrite: true });
      const rewritten = (await store.listTerminalCandidates()).find((candidate) => candidate.runId === runId);

      expect(rewritten?.terminalAt).toBe(first?.terminalAt);
      const row = await runStore.get(runId);
      expect(row).toMatchObject({ status, statusReason: 'late-rewrite', metadata: { lateRewrite: true } });
    },
  );

  it.each(['markStatus', 'markStatusIfCurrent', 'releaseLease'] as const)(
    '%s 的首次终态 marker 不早于 PostgreSQL 行锁释放时刻',
    async (entry) => {
      const runId = `lock-time-${entry}`;
      const workerId = `worker-${entry}`;
      await runStore.upsertPending({
        runId,
        sessionId: `session-${runId}`,
        tenantId: 'tenant-1',
        workspaceId: 'workspace-lock-time',
        sandboxScopeId: `scope-${runId}`,
        metadata: {
          sandboxWorkloadTopLevel: true,
          sandboxWorkloadDescriptor: { kind: 'memory' },
        },
      });
      if (entry === 'releaseLease') {
        await expect(runStore.acquireLease(runId, workerId, 60_000)).resolves.toBeDefined();
      }

      const blocker = await pool.connect();
      let committed = false;
      try {
        await blocker.query('BEGIN');
        await blocker.query(`SELECT run_id FROM ${prefix}_runs WHERE run_id=$1 FOR UPDATE`, [runId]);
        const mutation = entry === 'markStatus'
          ? runStore.markStatus(runId, 'completed', 'after-lock')
          : entry === 'markStatusIfCurrent'
            ? runStore.markStatusIfCurrent(runId, ['pending'], 'completed', 'after-lock')
            : runStore.releaseLease(runId, workerId, 'completed', 'after-lock');

        await waitForBlockedSession(blocker);
        const unlockClock = await blocker.query<{ now: Date }>('SELECT clock_timestamp() AS now');
        await blocker.query('COMMIT');
        committed = true;

        const updated = await mutation;
        const marker = updated?.metadata.sandboxLifecycleTerminalAt;
        expect(typeof marker).toBe('string');
        expect(Date.parse(marker as string)).toBeGreaterThanOrEqual(unlockClock.rows[0]!.now.getTime());
      } finally {
        if (!committed) await blocker.query('ROLLBACK').catch(() => undefined);
        blocker.release();
      }
    },
    30_000,
  );

  it.each([
    { tenantId: 'tenant-meta-only', expectedTenantId: 'tenant-meta-only', suffix: 'tenant' },
    { tenantId: undefined, expectedTenantId: 'kaiyan', suffix: 'legacy' },
  ])('meta-only 预热会话（$suffix）可创建 cleanup carrier，并在 store 重建后继续投递', async ({
    tenantId, expectedTenantId, suffix,
  }) => {
    const sessionId = `meta-only-session-${suffix}`;
    const workspaceId = `workspace-meta-only-${suffix}`;
    const sandboxScopeId = `scope-meta-only-${suffix}`;
    const store = new PgSandboxLifecycleStore(
      pool as never, `${prefix}_runs`, `${prefix}_steering_inputs`,
    );
    const enqueued = await store.enqueueCleanup({
      sessionId, ...(tenantId ? { tenantId } : {}), userId: 'user-meta-only',
      username: 'alice', workspaceId, sandboxScopeId,
      targetHandId: 'agent-saas-acs', deletionGeneration: 'generation-meta-only',
    }, { prepared: true });

    expect(enqueued).toMatchObject({
      sessionId, tenantId: expectedTenantId,
      targetHandId: 'agent-saas-acs', deletionGeneration: 'generation-meta-only',
    });
    const carrier = await pool.query<{ status: string; tenant_id: string; carrier: string }>(`
      SELECT status, tenant_id, metadata->>'sandboxCleanupCarrier' AS carrier
      FROM ${prefix}_runs WHERE run_id=$1
    `, [enqueued!.runId]);
    expect(carrier.rows[0]).toEqual({ status: 'cancelled', tenant_id: expectedTenantId, carrier: 'true' });

    const rebuilt = new PgSandboxLifecycleStore(
      pool as never, `${prefix}_runs`, `${prefix}_steering_inputs`,
    );
    await expect(rebuilt.listPreparedCleanupCandidates(500)).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ runId: enqueued!.runId, sessionId }),
    ]));
    await expect(runStore.listBySession(sessionId)).resolves.toEqual([]);
    await expect(runStore.listSessionIdsByTenant(expectedTenantId)).resolves.not.toContain(sessionId);
  });

  it('同 scope A旧+B新只投B，且B delivered 后 A 永久不复活', async () => {
    const scope = 'scope-terminal-order';
    await runStore.upsertPending({
      runId: 'terminal-a', sessionId: 'terminal-a-session', tenantId: 'tenant-1',
      workspaceId: 'workspace-terminal-order', sandboxScopeId: scope, metadata: {
        sandboxWorkloadTopLevel: true,
        sandboxWorkloadDescriptor: { kind: 'cron' },
      },
    });
    await runStore.upsertPending({
      runId: 'terminal-b', sessionId: 'terminal-b-session', tenantId: 'tenant-1',
      workspaceId: 'workspace-terminal-order', sandboxScopeId: scope,
      metadata: {
        sandboxWorkloadTopLevel: true,
        sandboxWorkloadDescriptor: { kind: 'cron' },
        topLevelSessionId: 'terminal-a-session',
      },
    });
    await runStore.markStatus('terminal-a', 'completed', 'first-terminal');
    const store = new PgSandboxLifecycleStore(
      pool as never, `${prefix}_runs`, `${prefix}_steering_inputs`,
    );
    const firstA = (await store.listTerminalCandidates()).find((candidate) => candidate.runId === 'terminal-a');
    expect(firstA).toBeDefined();

    await pool.query('SELECT pg_sleep(0.01)');
    await runStore.markStatus('terminal-b', 'completed', 'newer-terminal');
    const afterB = await store.listTerminalCandidates();
    const terminalB = afterB.find((candidate) => candidate.runId === 'terminal-b');
    expect(terminalB).toBeDefined();
    expect(afterB).not.toEqual(expect.arrayContaining([expect.objectContaining({ runId: 'terminal-a' })]));
    await expect(store.isTerminalCandidateCurrent('terminal-a')).resolves.toBe(false);
    await expect(store.isTerminalCandidateCurrent('terminal-b')).resolves.toBe(true);
    await pool.query('SELECT pg_sleep(0.01)');
    await runStore.markStatus('terminal-a', 'completed', 'late-rewrite');
    const afterRewrite = await store.listTerminalCandidates();

    expect(afterRewrite).toEqual(expect.arrayContaining([expect.objectContaining({ runId: 'terminal-b' })]));
    expect(afterRewrite).not.toEqual(expect.arrayContaining([expect.objectContaining({ runId: 'terminal-a' })]));
    await store.markTerminalDelivered('terminal-b', new Date().toISOString());
    await expect(store.isTerminalCandidateCurrent('terminal-b')).resolves.toBe(false);
    const remainingCandidates = await store.listTerminalCandidates();
    expect(remainingCandidates).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ runId: 'terminal-a' }),
      expect.objectContaining({ runId: 'terminal-b' }),
    ]));
  });

  it('旧 terminal 在后续子 Run 完整结束后仍可携 scope 最后活动时间投递', async () => {
    const runId = 'terminal-before-child';
    const sessionId = 'terminal-before-child-session';
    const sandboxScopeId = 'terminal-before-child-scope';
    await runStore.upsertPending({
      runId, sessionId, tenantId: 'tenant-legacy', workspaceId: 'workspace-before-child', sandboxScopeId,
      metadata: { sandboxWorkloadTopLevel: true, sandboxWorkloadDescriptor: { kind: 'cron' } },
    });
    await runStore.markStatus(runId, 'completed');

    await pool.query(`ALTER TABLE ${prefix}_runs ALTER COLUMN tenant_id DROP NOT NULL`);
    try {
      await pool.query(`UPDATE ${prefix}_runs SET tenant_id=NULL WHERE run_id=$1`, [runId]);
      await runStore.upsertPending({
        runId: 'terminal-after-child', sessionId: 'terminal-after-child-session', tenantId: 'kaiyan',
        workspaceId: 'workspace-before-child', sandboxScopeId,
        metadata: { topLevelSessionId: sessionId },
      });
      await runStore.markStatus('terminal-after-child', 'completed');

      const store = new PgSandboxLifecycleStore(
        pool as never, `${prefix}_runs`, `${prefix}_steering_inputs`,
      );
      await expect(store.hasActivity({ sandboxScopeId, sessionId, tenantId: 'kaiyan' })).resolves.toBe(false);
      await expect(store.isTerminalCandidateCurrent(runId)).resolves.toBe(true);
      let effectiveTerminalAt: string | undefined;
      const candidate = (await store.listTerminalCandidates(500)).find((item) => item.runId === runId);
      expect(candidate).toBeDefined();
      await expect(store.runWhileTerminalCandidateCurrent(candidate!, async (terminalAt) => {
        effectiveTerminalAt = terminalAt;
      })).resolves.toBe('committed');
      const child = await runStore.get('terminal-after-child');
      expect(Date.parse(effectiveTerminalAt!)).toBeGreaterThanOrEqual(Date.parse(child!.updatedAt));
    } finally {
      await pool.query(`UPDATE ${prefix}_runs SET tenant_id='kaiyan' WHERE tenant_id IS NULL`);
      await pool.query(`ALTER TABLE ${prefix}_runs ALTER COLUMN tenant_id SET NOT NULL`);
    }
  });

  it('终态投递持有 admission lock，锁内复核到通知完成前不能接纳新 Run', async () => {
    const runId = 'terminal-guarded';
    const sessionId = 'terminal-guarded-session';
    const sandboxScopeId = 'terminal-guarded-scope';
    await runStore.upsertPending({
      runId, sessionId, tenantId: 'tenant-guarded', workspaceId: 'workspace-guarded', sandboxScopeId,
      metadata: { sandboxWorkloadTopLevel: true, sandboxWorkloadDescriptor: { kind: 'cron' } },
    });
    await runStore.markStatus(runId, 'completed');
    const store = new PgSandboxLifecycleStore(
      pool as never, `${prefix}_runs`, `${prefix}_steering_inputs`,
    );
    const candidate = (await store.listTerminalCandidates(500)).find((item) => item.runId === runId);
    expect(candidate).toBeDefined();

    let enterOperation!: () => void;
    const operationEntered = new Promise<void>((resolve) => { enterOperation = resolve; });
    let releaseOperation!: () => void;
    const operationRelease = new Promise<void>((resolve) => { releaseOperation = resolve; });
    const guardedDelivery = store.runWhileTerminalCandidateCurrent(candidate!, async () => {
      enterOperation();
      await operationRelease;
    });
    await operationEntered;

    const observer = await pool.connect();
    let operationReleased = false; // 确保断言失败时也释放 operation barrier
    try {
      const held = await observer.query<AdvisoryLockId>(`
        SELECT classid::text, objid::text, objsubid FROM pg_locks
        WHERE locktype='advisory' AND granted
          AND classid=((hashtextextended($1, 0) >> 32) & 4294967295)::oid
          AND objid=(hashtextextended($1, 0) & 4294967295)::oid
        LIMIT 1
      `, [sandboxScopeId]);
      expect(held.rows[0]).toBeDefined();
      const admission = runStore.upsertPending({
        runId: 'terminal-guarded-new-run', sessionId: 'terminal-guarded-child', tenantId: 'tenant-guarded',
        workspaceId: 'workspace-guarded', sandboxScopeId,
        metadata: { topLevelSessionId: sessionId },
      });
      await waitForAdvisoryWaiters(observer, held.rows[0]!, 1);

      releaseOperation();
      operationReleased = true;
      await expect(guardedDelivery).resolves.toBe('committed');
      await expect(admission).resolves.toEqual(expect.objectContaining({ runId: 'terminal-guarded-new-run' }));
      await expect(store.isTerminalCandidateCurrent(runId)).resolves.toBe(true);
      await expect(store.hasActivity({
        sandboxScopeId, sessionId, tenantId: 'tenant-guarded',
      })).resolves.toBe(true);
    } finally {
      if (!operationReleased) releaseOperation();
      observer.release();
      await guardedDelivery.catch(() => undefined);
    }
  }, 30_000);

  it('100 个 deferred poison 不会长期挡住第 101 个健康候选，固定时钟退避可验证', async () => {
    const fixedNow = new Date('2026-09-01T00:00:00.000Z');
    const bulkPrefix = `poison-${randomUUID().slice(0, 8)}`;
    await pool.query(`
      INSERT INTO ${prefix}_runs (
        run_id, session_id, tenant_id, status, requested_at, updated_at, completed_at,
        workspace_id, sandbox_scope_id, metadata
      )
      SELECT
        $1 || '-' || n::text, $1 || '-session-' || n::text, 'tenant-poison', 'completed',
        $2::timestamptz + n * interval '1 second', $2::timestamptz + n * interval '1 second',
        $2::timestamptz + n * interval '1 second', 'workspace-poison', $1 || '-scope-' || n::text,
        jsonb_build_object(
          'sandboxWorkloadTopLevel', true,
          'sandboxWorkloadDescriptor', jsonb_build_object('kind', 'cron'),
          'sandboxLifecycleTerminalAt', ($2::timestamptz + n * interval '1 second')::text
        )
      FROM generate_series(1, 101) AS n
    `, [bulkPrefix, '2026-08-31T00:00:00.000Z']);
    let clock = fixedNow;
    const store = new PgSandboxLifecycleStore(
      pool as never, `${prefix}_runs`, `${prefix}_steering_inputs`, () => clock,
    );
    const firstPage = (await store.listTerminalCandidates(100))
      .filter((candidate) => candidate.runId.startsWith(bulkPrefix));
    expect(firstPage).toHaveLength(100);
    await Promise.all(firstPage.map((candidate) => store.deferTerminalCandidate(
      candidate.runId, new Error(`poison:${candidate.runId}`), fixedNow.toISOString(),
    )));

    const nextPage = await store.listTerminalCandidates(100);
    expect(nextPage).toEqual(expect.arrayContaining([
      expect.objectContaining({ runId: `${bulkPrefix}-101` }),
    ]));
    const poison = firstPage[0]!;
    const firstDeferred = await pool.query<{ outbox: Record<string, unknown> }>(`
      SELECT metadata->'sandboxLifecycleOutbox' AS outbox FROM ${prefix}_runs WHERE run_id=$1
    `, [poison.runId]);
    expect(firstDeferred.rows[0]?.outbox).toMatchObject({
      state: 'deferred', attempts: 1, lastError: `poison:${poison.runId}`,
    });
    expect(new Date(String(firstDeferred.rows[0]?.outbox.nextAttemptAt)).toISOString())
      .toBe('2026-09-01T00:00:01.000Z');
    clock = new Date('2026-09-01T00:00:01.000Z');
    await expect(store.listTerminalCandidates(200)).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ runId: poison.runId }),
    ]));
    const second = await store.deferTerminalCandidate(poison.runId, 'still poison', clock.toISOString());
    expect(second).toMatchObject({ attempts: 2, lastError: 'still poison' });
    expect(Date.parse(second!.nextAttemptAt)).toBe(Date.parse('2026-09-01T00:00:03.000Z'));
  });

  it('候选集合中的 terminal outbox target hand 经 PostgreSQL 持久化后不随 rollout 漂移', async () => {
    await runStore.upsertPending({
      runId: 'terminal-run-1', sessionId: 'terminal-session-1', tenantId: 'tenant-1',
      workspaceId: 'workspace-1', sandboxScopeId: 'scope-terminal-1', metadata: {
        sandboxWorkloadTopLevel: true,
        sandboxWorkloadDescriptor: { kind: 'cron' },
      },
    });
    await runStore.markStatus('terminal-run-1', 'completed');
    const store = new PgSandboxLifecycleStore(
      pool as never, `${prefix}_runs`, `${prefix}_steering_inputs`,
    );
    await expect(store.pinTerminalTargetHand('terminal-run-1', 'acs-old')).resolves.toBe('acs-old');

    // Earlier cases intentionally leave more than one default page of durable candidates.
    const rebuilt = new PgSandboxLifecycleStore(
      pool as never, `${prefix}_runs`, `${prefix}_steering_inputs`,
    );
    await expect(rebuilt.listTerminalCandidates(500)).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ runId: 'terminal-run-1', targetHandId: 'acs-old' }),
    ]));
  });
});
