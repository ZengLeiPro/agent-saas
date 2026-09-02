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
  throw new Error(`expected at least ${expected} waiter(s) for the prepared-intent advisory lock`);
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

  it('legacy null-tenant cleanup fences admission until explicit restore cancels the delivered carrier', async () => {
    const sessionId = 'legacy-cleanup-session';
    const sandboxScopeId = 'legacy-cleanup-scope';
    await runStore.upsertPending({
      runId: 'legacy-staged-run', sessionId, tenantId: 'tenant-1',
      workspaceId: 'workspace-legacy', sandboxScopeId,
      metadata: { schedulerState: 'staged' },
    });
    await runStore.upsertPending({
      runId: 'legacy-cleanup-carrier', sessionId: 'legacy-cleanup-carrier-session', tenantId: 'tenant-1',
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
      runId: 'legacy-new-tenant-run', sessionId, tenantId: 'tenant-2',
      workspaceId: 'workspace-legacy', sandboxScopeId, metadata: {},
    })).rejects.toThrow(/Sandbox cleanup is active/u);

    const store = new PgSandboxLifecycleStore(pool as never, `${prefix}_runs`, `${prefix}_steering_inputs`);
    await expect(store.cancelCleanup(sessionId, 'tenant-1', 'generation-legacy-restored')).resolves.toEqual([
      expect.objectContaining({
        runId: 'legacy-cleanup-carrier', previousDeletionGeneration: 'generation-legacy',
        deletionGeneration: 'generation-legacy-restored',
      }),
    ]);
    await expect(runStore.activateStagedRun('legacy-staged-run')).resolves.toBe(true);
      await expect(runStore.upsertPending({
        runId: 'legacy-restored-run', sessionId, tenantId: 'tenant-2',
        workspaceId: 'workspace-legacy', sandboxScopeId, metadata: {},
      })).resolves.toEqual(expect.objectContaining({ runId: 'legacy-restored-run' }));
    } finally {
      await pool.query(`UPDATE ${prefix}_runs SET tenant_id='pantheon' WHERE tenant_id IS NULL`);
      await pool.query(`ALTER TABLE ${prefix}_runs ALTER COLUMN tenant_id SET NOT NULL`);
    }
  });

  it('prepared cleanup fences late admission and guarded cancellation avoids carrier Run self-lock', async () => {
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
    await store.enqueueCleanup({
      workspaceId: 'workspace-intent', sessionId: 'intent-session-1', sandboxScopeId: 'scope-intent',
      tenantId: 'tenant-1', targetHandId: 'acs-old', deletionGeneration: 'generation-intent-1',
    }, { prepared: true });
    await expect(store.listPreparedCleanupCandidates()).resolves.toEqual([
      expect.objectContaining({ runId: 'intent-run-1', sessionId: 'intent-session-1' }),
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
      store.claimPreparedCleanup('intent-run-1', 'worker-a'),
      store.claimPreparedCleanup('intent-run-1', 'worker-b'),
    ]);
    const owner = first ?? second;
    expect([first, second].filter(Boolean)).toHaveLength(1);
    expect(owner).toEqual(expect.objectContaining({ claimGeneration: 1 }));
    await expect(store.listCleanupCandidates()).resolves.toEqual([]);

    const rebuilt = new PgSandboxLifecycleStore(
      pool as never, `${prefix}_runs`, `${prefix}_steering_inputs`,
    );
    await expect(rebuilt.completePreparedCleanup(
      'intent-run-1', owner!.claimId!, owner!.claimGeneration!,
    )).resolves.toBeUndefined();
    const reason = 'session_deleted:intent-session-1';
    await expect(runStore.cancelSteeringBeforeDispatchBySessionWithEvent(
      'intent-session-1', reason, 'intent-run-1', {
        type: 'run_cancel_requested', sessionId: 'intent-session-1', runId: 'intent-run-1', reason,
      }, 'tenant-1', {
        cleanupRunId: 'intent-run-1', sessionId: 'intent-session-1', sandboxScopeId: 'scope-intent',
        claimId: owner!.claimId!, claimGeneration: owner!.claimGeneration!,
      },
    )).resolves.toEqual(expect.objectContaining({ targetCancelled: true }));
    await expect(rebuilt.completePreparedCleanup(
      'intent-run-1', owner!.claimId!, owner!.claimGeneration!,
    )).resolves.toEqual(expect.objectContaining({ runId: 'intent-run-1' }));
    await expect(rebuilt.listCleanupCandidates()).resolves.toEqual([
      expect.objectContaining({ runId: 'intent-run-1', sessionId: 'intent-session-1' }),
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
    await store.enqueueCleanup({
      workspaceId: 'workspace-prepared-refresh', sessionId, sandboxScopeId,
      tenantId: 'tenant-1', targetHandId: 'acs-old', deletionGeneration: 'delete-generation-old',
    }, { prepared: true });
    await pool.query(`UPDATE ${prefix}_runs SET metadata=jsonb_set(metadata,
      '{sandboxCleanupOutbox,queuedAt}', to_jsonb($2::text)) WHERE run_id=$1`, [
      runId, '2000-01-01T00:00:00.000Z',
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
      const expiry = store.expireUncommittedPreparedCleanup(runId);
      await waitForAdvisoryWaiters(blocker, lock!, 2);
      await blocker.query('COMMIT');
      committed = true;

      await expect(takeover).resolves.toEqual(expect.objectContaining({
        runId, previousDeletionGeneration: 'delete-generation-root',
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
        runId, previousDeletionGeneration: 'delete-generation-root',
        deletionGeneration: 'delete-generation-new',
      }),
    ]));
    await runStore.markStatus(runId, 'cancelled', 'session deleted before restart');
    const claimed = await rebuilt.claimPreparedCleanup(runId, 'restarted-scanner');
    expect(claimed?.claimGeneration).toBe(1);
    await expect(rebuilt.completePreparedCleanup(
      runId, claimed!.claimId!, claimed!.claimGeneration!,
    )).resolves.toEqual(expect.objectContaining({ runId, deletionGeneration: 'delete-generation-new' }));
    await expect(rebuilt.listCleanupCandidates()).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({
        runId, previousDeletionGeneration: 'delete-generation-root',
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
    await store.enqueueCleanup({
      workspaceId: 'workspace-takeover', sessionId: 'takeover-session-1', sandboxScopeId: 'scope-takeover',
      tenantId: 'tenant-1', targetHandId: 'acs-old', deletionGeneration: 'delete-generation-1',
    }, { prepared: true });
    const crashed = await store.claimPreparedCleanup('takeover-run-1', 'crashed-worker');
    expect(crashed?.claimGeneration).toBe(1);
    await pool.query(`UPDATE ${prefix}_runs SET metadata=jsonb_set(metadata,
      '{sandboxCleanupOutbox,claimedAt}', to_jsonb($2::text)) WHERE run_id=$1`, [
      'takeover-run-1', '2000-01-01T00:00:00.000Z',
    ]);
    const rebuilt = new PgSandboxLifecycleStore(
      pool as never, `${prefix}_runs`, `${prefix}_steering_inputs`,
    );
    const takeover = await rebuilt.claimPreparedCleanup('takeover-run-1', 'restarted-worker');
    expect(takeover?.claimGeneration).toBe(2);
    await rebuilt.cancelCleanup('takeover-session-1', 'tenant-1', 'restore-generation-1');
    await expect(rebuilt.completePreparedCleanup(
      'takeover-run-1', takeover!.claimId!, takeover!.claimGeneration!,
    )).resolves.toBeUndefined();
    await expect(rebuilt.listCleanupCandidates()).resolves.not.toEqual(expect.arrayContaining([
      expect.objectContaining({ runId: 'takeover-run-1' }),
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

        let waiting = false;
        for (let attempt = 0; attempt < 100 && !waiting; attempt += 1) {
          const observed = await blocker.query<{ waiting: boolean }>(`
            SELECT EXISTS (
              SELECT 1 FROM pg_stat_activity
              WHERE pid <> pg_backend_pid()
                AND wait_event_type = 'Lock'
                AND query LIKE $1
            ) AS waiting
          `, [`%${prefix}_runs%`]);
          waiting = observed.rows[0]?.waiting === true;
          if (!waiting) await new Promise((resolve) => setTimeout(resolve, 10));
        }
        expect(waiting).toBe(true);
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

  it('A旧+B新只投B，且B delivered 后 A 永久不复活', async () => {
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
    await pool.query('SELECT pg_sleep(0.01)');
    await runStore.markStatus('terminal-a', 'completed', 'late-rewrite');
    const afterRewrite = await store.listTerminalCandidates();

    expect(afterRewrite).toEqual(expect.arrayContaining([expect.objectContaining({ runId: 'terminal-b' })]));
    expect(afterRewrite).not.toEqual(expect.arrayContaining([expect.objectContaining({ runId: 'terminal-a' })]));
    await store.markTerminalDelivered('terminal-b', new Date().toISOString());
    const afterDelivery = await store.listTerminalCandidates();
    expect(afterDelivery).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ runId: 'terminal-a' }),
      expect.objectContaining({ runId: 'terminal-b' }),
    ]));
  });

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
      nextAttemptAt: '2026-09-01 00:00:01+00',
    });
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
