import type { TaskBoardTask } from '../../../../shared/src/types/taskboard.js';
import {
  appendChange,
  loadAccessibleTaskAndBoard,
  loadTask,
  requireBoardAccess,
  type TaskboardV2StoreOptions,
  withTransaction,
} from '../v2Store.js';
import { integrationAgentTableNames } from '../integrationAgentSchema.js';
import { loadWorkflowFacts } from './commandService.js';
import { assertIntegrationExecutionMigrated } from './decider.js';
import {
  TaskboardConflictError,
  TaskboardValidationError,
  type TaskboardIdentity,
} from '../types.js';

export async function resumeBlockedTask(
  options: TaskboardV2StoreOptions,
  identity: TaskboardIdentity,
  taskId: string,
  input: { expectedVersion: number; decision: string; sourceIds?: string[] },
): Promise<TaskBoardTask> {
  return withTransaction(options, async (client) => {
    const loaded = await loadAccessibleTaskAndBoard(options, client, identity, taskId, true);
    await requireBoardAccess(options, client, identity, loaded.task.boardId, 'maintainer', false);
    assertIntegrationExecutionMigrated(loaded.task);
    if (loaded.task.version !== input.expectedVersion) throw new TaskboardConflictError(loaded.task);
    const facts = await loadWorkflowFacts(options, client, loaded.task);
    const workflowV3 = loaded.task.kind === 'integration' && loaded.task.workflowVersion === 3;
    if (facts.hasMergeFact || (!workflowV3 && loaded.task.status !== 'blocked')) {
      throw new TaskboardValidationError('Only a non-merged blocked task can be resumed', 'TASKBOARD_RESUME_INVALID');
    }
    const decision = input.decision.trim();
    if (!decision) throw new TaskboardValidationError('Resume decision is required');
    let resumePurpose: 'work' | 'review' = 'work';
    const resumedSourceIds: string[] = [];
    if (workflowV3) {
      if (input.sourceIds?.length) {
        throw new TaskboardValidationError(
          'Integration Agent resume cannot select legacy sources',
          'TASKBOARD_INTEGRATION_AGENT_RESUME_SOURCE_FORBIDDEN',
        );
      }
      const { agentsTable } = integrationAgentTableNames(options.integrationSourcesTable);
      const resumed = await client.query(
        `UPDATE ${agentsTable}
            SET status='active',review_head_oid=NULL,verdict=NULL,review_execution_id=NULL,updated_at=now()
          WHERE integration_task_id=$1 AND status NOT IN ('merged','canceled')
            AND merge_in_flight_execution_id IS NULL
          RETURNING integration_task_id`, [taskId],
      );
      if (!resumed.rows[0]) {
        throw new TaskboardValidationError(
          'Integration Agent is terminal or unavailable',
          'TASKBOARD_INTEGRATION_AGENT_RESUME_INVALID',
        );
      }
      await client.query(
        `UPDATE ${options.tasksTable}
            SET status='in_progress',completed_at=NULL,next_action='none',
                next_action_revision=next_action_revision+1,version=version+1,updated_at=now()
          WHERE id=$1`, [taskId],
      );
      await appendChange(options, client, taskId, 'integration.agent.resumed',
        'user', identity.ownerUserId, { decision });
      return loadTask(options, client, taskId);
    }
    if (input.sourceIds?.length) {
      throw new TaskboardValidationError('sourceIds are only valid for integration resume');
    } else {
      const episode = await client.query(
        `SELECT purpose FROM ${options.blockEpisodesTable}
          WHERE task_id=$1 AND closed_at IS NULL ORDER BY opened_at DESC LIMIT 1`,
        [taskId],
      );
      if (episode.rows[0]?.purpose === 'review' && loaded.task.kind !== 'advisory') resumePurpose = 'review';
    }
    const resumeStatus = resumePurpose === 'review' ? 'in_review' : 'todo';
    await client.query(
      `UPDATE ${options.tasksTable}
          SET status=$2,workflow_epoch=workflow_epoch+1,next_action=$3,
              next_action_revision=next_action_revision+1,completed_at=NULL,
              resume_context=jsonb_build_object(
                'decision',$4::text,'purpose',$3::text,'sourceIds',$5::jsonb,
                'requestedAt',clock_timestamp(),'requestedBy',$6::text
              ),
              version=version+1,updated_at=now()
        WHERE id=$1`,
      [taskId, resumeStatus, resumePurpose, decision, JSON.stringify(resumedSourceIds), identity.ownerUserId],
    );
    await client.query(
      `UPDATE ${options.blockEpisodesTable} SET closed_at=now()
        WHERE task_id=$1 AND closed_at IS NULL`,
      [taskId],
    );
    await appendChange(options, client, taskId,
      loaded.task.kind === 'integration' ? 'integration.resume_requested' : 'task.resume_requested',
      'user', identity.ownerUserId, { decision, sourceIds: resumedSourceIds, purpose: resumePurpose });
    return loadTask(options, client, taskId);
  });
}
