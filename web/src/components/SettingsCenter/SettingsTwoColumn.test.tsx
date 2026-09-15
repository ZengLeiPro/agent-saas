import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { SettingsTwoColumn } from './SettingsTwoColumn';

describe('SettingsTwoColumn 滚动契约', () => {
  it('左栏限定高度可内滚，右栏跟随主区不设独立纵向滚动', () => {
    const { container } = render(
      <SettingsTwoColumn sidebar={<div>侧栏</div>}>
        <div>主内容</div>
      </SettingsTwoColumn>,
    );
    const grid = container.firstElementChild as HTMLElement;
    const [sidebar, content] = Array.from(grid.children) as HTMLElement[];
    expect(sidebar.className).toContain('md:overflow-auto');
    expect(sidebar.className).toMatch(/md:max-h-/);
    expect(content.className).not.toContain('overflow-auto');
    expect(screen.getByText('侧栏')).toBeTruthy();
    expect(screen.getByText('主内容')).toBeTruthy();
  });
});
