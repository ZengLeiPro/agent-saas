import type { PoolClient } from 'pg';

import type { TaskBoardTask } from '../../../shared/src/types/taskboard.js';
import { resolveWorkflowContract } from './workflowContract.js';

export async function resolveExecutionContextWorkflowContract(
  _options: { integrationSourcesTable: string },
  _client: Pick<PoolClient, 'query'>,
  task: TaskBoardTask,
  purpose?: import('../../../shared/src/types/taskboard.js').TaskBoardExecutionPurpose,
) {
  return resolveWorkflowContract(task, purpose);
}
