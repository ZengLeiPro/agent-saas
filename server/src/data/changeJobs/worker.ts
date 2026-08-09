import type { PgGovernanceChangeJobStore } from './store.js';
import type { GovernanceChangeJob, GovernanceChangeJobDomain } from './types.js';

export class GovernanceChangeJobWorker {
  constructor(private readonly options: {
    store: PgGovernanceChangeJobStore;
    workerId: string;
    retryDelayMs?: number;
  }) {}

  async execute(input: {
    tenantId: string;
    jobId: string;
    handlers: Record<string, () => Promise<void>>;
  }): Promise<GovernanceChangeJob> {
    const current = await this.options.store.get(input.tenantId, input.jobId);
    if (!current) throw new Error('CHANGE_JOB_NOT_FOUND');
    if (current.status === 'succeeded' || current.status === 'failed') return current;
    const claimed = await this.options.store.claim(
      input.tenantId, input.jobId, current.revision, this.options.workerId,
    );
    const domains = await this.options.store.listDomains(input.tenantId, input.jobId);
    try {
      for (const domain of domains) {
        if (domain.status === 'succeeded') continue;
        await this.executeDomain(input, domain);
      }
      return await this.options.store.complete(
        input.tenantId, input.jobId, claimed.revision, this.options.workerId,
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
        failedBy: this.options.workerId,
        retryAt: new Date(Date.now() + (this.options.retryDelayMs ?? 60_000)).toISOString(),
      });
    }  }

  private async executeDomain(
    input: { tenantId: string; jobId: string; handlers: Record<string, () => Promise<void>> },
    domain: GovernanceChangeJobDomain,
  ): Promise<void> {
    const handler = input.handlers[domain.domain];
    if (!handler) throw new Error('CHANGE_JOB_HANDLER_MISSING');
    try {
      await handler();
      await this.options.store.updateDomain({
        tenantId: input.tenantId, jobId: input.jobId, domain: domain.domain,
        expectedRevision: domain.revision, status: 'succeeded',
        totalCount: 1, completedCount: 1, failedCount: 0,
      });
    } catch (error) {
      const errorCode = error instanceof Error && /^[A-Z0-9_]{3,120}$/.test(error.message)
        ? error.message
        : 'CHANGE_JOB_DOMAIN_FAILED';
      await this.options.store.updateDomain({
        tenantId: input.tenantId, jobId: input.jobId, domain: domain.domain,
        expectedRevision: domain.revision, status: 'failed',
        totalCount: 1, completedCount: 0, failedCount: 1, errorCode,
      }).catch(() => undefined);
      throw error;
    }
  }
}
