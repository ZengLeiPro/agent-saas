import { randomUUID } from 'node:crypto';

import type { PgGovernanceChangeJobStore } from './store.js';
import type {
  GovernanceChangeDomainExecutionResult,
  GovernanceChangeJob,
  GovernanceChangeJobDomain,
} from './types.js';

export type GovernanceChangeJobHandler = () => Promise<void | GovernanceChangeDomainExecutionResult>;

class DomainExecutionFailure extends Error {
  constructor(readonly retryable: boolean, code = 'CHANGE_JOB_DOMAIN_UNRESOLVED') {
    super(code);
  }
}

function validResult(value: unknown): value is GovernanceChangeDomainExecutionResult {
  if (!value || typeof value !== 'object') return false;
  const result = value as GovernanceChangeDomainExecutionResult;
  return Number.isInteger(result.affectedCount) && result.affectedCount >= 0
    && Number.isInteger(result.completedCount) && result.completedCount >= 0
    && result.completedCount <= result.affectedCount
    && Array.isArray(result.unresolvedItems)
    && (result.receipt === undefined || (typeof result.receipt === 'object' && result.receipt !== null && !Array.isArray(result.receipt)))
    && (result.completedCount === result.affectedCount || result.unresolvedItems.length > 0);
}

export class GovernanceChangeJobWorker {
  constructor(private readonly options: {
    store: PgGovernanceChangeJobStore;
    workerId: string;
    /** Base delay for bounded exponential retry. */
    retryDelayMs?: number;
    maxRetryDelayMs?: number;
    leaseMs?: number;
  }) {}

  async execute(input: {
    tenantId: string;
    jobId: string;
    handlers: Record<string, GovernanceChangeJobHandler>;
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
    if (['succeeded', 'partial', 'failed', 'dead_letter'].includes(current.status)) return current;
    const claimed = await this.options.store.claim(
      input.tenantId, input.jobId, current.revision, executionId,
    );
    const storedDomains = await this.options.store.listDomains(input.tenantId, input.jobId);
    const handlerOrder = new Map(Object.keys(input.handlers).map((domain, index) => [domain, index]));
    const domains = [...storedDomains].sort((left, right) =>
      (handlerOrder.get(left.domain) ?? Number.MAX_SAFE_INTEGER)
      - (handlerOrder.get(right.domain) ?? Number.MAX_SAFE_INTEGER)
      || left.domain.localeCompare(right.domain),
    );
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
      const retryable = !(error instanceof DomainExecutionFailure) || error.retryable;
      const attempt = claimed.attempt ?? current.attempt ?? 1;
      const maxAttempts = claimed.maxAttempts ?? current.maxAttempts ?? 5;
      const exhausted = attempt >= maxAttempts;
      const baseDelayMs = Math.max(0, this.options.retryDelayMs ?? 60_000);
      const retryDelayMs = Math.min(
        this.options.maxRetryDelayMs ?? 60 * 60_000,
        baseDelayMs * (2 ** Math.max(0, attempt - 1)),
      );
      const terminalStatus = retryable
        ? 'dead_letter' as const
        : domains.some(domain => domain.status === 'succeeded') ? 'partial' as const : 'failed' as const;
      return this.options.store.fail({
        tenantId: input.tenantId,
        jobId: input.jobId,
        expectedRevision: claimed.revision,
        errorCode: code,
        failedBy: executionId,
        ...(retryable && !exhausted
          ? { retryAt: new Date(Date.now() + retryDelayMs).toISOString() }
          : { terminalStatus }),
      });
    }
  }

  private async executeDomain(
    input: { tenantId: string; jobId: string; handlers: Record<string, GovernanceChangeJobHandler> },
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
      const result = await handler();
      if (!await this.options.store.renewLease(input.tenantId, input.jobId, executionId)) {
        throw new Error('CHANGE_JOB_LEASE_LOST');
      }
      const measured = result ?? { affectedCount: 1, completedCount: 1, unresolvedItems: [] };
      if (!validResult(measured)) throw new Error('CHANGE_JOB_DOMAIN_RESULT_INVALID');
      const unresolved = [...measured.unresolvedItems];
      const failedCount = measured.affectedCount - measured.completedCount;
      await this.options.store.updateDomain({
        tenantId: input.tenantId, jobId: input.jobId, domain: domain.domain,
        expectedRevision: domain.revision,
        status: unresolved.length === 0 ? 'succeeded' : 'failed',
        totalCount: measured.affectedCount,
        completedCount: measured.completedCount,
        failedCount,
        unresolvedItems: unresolved,
        ...(measured.receipt !== undefined ? { receipt: measured.receipt } : {}),
        ...(unresolved.length > 0 ? { errorCode: 'CHANGE_JOB_DOMAIN_UNRESOLVED' } : {}),
        workerId: executionId,
      });
      if (unresolved.length > 0) {
        throw new DomainExecutionFailure(unresolved.some(item => item.retryable));
      }
    } catch (error) {
      if (!(error instanceof DomainExecutionFailure)) {
        const errorCode = error instanceof Error && /^[A-Z0-9_]{3,120}$/.test(error.message)
          ? error.message
          : 'CHANGE_JOB_DOMAIN_FAILED';
        const priorTotal = Number.isInteger(domain.totalCount) ? domain.totalCount : 0;
        const priorCompleted = Number.isInteger(domain.completedCount) ? domain.completedCount : 0;
        const totalCount = Math.max(priorTotal, priorCompleted + 1, 1);
        await this.options.store.updateDomain({
          tenantId: input.tenantId, jobId: input.jobId, domain: domain.domain,
          expectedRevision: domain.revision, status: 'failed',
          totalCount, completedCount: priorCompleted,
          failedCount: totalCount - priorCompleted,
          unresolvedItems: [{
            itemType: 'domain', itemId: domain.domain, reasonCode: errorCode, retryable: true,
          }],
          errorCode, workerId: executionId,
        }).catch(() => undefined);
      }
      throw error;
    } finally {
      clearInterval(heartbeat);
    }
  }
}
