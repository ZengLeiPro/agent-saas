import { describe, expect, it } from 'vitest';

import {
  GovernanceChangeJobWorker,
  PgGovernanceChangeJobStore,
  assertChangeJobRequestSafe,
  type GovernanceChangeJob,
  type GovernanceChangeJobDomain,
} from '../data/changeJobs/index.js';

const NOW = '2026-08-08T00:00:00.000Z';

function buildPool() {
  const jobs = new Map<string, Record<string, unknown>>();
  const domains = new Map<string, Record<string, unknown>>();
  const queries: string[] = [];
  const query = async (sql: string, params: unknown[] = []) => {
    queries.push(sql);
    if (sql.includes('SELECT version FROM')) return { rows: [], rowCount: 0 };
    if (sql.includes('INSERT INTO test_governance_change_jobs') && sql.includes('RETURNING')) {
      const existing = [...jobs.values()].find(row => row.tenant_id === params[1] && row.job_type === params[2]
        && (row.idempotency_key === params[5] || (row.target_type === params[3] && row.target_id === params[4]
          && ['pending', 'running', 'retry_wait'].includes(String(row.status)))));
      if (existing) return { rows: [], rowCount: 0 };
      const row = {
        job_id: params[0], tenant_id: params[1], job_type: params[2], target_type: params[3], target_id: params[4],
        idempotency_key: params[5], request_json: JSON.parse(String(params[6])), status: 'pending', revision: '1', attempt: 0, max_attempts: params[8] ?? 5,
        last_error_code: null, next_retry_at: null, created_at: NOW, created_by: params[7], updated_at: NOW,
        updated_by: params[7], completed_at: null,
      };
      jobs.set(String(params[0]), row);
      return { rows: [row], rowCount: 1 };
    }
    if (sql.includes('INSERT INTO test_governance_change_job_domains')) {
      const key = `${params[0]}:${params[1]}`;
      if (!domains.has(key)) domains.set(key, {
        job_id: params[0], domain: params[1], status: 'pending', total_count: '0', completed_count: '0',
        failed_count: '0', unresolved_items_json: [], revision: '1', updated_at: NOW, last_error_code: null,
      });
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes('FROM test_governance_change_jobs') && sql.includes('idempotency_key=$3')) {
      const row = [...jobs.values()].find(item => item.tenant_id === params[0] && item.job_type === params[1] && item.idempotency_key === params[2]);
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }
    if (sql.includes('FROM test_governance_change_jobs') && sql.includes('target_type=$3')) {
      const row = [...jobs.values()].find(item => item.tenant_id === params[0] && item.job_type === params[1]
        && item.target_type === params[2] && item.target_id === params[3]
        && ['pending', 'running', 'retry_wait'].includes(String(item.status)));
      return { rows: row ? [sql.includes('SELECT *') ? row : { job_id: row.job_id }] : [], rowCount: row ? 1 : 0 };
    }
    if (sql.includes('FROM test_governance_change_job_domains') && sql.includes('WHERE job_id=$1')) {
      const rows = [...domains.values()].filter(row => row.job_id === params[0]);
      return { rows, rowCount: rows.length };
    }
    if (sql.includes('JOIN test_governance_change_jobs')) {
      const job = jobs.get(String(params[1]));
      const rows = job?.tenant_id === params[0] ? [...domains.values()].filter(row => row.job_id === params[1]) : [];
      return { rows, rowCount: rows.length };
    }
    if (sql.includes('FROM test_governance_change_jobs') && sql.includes('tenant_id=$1 AND job_id=$2')) {
      const row = jobs.get(String(params[1]));
      const visible = row?.tenant_id === params[0] ? row : undefined;
      return { rows: visible ? [visible] : [], rowCount: visible ? 1 : 0 };
    }
    if (sql.includes('UPDATE test_governance_change_jobs') && sql.includes("SET status='running'")) {
      const row = jobs.get(String(params[1]));
      if (!row || row.tenant_id !== params[0] || Number(row.revision) !== Number(params[2]) || row.status !== 'pending') return { rows: [], rowCount: 0 };
      const updated = { ...row, status: 'running', revision: String(Number(row.revision) + 1), attempt: Number(row.attempt) + 1, updated_by: params[3] };
      jobs.set(String(params[1]), updated);
      return { rows: [updated], rowCount: 1 };
    }
    if (sql.includes('UPDATE test_governance_change_job_domains')) {
      const job = jobs.get(String(params[1]));
      const key = `${params[1]}:${params[2]}`;
      const row = domains.get(key);
      if (!job || job.tenant_id !== params[0] || job.status !== 'running' || !row || Number(row.revision) !== Number(params[9])) return { rows: [], rowCount: 0 };
      const updated = {
        ...row, status: params[3], total_count: String(params[4]), completed_count: String(params[5]),
        failed_count: String(params[6]), last_error_code: params[7], unresolved_items_json: JSON.parse(String(params[8])),
        revision: String(Number(row.revision) + 1),
      };
      domains.set(key, updated);
      return { rows: [updated], rowCount: 1 };
    }
    if (sql.includes('UPDATE test_governance_change_jobs') && sql.includes("status='succeeded'")) {
      const row = jobs.get(String(params[1]));
      if (!row || row.tenant_id !== params[0] || Number(row.revision) !== Number(params[2]) || row.status !== 'running') return { rows: [], rowCount: 0 };
      const updated = { ...row, status: 'succeeded', revision: String(Number(row.revision) + 1), completed_at: NOW, updated_by: params[3] };
      jobs.set(String(params[1]), updated);
      return { rows: [updated], rowCount: 1 };
    }
    if (sql.includes('UPDATE test_governance_change_jobs') && sql.includes('last_error_code=$5')) {
      const row = jobs.get(String(params[1]));
      if (!row || row.tenant_id !== params[0] || Number(row.revision) !== Number(params[2]) || row.status !== 'running') return { rows: [], rowCount: 0 };
      const updated = { ...row, status: params[3], last_error_code: params[4], next_retry_at: params[5], revision: String(Number(row.revision) + 1), updated_by: params[6] };
      jobs.set(String(params[1]), updated);
      return { rows: [updated], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  };
  const pool = { query, connect: async () => ({ query, release: () => undefined }) };
  return { pool: pool as never, jobs, domains, queries };
}

const createInput = {
  tenantId: 'acme', jobType: 'tenant_delete' as const, targetType: 'tenant', targetId: 'acme',
  idempotencyKey: 'delete-acme-v1', request: { reasonCode: 'customer_request' },
  domains: ['memberships', 'assignments'], createdBy: 'platform-admin',
};

describe('Governance Change Job', () => {
  it('migration V11 创建可重试 Job 与分域计数表', async () => {
    const { pool, queries } = buildPool();
    const store = new PgGovernanceChangeJobStore({ pool, tablePrefix: 'test' });
    await store.init();
    const sql = queries.join('\n');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS test_governance_change_jobs');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS test_governance_change_job_domains');
    expect(sql).toContain('UNIQUE (tenant_id, job_type, idempotency_key)');
    expect(sql).toContain('test_governance_change_jobs_active_target_unique');
    expect(sql).toContain("WHERE status IN ('pending','running','retry_wait')");
    expect(sql).toContain('unresolved_items_json');
    expect(queries.filter(item => item === 'BEGIN')).toHaveLength(29);
  });

  it('同 idempotency key 返回同一 Job，不重复建立分域', async () => {
    const { pool } = buildPool();
    const store = new PgGovernanceChangeJobStore({ pool, tablePrefix: 'test' });
    const first = await store.create(createInput);
    const second = await store.create(createInput);
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.job.jobId).toBe(first.job.jobId);
    expect(second.domains).toHaveLength(2);
  });

  it('同 idempotency key 携带不同目标或请求时拒绝复用', async () => {
    const { pool } = buildPool();
    const store = new PgGovernanceChangeJobStore({ pool, tablePrefix: 'test' });
    await store.create(createInput);
    await expect(store.create({ ...createInput, targetId: 'other-tenant' }))
      .rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSE_CONFLICT' });
    await expect(store.create({ ...createInput, request: { reasonCode: 'different' } }))
      .rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSE_CONFLICT' });
  });

  it('顺序创建同目标不同 idempotency key 时稳定返回 TARGET_BUSY', async () => {
    const { pool, jobs } = buildPool();
    const store = new PgGovernanceChangeJobStore({ pool, tablePrefix: 'test' });
    await store.create(createInput);
    await expect(store.create({ ...createInput, idempotencyKey: 'delete-acme-v2' }))
      .rejects.toMatchObject({ code: 'CHANGE_JOB_TARGET_BUSY' });
    expect(jobs.size).toBe(1);
  });

  it('并发创建同目标不同 idempotency key 时只建立一个活动 Job', async () => {
    const { pool, jobs } = buildPool();
    const store = new PgGovernanceChangeJobStore({ pool, tablePrefix: 'test' });
    const results = await Promise.allSettled([
      store.create(createInput),
      store.create({ ...createInput, idempotencyKey: 'delete-acme-v2' }),
    ]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toEqual([
      expect.objectContaining({ reason: expect.objectContaining({ code: 'CHANGE_JOB_TARGET_BUSY' }) }),
    ]);
    expect(jobs.size).toBe(1);
  });

  it('旧 Job 终态后允许为同目标创建新 Job', async () => {
    const { pool, jobs } = buildPool();
    const store = new PgGovernanceChangeJobStore({ pool, tablePrefix: 'test' });
    const first = await store.create(createInput);
    jobs.get(first.job.jobId)!.status = 'failed';
    await expect(store.create({ ...createInput, idempotencyKey: 'delete-acme-v2' }))
      .resolves.toMatchObject({ created: true, job: { status: 'pending' } });
    expect(jobs.size).toBe(2);
  });

  it('旧终态 Job retry 遇到同目标新活动 Job 时稳定返回 TARGET_BUSY', async () => {
    const { pool, jobs } = buildPool();
    const store = new PgGovernanceChangeJobStore({ pool, tablePrefix: 'test' });
    const first = await store.create(createInput);
    jobs.get(first.job.jobId)!.status = 'failed';
    await store.create({ ...createInput, idempotencyKey: 'delete-acme-v2' });
    await expect(store.retryNow('acme', first.job.jobId, first.job.revision, 'platform-admin'))
      .rejects.toMatchObject({ code: 'CHANGE_JOB_TARGET_BUSY' });
  });

  it('claim→分域计数→complete，未完成时 fail closed', async () => {
    const { pool } = buildPool();
    const store = new PgGovernanceChangeJobStore({ pool, tablePrefix: 'test' });
    const created = await store.create(createInput);
    const running = await store.claim('acme', created.job.jobId, 1, 'worker-1');
    await expect(store.complete('acme', created.job.jobId, running.revision, 'worker-1'))
      .rejects.toMatchObject({ code: 'CHANGE_JOB_INCOMPLETE' });
    for (const domain of created.domains) {
      await store.updateDomain({
        tenantId: 'acme', jobId: created.job.jobId, domain: domain.domain, expectedRevision: 1,
        status: 'succeeded', totalCount: 3, completedCount: 3, failedCount: 0, workerId: 'worker-1',
      });
    }
    const completed = await store.complete('acme', created.job.jobId, running.revision, 'worker-1');
    expect(completed).toMatchObject({ status: 'succeeded', revision: 3, completedAt: NOW });
  });

  it('活动目标查询包含 retry_wait（不是不存在的 retrying）', async () => {
    const { pool, jobs, queries } = buildPool();
    const store = new PgGovernanceChangeJobStore({ pool, tablePrefix: 'test' });
    const created = await store.create(createInput);
    jobs.get(created.job.jobId)!.status = 'retry_wait';
    await expect(store.findActiveForTarget('acme', 'tenant_delete', 'tenant', 'acme'))
      .resolves.toMatchObject({ jobId: created.job.jobId, status: 'retry_wait' });
    expect(queries.at(-1)).toContain("status IN ('pending','running','retry_wait')");
  });

  it('失败可进入 retry_wait，保留稳定 error code 而非错误正文', async () => {
    const { pool } = buildPool();
    const store = new PgGovernanceChangeJobStore({ pool, tablePrefix: 'test' });
    const created = await store.create(createInput);
    const running = await store.claim('acme', created.job.jobId, 1, 'worker-1');
    const failed = await store.fail({
      tenantId: 'acme', jobId: created.job.jobId, expectedRevision: running.revision,
      errorCode: 'ASSIGNMENT_CLEANUP_RETRYABLE', failedBy: 'worker-1', retryAt: '2026-08-08T01:00:00.000Z',
    });
    expect(failed).toMatchObject({ status: 'retry_wait', lastErrorCode: 'ASSIGNMENT_CLEANUP_RETRYABLE' });
    expect(JSON.stringify(failed)).not.toContain('stack');
  });

  it('不可重试且已有完成域时提供 partial 明确非成功终态', async () => {
    const { pool } = buildPool();
    const store = new PgGovernanceChangeJobStore({ pool, tablePrefix: 'test' });
    const created = await store.create(createInput);
    const running = await store.claim('acme', created.job.jobId, created.job.revision, 'worker-1');
    await expect(store.fail({
      tenantId: 'acme', jobId: created.job.jobId, expectedRevision: running.revision,
      errorCode: 'NON_RETRYABLE_UNRESOLVED', failedBy: 'worker-1', terminalStatus: 'partial',
    })).resolves.toMatchObject({ status: 'partial', lastErrorCode: 'NON_RETRYABLE_UNRESOLVED' });
  });

  it('故障注入：首轮失败进入 retry_wait，重试跳过成功域并最终收敛，OAuth fence 不重开', async () => {
    let job: GovernanceChangeJob = {
      jobId: 'job-offboard', tenantId: 'acme', jobType: 'user_offboarding', targetType: 'user',
      targetId: 'leaver', idempotencyKey: 'offboard-1', request: {}, status: 'pending',
      revision: 1, attempt: 0, maxAttempts: 5,
      createdAt: NOW, createdBy: 'admin', updatedAt: NOW, updatedBy: 'admin',
    };
    const domains = new Map<string, GovernanceChangeJobDomain>([
      ['credentials_connectors', {
        jobId: job.jobId, domain: 'credentials_connectors', status: 'pending', totalCount: 0,
        completedCount: 0, failedCount: 0, unresolvedItems: [], revision: 1, updatedAt: NOW,
      }],
      ['membership', {
        jobId: job.jobId, domain: 'membership', status: 'pending', totalCount: 0,
        completedCount: 0, failedCount: 0, unresolvedItems: [], revision: 1, updatedAt: NOW,
      }],
    ]);
    const store = {
      get: async () => job,
      recoverExpiredRunning: async () => null,
      claim: async (_tenantId: string, _jobId: string, expectedRevision: number, workerId: string) => {
        expect(job.revision).toBe(expectedRevision);
        job = { ...job, status: 'running', revision: job.revision + 1, attempt: job.attempt + 1, updatedBy: workerId };
        return job;
      },
      listDomains: async () => [...domains.values()],
      renewLease: async () => true,
      updateDomain: async (value: Record<string, unknown>) => {
        const current = domains.get(String(value.domain))!;
        const updated: GovernanceChangeJobDomain = {
          ...current,
          status: value.status as GovernanceChangeJobDomain['status'],
          totalCount: Number(value.totalCount), completedCount: Number(value.completedCount),
          failedCount: Number(value.failedCount),
          unresolvedItems: (value.unresolvedItems ?? []) as GovernanceChangeJobDomain['unresolvedItems'],
          revision: current.revision + 1,
          ...(value.errorCode ? { lastErrorCode: String(value.errorCode) } : {}),
        };
        domains.set(updated.domain, updated);
        return updated;
      },
      complete: async () => {
        expect([...domains.values()].every(domain => domain.status === 'succeeded')).toBe(true);
        job = { ...job, status: 'succeeded', revision: job.revision + 1, completedAt: NOW };
        return job;
      },
      fail: async (value: { errorCode: string; retryAt?: string }) => {
        job = {
          ...job, status: value.retryAt ? 'retry_wait' : 'partial', revision: job.revision + 1,
          lastErrorCode: value.errorCode, ...(value.retryAt ? { nextRetryAt: value.retryAt } : {}),
        };
        return job;
      },
    };
    const worker = new GovernanceChangeJobWorker({ store: store as never, workerId: 'test', retryDelayMs: 0 });
    let oauthFenceClosed = false;
    let credentialCalls = 0;
    let membershipCalls = 0;
    const handlers = {
      credentials_connectors: async () => {
        credentialCalls += 1;
        oauthFenceClosed = true;
        return { affectedCount: 2, completedCount: 2, unresolvedItems: [] };
      },
      membership: async () => {
        membershipCalls += 1;
        if (membershipCalls === 1) return {
          affectedCount: 1, completedCount: 0,
          unresolvedItems: [{ itemType: 'membership', itemId: 'leaver', reasonCode: 'INJECTED', retryable: true }],
        };
        return { affectedCount: 1, completedCount: 1, unresolvedItems: [] };
      },
    };

    await expect(worker.execute({ tenantId: 'acme', jobId: job.jobId, handlers }))
      .resolves.toMatchObject({ status: 'retry_wait' });
    expect(domains.get('credentials_connectors')).toMatchObject({
      status: 'succeeded', totalCount: 2, completedCount: 2, unresolvedItems: [],
    });
    expect(domains.get('membership')).toMatchObject({
      status: 'failed', totalCount: 1, completedCount: 0,
      unresolvedItems: [expect.objectContaining({ reasonCode: 'INJECTED', retryable: true })],
    });
    expect(oauthFenceClosed).toBe(true);

    await expect(worker.execute({ tenantId: 'acme', jobId: job.jobId, handlers }))
      .resolves.toMatchObject({ status: 'succeeded' });
    expect({ credentialCalls, membershipCalls, oauthFenceClosed }).toEqual({
      credentialCalls: 1, membershipCalls: 2, oauthFenceClosed: true,
    });
  });

  it('request 禁止 Secret、token、消息正文与 raw 参数', () => {
    expect(() => assertChangeJobRequestSafe({ reasonCode: 'customer_request' })).not.toThrow();
    for (const invalid of [{ secretRef: 'x' }, { accessToken: 'x' }, { messageBody: 'x' }, { rawParams: { x: 1 } }]) {
      expect(() => assertChangeJobRequestSafe(invalid))
        .toThrowError(expect.objectContaining({ code: 'CHANGE_JOB_REQUEST_SENSITIVE' }));
    }
  });
});
