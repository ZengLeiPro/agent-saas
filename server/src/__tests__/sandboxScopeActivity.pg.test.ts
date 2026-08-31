import { randomUUID } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PgRunStore } from '../runtime/runStore.js';
import { PgSandboxLifecycleStore } from '../runtime/sandboxLifecycleService.js';

const { Pool } = pg;
const testPgUrl = process.env.TEST_DATABASE_URL?.trim();
const describePg = testPgUrl ? describe : describe.skip;
if (!testPgUrl) console.warn('[sandboxScopeActivity.pg] SKIPPED: TEST_DATABASE_URL is not configured');

describePg('Sandbox lifecycle PostgreSQL contract', () => {
  const prefix = `scope_activity_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  let pool: InstanceType<typeof Pool>;
  let runStore: PgRunStore;

  beforeAll(async () => {
    pool = new Pool({ connectionString: testPgUrl!, connectionTimeoutMillis: 5_000, max: 4 });
    runStore = new PgRunStore({ pool, tablePrefix: prefix });
    await runStore.init();
  }, 30_000);

  afterAll(async () => {
    if (!pool) return;
    try {
      await pool.query(`DROP TABLE IF EXISTS ${prefix}_steering_inputs`);
      await pool.query(`DROP TABLE IF EXISTS ${prefix}_steering_sessions`);
      await pool.query(`DROP TABLE IF EXISTS ${prefix}_message_submissions`);
      await pool.query(`DROP TABLE IF EXISTS ${prefix}_runs`);
    } finally {
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

  it('cancelling owner 崩溃后可按 lease/generation 接管，restore 可使旧 owner CAS 失效', async () => {
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
    await expect(rebuilt.listCleanupCandidates()).resolves.toEqual([]);
  });

  it('terminal outbox 的 target hand 经真实 PostgreSQL 持久化，store 重建后不随 rollout 漂移', async () => {
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

    const rebuilt = new PgSandboxLifecycleStore(
      pool as never, `${prefix}_runs`, `${prefix}_steering_inputs`,
    );
    await expect(rebuilt.listTerminalCandidates()).resolves.toEqual([
      expect.objectContaining({ runId: 'terminal-run-1', targetHandId: 'acs-old' }),
    ]);
  });
});
