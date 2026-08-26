import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { FilePreviewProvider } from '@/contexts/FilePreviewContext';
import { MessageItem } from './MessageItem';
import type { MessageItem as MessageItemType } from './types';

vi.mock('@/components/artifacts/ArtifactPreviewDialog', () => ({
  ArtifactPreviewDialog: ({ artifactId }: { artifactId: string }) => (
    <div role="dialog" aria-label="Artifact 预览">{artifactId}</div>
  ),
}));

const authFetchMock = vi.fn();
vi.mock('@/lib/authFetch', () => ({
  authFetch: (...args: unknown[]) => authFetchMock(...args),
}));

describe('MessageItem Artifact 卡片', () => {
  it('点击文件卡时按需加载 Artifact 预览弹窗', async () => {
    const message: MessageItemType = {
      id: 'artifact-card-1',
      type: 'file_download',
      fileName: '客户清单.xlsx',
      fileType: 'xlsx',
      filePath: 'artifacts/artifact-1/客户清单.xlsx',
      fileSize: 6454,
      artifactId: 'artifact-1',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    };
    render(
      <FilePreviewProvider value={{ openPreview: vi.fn() }}>
        <MessageItem message={message} index={0} />
      </FilePreviewProvider>,
    );

    expect(screen.queryByRole('dialog', { name: 'Artifact 预览' })).toBeNull();
    fireEvent.click(screen.getByText('客户清单.xlsx'));
    expect((await screen.findByRole('dialog', { name: 'Artifact 预览' })).textContent).toBe('artifact-1');
  });

  it('下载按钮请求 attachment URL 而不影响文件卡预览', async () => {
    authFetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      url: 'https://api.example.com/api/artifacts/artifact-1/content?token=signed&download=true',
    }), { status: 200 }));
    const clicked: Array<{ href: string; download: string }> = [];
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      clicked.push({ href: this.href, download: this.download });
    });
    try {
      render(
        <FilePreviewProvider value={{ openPreview: vi.fn() }}>
          <MessageItem message={{
            id: 'artifact-card-download',
            type: 'file_download',
            fileName: '验收报告.pdf',
            fileType: 'pdf',
            filePath: 'artifacts/artifact-1/验收报告.pdf',
            fileSize: 1024,
            artifactId: 'artifact-1',
            mimeType: 'application/pdf',
          }} index={0} />
        </FilePreviewProvider>,
      );

      fireEvent.click(screen.getByRole('button', { name: '下载 验收报告.pdf' }));
      await waitFor(() => expect(clicked).toHaveLength(1));
      expect(authFetchMock).toHaveBeenCalledWith('/api/artifacts/artifact-1/read-url?download=true');
      expect(clicked).toEqual([{
        href: 'https://api.example.com/api/artifacts/artifact-1/content?token=signed&download=true',
        download: '验收报告.pdf',
      }]);
      expect(screen.queryByRole('dialog', { name: 'Artifact 预览' })).toBeNull();
    } finally {
      clickSpy.mockRestore();
    }
  });

  it('下载地址获取失败时显示明确提示', async () => {
    authFetchMock.mockResolvedValueOnce(new Response(null, { status: 503 }));
    render(
      <FilePreviewProvider value={{ openPreview: vi.fn() }}>
        <MessageItem message={{
          id: 'artifact-card-download-error',
          type: 'file_download',
          fileName: '验收报告.pdf',
          fileType: 'pdf',
          filePath: 'artifacts/artifact-1/验收报告.pdf',
          fileSize: 1024,
          artifactId: 'artifact-1',
          mimeType: 'application/pdf',
        }} index={0} />
      </FilePreviewProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: '下载 验收报告.pdf' }));
    expect((await screen.findByRole('alert')).textContent).toContain('下载地址获取失败（HTTP 503）');
  });
});
