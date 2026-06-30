import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { writeFile, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import type {
  SessionGroup,
  GroupsStoreFile,
  CreateGroupInput,
  UpdateGroupInput,
  InternalGroupPatch,
} from './types.js';

/** Callback to check whether a session transcript still exists */
export type SessionExistsChecker = (sessionId: string) => Promise<boolean>;

export class GroupStore {
  private groups: SessionGroup[] = [];
  private filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
    this.load();
  }

  private load(): void {
    if (!existsSync(this.filePath)) {
      mkdirSync(dirname(this.filePath), { recursive: true });
      this.groups = [];
      return;
    }
    try {
      const raw = readFileSync(this.filePath, 'utf-8');
      const data: GroupsStoreFile = JSON.parse(raw);
      this.groups = data.groups || [];
    } catch {
      this.groups = [];
    }
  }

  private async persist(): Promise<void> {
    const data: GroupsStoreFile = { version: 1, groups: this.groups };
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.tmp`;
    await writeFile(tempPath, JSON.stringify(data, null, 2));
    await rename(tempPath, this.filePath);
  }

  // --- Queries ---

  findById(id: string): SessionGroup | undefined {
    return this.groups.find(g => g.id === id);
  }

  listByUserId(userId: string): SessionGroup[] {
    return this.groups.filter(g => g.userId === userId);
  }

  listAll(): SessionGroup[] {
    return [...this.groups];
  }

  findByCronJobId(cronJobId: string): SessionGroup | undefined {
    return this.groups.find(g => g.kind === 'cron' && g.cronJobId === cronJobId);
  }

  // --- Mutations ---

  async create(input: CreateGroupInput): Promise<SessionGroup> {
    const group = this.buildGroup(input);
    this.groups.push(group);
    await this.persist();
    return group;
  }

  /** Batch create: insert multiple groups with a single persist (used by migration) */
  async createBatch(inputs: CreateGroupInput[]): Promise<SessionGroup[]> {
    const results = inputs.map(input => {
      const group = this.buildGroup(input);
      this.groups.push(group);
      return group;
    });
    if (results.length > 0) {
      await this.persist();
    }
    return results;
  }

  private buildGroup(input: CreateGroupInput): SessionGroup {
    const now = Date.now();
    const kind = input.kind ?? 'manual';
    const id = kind === 'cron' && input.cronJobId
      ? `cron:${input.cronJobId}`
      : randomUUID();

    return {
      id,
      userId: input.userId,
      name: input.name.trim(),
      kind,
      ...(input.cronJobId ? { cronJobId: input.cronJobId } : {}),
      sessionIds: input.sessionIds ?? [],
      createdAt: now,
      updatedAt: now,
    };
  }

  async update(id: string, patch: UpdateGroupInput): Promise<SessionGroup | undefined> {
    const group = this.findById(id);
    if (!group) return undefined;

    if (patch.name !== undefined) group.name = patch.name.trim();
    if (patch.sessionIds !== undefined) group.sessionIds = patch.sessionIds;
    group.updatedAt = Date.now();

    await this.persist();
    return group;
  }

  /** Internal update that can also change kind/cronJobId (used for cron detach) */
  async updateInternal(id: string, patch: InternalGroupPatch): Promise<SessionGroup | undefined> {
    const group = this.findById(id);
    if (!group) return undefined;

    if (patch.name !== undefined) group.name = patch.name.trim();
    if (patch.sessionIds !== undefined) group.sessionIds = patch.sessionIds;
    if (patch.kind !== undefined) group.kind = patch.kind;
    if ('cronJobId' in patch) group.cronJobId = patch.cronJobId ?? undefined;
    if (patch.userId !== undefined) group.userId = patch.userId;
    group.updatedAt = Date.now();

    await this.persist();
    return group;
  }

  async delete(id: string): Promise<boolean> {
    const index = this.groups.findIndex(g => g.id === id);
    if (index === -1) return false;
    this.groups.splice(index, 1);
    await this.persist();
    return true;
  }

  /**
   * Add sessions to a group.
   * Enforces single-group membership: removes these sessions from other groups of the same user first.
   */
  async addSessions(groupId: string, sessionIds: string[], userId: string): Promise<SessionGroup | undefined> {
    const group = this.findById(groupId);
    if (!group) return undefined;
    if (group.userId !== userId) return undefined;

    // Remove from other groups of this user
    const sessionSet = new Set(sessionIds);
    for (const other of this.groups) {
      if (other.id === groupId || other.userId !== userId) continue;
      const before = other.sessionIds.length;
      other.sessionIds = other.sessionIds.filter(sid => !sessionSet.has(sid));
      if (other.sessionIds.length !== before) {
        other.updatedAt = Date.now();
      }
    }

    // Add to target group (avoid duplicates)
    const existing = new Set(group.sessionIds);
    for (const sid of sessionIds) {
      if (!existing.has(sid)) {
        group.sessionIds.push(sid);
      }
    }
    group.updatedAt = Date.now();

    await this.persist();
    return group;
  }

  async removeSessions(groupId: string, sessionIds: string[]): Promise<SessionGroup | undefined> {
    const group = this.findById(groupId);
    if (!group) return undefined;

    const removeSet = new Set(sessionIds);
    group.sessionIds = group.sessionIds.filter(sid => !removeSet.has(sid));
    group.updatedAt = Date.now();

    await this.persist();
    return group;
  }

  /** Remove a session from all groups (called when a session is deleted) */
  async removeSessionFromAllGroups(sessionId: string): Promise<void> {
    let changed = false;
    for (const group of this.groups) {
      const before = group.sessionIds.length;
      group.sessionIds = group.sessionIds.filter(sid => sid !== sessionId);
      if (group.sessionIds.length !== before) {
        group.updatedAt = Date.now();
        changed = true;
      }
    }
    if (changed) {
      await this.persist();
    }
  }

  /**
   * Startup cleanup: remove sessionIds whose transcripts no longer exist.
   * Runs once at boot to catch orphans from manual deletions or pre-groups-era removals.
   */
  async pruneOrphanedSessionIds(sessionExists: SessionExistsChecker): Promise<number> {
    // Collect all unique sessionIds across groups
    const allIds = new Set<string>();
    for (const group of this.groups) {
      for (const sid of group.sessionIds) allIds.add(sid);
    }
    if (allIds.size === 0) return 0;

    // Check existence in parallel (batched)
    const dead = new Set<string>();
    const entries = [...allIds];
    const BATCH = 50;
    for (let i = 0; i < entries.length; i += BATCH) {
      const batch = entries.slice(i, i + BATCH);
      const results = await Promise.all(batch.map(async sid => ({ sid, exists: await sessionExists(sid) })));
      for (const r of results) {
        if (!r.exists) dead.add(r.sid);
      }
    }
    if (dead.size === 0) return 0;

    // Remove dead sessionIds from all groups
    for (const group of this.groups) {
      const before = group.sessionIds.length;
      group.sessionIds = group.sessionIds.filter(sid => !dead.has(sid));
      if (group.sessionIds.length !== before) {
        group.updatedAt = Date.now();
      }
    }
    await this.persist();
    return dead.size;
  }
}
