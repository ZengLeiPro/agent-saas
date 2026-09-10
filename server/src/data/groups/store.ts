import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { open, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { SessionGroup, GroupsStoreFile, CreateGroupInput, UpdateGroupInput, InternalGroupPatch } from './types.js';

/** Callback to check whether a session transcript still exists */
export type SessionExistsChecker = (sessionId: string) => Promise<boolean>;

export interface GroupStoreOptions {
  /** 生产 PG advisory lock；未提供时退化为跨进程文件锁。 */
  withLock?: <T>(operation: () => Promise<T>) => Promise<T>;
  lockTimeoutMs?: number;
  lockRetryMs?: number;
}

interface MutationResult<T> {
  changed: boolean;
  value: T;
}

interface LocalLock {
  handle: Awaited<ReturnType<typeof open>>;
  token: string;
}

export class SmartGroupingConflictError extends Error {}

export class GroupStoreUnavailableError extends Error {
  readonly code = 'GROUP_STORE_UNAVAILABLE';

  constructor(filePath: string, cause: unknown) {
    super(`Failed to read groups store: ${filePath}`, { cause });
    this.name = 'GroupStoreUnavailableError';
  }
}

const DEFAULT_LOCK_TIMEOUT_MS = 10_000;
const DEFAULT_LOCK_RETRY_MS = 20;

function errorCode(err: unknown): string | undefined {
  return typeof err === 'object' && err !== null && 'code' in err
    ? String((err as { code?: unknown }).code)
    : undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class GroupStore {
  private groups: SessionGroup[] = [];
  private sourceWasPresent = false;
  private readonly filePath: string;
  private readonly options: GroupStoreOptions;
  private mutationQueue: Promise<void> = Promise.resolve();
  private mutationActive = false;

  constructor(filePath: string, options: GroupStoreOptions = {}) {
    this.filePath = filePath;
    this.options = options;
    this.load();
  }

  private load(): void {
    try {
      const raw = readFileSync(this.filePath, 'utf-8');
      const data: GroupsStoreFile = JSON.parse(raw);
      if (data.version !== 1 || !Array.isArray(data.groups)) {
        throw new Error('Invalid groups store structure');
      }
      for (const group of data.groups) {
        if (
          !group ||
          typeof group !== 'object' ||
          typeof group.id !== 'string' ||
          typeof group.userId !== 'string' ||
          typeof group.name !== 'string' ||
          !Array.isArray(group.sessionIds)
        ) {
          throw new Error('Invalid group record');
        }
      }
      this.groups = data.groups;
      this.sourceWasPresent = true;
    } catch (error) {
      if (errorCode(error) === 'ENOENT' && !this.sourceWasPresent) {
        mkdirSync(dirname(this.filePath), { recursive: true });
        this.groups = [];
        return;
      }
      throw new GroupStoreUnavailableError(this.filePath, error);
    }
  }

  private refreshForRead(): void {
    // 同实例 mutation 已在锁内加载了最新快照；此时重新读旧文件会把尚未 publish
    // 的本地改动覆盖回去。其他进程的读则始终从原子发布后的文件取真值。
    if (!this.mutationActive) this.load();
  }

  private async persist(): Promise<void> {
    const data: GroupsStoreFile = { version: 1, groups: this.groups };
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(tempPath, JSON.stringify(data, null, 2));
      await rename(tempPath, this.filePath);
      this.sourceWasPresent = true;
    } finally {
      await rm(tempPath, { force: true }).catch(() => undefined);
    }
  }

  private async acquireLocalLock(): Promise<LocalLock> {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const lockPath = `${this.filePath}.lock`;
    const timeoutMs = Math.max(0, this.options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS);
    const retryMs = Math.max(1, this.options.lockRetryMs ?? DEFAULT_LOCK_RETRY_MS);
    const deadline = Date.now() + timeoutMs;
    const token = randomUUID();

    for (;;) {
      let handle: Awaited<ReturnType<typeof open>> | undefined;
      try {
        handle = await open(lockPath, 'wx');
        await handle.writeFile(token, 'utf-8');
        return { handle, token };
      } catch (err) {
        await handle?.close().catch(() => undefined);
        if (handle) await unlink(lockPath).catch(() => undefined);
        if (errorCode(err) !== 'EEXIST') throw err;
        if (Date.now() >= deadline) {
          throw new Error(`Timed out acquiring groups store lock: ${lockPath}`);
        }
        await sleep(Math.min(retryMs, Math.max(1, deadline - Date.now())));
      }
    }
  }

  private async releaseLocalLock(lock: LocalLock): Promise<void> {
    const lockPath = `${this.filePath}.lock`;
    await lock.handle.close().catch(() => undefined);
    try {
      const currentToken = await readFile(lockPath, 'utf-8');
      if (currentToken === lock.token) await unlink(lockPath);
    } catch (err) {
      if (errorCode(err) !== 'ENOENT') throw err;
    }
  }

  private async mutate<T>(operation: () => MutationResult<T> | Promise<MutationResult<T>>): Promise<T> {
    const execute = async (): Promise<T> => {
      this.mutationActive = true;
      let committedGroups = this.groups;
      try {
        this.load();
        committedGroups = structuredClone(this.groups);
        const result = await operation();
        if (result.changed) await this.persist();
        return result.value;
      } catch (error) {
        // Keep the latest successfully loaded snapshot when the mutation itself
        // is rejected, instead of restoring this process's stale pre-lock view.
        this.groups = committedGroups;
        throw error;
      } finally {
        this.mutationActive = false;
      }
    };

    const run = async (): Promise<T> => {
      if (this.options.withLock) return this.options.withLock(execute);
      const lock = await this.acquireLocalLock();
      try {
        return await execute();
      } finally {
        await this.releaseLocalLock(lock);
      }
    };

    const queued = this.mutationQueue.then(run, run);
    this.mutationQueue = queued.then(
      () => undefined,
      () => undefined,
    );
    return queued;
  }

  // --- Queries ---

  findById(id: string): SessionGroup | undefined {
    this.refreshForRead();
    return this.groups.find((g) => g.id === id);
  }

  listByUserId(userId: string): SessionGroup[] {
    this.refreshForRead();
    return this.groups.filter((g) => g.userId === userId);
  }

  listAll(): SessionGroup[] {
    this.refreshForRead();
    return [...this.groups];
  }

  findByCronJobId(cronJobId: string): SessionGroup | undefined {
    this.refreshForRead();
    return this.groups.find((g) => g.kind === 'cron' && g.cronJobId === cronJobId);
  }

  private fingerprintForUser(userId: string): string {
    const snapshot = this.groups
      .filter((group) => group.userId === userId)
      .map((group) => ({
        id: group.id,
        name: group.name,
        kind: group.kind,
        sessionIds: [...group.sessionIds].sort(),
      }))
      .sort((a, b) => a.id.localeCompare(b.id));
    return createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
  }

  getUserSnapshotFingerprint(userId: string): string {
    this.refreshForRead();
    return this.fingerprintForUser(userId);
  }

  // --- Mutations ---

  async create(input: CreateGroupInput): Promise<SessionGroup> {
    return this.mutate(() => {
      const group = this.buildGroup(input);
      this.groups.push(group);
      return { changed: true, value: group };
    });
  }

  /** Batch create: insert multiple groups with a single persist (used by migration) */
  async createBatch(inputs: CreateGroupInput[]): Promise<SessionGroup[]> {
    return this.mutate(() => {
      const results = inputs.map((input) => {
        const group = this.buildGroup(input);
        this.groups.push(group);
        return group;
      });
      return { changed: results.length > 0, value: results };
    });
  }

  /** 智能分组确认后的单次原子写入；永不改变 cron/taskboard 分组。 */
  async applySmartGrouping(input: {
    userId: string;
    expectedFingerprint: string;
    targetSessionIds: string[];
    groups: Array<{ name: string; sessionIds: string[] }>;
  }): Promise<SessionGroup[]> {
    return this.mutate(() => {
      if (this.fingerprintForUser(input.userId) !== input.expectedFingerprint) {
        throw new SmartGroupingConflictError('会话分组已发生变化，请重新生成方案');
      }
      const targets = new Set(input.targetSessionIds);
      const protectedIds = new Set(
        this.groups
          .filter((group) => group.userId === input.userId && group.kind !== 'manual')
          .flatMap((group) => group.sessionIds),
      );
      for (const sessionId of targets) {
        if (protectedIds.has(sessionId)) throw new Error(`系统分组会话不可调整：${sessionId}`);
      }
      const assigned = new Set<string>();
      for (const proposal of input.groups) {
        if (!proposal.name.trim()) throw new Error('智能分组名称不能为空');
        for (const sessionId of proposal.sessionIds) {
          if (!targets.has(sessionId)) throw new Error(`方案包含非目标会话：${sessionId}`);
          if (assigned.has(sessionId)) throw new Error(`方案重复分配会话：${sessionId}`);
          assigned.add(sessionId);
        }
      }

      const now = Date.now();
      for (const group of this.groups) {
        if (group.userId !== input.userId || group.kind !== 'manual') continue;
        const next = group.sessionIds.filter((sessionId) => !targets.has(sessionId));
        if (next.length !== group.sessionIds.length) {
          group.sessionIds = next;
          group.updatedAt = now;
        }
      }

      const changedGroups: SessionGroup[] = [];
      for (const proposal of input.groups) {
        const normalizedName = proposal.name.trim();
        let group = this.groups.find(
          (candidate) =>
            candidate.userId === input.userId &&
            candidate.kind === 'manual' &&
            candidate.name.localeCompare(normalizedName, undefined, { sensitivity: 'accent' }) === 0,
        );
        if (!group) {
          group = this.buildGroup({ userId: input.userId, name: normalizedName, kind: 'manual' });
          this.groups.push(group);
        }
        const existing = new Set(group.sessionIds);
        for (const sessionId of proposal.sessionIds) {
          if (!existing.has(sessionId)) group.sessionIds.push(sessionId);
        }
        group.updatedAt = now;
        changedGroups.push(group);
      }
      return { changed: targets.size > 0, value: changedGroups };
    });
  }

  private buildGroup(input: CreateGroupInput): SessionGroup {
    const now = Date.now();
    const kind = input.kind ?? 'manual';
    const id =
      kind === 'cron' && input.cronJobId
        ? `cron:${input.cronJobId}`
        : kind === 'taskboard' && input.taskboardId
          ? `taskboard:${input.taskboardId}`
          : randomUUID();

    return {
      id,
      userId: input.userId,
      name: input.name.trim(),
      kind,
      ...(input.cronJobId ? { cronJobId: input.cronJobId } : {}),
      ...(input.taskboardId ? { taskboardId: input.taskboardId } : {}),
      sessionIds: input.sessionIds ?? [],
      createdAt: now,
      updatedAt: now,
    };
  }

  async update(id: string, patch: UpdateGroupInput): Promise<SessionGroup | undefined> {
    return this.mutate(() => {
      const group = this.groups.find((candidate) => candidate.id === id);
      if (!group) return { changed: false, value: undefined };

      if (patch.name !== undefined) group.name = patch.name.trim();
      if (patch.sessionIds !== undefined) group.sessionIds = patch.sessionIds;
      group.updatedAt = Date.now();
      return { changed: true, value: group };
    });
  }

  /** Internal update that can also change kind/cronJobId (used for cron detach) */
  async updateInternal(id: string, patch: InternalGroupPatch): Promise<SessionGroup | undefined> {
    return this.mutate(() => {
      const group = this.groups.find((candidate) => candidate.id === id);
      if (!group) return { changed: false, value: undefined };

      if (patch.name !== undefined) group.name = patch.name.trim();
      if (patch.sessionIds !== undefined) group.sessionIds = patch.sessionIds;
      if (patch.kind !== undefined) group.kind = patch.kind;
      if ('cronJobId' in patch) group.cronJobId = patch.cronJobId ?? undefined;
      if ('taskboardId' in patch) group.taskboardId = patch.taskboardId ?? undefined;
      if (patch.userId !== undefined) group.userId = patch.userId;
      group.updatedAt = Date.now();
      return { changed: true, value: group };
    });
  }

  async delete(id: string): Promise<boolean> {
    return this.mutate(() => {
      const index = this.groups.findIndex((g) => g.id === id);
      if (index === -1) return { changed: false, value: false };
      this.groups.splice(index, 1);
      return { changed: true, value: true };
    });
  }

  async deleteByUserIds(userIds: Iterable<string>): Promise<number> {
    const targets = new Set(userIds);
    if (targets.size === 0) return 0;
    return this.mutate(() => {
      const before = this.groups.length;
      this.groups = this.groups.filter((g) => !targets.has(g.userId));
      const deleted = before - this.groups.length;
      return { changed: deleted > 0, value: deleted };
    });
  }

  private addSessionsInMemory(groupId: string, sessionIds: string[], userId: string): SessionGroup | undefined {
    const group = this.groups.find((candidate) => candidate.id === groupId);
    if (!group || group.userId !== userId) return undefined;

    const sessionSet = new Set(sessionIds);
    for (const other of this.groups) {
      if (other.id === groupId || other.userId !== userId) continue;
      const before = other.sessionIds.length;
      other.sessionIds = other.sessionIds.filter((sid) => !sessionSet.has(sid));
      if (other.sessionIds.length !== before) other.updatedAt = Date.now();
    }

    const existing = new Set(group.sessionIds);
    for (const sid of sessionIds) {
      if (!existing.has(sid)) {
        group.sessionIds.push(sid);
        existing.add(sid);
      }
    }
    group.updatedAt = Date.now();
    return group;
  }

  /**
   * Add sessions to a group.
   * Enforces single-group membership: removes these sessions from other groups of the same user first.
   */
  async addSessions(groupId: string, sessionIds: string[], userId: string): Promise<SessionGroup | undefined> {
    return this.mutate(() => {
      const group = this.addSessionsInMemory(groupId, sessionIds, userId);
      return { changed: !!group, value: group };
    });
  }

  /** Cron 创建会话后的原子 upsert，避免 find→create/add 跨进程竞态。 */
  async addCronSession(input: {
    jobId: string;
    jobName: string;
    sessionId: string;
    owner?: string;
  }): Promise<SessionGroup | undefined> {
    return this.mutate(() => {
      let group = this.groups.find((candidate) => candidate.kind === 'cron' && candidate.cronJobId === input.jobId);

      if (!group) {
        if (!input.owner) return { changed: false, value: undefined };
        group = this.buildGroup({
          name: input.jobName,
          kind: 'cron',
          cronJobId: input.jobId,
          sessionIds: [],
          userId: input.owner,
        });
        this.groups.push(group);
      } else if (group.name !== input.jobName.trim()) {
        group.name = input.jobName.trim();
      }

      const updated = this.addSessionsInMemory(group.id, [input.sessionId], group.userId);
      return { changed: !!updated, value: updated };
    });
  }

  /** Taskboard 会话创建后的原子 upsert；同一看板的所有任务会话共享一个系统分组。 */
  async addTaskboardSession(input: {
    boardId: string;
    boardName: string;
    sessionId: string;
    owner: string;
  }): Promise<SessionGroup> {
    return this.mutate(() => {
      let group = this.groups.find(
        (candidate) => candidate.kind === 'taskboard' && candidate.taskboardId === input.boardId,
      );

      if (!group) {
        group = this.buildGroup({
          name: input.boardName,
          kind: 'taskboard',
          taskboardId: input.boardId,
          sessionIds: [],
          userId: input.owner,
        });
        this.groups.push(group);
      } else if (group.name !== input.boardName.trim()) {
        group.name = input.boardName.trim();
      }

      const updated = this.addSessionsInMemory(group.id, [input.sessionId], group.userId);
      return { changed: true, value: updated ?? group };
    });
  }

  async removeSessions(groupId: string, sessionIds: string[]): Promise<SessionGroup | undefined> {
    return this.mutate(() => {
      const group = this.groups.find((candidate) => candidate.id === groupId);
      if (!group) return { changed: false, value: undefined };

      const removeSet = new Set(sessionIds);
      group.sessionIds = group.sessionIds.filter((sid) => !removeSet.has(sid));
      group.updatedAt = Date.now();
      return { changed: true, value: group };
    });
  }

  /** Remove a session from all groups (called when a session is deleted) */
  async removeSessionFromAllGroups(sessionId: string): Promise<void> {
    await this.mutate(() => {
      let changed = false;
      for (const group of this.groups) {
        const before = group.sessionIds.length;
        group.sessionIds = group.sessionIds.filter((sid) => sid !== sessionId);
        if (group.sessionIds.length !== before) {
          group.updatedAt = Date.now();
          changed = true;
        }
      }
      return { changed, value: undefined };
    });
  }

  /**
   * Startup cleanup: remove sessionIds whose transcripts no longer exist.
   * Runs once at boot to catch orphans from manual deletions or pre-groups-era removals.
   */
  async pruneOrphanedSessionIds(sessionExists: SessionExistsChecker): Promise<number> {
    const allIds = new Set<string>();
    for (const group of this.listAll()) {
      for (const sid of group.sessionIds) allIds.add(sid);
    }
    if (allIds.size === 0) return 0;

    const dead = new Set<string>();
    const entries = [...allIds];
    const BATCH = 50;
    for (let i = 0; i < entries.length; i += BATCH) {
      const batch = entries.slice(i, i + BATCH);
      const results = await Promise.all(batch.map(async (sid) => ({ sid, exists: await sessionExists(sid) })));
      for (const result of results) {
        if (!result.exists) dead.add(result.sid);
      }
    }
    if (dead.size === 0) return 0;

    return this.mutate(() => {
      let removed = 0;
      for (const group of this.groups) {
        const before = group.sessionIds.length;
        group.sessionIds = group.sessionIds.filter((sid) => !dead.has(sid));
        const groupRemoved = before - group.sessionIds.length;
        if (groupRemoved > 0) {
          group.updatedAt = Date.now();
          removed += groupRemoved;
        }
      }
      return { changed: removed > 0, value: removed > 0 ? dead.size : 0 };
    });
  }
}
