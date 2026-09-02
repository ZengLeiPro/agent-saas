import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';

import { TaskboardValidationError } from '../types.js';

export interface ExecutionFinishCommentHost {
  commentsTable: string;
  changesTable: string;
}

export async function recordExecutionFinishComment(
  host: ExecutionFinishCommentHost,
  client: PoolClient,
  execution: { taskId: string; runId: string },
  body: string,
): Promise<void> {
  const normalized = body.trim();
  if (!normalized) {
    throw new TaskboardValidationError('Execution finish comment is required', 'TASKBOARD_EXECUTION_COMMENT_REQUIRED');
  }
  const result = await client.query(
    `INSERT INTO ${host.commentsTable}
       (id,task_id,body,author_type,author_id,author_name,continuation_eligible,version)
     VALUES ($1,$2,$3,'agent',$4,'Agent',false,1)
     RETURNING id`,
    [randomUUID(), execution.taskId, normalized, execution.runId],
  );
  await client.query(
    `INSERT INTO ${host.changesTable}
       (task_id,change_type,actor_type,actor_id,payload)
     VALUES ($1,'execution.comment','agent',$2,$3::jsonb)`,
    [execution.taskId, execution.runId, JSON.stringify({ commentId: String(result.rows[0]!.id) })],
  );
}
