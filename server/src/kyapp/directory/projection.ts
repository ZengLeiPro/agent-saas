/**
 * WP2b 目录投影器（规范 §3.6）：把「源端目录」差分成附录 L 的变更事件。
 *
 * 为什么是**差分**而不是在每个写入点挂钩子（锚点地图 A2/A3 的三个缺口）：
 * - `users` 仍是 JSON 文件存储（`data/users/store.ts:84`），挂 PG 触发器根本覆盖不到；
 *   而 `UserStore.setPostPersistObserver` 是**单槽**回调，已被治理影子投影占用，
 *   再抢一次就会把既有链路顶掉；
 * - `PgDirectoryGroupStore.upsertProjection`（`store.ts:146-156`）对成员表是
 *   「DELETE 全量 + 重插」，**成员移除不留任何痕迹**，钩子拿不到被删的行；
 * - 三个源没有共同事务，谁先谁后不可控。
 *
 * 差分投影只依赖「当前期望态」与「上次投影态」两个快照，因此天然覆盖**所有**写路径
 * （包括我们还不知道的那些），也天然能补出删除墓碑。代价是延迟等于投影节拍
 * （§3.4「调部门：延迟 ≤ 轮询间隔，默认 5 分钟」正是按这个口径写的）。
 */
import type pg from 'pg';

import {
  PgGovernanceMigrationRunner,
  governanceTablePrefix,
  type GovernancePgPool,
} from '../../data/governance-schema/index.js';
import type { AppendDirectoryChangeInput, PgKyAppDirectoryChangeLog } from './changeLog.js';
import {
  directoryEntityDigest,
  toDirectoryGroup,
  toDirectoryUser,
  type DirectoryGroup,
  type DirectorySourceId,
  type DirectoryUser,
} from './types.js';

/** 一个组织的完整目录期望态；两个数组都已经过白名单投影。 */
export interface DirectorySourceSnapshot {
  users: DirectoryUser[];
  groups: DirectoryGroup[];
}

/**
 * 可插拔的目录源。本轮只有 `governance` 是真实现，`dingtalk` 是留空桩：
 * 服务端目前零通讯录调用能力，接通前置是钉钉后台的「通讯录只读」授权（管理动作）。
 */
export interface DirectorySourceProvider {
  readonly sourceId: DirectorySourceId;
  /** 需要投影的组织列表。 */
  listTenantIds(): Promise<string[]>;
  /** 拉取一个组织的完整目录期望态；必须是只读且幂等的。 */
  loadDirectory(tenantId: string): Promise<DirectorySourceSnapshot>;
}

/**
 * 用户源记录：**刻意只声明投影需要的字段**。
 * `UserStore.listAll()` 的 `UserInfo` 结构上满足它，但本模块在类型层就看不见
 * `phone` / `phoneVerifiedAt` 之类的字段，从源头杜绝「顺手 spread 一下」（§3.4）。
 */
export interface DirectoryUserSourceRecord {
  id: string;
  username: string;
  realName?: string;
  tenantId: string;
  role: string;
  disabled?: boolean;
}

export interface DirectoryUserReader {
  listAll(): readonly DirectoryUserSourceRecord[];
}

export interface GovernanceDirectorySourceOptions {
  pool: GovernancePgPool;
  tablePrefix?: string;
  users: DirectoryUserReader;
}

interface MembershipFacts {
  persona: string;
  status: 'active' | 'disabled';
  employeeNo: string | null;
}

/**
 * governance 源：用现有的 `users.json` + `tenant_memberships` + `directory_groups`
 * 拼出目录。账号是否存在以 `users.json` 为准（它是账号事实源），
 * 组织内属性（管理员、停用、工号）以 membership 为准，缺 membership 时回落到账号 role
 * ——口径与 `routes/handshake.ts` 的 `createTenantAdminResolver` 一致。
 */
export class GovernanceDirectorySource implements DirectorySourceProvider {
  readonly sourceId: DirectorySourceId = 'governance';
  readonly membershipsTable: string;
  readonly groupsTable: string;
  readonly groupMembersTable: string;

  constructor(private readonly options: GovernanceDirectorySourceOptions) {
    const prefix = governanceTablePrefix(options.tablePrefix);
    this.membershipsTable = `${prefix}_tenant_memberships`;
    this.groupsTable = `${prefix}_directory_groups`;
    this.groupMembersTable = `${prefix}_directory_group_members`;
  }

  async listTenantIds(): Promise<string[]> {
    const tenants = new Set<string>();
    for (const user of this.options.users.listAll()) {
      if (user.tenantId) tenants.add(user.tenantId);
    }
    const result = await this.options.pool.query<{ tenant_id: string }>(
      `SELECT DISTINCT tenant_id FROM ${this.membershipsTable}`,
    );
    for (const row of result.rows) tenants.add(row.tenant_id);
    return [...tenants].sort();
  }

  /** 录入工号（WP5 的 CSV 导入与管理界面走这里）；返回是否命中成员行。 */
  async setEmployeeNo(
    tenantId: string,
    userId: string,
    employeeNo: string | null,
  ): Promise<boolean> {
    const normalized = employeeNo?.trim() ? employeeNo.trim().slice(0, 32) : null;
    const result = await this.options.pool.query(
      `UPDATE ${this.membershipsTable} SET employee_no=$3, updated_at=NOW()
       WHERE tenant_id=$1 AND user_id=$2`,
      [tenantId, userId, normalized],
    );
    return (result.rowCount ?? 0) > 0;
  }

  private async loadMemberships(tenantId: string): Promise<Map<string, MembershipFacts>> {
    const result = await this.options.pool.query<{
      user_id: string;
      persona: string;
      status: string;
      employee_no: string | null;
    }>(
      `SELECT user_id,persona,status,employee_no FROM ${this.membershipsTable} WHERE tenant_id=$1`,
      [tenantId],
    );
    const map = new Map<string, MembershipFacts>();
    for (const row of result.rows) {
      map.set(row.user_id, {
        persona: row.persona,
        status: row.status === 'disabled' ? 'disabled' : 'active',
        employeeNo: row.employee_no,
      });
    }
    return map;
  }

  private async loadGroupIds(tenantId: string): Promise<Map<string, string[]>> {
    const result = await this.options.pool.query<{ user_id: string; group_id: string }>(
      `SELECT user_id,group_id FROM ${this.groupMembersTable} WHERE tenant_id=$1 ORDER BY group_id`,
      [tenantId],
    );
    const map = new Map<string, string[]>();
    for (const row of result.rows) {
      const list = map.get(row.user_id);
      if (list) list.push(row.group_id);
      else map.set(row.user_id, [row.group_id]);
    }
    return map;
  }

  async loadDirectory(tenantId: string): Promise<DirectorySourceSnapshot> {
    const [memberships, groupIds, groupRows] = await Promise.all([
      this.loadMemberships(tenantId),
      this.loadGroupIds(tenantId),
      this.options.pool.query<{
        group_id: string;
        display_name: string;
        parent_group_id: string | null;
        status: string;
      }>(
        `SELECT group_id,display_name,parent_group_id,status FROM ${this.groupsTable}
         WHERE tenant_id=$1 ORDER BY group_id`,
        [tenantId],
      ),
    ]);

    const users: DirectoryUser[] = [];
    for (const record of this.options.users.listAll()) {
      if (record.tenantId !== tenantId) continue;
      const membership = memberships.get(record.id);
      users.push(
        toDirectoryUser({
          userId: record.id,
          displayNameCandidates: [record.realName, record.username],
          employeeNo: membership?.employeeNo ?? null,
          accountDisabled: record.disabled === true,
          membershipStatus: membership?.status ?? null,
          isTenantAdmin: membership
            ? membership.status === 'active' && membership.persona === 'org_admin'
            : record.role === 'admin',
          groupIds: groupIds.get(record.id) ?? [],
        }),
      );
    }
    users.sort((left, right) => (left.userId < right.userId ? -1 : 1));

    const groups = groupRows.rows.map((row) =>
      toDirectoryGroup({
        groupId: row.group_id,
        displayNameCandidates: [row.display_name],
        parentGroupId: row.parent_group_id,
        status: row.status === 'disabled' ? 'disabled' : 'active',
      }),
    );
    return { users, groups };
  }
}

/** 钉钉源尚未接通时抛出；构造即抛，绝不静默降级成空目录。 */
export class DingTalkDirectoryNotConfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DingTalkDirectoryNotConfiguredError';
  }
}

export const DINGTALK_DIRECTORY_UNAVAILABLE_MESSAGE =
  '钉钉组织目录源未配置：服务端当前没有通讯录调用能力，' +
  '需先在钉钉后台为本应用授予「通讯录只读」权限并登记 corpId，再启用本源（WP2b 尾单）。';

/**
 * 钉钉部门树源——**本轮留空实现**。
 *
 * 现状（锚点地图 A5 已核实）：`server/src/integrations/dingtalk/**` 只有机器人消息、
 * 媒体、AI 卡片与告警，零通讯录调用；全仓服务端对 `employeeNo`/`jobNumber` 零命中。
 * 接通有两条通道，但都不是写代码能解决的：
 *   (a) 复用 `robotOtoAlert.ts` 的 accessToken 打通讯录 API —— 卡在钉钉后台授权（管理动作）；
 *   (b) 走 DWS CLI 的 `contact.*` —— 需要客户组织已扫码授权的 DWS 账号 + sandbox Shell。
 * 因此这里只固化接口形状与「未配置即拒绝」的语义，不做任何假实现，
 * 免得上线后静默投影出一份空目录、把客户组织的人全部当成离职。
 */
export class DingTalkDirectorySource implements DirectorySourceProvider {
  readonly sourceId: DirectorySourceId = 'dingtalk';

  constructor() {
    throw new DingTalkDirectoryNotConfiguredError(DINGTALK_DIRECTORY_UNAVAILABLE_MESSAGE);
  }

  async listTenantIds(): Promise<string[]> {
    throw new DingTalkDirectoryNotConfiguredError(DINGTALK_DIRECTORY_UNAVAILABLE_MESSAGE);
  }

  async loadDirectory(): Promise<DirectorySourceSnapshot> {
    throw new DingTalkDirectoryNotConfiguredError(DINGTALK_DIRECTORY_UNAVAILABLE_MESSAGE);
  }
}

export interface DirectoryReconcileResult {
  tenantId: string;
  userUpserts: number;
  userRemovals: number;
  groupUpserts: number;
  groupRemovals: number;
  /** 本轮追加事件后的水位；无变更时是该组织既有水位。 */
  snapshotSeq: number;
}

export interface DirectoryProjectorOptions {
  pool: GovernancePgPool;
  tablePrefix?: string;
  changeLog: PgKyAppDirectoryChangeLog;
  source: DirectorySourceProvider;
}

interface StateRow {
  entity_type: string;
  entity_id: string;
  digest: string;
}

interface PendingUpsert {
  key: string;
  entityType: 'user' | 'group';
  entityId: string;
  entity: DirectoryUser | DirectoryGroup;
  digest: string;
}

export class DirectoryProjector {
  readonly stateTable: string;
  private readonly tablePrefix?: string;

  constructor(private readonly options: DirectoryProjectorOptions) {
    this.tablePrefix = options.tablePrefix;
    this.stateTable = `${governanceTablePrefix(options.tablePrefix)}_ky_app_directory_state`;
  }

  async init(): Promise<void> {
    await new PgGovernanceMigrationRunner(this.options.pool, this.tablePrefix).run();
  }

  async reconcileAll(): Promise<DirectoryReconcileResult[]> {
    const tenantIds = await this.options.source.listTenantIds();
    const results: DirectoryReconcileResult[] = [];
    for (const tenantId of tenantIds) results.push(await this.reconcileTenant(tenantId));
    return results;
  }

  /**
   * 对齐一个组织：算差分 → 在**同一个事务**里追加事件并更新投影态。
   * 事务外先取期望态（源端可能是慢 IO），事务内用 advisory lock 把同组织的并发投影串起来，
   * 避免两个 worker 同时跑出重复事件。
   */
  async reconcileTenant(tenantId: string): Promise<DirectoryReconcileResult> {
    const desired = await this.options.source.loadDirectory(tenantId);
    const client = await this.options.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        `ky_app_directory:${tenantId}`,
      ]);
      const stored = await client.query<StateRow>(
        `SELECT entity_type,entity_id,digest FROM ${this.stateTable} WHERE tenant_id=$1`,
        [tenantId],
      );
      const previous = new Map<string, string>();
      for (const row of stored.rows)
        previous.set(`${row.entity_type}:${row.entity_id}`, row.digest);

      const changes: AppendDirectoryChangeInput[] = [];
      const upserts: PendingUpsert[] = [];
      const source = this.options.source.sourceId;
      const result: DirectoryReconcileResult = {
        tenantId,
        userUpserts: 0,
        userRemovals: 0,
        groupUpserts: 0,
        groupRemovals: 0,
        snapshotSeq: 0,
      };

      // 分组先于用户 upsert：消费端拿到 user.groupIds 时对应的 group 已经落地。
      for (const group of desired.groups) {
        const key = `group:${group.groupId}`;
        const digest = directoryEntityDigest(group);
        if (previous.get(key) === digest) continue;
        changes.push({
          tenantId,
          source,
          type: 'group.upsert',
          entityId: group.groupId,
          payload: group,
        });
        upserts.push({ key, entityType: 'group', entityId: group.groupId, entity: group, digest });
        result.groupUpserts += 1;
      }
      for (const user of desired.users) {
        const key = `user:${user.userId}`;
        const digest = directoryEntityDigest(user);
        if (previous.get(key) === digest) continue;
        changes.push({
          tenantId,
          source,
          type: 'user.upsert',
          entityId: user.userId,
          payload: user,
        });
        upserts.push({ key, entityType: 'user', entityId: user.userId, entity: user, digest });
        result.userUpserts += 1;
      }

      // 删除墓碑：投影态里还在、源端已经没有的实体。用户先删、分组后删，
      // 保证消费端不会在分组已消失的瞬间还持有指向它的 user.groupIds。
      const desiredKeys = new Set<string>([
        ...desired.users.map((user) => `user:${user.userId}`),
        ...desired.groups.map((group) => `group:${group.groupId}`),
      ]);
      const removals = stored.rows.filter(
        (row) => !desiredKeys.has(`${row.entity_type}:${row.entity_id}`),
      );
      for (const row of removals.filter((item) => item.entity_type === 'user')) {
        changes.push({ tenantId, source, type: 'user.remove', entityId: row.entity_id });
        result.userRemovals += 1;
      }
      for (const row of removals.filter((item) => item.entity_type === 'group')) {
        changes.push({ tenantId, source, type: 'group.remove', entityId: row.entity_id });
        result.groupRemovals += 1;
      }

      const appended = await this.options.changeLog.appendWithin(client, changes);
      const seqByKey = new Map<string, number>();
      for (const record of appended) {
        const entityType = record.type.startsWith('user') ? 'user' : 'group';
        seqByKey.set(`${entityType}:${record.entityId}`, record.seq);
      }
      for (const upsert of upserts) {
        await client.query(
          `INSERT INTO ${this.stateTable}
             (tenant_id,entity_type,entity_id,payload,digest,updated_seq,updated_at)
           VALUES ($1,$2,$3,$4::jsonb,$5,$6,NOW())
           ON CONFLICT (tenant_id,entity_type,entity_id) DO UPDATE SET
             payload=EXCLUDED.payload,digest=EXCLUDED.digest,
             updated_seq=EXCLUDED.updated_seq,updated_at=NOW()`,
          [
            tenantId,
            upsert.entityType,
            upsert.entityId,
            JSON.stringify(upsert.entity),
            upsert.digest,
            seqByKey.get(upsert.key) ?? 0,
          ],
        );
      }
      for (const row of removals) {
        await client.query(
          `DELETE FROM ${this.stateTable}
           WHERE tenant_id=$1 AND entity_type=$2 AND entity_id=$3`,
          [tenantId, row.entity_type, row.entity_id],
        );
      }
      const watermark = await client.query<{ seq: string | null }>(
        `SELECT MAX(updated_seq) AS seq FROM ${this.stateTable} WHERE tenant_id=$1`,
        [tenantId],
      );
      const appendedMax = appended.reduce((max, record) => Math.max(max, record.seq), 0);
      const storedMax = Number(watermark.rows[0]?.seq ?? 0);
      result.snapshotSeq = Math.max(appendedMax, Number.isFinite(storedMax) ? storedMax : 0);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}
