/**
 * §3.4 / §3.6 组织目录的 PostgreSQL 实现。
 *
 * 快照与每一批变更都在**单个事务**内应用并推进 checkpoint（§3.6 消费算法）；
 * 目录 `disabled` / `remove` 一律把本地状态压成 `suspended`，且不随目录恢复自动复活。
 */
import type { DirectoryEvent, DirectoryGroup, DirectoryUser } from '@kaiyan/ky-app-contract';

import type { Pool, PoolClient } from 'pg';

import type {
  DirectoryCheckpoint,
  DirectoryStore,
  LocalDirectoryUser,
  LocalUserStatus,
} from './store.js';

interface UserRow {
  user_id: string;
  display_name: string;
  employee_no: string | null;
  status: 'active' | 'disabled';
  is_tenant_admin: boolean;
  group_ids: string[];
  local_status: LocalUserStatus;
  removed: boolean;
  updated_at: Date;
}

function toLocalUser(row: UserRow): LocalDirectoryUser {
  return {
    userId: row.user_id,
    displayName: row.display_name,
    ...(row.employee_no === null ? {} : { employeeNo: row.employee_no }),
    status: row.status,
    isTenantAdmin: row.is_tenant_admin,
    groupIds: row.group_ids,
    localStatus: row.local_status,
    removed: row.removed,
    updatedAt: row.updated_at.getTime(),
  };
}

/**
 * upsert 一个用户。`local_status` 的取值规则写在 SQL 里，保证并发下也是一次判定：
 * 目录 disabled → suspended；已经 suspended 的保持 suspended（不自动复活）。
 */
async function upsertUser(client: PoolClient, user: DirectoryUser, at: number): Promise<void> {
  await client.query(
    `INSERT INTO ky_app_directory_user
       (user_id, display_name, employee_no, status, is_tenant_admin, group_ids,
        local_status, removed, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,
             CASE WHEN $4 = 'disabled' THEN 'suspended' ELSE 'active' END, false, $7)
     ON CONFLICT (user_id) DO UPDATE SET
       display_name = EXCLUDED.display_name,
       employee_no = EXCLUDED.employee_no,
       status = EXCLUDED.status,
       is_tenant_admin = EXCLUDED.is_tenant_admin,
       group_ids = EXCLUDED.group_ids,
       local_status = CASE
         WHEN EXCLUDED.status = 'disabled' THEN 'suspended'
         WHEN ky_app_directory_user.local_status = 'suspended' THEN 'suspended'
         ELSE 'active' END,
       removed = false,
       updated_at = EXCLUDED.updated_at`,
    [
      user.userId,
      user.displayName,
      user.employeeNo ?? null,
      user.status,
      user.isTenantAdmin,
      user.groupIds,
      new Date(at),
    ],
  );
}

async function upsertGroup(client: PoolClient, group: DirectoryGroup): Promise<void> {
  await client.query(
    `INSERT INTO ky_app_directory_group (group_id, display_name, parent_group_id, status)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (group_id) DO UPDATE SET
       display_name = EXCLUDED.display_name,
       parent_group_id = EXCLUDED.parent_group_id,
       status = EXCLUDED.status`,
    [group.groupId, group.displayName, group.parentGroupId ?? null, group.status],
  );
}

async function markRemoved(client: PoolClient, userId: string, at: number): Promise<void> {
  await client.query(
    `UPDATE ky_app_directory_user
        SET removed = true, local_status = 'suspended', updated_at = $2
      WHERE user_id = $1`,
    [userId, new Date(at)],
  );
}

async function setCheckpoint(client: PoolClient, seq: number, at: number): Promise<void> {
  await client.query(
    `INSERT INTO ky_app_directory_checkpoint (id, seq, synced_at) VALUES (1, $1, $2)
     ON CONFLICT (id) DO UPDATE SET seq = EXCLUDED.seq, synced_at = EXCLUDED.synced_at`,
    [seq, new Date(at)],
  );
}

export class PgDirectoryStore implements DirectoryStore {
  constructor(private readonly pool: Pool) {}

  private async transaction<T>(run: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await run(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async getCheckpoint(): Promise<DirectoryCheckpoint | null> {
    const result = await this.pool.query<{ seq: string; synced_at: Date }>(
      'SELECT seq, synced_at FROM ky_app_directory_checkpoint WHERE id = 1',
    );
    if (result.rowCount !== 1) return null;
    return { seq: Number(result.rows[0].seq), at: result.rows[0].synced_at.getTime() };
  }

  async applySnapshot(input: {
    snapshotSeq: number;
    users: DirectoryUser[];
    groups: DirectoryGroup[];
    at: number;
  }): Promise<void> {
    await this.transaction(async (client) => {
      const ids = input.users.map((user) => user.userId);
      // 快照里没有的老用户 = 已离职：保留数据并标记，不物理删除（§3.4）。
      await client.query(
        `UPDATE ky_app_directory_user
            SET removed = true, local_status = 'suspended', updated_at = $1
          WHERE NOT (user_id = ANY($2::text[]))`,
        [new Date(input.at), ids],
      );
      for (const user of input.users) await upsertUser(client, user, input.at);
      await client.query('DELETE FROM ky_app_directory_group');
      for (const group of input.groups) await upsertGroup(client, group);
      await setCheckpoint(client, input.snapshotSeq, input.at);
    });
  }

  async applyChanges(input: {
    events: DirectoryEvent[];
    nextSeq: number;
    at: number;
  }): Promise<void> {
    const checkpoint = await this.getCheckpoint();
    const floor = checkpoint?.seq ?? 0;
    await this.transaction(async (client) => {
      for (const event of input.events) {
        if (event.seq <= floor) continue;
        switch (event.type) {
          case 'user.upsert':
            await upsertUser(client, event.user, input.at);
            break;
          case 'user.remove':
            await markRemoved(client, event.userId, input.at);
            break;
          case 'group.upsert':
            await upsertGroup(client, event.group);
            break;
          case 'group.remove':
            await client.query('DELETE FROM ky_app_directory_group WHERE group_id = $1', [
              event.groupId,
            ]);
            break;
        }
      }
      await setCheckpoint(client, input.nextSeq, input.at);
    });
  }

  async touchCheckpoint(at: number): Promise<void> {
    await this.pool.query('UPDATE ky_app_directory_checkpoint SET synced_at = $1 WHERE id = 1', [
      new Date(at),
    ]);
  }

  async getUser(userId: string): Promise<LocalDirectoryUser | null> {
    const result = await this.pool.query<UserRow>(
      'SELECT * FROM ky_app_directory_user WHERE user_id = $1',
      [userId],
    );
    return result.rowCount === 1 ? toLocalUser(result.rows[0]) : null;
  }

  async listUsers(): Promise<LocalDirectoryUser[]> {
    const result = await this.pool.query<UserRow>(
      'SELECT * FROM ky_app_directory_user ORDER BY user_id',
    );
    return result.rows.map(toLocalUser);
  }

  async listGroups(): Promise<DirectoryGroup[]> {
    const result = await this.pool.query<{
      group_id: string;
      display_name: string;
      parent_group_id: string | null;
      status: 'active' | 'disabled';
    }>('SELECT * FROM ky_app_directory_group ORDER BY group_id');
    return result.rows.map((row) => ({
      groupId: row.group_id,
      displayName: row.display_name,
      parentGroupId: row.parent_group_id,
      status: row.status,
    }));
  }

  async setTenantAdmin(userId: string, isTenantAdmin: boolean, at: number): Promise<void> {
    await this.pool.query(
      'UPDATE ky_app_directory_user SET is_tenant_admin = $2, updated_at = $3 WHERE user_id = $1',
      [userId, isTenantAdmin, new Date(at)],
    );
  }

  async reinstateUser(userId: string, at: number): Promise<void> {
    await this.pool.query(
      `UPDATE ky_app_directory_user SET local_status = 'active', updated_at = $2 WHERE user_id = $1`,
      [userId, new Date(at)],
    );
  }
}
