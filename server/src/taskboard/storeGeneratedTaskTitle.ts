import type { TaskBoardTask } from '../../../shared/src/types/taskboard.js';
import { assertBoardRole, assertWritableTask, requireText } from './storeHelpers.js';
import type { PgTaskboardStore } from './store.js';
import type { TaskboardIdentity } from './types.js';
import { appendTaskChange } from './v2Store.js';

export async function applyGeneratedTaskTitle(
  store: PgTaskboardStore,
  identity: TaskboardIdentity,
  taskId: string,
  title: string,
): Promise<TaskBoardTask> {
  const generatedTitle = requireText(title, 'Generated task title');
  return store.withTransaction(async (client) => {
    const loaded = await store.requireTaskWithBoard(client, identity, taskId, true);
    assertBoardRole(loaded.boardRole, 'editor');
    assertWritableTask(loaded.task, loaded.boardArchivedAt);
    if (loaded.task.title.trim()) return loaded.task;
    const updated = await client.query(
      `UPDATE ${store.tasksTable} t
          SET title=$4, version=t.version+1, updated_at=now()
         FROM ${store.boardsTable} b
        WHERE t.id=$1 AND t.board_id=b.id
          AND b.tenant_id=$2 AND (b.owner_user_id=$3 OR b.visibility='organization')
          AND t.title=''
        RETURNING t.id`,
      [taskId, identity.tenantId, identity.ownerUserId, generatedTitle],
    );
    if (!updated.rows[0]) return store.requireTask(client, identity, taskId, false);
    await appendTaskChange(
      store, client, taskId, 'task.updated', 'system', 'task-title-generator',
      { fields: ['title'], automated: true },
    );
    return store.requireTask(client, identity, taskId, false);
  });
}
