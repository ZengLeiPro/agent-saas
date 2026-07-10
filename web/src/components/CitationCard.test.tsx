/**
 * CitationCard 测试（计划用例 4-6）
 *
 * 4. pdf 点击 → 以 kb://<doc>#page=N 调 openPreview(mode='side')
 * 5. shareToken（分享页）→ 徽标禁用零副作用
 * 6. 图片 → 组件内 lightbox（不走 openPreview）
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CitationCard } from './CitationCard';
import { FilePreviewProvider } from '@/contexts/FilePreviewContext';

vi.mock('@agent/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent/shared')>();
  return {
    ...actual,
    resolveKbFileSrc: vi.fn(async (path: string) => `https://example.test/api/kb/file?path=${encodeURIComponent(path)}&token=t`),
  };
});

describe('CitationCard', () => {
  it('用例4: pdf 点击以 kb://+page 调 openPreview(mode=side)', () => {
    const openPreview = vi.fn();
    render(
      <FilePreviewProvider value={{ openPreview }}>
        <CitationCard doc="catalog/接插件.pdf" page={12} label="接插件选型 p.12" />
      </FilePreviewProvider>,
    );
    const button = screen.getByRole('button', { name: '引用：接插件选型 p.12' });
    expect((button as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(button);
    expect(openPreview).toHaveBeenCalledTimes(1);
    expect(openPreview).toHaveBeenCalledWith('kb://catalog/接插件.pdf#page=12', undefined, { mode: 'side' });
  });

  it('用例5: shareToken 场景禁用徽标且点击零副作用', () => {
    const openPreview = vi.fn();
    render(
      <FilePreviewProvider value={{ openPreview, shareToken: 'share-token-1' }}>
        <CitationCard doc="catalog/接插件.pdf" page={3} label="接插件 p.3" />
      </FilePreviewProvider>,
    );
    const button = screen.getByRole('button', { name: '引用：接插件 p.3' });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(button.getAttribute('title')).toBe('引用文档需登录查看');
    fireEvent.click(button);
    expect(openPreview).not.toHaveBeenCalled();
  });

  it('用例6: 图片引用走组件内 lightbox，不调 openPreview', async () => {
    const openPreview = vi.fn();
    render(
      <FilePreviewProvider value={{ openPreview }}>
        <CitationCard doc="images/结构图.png" label="结构图" />
      </FilePreviewProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: '引用：结构图' }));
    await waitFor(() => {
      expect(screen.getByAltText('结构图')).toBeTruthy();
    });
    expect(openPreview).not.toHaveBeenCalled();
    // 点击遮罩关闭
    fireEvent.click(screen.getByRole('button', { name: '关闭预览' }));
    expect(screen.queryByAltText('结构图')).toBeNull();
  });
});
