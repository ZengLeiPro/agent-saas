import { describe, expect, it, vi } from 'vitest';

import { GovernanceDomainShadowAuditor } from '../data/migrationControl/index.js';

describe('GovernanceDomainShadowAuditor', () => {
  it('按真实比较结果写入 Domain 快照，空批次不会伪造 ready', async () => {
    const states = {
      listDomains: vi.fn().mockResolvedValue([{ domain: 'assignment', revision: 7 }]),
      recordDomainSnapshot: vi.fn().mockResolvedValue({}),
    };
    const comparator = {
      countOpenBlockingDifferences: vi.fn().mockResolvedValue(1),
      compare: vi.fn()
        .mockResolvedValueOnce({ matched: true })
        .mockResolvedValueOnce({ matched: false, category: 'value_mismatch' }),
    };
    const auditor = new GovernanceDomainShadowAuditor({ comparator: comparator as never, states });
    await expect(auditor.audit('assignment', [
      { tenantId: 'acme', resourceType: 'org_agent', resourceId: 'a1', legacy: { allow: true }, governance: { allow: true } },
      { tenantId: 'acme', resourceType: 'skill', resourceId: 's1', legacy: { allow: true }, governance: { allow: false } },
    ])).resolves.toEqual({ comparedCount: 2, matchedCount: 1, differenceCount: 1 });
    expect(states.recordDomainSnapshot).toHaveBeenCalledWith(expect.objectContaining({
      domain: 'assignment', expectedRevision: 7, comparedCount: 2,
      matchedCount: 1, differenceCount: 1, unresolvedBlockingCount: 1,
    }));
  });
});
