import { randomUUID } from 'node:crypto';

import type { PgGovernanceChangeJobStore } from './store.js';
import type { GovernanceChangeJob, GovernanceChangeJobDomain } from './types.js';

export class GovernanceChangeJobWorker {
  constructor(private readonly options: {
    store: PgGovernanceChangeJobStore;
    workerId: string;
    retryDelayMs?: number;
    leaseMs?: number;
  }) {}

  async execute(input: {
    tenantId: string;
    jobId: string;
    handlers: Record<string, () => Promise<void>>;
  }): Promise<GovernanceChangeJob> {
    const executionId = `${this.options.workerId}:${randomUUID()}`;
    let current = await this.options.store.get(input.tenantId, input.jobId);
    if (!current) throw new Error('CHANGE_JOB_NOT_FOUND');
    if (current.status === 'running') {
      const recovered = await this.options.store.recoverExpiredRunning(
        input.tenantId,
        input.jobId,
        this.options.leaseMs ?? 5 * 60_000,
        executionId,
      );
      if (!recovered) return current;
      current = recovered;
    }
    if (current.status === 'succeeded' || current.status === 'failed') return current;
    const claimed = await this.options.store.claim(
      input.tenantId, input.jobId, current.revision, executionId,
    );
    const domains = await this.options.store.listDomains(input.tenantId, input.jobId);
    try {
      for (const domain of domains) {
        if (domain.status === 'succeeded') continue;
        await this.executeDomain(input, domain, executionId);
      }
      return await this.options.store.complete(
        input.tenantId, input.jobId, claimed.revision, executionId,
      );
    } catch (error) {
      const code = error instanceof Error && /^[A-Z0-9_]{3,120}$/.test(error.message)
        ? error.message
        : 'CHANGE_JOB_HANDLER_FAILED';
      return this.options.store.fail({
        tenantId: input.tenantId,
        jobId: input.jobId,
        expectedRevision: claimed.revision,
        errorCode: code,
        failedBy: executionId,
        retryAt: new Date(Date.now() + (this.options.retryDelayMs ?? 60_000)).toISOString(),
      });
    }  }

  private async executeDomain(
    input: { tenantId: string; jobId: string; handlers: Record<string, () => Promise<void>> },
    domain: GovernanceChangeJobDomain,
    executionId: string,
  ): Promise<void> {
    const handler = input.handlers[domain.domain];
    if (!handler) throw new Error('CHANGE_JOB_HANDLER_MISSING');
    const leaseMs = this.options.leaseMs ?? 5 * 60_000;
    if (!await this.options.store.renewLease(input.tenantId, input.jobId, executionId)) {
      throw new Error('CHANGE_JOB_LEASE_LOST');
    }
    const heartbeat = setInterval(() => {
      void this.options.store.renewLease(input.tenantId, input.jobId, executionId);
    }, Math.max(1_000, Math.floor(leaseMs / 3)));
    heartbeat.unref?.();
    try {
      await handler();
      if (!await this.options.store.renewLease(input.tenantId, input.jobId, executionId)) {
        throw new Error('CHANGE_JOB_LEASE_LOST');
      }
      await this.options.store.updateDomain({
        tenantId: input.tenantId, jobId: input.jobId, domain: domain.domain,
        expectedRevision: domain.revision, status: 'succeeded',
        totalCount: 1, completedCount: 1, failedCount: 0, workerId: executionId,
      });
    } catch (error) {
      const errorCode = error instanceof Error && /^[A-Z0-9_]{3,120}$/.test(error.message)
        ? error.message
        : 'CHANGE_JOB_DOMAIN_FAILED';
      await this.options.store.updateDomain({
        tenantId: input.tenantId, jobId: input.jobId, domain: domain.domain,
        expectedRevision: domain.revision, status: 'failed',
        totalCount: 1, completedCount: 0, failedCount: 1, errorCode, workerId: executionId,
      }).catch(() => undefined);
      throw error;
    } finally {
      clearInterval(heartbeat);
    }
  }
}
