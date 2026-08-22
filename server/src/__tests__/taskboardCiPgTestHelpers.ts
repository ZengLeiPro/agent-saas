import { randomUUID } from 'node:crypto';

import type { PgTaskboardStore } from '../taskboard/store.js';

interface Queryable {
  query(text: string, values?: unknown[]): Promise<unknown>;
}

export async function seedSuccessfulReviewCi(
  pool: Queryable,
  store: Pick<PgTaskboardStore, 'executionsTable' | 'tasksTable'>,
  taskId: string,
  headOid: string,
): Promise<string> {
  const executionId = randomUUID();
  await pool.query(
    `INSERT INTO ${store.executionsTable}
       (id,task_id,run_id,session_id,status,purpose,trigger,protocol_version,attempt_id,
        requested_by,started_at,finished_at,resolved_at)
     VALUES($1,$2,$3,$4,'succeeded','review','initial',2,$5,'test-reviewer',now(),now(),now())`,
    [executionId, taskId, `seed-review-${executionId}`, `seed-session-${executionId}`, `seed-attempt-${executionId}`],
  );
  await pool.query(
    `UPDATE ${store.tasksTable}
        SET provider_ci_inspection_id=$2,provider_ci_execution_id=$3,provider_ci_purpose='review',
            provider_ci_head_oid=$4,provider_ci_status='success',provider_ci_inspected_at=now()
      WHERE id=$1`,
    [taskId, `seed-inspection-${executionId}`, executionId, headOid],
  );
  return executionId;
}
