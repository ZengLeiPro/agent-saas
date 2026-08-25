import type { PoolClient } from 'pg';

import type { TaskBoardTask } from '../../../shared/src/types/taskboard.js';
import { integrationAgentTableNames } from './integrationAgentSchema.js';
import { resolveWorkflowContract } from './workflowContract.js';

export async function resolveExecutionContextWorkflowContract(
  options: { integrationSourcesTable: string },
  client: Pick<PoolClient, 'query'>,
  task: TaskBoardTask,
  purpose?: import('../../../shared/src/types/taskboard.js').TaskBoardExecutionPurpose,
) {
  if (task.kind !== 'integration' || task.workflowVersion !== 3) {
    return resolveWorkflowContract(task, purpose);
  }
  const { agentsTable } = integrationAgentTableNames(options.integrationSourcesTable);
  const agent = await client.query(
    `SELECT status FROM ${agentsTable} WHERE integration_task_id=$1 LIMIT 1`, [task.id],
  );
  const status = String(agent.rows[0]?.status ?? 'active');
  return resolveWorkflowContract(task, purpose, {
    candidateState: status === 'ready_to_merge' ? 'approved'
      : status === 'reviewing' ? 'in_review' : 'needs_work',
  });
}
