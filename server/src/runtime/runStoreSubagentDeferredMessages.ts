import type { PgPool, RunRecord, SubagentDeferredMessage } from './runStoreTypes.js';
import { normalizeRunRecord } from './runStoreRecordHelpers.js';
import { supportsSubagentContinuationProtocol } from './subagent/subagentContinuationProtocol.js';

const ACTIVE_STATUSES = new Set([
  'pending',
  'running',
  'waiting_approval',
  'waiting_user',
  'waiting_hand',
]);

export async function queueSubagentDeferredMessage(
  pool: PgPool,
  runsTable: string,
  input: {
    taskRunId: string;
    agentId: string;
    tenantId: string;
    parentSessionId: string;
    userId?: string;
    message: SubagentDeferredMessage;
  },
): Promise<{ state: 'accepted' } | { state: 'physical_active'; target: RunRecord }> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const taskResult = await client.query<{ row_json: RunRecord }>(
      `
      SELECT row_to_json(task.*) AS row_json
      FROM ${runsTable} task
      WHERE task.run_id = $1 AND task.tenant_id = $2
      FOR UPDATE
    `,
      [input.taskRunId, input.tenantId],
    );
    const task = taskResult.rows[0]?.row_json && normalizeRunRecord(taskResult.rows[0].row_json);
    if (
      !task ||
      !ACTIVE_STATUSES.has(task.status) ||
      task.metadata.backgroundTask !== true ||
      !supportsSubagentContinuationProtocol(task.metadata) ||
      task.metadata.subagentAgentId !== input.agentId ||
      task.metadata.parentSessionId !== input.parentSessionId ||
      (input.userId && task.userId !== input.userId && task.submitterUserId !== input.userId)
    ) {
      throw new Error('SUBAGENT_BACKGROUND_CONTINUATION_NOT_AUTHORIZED');
    }

    const childRunId =
      typeof task.metadata.executionChildRunId === 'string'
        ? task.metadata.executionChildRunId
        : undefined;
    if (childRunId) {
      const childResult = await client.query<{ row_json: RunRecord }>(
        `
        SELECT row_to_json(child.*) AS row_json
        FROM ${runsTable} child
        WHERE child.run_id = $1
          AND child.tenant_id = $2
          AND child.metadata->>'subagentAgentId' = $3
          AND child.status IN ('pending','running','waiting_approval','waiting_user','waiting_hand')
        FOR UPDATE
      `,
        [childRunId, input.tenantId, input.agentId],
      );
      if (childResult.rows[0]) {
        await client.query('COMMIT');
        return {
          state: 'physical_active',
          target: normalizeRunRecord(childResult.rows[0].row_json),
        };
      }
    }

    const current = Array.isArray(task.metadata.subagentDeferredMessages)
      ? task.metadata.subagentDeferredMessages.filter(isDeferredMessage)
      : [];
    if (!current.some((message) => message.messageId === input.message.messageId)) {
      if (current.length >= 100) throw new Error('SUBAGENT_DEFERRED_MESSAGE_LIMIT');
      current.push(input.message);
      await client.query(
        `
        UPDATE ${runsTable}
        SET metadata = jsonb_set(metadata, '{subagentDeferredMessages}', $2::jsonb, true),
            updated_at = NOW()
        WHERE run_id = $1
      `,
        [input.taskRunId, JSON.stringify(current)],
      );
    }
    await client.query('COMMIT');
    return { state: 'accepted' };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function drainSubagentDeferredMessages(
  pool: PgPool,
  runsTable: string,
  input: { taskRunId: string; childRunId: string; agentId: string; tenantId: string },
): Promise<SubagentDeferredMessage[]> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const taskResult = await client.query<{ row_json: RunRecord }>(
      `
      SELECT row_to_json(task.*) AS row_json
      FROM ${runsTable} task
      WHERE task.run_id = $1 AND task.tenant_id = $2
      FOR UPDATE
    `,
      [input.taskRunId, input.tenantId],
    );
    const task = taskResult.rows[0]?.row_json && normalizeRunRecord(taskResult.rows[0].row_json);
    if (
      !task ||
      task.metadata.backgroundTask !== true ||
      !supportsSubagentContinuationProtocol(task.metadata) ||
      task.metadata.subagentAgentId !== input.agentId ||
      task.metadata.executionChildRunId !== input.childRunId
    ) {
      throw new Error('SUBAGENT_DEFERRED_MESSAGE_HANDOFF_MISMATCH');
    }
    const child = await client.query<{ run_id: string }>(
      `
      SELECT run_id FROM ${runsTable}
      WHERE run_id = $1 AND tenant_id = $2 AND metadata->>'subagentAgentId' = $3
      FOR UPDATE
    `,
      [input.childRunId, input.tenantId, input.agentId],
    );
    if (!child.rows[0]) throw new Error('SUBAGENT_DEFERRED_MESSAGE_CHILD_MISSING');

    const pending = Array.isArray(task.metadata.subagentDeferredMessages)
      ? task.metadata.subagentDeferredMessages.filter(isDeferredMessage)
      : [];
    const applied = Array.isArray(task.metadata.subagentAppliedMessageIds)
      ? task.metadata.subagentAppliedMessageIds.filter((value) => typeof value === 'string')
      : [];
    await client.query(
      `
      UPDATE ${runsTable}
      SET metadata = jsonb_set(
            metadata - 'subagentDeferredMessages',
            '{subagentAppliedMessageIds}',
            $2::jsonb,
            true
          ),
          updated_at = NOW()
      WHERE run_id = $1
    `,
      [
        input.taskRunId,
        JSON.stringify([...applied, ...pending.map((message) => message.messageId)].slice(-500)),
      ],
    );
    await client.query('COMMIT');
    return pending;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

function isDeferredMessage(value: unknown): value is SubagentDeferredMessage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row.messageId === 'string' &&
    typeof row.prompt === 'string' &&
    typeof row.acceptedAt === 'string'
  );
}
