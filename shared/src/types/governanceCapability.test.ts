import { describe, expect, it } from 'vitest';

import { GOVERNANCE_CAPABILITIES, governanceCapability } from './governanceCapability';

describe('governance capability inventory', () => {
  it('使用唯一 ID 和受控状态，并明确组织文件与自动化尚未交付', () => {
    expect(new Set(GOVERNANCE_CAPABILITIES.map((item) => item.id)).size).toBe(
      GOVERNANCE_CAPABILITIES.length,
    );
    expect(
      GOVERNANCE_CAPABILITIES.every((item) =>
        ['available', 'read_only', 'unavailable'].includes(item.status),
      ),
    ).toBe(true);
    expect(new Set(GOVERNANCE_CAPABILITIES.map((item) => item.status))).toEqual(
      new Set(['available', 'read_only', 'unavailable']),
    );
    expect(governanceCapability('organization.files')?.status).toBe('unavailable');
    expect(governanceCapability('organization.automation')?.status).toBe('unavailable');
  });
});
