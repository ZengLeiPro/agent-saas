import { describe, expect, it } from 'vitest';

import { formatUsageRangeLabel } from './format';

describe('formatUsageRangeLabel', () => {
  it('全部范围有数据时继续显示后端返回的真实 earliest date', () => {
    expect(formatUsageRangeLabel('2025-12-03', '2026-08-14', { range: 'all', hasData: true }))
      .toBe('2025-12-03 → 2026-08-14');
  });

  it('全部范围无数据时显示无数据语义，不展示日期哨兵', () => {
    expect(formatUsageRangeLabel('0000-01-01', '2026-08-14', { range: 'all', hasData: false }))
      .toBe('全部历史 / 无数据');
  });
});
