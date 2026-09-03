import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { FilePreviewProvider } from '@/contexts/FilePreviewContext';
import { MessageItem } from './MessageItem';
import type { MessageItem as MessageItemType } from './types';

vi.mock('@/components/artifacts/ArtifactPreviewDialog', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/components/artifacts/ArtifactPreviewDialog')>(),
  ArtifactPreviewDialog: ({ artifactId, onDock }: { artifactId: string; onDock?: () => void }) => (
    <div role="dialog" aria-label="Artifact 预览">
      {artifactId}
      {onDock ? <button type="button" onClick={onDock}>右侧打开</button> : null}
    </div>
  ),
}));

const authFetchMock = vi.fn();
const authFetchResourceMock = vi.fn();
vi.mock('@/lib/authFetch', () => ({
  authFetch: (...args: unknown[]) => authFetchMock(...args),
}));
vi.mock('@agent/shared', async (importOriginal) => ({
  ...await importOriginal<typeof import('@agent/shared')>(),
  authFetchResource: (...args: unknown[]) => authFetchResourceMock(...args),
}));

describe('MessageItem Artifact 卡片', () => {
  beforeEach(() => {
    authFetchMock.mockReset();
    authFetchResourceMock.mockReset();
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn(() => 'blob:artifact-download') });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
  });

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

  it('桌面预览可切换到右侧 Artifact 面板', async () => {
    const openArtifactPreview = vi.fn();
    render(
      <FilePreviewProvider value={{ openPreview: vi.fn(), openArtifactPreview }}>
        <MessageItem message={{
          id: 'artifact-card-dock',
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

    fireEvent.click(screen.getByText('验收报告.pdf'));
    fireEvent.click(await screen.findByRole('button', { name: '右侧打开' }));

    expect(openArtifactPreview).toHaveBeenCalledWith({
      artifactId: 'artifact-1',
      fileName: '验收报告.pdf',
      fileSize: 1024,
      mimeType: 'application/pdf',
    });
    expect(screen.queryByRole('dialog', { name: 'Artifact 预览' })).toBeNull();
  });

  it('下载按钮请求 attachment URL 内容而不影响文件卡预览', async () => {
    authFetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      readUrl: 'https://api.example.com/api/artifacts/artifact-1/content?token=signed&download=true',
      descriptor: {
        artifactId: 'artifact-1', name: '验收报告.pdf', safeMime: 'application/pdf', size: 1024,
        digest: 'a'.repeat(64), viewKind: 'pdf', activeContent: false, requiresWarning: false,
        expiresAt: '2030-01-01T00:00:00.000Z', correlationId: 'corr',
      },
    }), { status: 200 }));
    authFetchResourceMock.mockResolvedValueOnce(new Response('pdf', { status: 200 }));
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
      expect(authFetchMock).toHaveBeenCalledWith('/api/artifacts/artifact-1/read-url?viewPolicyVersion=2&download=true', expect.objectContaining({ cache: 'no-store' }));
      expect(authFetchResourceMock).toHaveBeenCalledWith(
        'https://api.example.com/api/artifacts/artifact-1/content?token=signed&download=true',
        expect.objectContaining({ cache: 'no-store', referrerPolicy: 'no-referrer' }),
      );
      expect(clicked).toEqual([{
        href: 'blob:artifact-download',
        download: '验收报告.pdf',
      }]);
      expect(screen.queryByRole('dialog', { name: 'Artifact 预览' })).toBeNull();
    } finally {
      clickSpy.mockRestore();
    }
  });

  it('主动内容从文件卡下载时也必须二次确认', async () => {
    authFetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      readUrl: 'https://api.example.com/api/artifacts/artifact-1/content?token=signed',
      descriptor: {
        artifactId: 'artifact-1', name: 'run.sh', safeMime: 'text/plain; charset=utf-8', size: 10,
        digest: 'a'.repeat(64), viewKind: 'source', activeContent: true, requiresWarning: true,
        expiresAt: '2030-01-01T00:00:00.000Z', correlationId: 'corr',
      },
    }), { status: 200 }));
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    render(
      <FilePreviewProvider value={{ openPreview: vi.fn() }}>
        <MessageItem message={{
          id: 'artifact-card-active-download', type: 'file_download', fileName: 'run.sh', fileType: 'file',
          filePath: 'artifacts/artifact-1/run.sh', fileSize: 10, artifactId: 'artifact-1', mimeType: 'text/plain',
        }} index={0} />
      </FilePreviewProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: '下载 run.sh' }));
    await waitFor(() => expect(confirmSpy).toHaveBeenCalledOnce());
    expect(clickSpy).not.toHaveBeenCalled();
  });

  it('匿名 Session Share 中 Artifact 明确只读，不提供预览或下载入口', async () => {
    const openPreview = vi.fn();
    render(
      <FilePreviewProvider value={{ openPreview, shareToken: 'session-share-token' }}>
        <MessageItem message={{
          id: 'public-artifact-card',
          type: 'file_download',
          fileName: '公开清单.xlsx',
          fileType: 'xlsx',
          filePath: 'artifacts/artifact-public/公开清单.xlsx',
          fileSize: 2048,
          artifactId: 'artifact-public',
          mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        }} index={0} />
      </FilePreviewProvider>,
    );

    expect(screen.getByText('公开分享中仅展示')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '下载 公开清单.xlsx' })).toBeNull();
    fireEvent.click(screen.getByText('公开清单.xlsx'));
    expect(screen.queryByRole('dialog', { name: 'Artifact 预览' })).toBeNull();
    expect(openPreview).not.toHaveBeenCalled();
    expect(authFetchMock).not.toHaveBeenCalled();
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
