import { createHash } from 'node:crypto';

import type { GovernanceMigrationDomain, GovernanceShadowDifference } from './types.js';

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().filter(key => record[key] !== undefined)
    .map(key => `${JSON.stringify(key)}:${canonicalize(record[key])}`).join(',')}}`;
}

export function governanceProjectionDigest(value: unknown): string {
  return createHash('sha256').update(canonicalize(value)).digest('hex');
}

interface DifferenceWriter {
  recordDifference(input: {
    domain: GovernanceMigrationDomain;
    tenantId?: string;
    resourceType: string;
    resourceId: string;
    category: GovernanceShadowDifference['category'];
    legacyDigest?: string;
    governanceDigest?: string;
    blocking: boolean;
  }): Promise<GovernanceShadowDifference>;
}

export class GovernanceShadowComparator {
  constructor(private readonly differences: DifferenceWriter) {}

  async compare(input: {
    domain: GovernanceMigrationDomain;
    tenantId?: string;
    resourceType: string;
    resourceId: string;
    legacy: unknown | undefined;
    governance: unknown | undefined;
    blocking?: boolean;
  }): Promise<{ matched: boolean; category?: GovernanceShadowDifference['category']; difference?: GovernanceShadowDifference }> {
    const legacyDigest = input.legacy === undefined ? undefined : governanceProjectionDigest(input.legacy);
    const governanceDigest = input.governance === undefined ? undefined : governanceProjectionDigest(input.governance);
    if (legacyDigest && governanceDigest && legacyDigest === governanceDigest) return { matched: true };
    const category: GovernanceShadowDifference['category'] = input.legacy === undefined
      ? 'missing_legacy'
      : input.governance === undefined
        ? 'missing_governance'
        : 'value_mismatch';
    const difference = await this.differences.recordDifference({
      domain: input.domain,
      ...(input.tenantId ? { tenantId: input.tenantId } : {}),
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      category,
      ...(legacyDigest ? { legacyDigest } : {}),
      ...(governanceDigest ? { governanceDigest } : {}),
      blocking: input.blocking ?? true,
    });
    return { matched: false, category, difference };
  }
}
