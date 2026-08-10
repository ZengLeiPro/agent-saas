import type { GovernanceMigrationDomain } from './types.js';
import { GovernanceShadowComparator } from './comparator.js';

interface DomainStateWriter {
  listDomains(): Promise<Array<{ domain: GovernanceMigrationDomain; revision: number }>>;
  recordDomainSnapshot(input: {
    domain: GovernanceMigrationDomain;
    expectedRevision: number;
    comparedCount: number;
    matchedCount: number;
    differenceCount: number;
    unresolvedBlockingCount: number;
    updatedBy: string;
  }): Promise<unknown>;
}

export interface GovernanceShadowComparison {
  tenantId?: string;
  resourceType: string;
  resourceId: string;
  legacy: unknown | undefined;
  governance: unknown | undefined;
  blocking?: boolean;
}

export class GovernanceDomainShadowAuditor {
  constructor(private readonly options: {
    comparator: GovernanceShadowComparator;
    states: DomainStateWriter;
  }) {}

  async audit(domain: GovernanceMigrationDomain, comparisons: GovernanceShadowComparison[]): Promise<{
    comparedCount: number;
    matchedCount: number;
    differenceCount: number;
  }> {
    let matchedCount = 0;
    let differenceCount = 0;
    for (const comparison of comparisons) {
      const result = await this.options.comparator.compare({ domain, ...comparison });
      if (result.matched) matchedCount += 1;
      else differenceCount += 1;
    }
    const unresolvedBlockingCount = await this.options.comparator.countOpenBlockingDifferences(domain);
    const state = (await this.options.states.listDomains()).find(item => item.domain === domain);
    if (!state) throw new Error('MIGRATION_CONTROL_NOT_FOUND');
    await this.options.states.recordDomainSnapshot({
      domain,
      expectedRevision: state.revision,
      comparedCount: comparisons.length,
      matchedCount,
      differenceCount,
      unresolvedBlockingCount,
      updatedBy: 'system:shadow-auditor',
    });
    return { comparedCount: comparisons.length, matchedCount, differenceCount };
  }
}
