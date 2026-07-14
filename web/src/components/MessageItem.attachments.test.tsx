/**
 * 用户消息附件 chip 交互测试（2026-07-14 点击预览/下载批次）
 *
 * 1. 存量消息（无 relativePath）保持静态展示，无可点击语义
 * 2. 可预览文件（pdf）点击调 openPreview(relativePath, owner)
 * 3. 图片点击打开 lightbox
 * 4. 不可预览类型点击走下载（authFetch 到 /api/file/download）
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { initPlatform } from '@agent/shared';
import type { PlatformDeps } from '@agent/shared';
import { MessageItem } from './MessageItem';
import { FilePreviewProvider } from '@/contexts/FilePreviewContext';
import type { MessageItem as MessageItemType } from './types';

beforeAll(() => {
  Range.prototype.getClientRects = () => ({
    length: 0,
    item: () => null,
    [Symbol.iterator]: [][Symbol.iterator],
  }) as unknown as DOMRectList;
  // resolveImageSrc（下载/图片 URL 构造）依赖 platform context
  initPlatform({
    secureStorage: { getItem: async () => null, setItem: async () => {}, removeItem: async () => {} },
    platformConfig: { getBaseUrl: () => '' },
  } as unknown as PlatformDeps);
});

const authFetchMock = vi.fn(async () => new Response(new Blob(['x']), { status: 200 }));
vi.mock('@/lib/authFetch', () => ({
  authFetch: (...args: unknown[]) => authFetchMock(...args as []),
  setOnUnauthorized: vi.fn(),
}));

function userMessage(
  attachments: Array<{ name: string; isImage?: boolean; relativePath?: string }>,
): MessageItemType {
  return { id: 'line-1', type: 'user', content: '看下附件', attachments };
}

function renderMessage(message: MessageItemType, openPreview = vi.fn(), owner?: string) {
  return render(
    <FilePreviewProvider value={{ openPreview, ...(owner ? { owner } : {}) }}>
      <MessageItem message={message} index={0} />
    </FilePreviewProvider>,
  );
}

describe('用户消息附件 chip', () => {
  it('存量附件（无 relativePath）保持静态展示', () => {
    const openPreview = vi.fn();
    renderMessage(userMessage([{ name: '旧附件.pdf' }]), openPreview);
    expect(screen.getByText('旧附件.pdf')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /旧附件/ })).toBeNull();
    fireEvent.click(screen.getByText('旧附件.pdf'));
    expect(openPreview).not.toHaveBeenCalled();
  });

  it('可预览文件点击调 openPreview(relativePath, owner)', () => {
    const openPreview = vi.fn();
    renderMessage(
      userMessage([{ name: '报价单.pdf', relativePath: 'uploads/att-1/报价单.pdf' }]),
      openPreview,
      'u-wu',
    );
    fireEvent.click(screen.getByText('报价单.pdf'));
    expect(openPreview).toHaveBeenCalledWith('uploads/att-1/报价单.pdf', 'u-wu');
  });

  it('图片点击打开 lightbox', async () => {
    renderMessage(
      userMessage([{ name: 'photo.png', isImage: true, relativePath: 'uploads/att-2/photo.png' }]),
    );
    fireEvent.click(screen.getByText('photo.png'));
    await waitFor(() => {
      expect(screen.getByAltText('photo.png')).toBeTruthy();
    });
    // 点击遮罩关闭
    fireEvent.click(screen.getByRole('button', { name: '关闭预览' }));
    expect(screen.queryByAltText('photo.png')).toBeNull();
  });

  it('不可预览类型点击走 <a download> 下载', async () => {
    // .zip 无预览面板 → authFetchDownload（构带 token 的 /api/file/download URL 后 a.click()）
    const clicked: Array<{ href: string; download: string }> = [];
    const clickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(function (this: HTMLAnchorElement) {
        clicked.push({ href: this.href, download: this.download });
      });
    try {
      renderMessage(
        userMessage([{ name: 'archive.zip', relativePath: 'uploads/att-3/archive.zip' }]),
      );
      fireEvent.click(screen.getByText('archive.zip'));
      await waitFor(() => {
        expect(clicked).toHaveLength(1);
      });
      expect(clicked[0].href).toContain('/api/file/download?path=uploads%2Fatt-3%2Farchive.zip');
      expect(clicked[0].download).toBe('archive.zip');
    } finally {
      clickSpy.mockRestore();
    }
  });
});
