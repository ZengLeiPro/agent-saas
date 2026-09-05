/**
 * §3.4 / §3.6 目录快照与本地用户状态的存储契约与内存实现。
 *
 * 本地用户唯一键 `(tid, iid, sub)`；`disabled`/`removed` → 业务角色 `suspended`，
 * 重新启用**不自动复活**；离职数据保留并标记。`adminRole` 由目录事件 `isTenantAdmin`
 * 与 SAT `tadm` 双通道同步。
 */
import type { DirectoryEvent, DirectoryGroup, DirectoryUser } from '@kaiyan/ky-app-contract';

/** 本地用户状态：与目录状态区分开，`suspended` 不随目录 `active` 自动复活。 */
export type LocalUserStatus = 'active' | 'suspended';

export interface LocalDirectoryUser extends DirectoryUser {
  localStatus: LocalUserStatus;
  /** 已从目录中移除（离职）；数据保留并标「已离职」。 */
  removed: boolean;
  /** 最近一次由目录事件或 SAT `tadm` 更新的时刻（毫秒）。 */
  updatedAt: number;
}

/** 消费位点。`at` = 最近一次成功同步的本地时刻，用于 §3.4 陈旧度门禁。 */
export interface DirectoryCheckpoint {
  seq: number;
  at: number;
}

export interface DirectoryStore {
  getCheckpoint(): Promise<DirectoryCheckpoint | null>;
  /** 单一本地事务：清空并写入整份快照，同时把 checkpoint 设为 `snapshotSeq`。 */
  applySnapshot(input: {
    snapshotSeq: number;
    users: DirectoryUser[];
    groups: DirectoryGroup[];
    at: number;
  }): Promise<void>;
  /** 单一本地事务：按 `seq` 幂等应用一批事件，提交后把 checkpoint 设为 `nextSeq`。 */
  applyChanges(input: { events: DirectoryEvent[]; nextSeq: number; at: number }): Promise<void>;
  /** 只更新 checkpoint 时间（无新事件时刷新陈旧度）。 */
  touchCheckpoint(at: number): Promise<void>;
  getUser(userId: string): Promise<LocalDirectoryUser | null>;
  listUsers(): Promise<LocalDirectoryUser[]>;
  listGroups(): Promise<DirectoryGroup[]>;
  /** SAT `tadm` 覆盖通道（§3.4：以 `tadm` 为准）。 */
  setTenantAdmin(userId: string, isTenantAdmin: boolean, at: number): Promise<void>;
  /** 管理员显式复活被 `suspended` 的用户。 */
  reinstateUser(userId: string, at: number): Promise<void>;
}

function toLocal(
  user: DirectoryUser,
  previous: LocalDirectoryUser | undefined,
  at: number,
): LocalDirectoryUser {
  // 目录 disabled → suspended；一旦 suspended，目录恢复 active 也不自动复活（§3.4）。
  const suspended = user.status === 'disabled' || previous?.localStatus === 'suspended';
  return {
    ...user,
    localStatus: suspended ? 'suspended' : 'active',
    removed: false,
    updatedAt: at,
  };
}

/** 内存实现：测试与单进程开发用。 */
export class MemoryDirectoryStore implements DirectoryStore {
  private users = new Map<string, LocalDirectoryUser>();
  private groups = new Map<string, DirectoryGroup>();
  private checkpoint: DirectoryCheckpoint | null = null;

  async getCheckpoint(): Promise<DirectoryCheckpoint | null> {
    return this.checkpoint === null ? null : { ...this.checkpoint };
  }

  async applySnapshot(input: {
    snapshotSeq: number;
    users: DirectoryUser[];
    groups: DirectoryGroup[];
    at: number;
  }): Promise<void> {
    const previous = this.users;
    const users = new Map<string, LocalDirectoryUser>();
    for (const user of input.users) {
      users.set(user.userId, toLocal(user, previous.get(user.userId), input.at));
    }
    // 快照里没有的老用户视为已移除：保留数据并标「已离职」+ suspended。
    for (const [userId, user] of previous) {
      if (users.has(userId)) continue;
      users.set(userId, { ...user, removed: true, localStatus: 'suspended', updatedAt: input.at });
    }
    this.users = users;
    this.groups = new Map(input.groups.map((group) => [group.groupId, group]));
    this.checkpoint = { seq: input.snapshotSeq, at: input.at };
  }

  async applyChanges(input: {
    events: DirectoryEvent[];
    nextSeq: number;
    at: number;
  }): Promise<void> {
    const checkpointSeq = this.checkpoint?.seq ?? 0;
    for (const event of input.events) {
      if (event.seq <= checkpointSeq) continue;
      this.applyEvent(event, input.at);
    }
    this.checkpoint = { seq: input.nextSeq, at: input.at };
  }

  private applyEvent(event: DirectoryEvent, at: number): void {
    switch (event.type) {
      case 'user.upsert':
        this.users.set(
          event.user.userId,
          toLocal(event.user, this.users.get(event.user.userId), at),
        );
        break;
      case 'user.remove': {
        const existing = this.users.get(event.userId);
        if (existing !== undefined) {
          this.users.set(event.userId, {
            ...existing,
            removed: true,
            localStatus: 'suspended',
            updatedAt: at,
          });
        }
        break;
      }
      case 'group.upsert':
        this.groups.set(event.group.groupId, event.group);
        break;
      case 'group.remove':
        this.groups.delete(event.groupId);
        break;
    }
  }

  async touchCheckpoint(at: number): Promise<void> {
    if (this.checkpoint !== null) this.checkpoint = { ...this.checkpoint, at };
  }

  async getUser(userId: string): Promise<LocalDirectoryUser | null> {
    const user = this.users.get(userId);
    return user === undefined ? null : { ...user };
  }

  async listUsers(): Promise<LocalDirectoryUser[]> {
    return [...this.users.values()].map((user) => ({ ...user }));
  }

  async listGroups(): Promise<DirectoryGroup[]> {
    return [...this.groups.values()].map((group) => ({ ...group }));
  }

  async setTenantAdmin(userId: string, isTenantAdmin: boolean, at: number): Promise<void> {
    const user = this.users.get(userId);
    if (user === undefined) return;
    this.users.set(userId, { ...user, isTenantAdmin, updatedAt: at });
  }

  async reinstateUser(userId: string, at: number): Promise<void> {
    const user = this.users.get(userId);
    if (user === undefined) return;
    this.users.set(userId, { ...user, localStatus: 'active', updatedAt: at });
  }
}
