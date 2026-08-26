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
    if (loaded.task.kind === 'integration' || loaded.task.kind === 'remediation'
      || loaded.task.status === 'done' || loaded.task.status === 'canceled'
      || loaded.task.mergeEligibility === 'claimed') {
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
    await appendTaskChange(store, client, taskId, 'task.transitioned', 'user', identity.ownerUserId, {
      from: loaded.task.status,
      to: 'done',
    });
    return store.requireTask(client, identity, taskId, false);
  });
}
