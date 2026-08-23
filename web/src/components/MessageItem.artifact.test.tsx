import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { FilePreviewProvider } from '@/contexts/FilePreviewContext';
import { MessageItem } from './MessageItem';
import type { MessageItem as MessageItemType } from './types';

vi.mock('@/components/artifacts/ArtifactPreviewDialog', () => ({
  ArtifactPreviewDialog: ({ artifactId }: { artifactId: string }) => (
    <div role="dialog" aria-label="Artifact 预览">{artifactId}</div>
  ),
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
});
