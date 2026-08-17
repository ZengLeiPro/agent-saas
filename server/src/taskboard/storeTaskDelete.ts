import type { PoolClient } from 'pg';

import type { TaskBoard, TaskBoardTask } from '../../../shared/src/types/taskboard.js';
import { assertTaskHasNoActiveRuns } from './archiveGuard.js';
import { assertExpectedVersion } from './storeHelpers.js';
import { TaskboardPermissionError, TaskboardValidationError, type TaskboardIdentity } from './types.js';
import { appendTaskChange } from './v2Store.js';

export interface TaskboardTaskDeleteHost {
  pool: {
    connect(): Promise<PoolClient>;
    query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  };
  tasksTable: string;
  boardsTable: string;
  commentsTable: string;
  executionsTable: string;
  membersTable: string;
  changesTable: string;
  integrationLanesTable: string;
  integrationSourcesTable: string;
  mergeAuthorizationsTable: string;
  mergeOperationsTable: string;
  blockEpisodesTable: string;
  integrationTriggerOutboxTable: string;
  continuationOutboxTable: string;
  executionOutboxTable: string;
  requireTaskWithBoard(
    db: PoolClient,
    identity: TaskboardIdentity,
    taskId: string,
    forUpdate: boolean,
  ): Promise<{
    task: TaskBoardTask;
    boardArchivedAt?: string;
    boardRole: TaskBoard['role'];
  }>;
}

function assertMaintainer(role: TaskBoard['role']): void {
  const rank = role === 'owner' ? 4 : role === 'maintainer' ? 3 : role === 'editor' ? 2 : 1;
  if (rank < 3) {
    throw new TaskboardPermissionError('Taskboard role does not allow this operation');
  }
}

export async function deleteStoredTask(
  host: TaskboardTaskDeleteHost,
  client: PoolClient,
  identity: TaskboardIdentity,
  taskId: string,
  expectedVersion: number,
): Promise<TaskBoardTask> {
  const loaded = await host.requireTaskWithBoard(client, identity, taskId, true);
  assertMaintainer(loaded.boardRole);
  assertExpectedVersion(loaded.task, expectedVersion);
  if (loaded.boardArchivedAt) {
    throw new TaskboardValidationError('Archived boards are read-only', 'TASKBOARD_BOARD_ARCHIVED');
  }
  if (loaded.task.deletedAt) {
    throw new TaskboardValidationError('Task is already deleted', 'TASKBOARD_TASK_DELETED');
  }
  await assertTaskHasNoActiveRuns(host, client, taskId);
  await client.query(
    `UPDATE ${host.tasksTable} t
        SET deleted_at=now(), version=t.version+1, updated_at=now()
       FROM ${host.boardsTable} b
      WHERE t.id=$1 AND t.board_id=b.id
        AND b.tenant_id=$2 AND (b.owner_user_id=$3 OR b.visibility='organization')`,
    [taskId, identity.tenantId, identity.ownerUserId],
  );
  await appendTaskChange(host, client, taskId, 'task.deleted', 'user', identity.ownerUserId, {}, true);
  return { ...loaded.task, deletedAt: new Date().toISOString(), version: loaded.task.version + 1 };
}
