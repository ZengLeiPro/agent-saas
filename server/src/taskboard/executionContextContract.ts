import type { PoolClient } from 'pg';

import type {
  TaskBoardExecutionPurpose,
  TaskBoardIntegrationCandidateState,
  TaskBoardTask,
} from '../../../shared/src/types/taskboard.js';
import { integrationCandidateTableNames } from './integrationCandidateSchema.js';
import { resolveWorkflowContract } from './workflowContract.js';

export async function resolveExecutionContextWorkflowContract(
  options: { integrationSourcesTable: string },
  client: Pick<PoolClient, 'query'>,
  task: TaskBoardTask,
  purpose?: TaskBoardExecutionPurpose,
) {
  if (task.kind !== 'integration' || task.workflowVersion !== 3) {
    return resolveWorkflowContract(task, purpose);
  }
  const tables = integrationCandidateTableNames(options.integrationSourcesTable);
  const candidate = await client.query(
    `SELECT state FROM ${tables.candidatesTable} WHERE integration_task_id=$1 LIMIT 1`,
    [task.id],
  );
  const candidateState = candidate.rows[0]?.state as TaskBoardIntegrationCandidateState | undefined;
  return resolveWorkflowContract(task, purpose, { candidateState });
}
