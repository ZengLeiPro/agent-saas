import { describe, expect, it } from 'vitest';

import { settingsPageWidthClass } from './settingsLayout';

describe('设置页面宽度分级', () => {
  it('紧凑页和标准页保持居中且使用不同最大宽度', () => {
    expect(settingsPageWidthClass('compact')).toContain('max-w-6xl');
    expect(settingsPageWidthClass('compact')).toContain('mx-auto');
    expect(settingsPageWidthClass('standard')).toContain('max-w-7xl');
    expect(settingsPageWidthClass('standard')).toContain('mx-auto');
  });

  it('宽页面占满可用空间', () => {
    expect(settingsPageWidthClass('wide')).toBe('w-full');
  });
});
