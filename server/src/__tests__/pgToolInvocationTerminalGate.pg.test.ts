import { randomUUID } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PgRunStore } from '../runtime/runStore.js';
import { PgToolInvocationStore } from '../runtime/toolInvocationStore.js';

const { Pool } = pg;
const testPgUrl = process.env.TEST_DATABASE_URL?.trim();
const describePg = testPgUrl ? describe : describe.skip;
if (!testPgUrl) {
  console.warn('[pgToolInvocationTerminalGate.pg] SKIPPED: TEST_DATABASE_URL is not configured');
}

describePg('PgToolInvocationStore terminal run gate', () => {
  const prefix = `tool_terminal_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  let pool: InstanceType<typeof Pool>;
  let runStore: PgRunStore;
  let toolInvocationStore: PgToolInvocationStore;

  beforeAll(async () => {
    pool = new Pool({ connectionString: testPgUrl!, connectionTimeoutMillis: 5_000, max: 4 });
    runStore = new PgRunStore({ pool, tablePrefix: prefix });
    await runStore.init();
    toolInvocationStore = new PgToolInvocationStore({ pool, tablePrefix: prefix });
    await toolInvocationStore.init();
  }, 30_000);

  afterAll(async () => {
    if (!pool) return;
    await pool.query(`DROP TABLE IF EXISTS ${prefix}_tool_invocations`);
    await pool.query(`DROP TABLE IF EXISTS ${prefix}_steering_inputs`);
    await pool.query(`DROP TABLE IF EXISTS ${prefix}_steering_sessions`);
    await pool.query(`DROP TABLE IF EXISTS ${prefix}_message_submissions`);
    await pool.query(`DROP TABLE IF EXISTS ${prefix}_runs`);
    await pool.end();
  }, 30_000);

  it.each(['completed', 'failed', 'orphaned'] as const)(
    'run 已 %s 后的 late start 原子落为 failed 且不创建外部取消 outbox',
    async (terminalStatus) => {
      const sessionId = `session-terminal-late-start-${terminalStatus}`;
      const runId = `run-terminal-late-start-${terminalStatus}`;
      const invocationId = `invocation-terminal-late-start-${terminalStatus}`;
      await runStore.upsertPending({ runId, sessionId, userId: 'user-1', channel: 'web' });
      await runStore.markStatus(runId, terminalStatus);

      const invocation = await toolInvocationStore.start({
        invocationId,
        runId,
        sessionId,
        toolCallId: `call-terminal-late-start-${terminalStatus}`,
        toolName: 'Shell',
        executionTarget: 'server-remote',
      });

      expect(invocation).toMatchObject({
        status: 'failed',
        error: `run_already_terminal_before_tool_start status=${terminalStatus}`,
        metadata: expect.objectContaining({ terminalRunStatus: terminalStatus }),
      });
      expect(invocation.cancelRequestedAt).toBeUndefined();
      await expect(toolInvocationStore.listRunning(sessionId)).resolves.toHaveLength(0);
      await expect(toolInvocationStore.listCancelRequested(sessionId)).resolves.toHaveLength(0);
    },
  );

  it('terminal update 提交与 late start 真并发时，start 等待行锁后 fail closed', async () => {
    const sessionId = 'session-terminal-start-race';
    const runId = 'run-terminal-start-race';
    const invocationId = 'invocation-terminal-start-race';
    await runStore.upsertPending({ runId, sessionId, userId: 'user-1', channel: 'web' });
    await runStore.markStatus(runId, 'running');

    const terminalWriter = await pool.connect();
    let lateStart: ReturnType<PgToolInvocationStore['start']> | undefined;
    try {
      await terminalWriter.query('BEGIN');
      await terminalWriter.query(`
        UPDATE ${prefix}_runs
        SET status = 'completed', completed_at = clock_timestamp(), updated_at = clock_timestamp()
        WHERE run_id = $1
      `, [runId]);
      lateStart = toolInvocationStore.start({
        invocationId,
        runId,
        sessionId,
        toolCallId: 'call-terminal-start-race',
        toolName: 'Shell',
        executionTarget: 'server-remote',
      });

      let waitingOnRunLock = false;
      for (let attempt = 0; attempt < 100 && !waitingOnRunLock; attempt += 1) {
        const waiting = await pool.query<{ waiting: boolean }>(`
          SELECT EXISTS (
            SELECT 1 FROM pg_stat_activity
            WHERE datname = current_database()
              AND wait_event_type = 'Lock'
              AND query LIKE $1
          ) AS waiting
        `, [`%SELECT status FROM ${prefix}_runs%FOR SHARE%`]);
        waitingOnRunLock = waiting.rows[0]?.waiting ?? false;
        if (!waitingOnRunLock) await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(waitingOnRunLock).toBe(true);
      await terminalWriter.query('COMMIT');

      await expect(lateStart).resolves.toMatchObject({
        status: 'failed',
        error: 'run_already_terminal_before_tool_start status=completed',
      });
      expect((await toolInvocationStore.get(invocationId))?.cancelRequestedAt).toBeUndefined();
      await expect(toolInvocationStore.listCancelRequested(sessionId)).resolves.toHaveLength(0);
    } finally {
      await terminalWriter.query('ROLLBACK').catch(() => undefined);
      terminalWriter.release();
      await lateStart?.catch(() => undefined);
    }
  });
});
