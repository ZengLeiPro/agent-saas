import { randomUUID } from 'node:crypto';
import type { TaskBoardTask } from '../../../../shared/src/types/taskboard.js';
import {
  appendChange,
  loadAccessibleTaskAndBoard,
  loadTask,
  requireBoardAccess,
  type TaskboardV2StoreOptions,
  withTransaction,
} from '../v2Store.js';
import { integrationCandidateTableNames } from '../integrationCandidateSchema.js';
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
    let resumedSourceIds: string[] = [];
    if (loaded.task.kind === 'integration' && loaded.task.workflowVersion === 3) {
      if (input.sourceIds?.length) {
        throw new TaskboardValidationError(
          'Workflow v3 resume cannot select or reuse legacy sources',
          'TASKBOARD_V3_RESUME_SOURCE_FORBIDDEN',
        );
      }
      const { candidatesTable, requestsOutboxTable } = integrationCandidateTableNames(options.integrationSourcesTable);
      const locked = await client.query(
        `SELECT * FROM ${candidatesTable}
          WHERE integration_task_id=$1 AND state IN ('blocked','needs_human') FOR UPDATE`, [taskId]);
      if (!locked.rows[0]) {
        throw new TaskboardValidationError(
          'Workflow v3 blocked task requires a blocked candidate',
          'TASKBOARD_CANDIDATE_RESUME_INVALID',
        );
      }
      const lane = await client.query(
        `UPDATE ${options.integrationLanesTable}
            SET active_integration_task_id=$2,lease_id=NULL,epoch=epoch+1,updated_at=now()
          WHERE repository_id=$1 AND (active_integration_task_id IS NULL OR active_integration_task_id=$2)
          RETURNING epoch`, [locked.rows[0].repository_id, taskId]);
      if (!lane.rows[0]) throw new TaskboardValidationError(
        'Repository lane is owned by another integration', 'TASKBOARD_INTEGRATION_ACTIVE');
      const candidate = await client.query(
        `UPDATE ${candidatesTable}
            SET workflow_epoch=workflow_epoch+1,lane_epoch=$2::bigint,
                approved_revision=NULL,approved_review_execution_id=NULL,
                last_error='engine_reconcile_required',version=version+1,updated_at=now()
          WHERE id=$1
          RETURNING id,state,current_revision,work_round,workflow_epoch,lane_epoch`,
        [locked.rows[0].id, lane.rows[0].epoch],
      );
      await client.query(
        `UPDATE ${options.tasksTable}
            SET workflow_epoch=workflow_epoch+1,next_action='none',
                next_action_revision=next_action_revision+1,completed_at=NULL,
                resume_context=jsonb_build_object(
                  'decision',$2::text,'purpose','merge','sourceIds','[]'::jsonb,
                  'reconcileRequired',true,'candidateId',$3::text,
                  'requestedAt',clock_timestamp(),'requestedBy',$4::text
                ),
                version=version+1,updated_at=now()
          WHERE id=$1`,
        [taskId, decision, candidate.rows[0].id, identity.ownerUserId],
      );
      await client.query(
        `INSERT INTO ${requestsOutboxTable}
          (id,request_key,kind,candidate_id,candidate_revision,work_round,workflow_epoch,lane_epoch,payload)
         VALUES ($1,$2,'workspace_sync',$3,$4,$5,$6::bigint,$7::bigint,$8::jsonb)
         ON CONFLICT (request_key) DO NOTHING`,
        [randomUUID(), `v3:resume:${String(candidate.rows[0].id)}:${String(candidate.rows[0].workflow_epoch)}`,
          candidate.rows[0].id, candidate.rows[0].current_revision, candidate.rows[0].work_round,
          candidate.rows[0].workflow_epoch, candidate.rows[0].lane_epoch,
          JSON.stringify({ candidateId: candidate.rows[0].id, revision: Number(candidate.rows[0].current_revision), decision, reason: 'resume_reconcile' })],
      );
      await appendChange(options, client, taskId, 'integration.candidate_reconcile_requested',
        'user', identity.ownerUserId, {
          decision,
          candidateId: String(candidate.rows[0].id),
          candidateRevision: Number(candidate.rows[0].current_revision),
          candidateWorkRound: Number(candidate.rows[0].work_round),
          workflowEpoch: String(candidate.rows[0].workflow_epoch),
          laneEpoch: String(candidate.rows[0].lane_epoch),
          reconcileRequired: true,
        });
      // Keep task/candidate blocked. integrationTriggers must ask the engine to
      // reconcile/reacquire the lane before choosing a legal candidate state.
      return loadTask(options, client, taskId);
    }
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
      resumedSourceIds = sourceIds;
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
