import type { TaskBoardTask } from '../../../../shared/src/types/taskboard.js';
import {
  appendChange,
  loadAccessibleTaskAndBoard,
  loadTask,
  requireBoardAccess,
  type TaskboardV2StoreOptions,
  withTransaction,
} from '../v2Store.js';
import { loadWorkflowFacts } from './commandService.js';
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
    if (loaded.task.version !== input.expectedVersion) throw new TaskboardConflictError(loaded.task);
    const facts = await loadWorkflowFacts(options, client, loaded.task);
    if (loaded.task.status !== 'blocked' || facts.hasMergeFact) {
      throw new TaskboardValidationError('Only a non-merged blocked task can be resumed', 'TASKBOARD_RESUME_INVALID');
    }
    const decision = input.decision.trim();
    if (!decision) throw new TaskboardValidationError('Resume decision is required');
    let resumePurpose: 'work' | 'review' | 'merge' = 'work';
    if (loaded.task.kind === 'integration') {
      const sourceIds = [...new Set(input.sourceIds ?? [])];
      if (!sourceIds.length) {
        throw new TaskboardValidationError('Integration resume requires explicit sourceIds', 'TASKBOARD_RESUME_SOURCE_REQUIRED');
      }
      const resumed = await client.query(
        `UPDATE ${options.integrationSourcesTable}
            SET state='pending',last_error=NULL,updated_at=now()
          WHERE integration_task_id=$1 AND id=ANY($2::text[]) AND state='needs_human'
            AND merged_commit_oid IS NULL AND provider_receipt_id IS NULL
          RETURNING id`,
        [taskId, sourceIds],
      );
      if (resumed.rows.length !== sourceIds.length) {
        throw new TaskboardValidationError('One or more sources are not resumable', 'TASKBOARD_RESUME_SOURCE_INVALID');
      }
      resumePurpose = 'merge';
    } else if (input.sourceIds?.length) {
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
              next_action_revision=next_action_revision+1,completed_at=NULL,version=version+1,updated_at=now()
        WHERE id=$1`,
      [taskId, resumeStatus, resumePurpose],
    );
    await client.query(
      `UPDATE ${options.blockEpisodesTable} SET closed_at=now()
        WHERE task_id=$1 AND closed_at IS NULL`,
      [taskId],
    );
    await appendChange(options, client, taskId,
      loaded.task.kind === 'integration' ? 'integration.resume_requested' : 'task.resume_requested',
      'user', identity.ownerUserId, { decision, sourceIds: input.sourceIds ?? [], purpose: resumePurpose });
    return loadTask(options, client, taskId);
  });
}
