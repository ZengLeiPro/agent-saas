import { randomUUID } from 'node:crypto';

import type { Pool } from 'pg';

import type {
  SkillMaterializationBatch,
  SkillMaterializationBatchStatus,
  SkillMaterializationRequest,
  SkillMaterializationResult,
  SkillMaterializationStore,
  SkillMaterializationTask,
} from './types.js';

function nowIso(): string {
  return new Date().toISOString();
}

function batchStatus(counts: {
  total: number;
  queued: number;
  running: number;
  succeeded: number;
  failed: number;
}): SkillMaterializationBatchStatus {
  if (counts.total === 0 || counts.succeeded === counts.total) return 'succeeded';
  if (counts.failed === counts.total) return 'failed';
  if (counts.succeeded + counts.failed === counts.total) return 'partial';
  if (counts.running > 0 || counts.succeeded > 0 || counts.failed > 0) return 'running';
  return 'queued';
}

export class InMemorySkillMaterializationStore implements SkillMaterializationStore {
  private readonly batches = new Map<string, { createdAt: string; taskIds: string[]; tenantIds: string[] }>();
  private readonly tasks = new Map<string, SkillMaterializationTask & { leaseOwner?: string; leaseExpiresAt?: number }>();
  private readonly workspaceLocks = new Map<string, Promise<void>>();

  async init(): Promise<void> {}

  async enqueueBatch(input: {
    requests: Array<SkillMaterializationRequest & {
      requestKey: string;
      sourceRevision: string;
    }>;
  }): Promise<SkillMaterializationBatch> {
    const batchId = randomUUID();
    const createdAt = nowIso();
    const taskIds: string[] = [];
    for (const request of input.requests) {
      const task: SkillMaterializationTask = {
        id: randomUUID(),
        batchId,
        requestKey: request.requestKey,
        sourceRevision: request.sourceRevision,
        user: request.user,
        userCwd: request.userCwd,
        reason: request.reason,
        priority: request.priority ?? 50,
        requiredSkillIds: [...new Set(request.requiredSkillIds ?? [])].sort(),
        force: request.force === true,
        status: 'queued',
        attempts: 0,
        changedSkills: 0,
        skippedSkills: 0,
        removedSkills: 0,
        createdAt,
      };
      this.tasks.set(task.id, task);
      taskIds.push(task.id);
    }
    this.batches.set(batchId, {
      createdAt,
      taskIds,
      tenantIds: [...new Set(input.requests.map((request) => request.user.tenantId).filter((id): id is string => !!id))],
    });
    return (await this.getBatch(batchId))!;
  }

  async getBatch(batchId: string): Promise<SkillMaterializationBatch | null> {
    const batch = this.batches.get(batchId);
    if (!batch) return null;
    const tasks = batch.taskIds.map((id) => this.tasks.get(id)!).filter(Boolean);
    const counts = {
      total: tasks.length,
      queued: tasks.filter((task) => task.status === 'queued').length,
      running: tasks.filter((task) => task.status === 'running').length,
      succeeded: tasks.filter((task) => task.status === 'succeeded').length,
      failed: tasks.filter((task) => task.status === 'failed').length,
    };
    const status = batchStatus(counts);
    return {
      id: batchId,
      tenantIds: [...batch.tenantIds],
      status,
      ...counts,
      changedSkills: tasks.reduce((sum, task) => sum + task.changedSkills, 0),
      skippedSkills: tasks.reduce((sum, task) => sum + task.skippedSkills, 0),
      removedSkills: tasks.reduce((sum, task) => sum + task.removedSkills, 0),
      createdAt: batch.createdAt,
      startedAt: tasks.map((task) => task.startedAt).filter(Boolean).sort()[0],
      finishedAt: status === 'succeeded' || status === 'partial' || status === 'failed'
        ? tasks.map((task) => task.finishedAt).filter(Boolean).sort().at(-1)
        : undefined,
      error: tasks.find((task) => task.error)?.error,
    };
  }

  async getTask(taskId: string): Promise<SkillMaterializationTask | null> {
    const task = this.tasks.get(taskId);
    if (!task) return null;
    const { leaseOwner: _leaseOwner, leaseExpiresAt: _leaseExpiresAt, ...publicTask } = task;
    return { ...publicTask };
  }

  async claimNext(
    workerId: string,
    leaseSeconds: number,
    sourceRevision: string,
  ): Promise<SkillMaterializationTask | null> {
    await this.releaseExpiredLeases();
    const task = [...this.tasks.values()]
      .filter((candidate) => (
        candidate.status === 'queued'
        && candidate.sourceRevision === sourceRevision
      ))
      .sort((a, b) => b.priority - a.priority || a.createdAt.localeCompare(b.createdAt))[0];
    if (!task) return null;
    task.status = 'running';
    task.attempts++;
    task.startedAt ??= nowIso();
    task.leaseOwner = workerId;
    task.leaseExpiresAt = Date.now() + leaseSeconds * 1_000;
    return this.getTask(task.id);
  }

  async runExclusive<T>(workspaceKey: string, work: () => Promise<T>): Promise<T> {
    const previous = this.workspaceLocks.get(workspaceKey) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.workspaceLocks.set(workspaceKey, current);
    await previous;
    try {
      return await work();
    } finally {
      release();
      if (this.workspaceLocks.get(workspaceKey) === current) {
        this.workspaceLocks.delete(workspaceKey);
      }
    }
  }

  async markSucceeded(
    taskId: string,
    workerId: string,
    result: SkillMaterializationResult,
  ): Promise<void> {
    const task = this.tasks.get(taskId);
    if (!task || task.leaseOwner !== workerId) return;
    Object.assign(task, result, {
      status: 'succeeded',
      finishedAt: nowIso(),
      leaseOwner: undefined,
      leaseExpiresAt: undefined,
      error: undefined,
    });
  }

  async markFailed(taskId: string, workerId: string, error: string): Promise<void> {
    const task = this.tasks.get(taskId);
    if (!task || task.leaseOwner !== workerId) return;
    Object.assign(task, {
      status: 'failed',
      finishedAt: nowIso(),
      leaseOwner: undefined,
      leaseExpiresAt: undefined,
      error,
    });
  }

  async releaseExpiredLeases(): Promise<number> {
    let released = 0;
    for (const task of this.tasks.values()) {
      if (task.status === 'running' && (task.leaseExpiresAt ?? 0) <= Date.now()) {
        task.status = 'queued';
        task.leaseOwner = undefined;
        task.leaseExpiresAt = undefined;
        released++;
      }
    }
    return released;
  }

  async close(): Promise<void> {}
}

interface PgSkillMaterializationStoreOptions {
  pool: Pool;
  tablePrefix?: string;
}

interface TaskRow {
  id: string;
  batch_id: string;
  request_key: string;
  source_revision: string;
  user_id: string;
  username: string;
  tenant_id: string | null;
  user_role: 'admin' | 'user';
  user_cwd: string;
  reason: SkillMaterializationTask['reason'];
  priority: number;
  required_skill_ids: unknown;
  force: boolean;
  status: SkillMaterializationTask['status'];
  attempts: number;
  changed_skills: number;
  skipped_skills: number;
  removed_skills: number;
  error: string | null;
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
}

function mapTask(row: TaskRow): SkillMaterializationTask {
  return {
    id: row.id,
    batchId: row.batch_id,
    requestKey: row.request_key,
    sourceRevision: row.source_revision,
    user: {
      id: row.user_id,
      username: row.username,
      role: row.user_role,
      ...(row.tenant_id ? { tenantId: row.tenant_id } : {}),
    },
    userCwd: row.user_cwd,
    reason: row.reason,
    priority: row.priority,
    requiredSkillIds: Array.isArray(row.required_skill_ids)
      ? row.required_skill_ids.filter((value): value is string => typeof value === 'string')
      : [],
    force: row.force,
    status: row.status,
    attempts: row.attempts,
    changedSkills: row.changed_skills,
    skippedSkills: row.skipped_skills,
    removedSkills: row.removed_skills,
    ...(row.error ? { error: row.error } : {}),
    createdAt: row.created_at.toISOString(),
    ...(row.started_at ? { startedAt: row.started_at.toISOString() } : {}),
    ...(row.finished_at ? { finishedAt: row.finished_at.toISOString() } : {}),
  };
}

export class PgSkillMaterializationStore implements SkillMaterializationStore {
  private readonly prefix: string;
  private readonly batchesTable: string;
  private readonly tasksTable: string;

  constructor(private readonly options: PgSkillMaterializationStoreOptions) {
    this.prefix = options.tablePrefix ?? 'agent_runtime';
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(this.prefix)) {
      throw new Error(`Invalid skill materialization table prefix: ${this.prefix}`);
    }
    this.batchesTable = `${this.prefix}_skill_materialization_batches`;
    this.tasksTable = `${this.prefix}_skill_materialization_tasks`;
  }

  async init(): Promise<void> {
    const client = await this.options.pool.connect();
    const lockName = `${this.tasksTable}:init`;
    try {
      await client.query('SELECT pg_advisory_lock(hashtext($1))', [lockName]);
      await client.query(`
        CREATE TABLE IF NOT EXISTS ${this.batchesTable} (
          id UUID PRIMARY KEY,
          tenant_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await client.query(`
        ALTER TABLE ${this.batchesTable}
        ADD COLUMN IF NOT EXISTS tenant_ids JSONB NOT NULL DEFAULT '[]'::jsonb
      `);
      await client.query(`
        CREATE TABLE IF NOT EXISTS ${this.tasksTable} (
          id UUID PRIMARY KEY,
          batch_id UUID NOT NULL REFERENCES ${this.batchesTable}(id) ON DELETE CASCADE,
          request_key TEXT NOT NULL,
          source_revision TEXT NOT NULL DEFAULT 'legacy',
          user_id TEXT NOT NULL,
          username TEXT NOT NULL,
          tenant_id TEXT,
          user_role TEXT NOT NULL,
          user_cwd TEXT NOT NULL,
          reason TEXT NOT NULL,
          priority INTEGER NOT NULL DEFAULT 50,
          required_skill_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
          force BOOLEAN NOT NULL DEFAULT FALSE,
          status TEXT NOT NULL DEFAULT 'queued',
          attempts INTEGER NOT NULL DEFAULT 0,
          changed_skills INTEGER NOT NULL DEFAULT 0,
          skipped_skills INTEGER NOT NULL DEFAULT 0,
          removed_skills INTEGER NOT NULL DEFAULT 0,
          error TEXT,
          lease_owner TEXT,
          lease_expires_at TIMESTAMPTZ,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          started_at TIMESTAMPTZ,
          finished_at TIMESTAMPTZ
        )
      `);
      await client.query(`
        ALTER TABLE ${this.tasksTable}
        ADD COLUMN IF NOT EXISTS force BOOLEAN NOT NULL DEFAULT FALSE
      `);
      await client.query(`
        ALTER TABLE ${this.tasksTable}
        ADD COLUMN IF NOT EXISTS source_revision TEXT NOT NULL DEFAULT 'legacy'
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS ${this.tasksTable}_claim_v2_idx
        ON ${this.tasksTable} (source_revision, status, priority DESC, created_at ASC)
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS ${this.tasksTable}_batch_idx
        ON ${this.tasksTable} (batch_id, status)
      `);
    } finally {
      await client.query('SELECT pg_advisory_unlock(hashtext($1))', [lockName]).catch(() => undefined);
      client.release();
    }
  }

  async enqueueBatch(input: {
    requests: Array<SkillMaterializationRequest & {
      requestKey: string;
      sourceRevision: string;
    }>;
  }): Promise<SkillMaterializationBatch> {
    const batchId = randomUUID();
    const client = await this.options.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO ${this.batchesTable} (id, tenant_ids) VALUES ($1, $2::jsonb)`,
        [
          batchId,
          JSON.stringify([
            ...new Set(input.requests.map((request) => request.user.tenantId).filter((id): id is string => !!id)),
          ]),
        ],
      );
      for (const request of input.requests) {
        await client.query(
          `INSERT INTO ${this.tasksTable}
             (id, batch_id, request_key, source_revision, user_id, username, tenant_id,
              user_role, user_cwd, reason, priority, required_skill_ids, force)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13)`,
          [
            randomUUID(),
            batchId,
            request.requestKey,
            request.sourceRevision,
            request.user.id,
            request.user.username,
            request.user.tenantId ?? null,
            request.user.role,
            request.userCwd,
            request.reason,
            request.priority ?? 50,
            JSON.stringify([...new Set(request.requiredSkillIds ?? [])].sort()),
            request.force === true,
          ],
        );
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
    return (await this.getBatch(batchId))!;
  }

  async getBatch(batchId: string): Promise<SkillMaterializationBatch | null> {
    const result = await this.options.pool.query<{
      id: string;
      tenant_ids: unknown;
      created_at: Date;
      total: string;
      queued: string;
      running: string;
      succeeded: string;
      failed: string;
      changed_skills: string;
      skipped_skills: string;
      removed_skills: string;
      started_at: Date | null;
      finished_at: Date | null;
      error: string | null;
    }>(
      `SELECT b.id, b.tenant_ids, b.created_at,
              COUNT(t.id) AS total,
              COUNT(*) FILTER (WHERE t.status = 'queued') AS queued,
              COUNT(*) FILTER (WHERE t.status = 'running') AS running,
              COUNT(*) FILTER (WHERE t.status = 'succeeded') AS succeeded,
              COUNT(*) FILTER (WHERE t.status = 'failed') AS failed,
              COALESCE(SUM(t.changed_skills), 0) AS changed_skills,
              COALESCE(SUM(t.skipped_skills), 0) AS skipped_skills,
              COALESCE(SUM(t.removed_skills), 0) AS removed_skills,
              MIN(t.started_at) AS started_at,
              MAX(t.finished_at) AS finished_at,
              MAX(t.error) FILTER (WHERE t.error IS NOT NULL) AS error
       FROM ${this.batchesTable} b
       LEFT JOIN ${this.tasksTable} t ON t.batch_id = b.id
       WHERE b.id = $1
       GROUP BY b.id, b.tenant_ids, b.created_at`,
      [batchId],
    );
    const row = result.rows[0];
    if (!row) return null;
    const counts = {
      total: Number(row.total),
      queued: Number(row.queued),
      running: Number(row.running),
      succeeded: Number(row.succeeded),
      failed: Number(row.failed),
    };
    const status = batchStatus(counts);
    return {
      id: row.id,
      tenantIds: Array.isArray(row.tenant_ids)
        ? row.tenant_ids.filter((value): value is string => typeof value === 'string')
        : [],
      status,
      ...counts,
      changedSkills: Number(row.changed_skills),
      skippedSkills: Number(row.skipped_skills),
      removedSkills: Number(row.removed_skills),
      createdAt: row.created_at.toISOString(),
      ...(row.started_at ? { startedAt: row.started_at.toISOString() } : {}),
      ...(status === 'succeeded' || status === 'partial' || status === 'failed') && row.finished_at
        ? { finishedAt: row.finished_at.toISOString() }
        : {},
      ...(row.error ? { error: row.error } : {}),
    };
  }

  async getTask(taskId: string): Promise<SkillMaterializationTask | null> {
    const result = await this.options.pool.query<TaskRow>(
      `SELECT * FROM ${this.tasksTable} WHERE id = $1`,
      [taskId],
    );
    return result.rows[0] ? mapTask(result.rows[0]) : null;
  }

  async claimNext(
    workerId: string,
    leaseSeconds: number,
    sourceRevision: string,
  ): Promise<SkillMaterializationTask | null> {
    const client = await this.options.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query<TaskRow>(
        `SELECT * FROM ${this.tasksTable}
         WHERE source_revision = $1
           AND (
             status = 'queued'
             OR (status = 'running' AND lease_expires_at < NOW())
           )
         ORDER BY priority DESC, created_at ASC
         LIMIT 1
         FOR UPDATE SKIP LOCKED`,
        [sourceRevision],
      );
      const row = result.rows[0];
      if (!row) {
        await client.query('COMMIT');
        return null;
      }
      const updated = await client.query<TaskRow>(
        `UPDATE ${this.tasksTable}
         SET status = 'running',
             attempts = attempts + 1,
             lease_owner = $2,
             lease_expires_at = NOW() + make_interval(secs => $3),
             started_at = COALESCE(started_at, NOW()),
             finished_at = NULL,
             error = NULL
         WHERE id = $1
         RETURNING *`,
        [row.id, workerId, leaseSeconds],
      );
      await client.query('COMMIT');
      return mapTask(updated.rows[0]!);
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async runExclusive<T>(workspaceKey: string, work: () => Promise<T>): Promise<T> {
    const client = await this.options.pool.connect();
    const lockName = `${this.tasksTable}:workspace:${workspaceKey}`;
    try {
      await client.query('SELECT pg_advisory_lock(hashtext($1)::bigint)', [lockName]);
      return await work();
    } finally {
      await client.query('SELECT pg_advisory_unlock(hashtext($1)::bigint)', [lockName])
        .catch(() => undefined);
      client.release();
    }
  }

  async markSucceeded(
    taskId: string,
    workerId: string,
    result: SkillMaterializationResult,
  ): Promise<void> {
    await this.options.pool.query(
      `UPDATE ${this.tasksTable}
       SET status = 'succeeded',
           changed_skills = $3,
           skipped_skills = $4,
           removed_skills = $5,
           error = NULL,
           lease_owner = NULL,
           lease_expires_at = NULL,
           finished_at = NOW()
       WHERE id = $1 AND lease_owner = $2`,
      [taskId, workerId, result.changedSkills, result.skippedSkills, result.removedSkills],
    );
  }

  async markFailed(taskId: string, workerId: string, error: string): Promise<void> {
    await this.options.pool.query(
      `UPDATE ${this.tasksTable}
       SET status = 'failed',
           error = $3,
           lease_owner = NULL,
           lease_expires_at = NULL,
           finished_at = NOW()
       WHERE id = $1 AND lease_owner = $2`,
      [taskId, workerId, error.slice(0, 4_000)],
    );
  }

  async releaseExpiredLeases(): Promise<number> {
    const result = await this.options.pool.query(
      `UPDATE ${this.tasksTable}
       SET status = 'queued', lease_owner = NULL, lease_expires_at = NULL
       WHERE status = 'running' AND lease_expires_at < NOW()`,
    );
    return result.rowCount ?? 0;
  }

  async close(): Promise<void> {
    // 复用 PgEventStore 的共享 Pool，生命周期由 AppRuntime 统一管理。
  }
}
