import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { Tabs, TabsList, TabsTrigger } from './tabs';

function renderTabs(variant: 'primary' | 'secondary', count: number) {
  render(
    <Tabs defaultValue="tab-0">
      <TabsList variant={variant} aria-label={`${variant} tabs`}>
        {Array.from({ length: count }, (_, index) => (
          <TabsTrigger key={index} value={`tab-${index}`}>
            标签 {index + 1}
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>,
  );
  return screen.getByRole('tablist', { name: `${variant} tabs` });
}

describe('page tabs presentation', () => {
  it('一级标签在两项时自动采用紧凑宽度', () => {
    const tablist = renderTabs('primary', 2);

    expect(tablist.getAttribute('data-tabs-layout')).toBe('compact');
    expect(tablist.className).toContain('md:w-72');
    expect(screen.getAllByRole('tab')[0]?.className).toContain('flex-1');
  });

  it('一级标签在四项时自动铺满', () => {
    const tablist = renderTabs('primary', 4);

    expect(tablist.getAttribute('data-tabs-layout')).toBe('full');
    expect(tablist.className).toContain('w-full');
    expect(screen.getAllByRole('tab')[0]?.className).toContain('grow');
    expect(screen.getAllByRole('tab')[0]?.className).toContain('shrink-0');
  });

  it('二级标签弱化显示且少量标签保持紧凑', () => {
    const tablist = renderTabs('secondary', 2);

    expect(tablist.getAttribute('data-tabs-layout')).toBe('compact');
    expect(tablist.className).toContain('md:w-56');
    expect(tablist.className).toContain('bg-muted/60');
    expect(tablist.className).not.toContain('shadow-sm');
    expect(screen.getAllByRole('tab')[0]?.className).toContain('data-[state=active]:bg-card');
  });
});
