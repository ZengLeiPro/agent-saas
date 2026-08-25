import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';

import { PgGovernanceMigrationRunner, governanceTablePrefix, type GovernancePgPool } from '../governance-schema/index.js';
import { governanceDigest } from '../governance-audit/index.js';
import {
  GovernanceChangeJobInvariantError,
  type GovernanceChangeJob,
  type GovernanceChangeJobDomain,
  type GovernanceChangeJobType,
} from './types.js';

const FORBIDDEN_KEYS = new Set([
  'secret', 'secretref', 'password', 'token', 'accesstoken', 'apikey', 'clientsecret',
  'credentialvalue', 'messagetext', 'messagebody', 'rawparams', 'rawparameters',
]);

function normalizedKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

export function assertChangeJobRequestSafe(value: unknown): void {
  if (Array.isArray(value)) {
    value.forEach(assertChangeJobRequestSafe);
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_KEYS.has(normalizedKey(key))) {
      throw new GovernanceChangeJobInvariantError('CHANGE_JOB_REQUEST_SENSITIVE');
    }
    assertChangeJobRequestSafe(child);
  }
}

function rowToJob(row: Record<string, unknown>): GovernanceChangeJob {
  return {
    jobId: String(row.job_id), tenantId: String(row.tenant_id),
    jobType: row.job_type as GovernanceChangeJobType, targetType: String(row.target_type), targetId: String(row.target_id),
    idempotencyKey: String(row.idempotency_key), request: row.request_json as Record<string, unknown>,
    status: row.status as GovernanceChangeJob['status'], revision: Number(row.revision), attempt: Number(row.attempt),
    maxAttempts: Number(row.max_attempts ?? 5),
    ...(row.last_error_code ? { lastErrorCode: String(row.last_error_code) } : {}),
    ...(row.next_retry_at ? { nextRetryAt: row.next_retry_at instanceof Date ? row.next_retry_at.toISOString() : String(row.next_retry_at) } : {}),
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    createdBy: String(row.created_by),
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
    updatedBy: String(row.updated_by),
    ...(row.completed_at ? { completedAt: row.completed_at instanceof Date ? row.completed_at.toISOString() : String(row.completed_at) } : {}),
  };
}

function rowToDomain(row: Record<string, unknown>): GovernanceChangeJobDomain {
  const unresolved = Array.isArray(row.unresolved_items_json) ? row.unresolved_items_json : [];
  return {
    jobId: String(row.job_id), domain: String(row.domain),
    ...(row.ordinal !== undefined && row.ordinal !== null ? { ordinal: Number(row.ordinal) } : {}),
    status: row.status as GovernanceChangeJobDomain['status'], totalCount: Number(row.total_count), completedCount: Number(row.completed_count), failedCount: Number(row.failed_count),
    unresolvedItems: unresolved.map(item => ({
      itemType: String((item as Record<string, unknown>).itemType),
      itemId: String((item as Record<string, unknown>).itemId),
      reasonCode: String((item as Record<string, unknown>).reasonCode),
      retryable: (item as Record<string, unknown>).retryable === true,
    })),
    ...(row.receipt_json && typeof row.receipt_json === 'object'
      ? { receipt: row.receipt_json as Record<string, unknown> } : {}),
    revision: Number(row.revision),
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
    ...(row.last_error_code ? { lastErrorCode: String(row.last_error_code) } : {}),
  };
}

export class PgGovernanceChangeJobStore {
  readonly jobsTable: string;
  readonly domainsTable: string;
  private readonly tablePrefix?: string;

  constructor(private readonly options: { pool: GovernancePgPool; tablePrefix?: string }) {
    const prefix = governanceTablePrefix(options.tablePrefix);
    this.tablePrefix = options.tablePrefix;
    this.jobsTable = `${prefix}_governance_change_jobs`;
    this.domainsTable = `${prefix}_governance_change_job_domains`;
  }

  async init(): Promise<void> {
    await new PgGovernanceMigrationRunner(this.options.pool, this.tablePrefix).run();
  }

  async findByIdempotency(
    tenantId: string,
    jobType: GovernanceChangeJob['jobType'],
    idempotencyKey: string,
  ): Promise<GovernanceChangeJob | null> {
    const result = await this.options.pool.query(
      `SELECT * FROM ${this.jobsTable} WHERE tenant_id=$1 AND job_type=$2 AND idempotency_key=$3`,
      [tenantId, jobType, idempotencyKey],
    );
    return result.rows[0] ? rowToJob(result.rows[0]) : null;
  }

  async get(tenantId: string, jobId: string): Promise<GovernanceChangeJob | null> {
    const result = await this.options.pool.query(
      `SELECT * FROM ${this.jobsTable} WHERE tenant_id=$1 AND job_id=$2`, [tenantId, jobId],
    );
    return result.rows[0] ? rowToJob(result.rows[0]) : null;
  }

  async listDue(
    jobType: GovernanceChangeJobType,
    limit = 25,
    expiredRunningLeaseMs?: number,
  ): Promise<GovernanceChangeJob[]> {
    const safeLimit = Math.max(1, Math.min(100, Math.trunc(limit)));
    const safeLeaseMs = expiredRunningLeaseMs === undefined
      ? null
      : Math.max(1, Math.trunc(expiredRunningLeaseMs));
    const result = await this.options.pool.query(
      `SELECT * FROM ${this.jobsTable}
       WHERE job_type=$1 AND (
         status='pending'
         OR (status='retry_wait' AND next_retry_at<=NOW())
         OR ($3::bigint IS NOT NULL AND status='running'
           AND updated_at < NOW() - ($3 * INTERVAL '1 millisecond'))
       )
       ORDER BY COALESCE(next_retry_at,created_at),created_at LIMIT $2`,
      [jobType, safeLimit, safeLeaseMs],
    );
    return result.rows.map(rowToJob);
  }

  async findActiveForTarget(
    tenantId: string,
    jobType: GovernanceChangeJobType,
    targetType: string,
    targetId: string,
  ): Promise<GovernanceChangeJob | null> {
    const result = await this.options.pool.query(
      `SELECT * FROM ${this.jobsTable}
       WHERE tenant_id=$1 AND job_type=$2 AND target_type=$3 AND target_id=$4
         AND status IN ('pending','running','retry_wait')
       ORDER BY created_at LIMIT 1`,
      [tenantId, jobType, targetType, targetId],
    );
    return result.rows[0] ? rowToJob(result.rows[0]) : null;
  }

  async listDomains(tenantId: string, jobId: string): Promise<GovernanceChangeJobDomain[]> {
    const result = await this.options.pool.query(`
      SELECT d.* FROM ${this.domainsTable} d
      JOIN ${this.jobsTable} j ON j.job_id=d.job_id
      WHERE j.tenant_id=$1 AND d.job_id=$2 ORDER BY d.ordinal, d.domain
    `, [tenantId, jobId]);
    return result.rows.map(rowToDomain);
  }

  async create(input: {
    tenantId: string;
    jobType: GovernanceChangeJobType;
    targetType: string;
    targetId: string;
    idempotencyKey: string;
    request?: Record<string, unknown>;
    domains: string[];
    maxAttempts?: number;
    createdBy: string;
  }): Promise<{ job: GovernanceChangeJob; domains: GovernanceChangeJobDomain[]; created: boolean }> {
    const maxAttempts = input.maxAttempts ?? 5;
    if (!input.tenantId.trim() || !input.targetType.trim() || !input.targetId.trim()
      || !input.idempotencyKey.trim() || input.domains.length === 0 || input.domains.some(domain => !domain.trim())
      || !Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 100) {
      throw new GovernanceChangeJobInvariantError('CHANGE_JOB_INVALID');
    }
    assertChangeJobRequestSafe(input.request ?? {});
    return this.withTransaction(async client => {
      const jobId = `chg-${randomUUID()}`;
      const inserted = await client.query(`
        INSERT INTO ${this.jobsTable} (
          job_id,tenant_id,job_type,target_type,target_id,idempotency_key,request_json,status,
          max_attempts,created_by,updated_by
        ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,'pending',$9,$8,$8)
        ON CONFLICT DO NOTHING RETURNING *
      `, [
        jobId, input.tenantId, input.jobType, input.targetType, input.targetId,
        input.idempotencyKey, JSON.stringify(input.request ?? {}), input.createdBy, maxAttempts,
      ]);
      let job: GovernanceChangeJob;
      let created = false;
      if (inserted.rows[0]) {
        job = rowToJob(inserted.rows[0]);
        created = true;
        for (const [ordinal, domain] of [...new Set(input.domains)].entries()) {
          await client.query(`
            INSERT INTO ${this.domainsTable} (job_id,domain,ordinal,status)
            VALUES ($1,$2,$3,'pending') ON CONFLICT DO NOTHING
          `, [job.jobId, domain, ordinal + 1]);
        }
      } else {
        const existing = await client.query(`
          SELECT * FROM ${this.jobsTable}
          WHERE tenant_id=$1 AND job_type=$2 AND idempotency_key=$3
        `, [input.tenantId, input.jobType, input.idempotencyKey]);
        if (!existing.rows[0]) {
          const activeTarget = await client.query(`
            SELECT job_id FROM ${this.jobsTable}
            WHERE tenant_id=$1 AND job_type=$2 AND target_type=$3 AND target_id=$4
              AND status IN ('pending','running','retry_wait')
          `, [input.tenantId, input.jobType, input.targetType, input.targetId]);
          if (activeTarget.rows[0]) throw new GovernanceChangeJobInvariantError('CHANGE_JOB_TARGET_BUSY');
          throw new GovernanceChangeJobInvariantError('CHANGE_JOB_NOT_FOUND');
        }
        job = rowToJob(existing.rows[0]);
      }
      const domains = await client.query(
        `SELECT * FROM ${this.domainsTable} WHERE job_id=$1 ORDER BY ordinal, domain`, [job.jobId],
      );
      const domainRecords = domains.rows.map(rowToDomain);
      if (!created) {
        const requestedDomains = [...new Set(input.domains)];
        const existingDomains = domainRecords.map(item => item.domain);
        const identityMatches = job.targetType === input.targetType
          && job.targetId === input.targetId
          && job.createdBy === input.createdBy
          && job.maxAttempts === maxAttempts
          && governanceDigest(job.request) === governanceDigest(input.request ?? {})
          && governanceDigest(existingDomains) === governanceDigest(requestedDomains);
        if (!identityMatches) throw new GovernanceChangeJobInvariantError('IDEMPOTENCY_KEY_REUSE_CONFLICT');
      }
      return { job, domains: domainRecords, created };
    });
  }

  async recoverExpiredRunning(
    tenantId: string,
    jobId: string,
    leaseMs: number,
    workerId: string,
  ): Promise<GovernanceChangeJob | null> {
    const result = await this.options.pool.query(`
      UPDATE ${this.jobsTable}
      SET status='retry_wait',next_retry_at=NOW(),revision=revision+1,
          updated_at=NOW(),updated_by=$4
      WHERE tenant_id=$1 AND job_id=$2 AND status='running'
        AND updated_at < NOW() - ($3 * INTERVAL '1 millisecond')
      RETURNING *
    `, [tenantId, jobId, leaseMs, workerId]);
    return result.rows[0] ? rowToJob(result.rows[0]) : null;
  }

  async claim(tenantId: string, jobId: string, expectedRevision: number, workerId: string): Promise<GovernanceChangeJob> {
    const result = await this.options.pool.query(`
      UPDATE ${this.jobsTable}
      SET status='running',revision=revision+1,attempt=attempt+1,next_retry_at=NULL,
          updated_at=NOW(),updated_by=$4
      WHERE tenant_id=$1 AND job_id=$2 AND revision=$3
        AND (status='pending' OR (status='retry_wait' AND next_retry_at <= NOW()))
      RETURNING *
    `, [tenantId, jobId, expectedRevision, workerId]);
    if (result.rows[0]) return rowToJob(result.rows[0]);
    return this.throwJobConflict(tenantId, jobId, expectedRevision);
  }

  async renewLease(tenantId: string, jobId: string, workerId: string): Promise<boolean> {
    const result = await this.options.pool.query(`
      UPDATE ${this.jobsTable} SET updated_at=NOW()
      WHERE tenant_id=$1 AND job_id=$2 AND status='running' AND updated_by=$3
      RETURNING job_id
    `, [tenantId, jobId, workerId]);
    return Boolean(result.rows[0]);
  }

  async updateDomain(input: {
    tenantId: string;
    jobId: string;
    domain: string;
    expectedRevision: number;
    status: GovernanceChangeJobDomain['status'];
    totalCount: number;
    completedCount: number;
    failedCount: number;
    unresolvedItems?: GovernanceChangeJobDomain['unresolvedItems'];
    /** Safe structured receipt persisted atomically with this domain state. */
    receipt?: Record<string, unknown>;
    errorCode?: string;
    workerId: string;
  }): Promise<GovernanceChangeJobDomain> {
    if ([input.totalCount, input.completedCount, input.failedCount].some(value => !Number.isInteger(value) || value < 0)
      || input.completedCount + input.failedCount > input.totalCount) {
      throw new GovernanceChangeJobInvariantError('CHANGE_JOB_INVALID');
    }
    if (input.receipt !== undefined) assertChangeJobRequestSafe(input.receipt);
    const result = await this.options.pool.query(`
      UPDATE ${this.domainsTable} d
      SET status=$4,total_count=$5,completed_count=$6,failed_count=$7,last_error_code=$8,
          unresolved_items_json=$9::jsonb,receipt_json=$10::jsonb,revision=d.revision+1,updated_at=NOW()
      FROM ${this.jobsTable} j
      WHERE d.job_id=$2 AND d.domain=$3 AND d.revision=$11
        AND j.job_id=d.job_id AND j.tenant_id=$1 AND j.status='running' AND j.updated_by=$12
      RETURNING d.*
    `, [
      input.tenantId, input.jobId, input.domain, input.status, input.totalCount,
      input.completedCount, input.failedCount, input.errorCode ?? null,
      JSON.stringify(input.unresolvedItems ?? []), input.receipt === undefined ? null : JSON.stringify(input.receipt), input.expectedRevision, input.workerId,
    ]);
    if (!result.rows[0]) throw new GovernanceChangeJobInvariantError('CHANGE_JOB_VERSION_CONFLICT');
    return rowToDomain(result.rows[0]);
  }

  async complete(tenantId: string, jobId: string, expectedRevision: number, completedBy: string): Promise<GovernanceChangeJob> {
    return this.withTransaction(async client => {
      const domains = await client.query(
        `SELECT * FROM ${this.domainsTable} WHERE job_id=$1 FOR UPDATE`, [jobId],
      );
      if (domains.rows.length === 0 || domains.rows.some(row => row.status !== 'succeeded'
        || Number(row.completed_count) + Number(row.failed_count) !== Number(row.total_count)
        || Number(row.failed_count) !== 0
        || (Array.isArray(row.unresolved_items_json) && row.unresolved_items_json.length > 0))) {
        throw new GovernanceChangeJobInvariantError('CHANGE_JOB_INCOMPLETE');
      }
      const result = await client.query(`
        UPDATE ${this.jobsTable}
        SET status='succeeded',revision=revision+1,completed_at=NOW(),updated_at=NOW(),updated_by=$4
        WHERE tenant_id=$1 AND job_id=$2 AND revision=$3 AND status='running' AND updated_by=$4 RETURNING *
      `, [tenantId, jobId, expectedRevision, completedBy]);
      if (!result.rows[0]) throw new GovernanceChangeJobInvariantError('CHANGE_JOB_VERSION_CONFLICT');
      return rowToJob(result.rows[0]);
    });
  }

  async fail(input: {
    tenantId: string;
    jobId: string;
    expectedRevision: number;
    errorCode: string;
    failedBy: string;
    retryAt?: string;
    terminalStatus?: 'partial' | 'failed' | 'dead_letter';
  }): Promise<GovernanceChangeJob> {
    const retryAt = input.retryAt ? new Date(input.retryAt) : undefined;
    if (retryAt && Number.isNaN(retryAt.getTime())) throw new GovernanceChangeJobInvariantError('CHANGE_JOB_INVALID');
    const status = retryAt ? 'retry_wait' : (input.terminalStatus ?? 'failed');
    const result = await this.options.pool.query(`
      UPDATE ${this.jobsTable}
      SET status=$4,last_error_code=$5,next_retry_at=$6,revision=revision+1,updated_at=NOW(),updated_by=$7,
          completed_at=CASE WHEN $4 IN ('partial','failed','dead_letter') THEN NOW() ELSE NULL END
      WHERE tenant_id=$1 AND job_id=$2 AND revision=$3 AND status='running' AND updated_by=$7 RETURNING *
    `, [
      input.tenantId, input.jobId, input.expectedRevision, status,
      input.errorCode, retryAt?.toISOString() ?? null, input.failedBy,
    ]);
    if (result.rows[0]) return rowToJob(result.rows[0]);
    return this.throwJobConflict(input.tenantId, input.jobId, input.expectedRevision);
  }

  async retryNow(
    tenantId: string,
    jobId: string,
    expectedRevision: number,
    requestedBy: string,
    additionalAttempts = 5,
  ): Promise<GovernanceChangeJob> {
    if (!Number.isInteger(additionalAttempts) || additionalAttempts < 1 || additionalAttempts > 20) {
      throw new GovernanceChangeJobInvariantError('CHANGE_JOB_INVALID');
    }
    return this.withTransaction(async client => {
      const currentResult = await client.query(
        `SELECT * FROM ${this.jobsTable} WHERE tenant_id=$1 AND job_id=$2 FOR UPDATE`,
        [tenantId, jobId],
      );
      if (!currentResult.rows[0]) throw new GovernanceChangeJobInvariantError('CHANGE_JOB_NOT_FOUND');
      const current = rowToJob(currentResult.rows[0]);
      if (current.revision !== expectedRevision) throw new GovernanceChangeJobInvariantError('CHANGE_JOB_VERSION_CONFLICT');
      if (!['retry_wait', 'partial', 'failed', 'dead_letter'].includes(current.status)) {
        throw new GovernanceChangeJobInvariantError('CHANGE_JOB_INVALID_TRANSITION');
      }
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
        `change-job-target:${tenantId}:${current.jobType}:${current.targetType}:${current.targetId}`,
      ]);
      const active = await client.query(`
        SELECT job_id FROM ${this.jobsTable}
        WHERE tenant_id=$1 AND job_type=$2 AND target_type=$3 AND target_id=$4 AND job_id<>$5
          AND status IN ('pending','running','retry_wait')
        LIMIT 1
      `, [tenantId, current.jobType, current.targetType, current.targetId, jobId]);
      if (active.rows[0]) throw new GovernanceChangeJobInvariantError('CHANGE_JOB_TARGET_BUSY');
      try {
        const result = await client.query(`
          UPDATE ${this.jobsTable}
          SET status='retry_wait',next_retry_at=NOW(),completed_at=NULL,
              max_attempts=GREATEST(max_attempts,attempt+$5),
              revision=revision+1,updated_at=NOW(),updated_by=$4
          WHERE tenant_id=$1 AND job_id=$2 AND revision=$3
            AND status IN ('retry_wait','partial','failed','dead_letter')
          RETURNING *
        `, [tenantId, jobId, expectedRevision, requestedBy, additionalAttempts]);
        if (result.rows[0]) return rowToJob(result.rows[0]);
      } catch (error) {
        if ((error as { code?: string }).code === '23505') {
          throw new GovernanceChangeJobInvariantError('CHANGE_JOB_TARGET_BUSY');
        }
        throw error;
      }
      throw new GovernanceChangeJobInvariantError('CHANGE_JOB_VERSION_CONFLICT');
    });
  }

  private async throwJobConflict(tenantId: string, jobId: string, expectedRevision: number): Promise<never> {
    const current = await this.get(tenantId, jobId);
    if (!current) throw new GovernanceChangeJobInvariantError('CHANGE_JOB_NOT_FOUND');
    if (current.revision !== expectedRevision) throw new GovernanceChangeJobInvariantError('CHANGE_JOB_VERSION_CONFLICT');
    throw new GovernanceChangeJobInvariantError('CHANGE_JOB_INVALID_TRANSITION');
  }

  private async withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.options.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
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
