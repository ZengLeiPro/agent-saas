/**
 * WP2b 组织目录快照的分页读取（规范 §3.6 / 附录 L）。
 *
 * 数据源是 Phase A 的投影态表 `<prefix>_ky_app_directory_state`（不是源端三张表）：
 * 各页读同一张态表才可能保证 `snapshotSeq` 一致，而 users/membership/directory_groups
 * 三个源没有共同事务，逐页去源端捞必然读出撕裂的目录。
 *
 * ## `snapshotSeq` 取值（本文件最需要想清楚的一件事）
 *
 * 取 `max(变更日志该组织的 MAX(seq), 投影态该组织的 MAX(updated_seq))`，两者在同一个
 * 持有变更日志 SHARE 锁的事务里读出。理由：
 * - 投影器在**同一个事务**里追加事件并更新投影态，所以变更日志的 `MAX(seq)` 恰好就是
 *   「已经体现在投影态里的最后一个事件」的序号 —— 这是最紧的正确取值；
 * - 但 30 天保留清理会把老事件删光。一个组织连续 30 天没有任何目录变更时，
 *   变更日志里该组织一行不剩、`MAX(seq)` 退化成 0，而投影态**不参与清理**，
 *   此时必须用 `MAX(updated_seq)` 兜住，否则消费端的 checkpoint 会被打回 0。
 *
 * 两个取值都**只会偏小、不会偏大**（删除墓碑的 seq 不会留在投影态里，于是快照的
 * `snapshotSeq` 可能落在墓碑事件之前）。偏小的代价只是消费端把那几条 remove 事件
 * 再幂等应用一次；偏大才会丢事件，那是不能接受的方向。
 *
 * ## 一致性与 410
 *
 * 任何一次投影（upsert 或墓碑）都会让变更日志的 `MAX(seq)` 严格变大，因此「两页之间
 * 目录变过」必定表现为 `snapshotSeq` 不同。路由层据此回 410 `snapshot_expired`
 * 要求整份重拉，翻页期间不需要也不应该持有任何长事务。
 */
import type pg from 'pg';

import {
  governanceTablePrefix,
  type GovernancePgPool,
} from '../../data/governance-schema/index.js';
import {
  DIRECTORY_GROUP_FIELDS,
  DIRECTORY_USER_FIELDS,
  type DirectoryGroup,
  type DirectoryUser,
} from './types.js';

/**
 * 固定页大小（§3.6「页大小固定」）。取 200：
 * 千人规模的组织 5 页拉完，单页 JSON 远小于消费端与网关的常见上限。
 */
export const DIRECTORY_SNAPSHOT_PAGE_SIZE = 200;

export interface DirectorySnapshotPage {
  /** 本页读到的水位；调用方负责与 pageToken 里的值比对。 */
  snapshotSeq: number;
  users: DirectoryUser[];
  groups: DirectoryGroup[];
  hasMore: boolean;
}

export interface ReadDirectorySnapshotPageInput {
  tenantId: string;
  /** 页码，0 起。 */
  page: number;
  pageSize?: number;
}

/** 快照分页的数据源。PG 实现读投影态表；测试可注入内存替身。 */
export interface DirectorySnapshotSource {
  readPage(input: ReadDirectorySnapshotPageInput): Promise<DirectorySnapshotPage>;
}

/**
 * 从投影态里存的 JSON 重新按白名单挑字段。
 *
 * 投影态里的载荷本来就是 `toDirectoryUser()` 的产物，理论上已经干净；
 * 这里再挑一次是**纵深防御**：附录 L 的 `additionalProperties:false` 让任何一个
 * 多余键都会在消费端把整份快照判红，而库里的 JSONB 是可以被别的代码路径写脏的。
 * 与投影函数同样的纪律：逐字段显式赋值，绝不 spread。
 */
export function pickDirectoryUser(payload: Record<string, unknown>): DirectoryUser {
  const employeeNo = payload.employeeNo;
  const groupIds = Array.isArray(payload.groupIds)
    ? payload.groupIds.filter((item): item is string => typeof item === 'string')
    : [];
  const user: DirectoryUser = {
    userId: String(payload.userId ?? ''),
    displayName: String(payload.displayName ?? ''),
    status: payload.status === 'disabled' ? 'disabled' : 'active',
    isTenantAdmin: payload.isTenantAdmin === true,
    groupIds,
  };
  if (typeof employeeNo === 'string' && employeeNo.length > 0) user.employeeNo = employeeNo;
  return user;
}

export function pickDirectoryGroup(payload: Record<string, unknown>): DirectoryGroup {
  const parentGroupId = payload.parentGroupId;
  const group: DirectoryGroup = {
    groupId: String(payload.groupId ?? ''),
    displayName: String(payload.displayName ?? ''),
    status: payload.status === 'disabled' ? 'disabled' : 'active',
  };
  if (typeof parentGroupId === 'string' && parentGroupId.length > 0) {
    group.parentGroupId = parentGroupId;
  }
  return group;
}

/** 白名单键集合，供单测断言投影出口与附录 L 完全对齐。 */
export const DIRECTORY_SNAPSHOT_FIELD_WHITELIST = {
  user: DIRECTORY_USER_FIELDS,
  group: DIRECTORY_GROUP_FIELDS,
} as const;

export interface PgDirectorySnapshotSourceOptions {
  pool: GovernancePgPool;
  tablePrefix?: string;
}

interface StateRow extends pg.QueryResultRow {
  entity_type: string;
  entity_id: string;
  payload: unknown;
}

export class PgDirectorySnapshotSource implements DirectorySnapshotSource {
  readonly stateTable: string;
  readonly changeLogTable: string;

  constructor(private readonly options: PgDirectorySnapshotSourceOptions) {
    const prefix = governanceTablePrefix(options.tablePrefix);
    this.stateTable = `${prefix}_ky_app_directory_state`;
    this.changeLogTable = `${prefix}_ky_app_directory_change_log`;
  }

  async readPage(input: ReadDirectorySnapshotPageInput): Promise<DirectorySnapshotPage> {
    const pageSize = Math.max(1, input.pageSize ?? DIRECTORY_SNAPSHOT_PAGE_SIZE);
    const offset = Math.max(0, input.page) * pageSize;
    const client = await this.options.pool.connect();
    try {
      await client.query('BEGIN');
      // 与 changeLog.listAfter 同一把锁：挡住正在提交的投影事务，
      // 保证水位与本页内容来自同一个一致视图。
      await client.query(`LOCK TABLE ${this.changeLogTable} IN SHARE MODE`);
      const [stateMax, logMax, rows] = await Promise.all([
        client.query<{ seq: string | null }>(
          `SELECT MAX(updated_seq) AS seq FROM ${this.stateTable} WHERE tenant_id=$1`,
          [input.tenantId],
        ),
        client.query<{ seq: string | null }>(
          `SELECT MAX(seq) AS seq FROM ${this.changeLogTable} WHERE tenant_id=$1`,
          [input.tenantId],
        ),
        // 多取一行判 hasMore，不额外发 COUNT。
        // 'group' < 'user'，所以分组天然排在用户前面；(entity_type,entity_id) 是主键前缀，
        // 排序是全序，OFFSET 分页在同一份快照内确定可复现。
        client.query<StateRow>(
          `SELECT entity_type,entity_id,payload FROM ${this.stateTable}
           WHERE tenant_id=$1
           ORDER BY entity_type,entity_id
           OFFSET $2 LIMIT $3`,
          [input.tenantId, offset, pageSize + 1],
        ),
      ]);
      await client.query('COMMIT');

      const hasMore = rows.rows.length > pageSize;
      const page = hasMore ? rows.rows.slice(0, pageSize) : rows.rows;
      const users: DirectoryUser[] = [];
      const groups: DirectoryGroup[] = [];
      for (const row of page) {
        const payload = (row.payload ?? {}) as Record<string, unknown>;
        if (row.entity_type === 'user') users.push(pickDirectoryUser(payload));
        else groups.push(pickDirectoryGroup(payload));
      }
      return {
        snapshotSeq: Math.max(numberOf(stateMax.rows[0]?.seq), numberOf(logMax.rows[0]?.seq)),
        users,
        groups,
        hasMore,
      };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}

function numberOf(value: string | null | undefined): number {
  if (value === null || value === undefined) return 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * 内存快照源：把一份完整目录按固定页大小切片，语义与 PG 实现逐字对齐。
 * 供路由单测与 `DirectoryClient` 交叉测试使用（存储是替身，路由与消费端都是生产代码）。
 */
export class MemoryDirectorySnapshotSource implements DirectorySnapshotSource {
  private readonly tenants = new Map<
    string,
    { snapshotSeq: number; users: DirectoryUser[]; groups: DirectoryGroup[] }
  >();

  set(
    tenantId: string,
    input: { snapshotSeq: number; users: DirectoryUser[]; groups: DirectoryGroup[] },
  ): void {
    this.tenants.set(tenantId, {
      snapshotSeq: input.snapshotSeq,
      users: [...input.users],
      groups: [...input.groups],
    });
  }

  async readPage(input: ReadDirectorySnapshotPageInput): Promise<DirectorySnapshotPage> {
    const pageSize = Math.max(1, input.pageSize ?? DIRECTORY_SNAPSHOT_PAGE_SIZE);
    const state = this.tenants.get(input.tenantId);
    if (!state) return { snapshotSeq: 0, users: [], groups: [], hasMore: false };
    // 与 PG 实现同一个全序：'group' < 'user'，所以分组在前、用户在后，各自按 id 升序。
    const ordered: Array<{ group: DirectoryGroup } | { user: DirectoryUser }> = [
      ...[...state.groups]
        .sort((left, right) => (left.groupId < right.groupId ? -1 : 1))
        .map((group) => ({ group })),
      ...[...state.users]
        .sort((left, right) => (left.userId < right.userId ? -1 : 1))
        .map((user) => ({ user })),
    ];
    const offset = Math.max(0, input.page) * pageSize;
    const slice = ordered.slice(offset, offset + pageSize);
    return {
      snapshotSeq: state.snapshotSeq,
      // 与 PG 路径走同一道白名单挑选，避免内存替身比生产实现「更宽容」。
      users: slice.flatMap((item) =>
        'user' in item ? [pickDirectoryUser(item.user as unknown as Record<string, unknown>)] : [],
      ),
      groups: slice.flatMap((item) =>
        'group' in item
          ? [pickDirectoryGroup(item.group as unknown as Record<string, unknown>)]
          : [],
      ),
      hasMore: offset + pageSize < ordered.length,
    };
  }
}
