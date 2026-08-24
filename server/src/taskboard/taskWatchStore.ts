import type { PoolClient } from 'pg';

import type { TaskboardIdentity } from './types.js';
import type { PgTaskboardStore } from './store.js';
import { appendTaskChange } from './v2Store.js';

export async function isStoredTaskWatched(
  store: PgTaskboardStore,
  identity: TaskboardIdentity,
  taskId: string,
): Promise<boolean> {
  await store.requireTask(store.pool, identity, taskId, false);
  const result = await store.pool.query(
    `SELECT 1 FROM ${store.watchersTable} WHERE task_id=$1 AND user_id=$2`,
    [taskId, identity.ownerUserId],
  );
  return Boolean(result.rows[0]);
}

export function setStoredTaskWatched(
  store: PgTaskboardStore,
  identity: TaskboardIdentity,
  taskId: string,
  watched: boolean,
): Promise<boolean> {
  return store.withTransaction(async (client: PoolClient) => {
    await store.requireTaskWithBoard(client, identity, taskId, true);
    if (watched) {
      await client.query(
        `INSERT INTO ${store.watchersTable} (task_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
        [taskId, identity.ownerUserId],
      );
    } else {
      await client.query(
        `DELETE FROM ${store.watchersTable} WHERE task_id=$1 AND user_id=$2`,
        [taskId, identity.ownerUserId],
      );
    }
    await appendTaskChange(store, client, taskId, 'task.watch.updated', 'user', identity.ownerUserId, { watched });
    return watched;
  });
}
