import type { TaskBoardTask } from '../../../shared/src/types/taskboard.js';
import { assertTaskHasNoActiveRuns } from './archiveGuard.js';
import { nextTaskColumnSortOrder } from './continuationStore.js';
import type { PgTaskboardStore } from './store.js';
import { assertBoardRole, assertExpectedVersion, assertWritableTask } from './storeHelpers.js';
import { appendTaskChange } from './v2Store.js';
import {
  TaskboardValidationError,
  type TaskboardExpectedVersionInput,
  type TaskboardIdentity,
} from './types.js';

export async function completeStoredTask(
  store: PgTaskboardStore,
  identity: TaskboardIdentity,
  taskId: string,
  input: TaskboardExpectedVersionInput,
): Promise<TaskBoardTask> {
  return store.withTransaction(async (client) => {
    const loaded = await store.requireTaskWithBoard(client, identity, taskId, true);
    assertBoardRole(loaded.boardRole, 'maintainer');
    assertExpectedVersion(loaded.task, input.expectedVersion);
    assertWritableTask(loaded.task, loaded.boardArchivedAt);
    const deliveryRequiresWorkflow = loaded.task.kind === 'delivery' && (
      loaded.task.mergeEligibility === 'eligible' || loaded.task.mergeEligibility === 'claimed'
      || Boolean(loaded.task.providerPullRequestId && !loaded.task.mergedCommitOid)
    );
    if (loaded.task.kind === 'integration' || loaded.task.kind === 'remediation'
      || loaded.task.status === 'done' || loaded.task.status === 'canceled'
      || deliveryRequiresWorkflow) {
      throw new TaskboardValidationError(
        'This task must be completed by its workflow',
        'TASKBOARD_PROTECTED_TRANSITION',
      );
    }
    await assertTaskHasNoActiveRuns(store, client, taskId);
    const sortOrder = await nextTaskColumnSortOrder(
      store,
      client,
      identity,
      loaded.task.boardId,
      taskId,
      'done',
    );
    await client.query(
      `UPDATE ${store.tasksTable}
          SET status='done',sort_order=$2,completed_at=COALESCE(completed_at,now()),
              workflow_epoch=workflow_epoch+1,next_action='none',next_action_revision=next_action_revision+1,
              version=version+1,updated_at=now()
        WHERE id=$1`,
      [taskId, sortOrder],
    );
    if (loaded.task.status === 'blocked') {
      await client.query(
        `UPDATE ${store.blockEpisodesTable} SET closed_at=COALESCE(closed_at,now())
          WHERE task_id=$1 AND closed_at IS NULL`,
        [taskId],
      );
    }
    await appendTaskChange(store, client, taskId, 'task.transitioned', 'user', identity.ownerUserId, {
      from: loaded.task.status,
      to: 'done',
    });
    return store.requireTask(client, identity, taskId, false);
  });
}
