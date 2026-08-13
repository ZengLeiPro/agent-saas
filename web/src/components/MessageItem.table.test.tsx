import { beforeAll, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

import { FilePreviewProvider } from '@/contexts/FilePreviewContext';
import { MessageItem } from './MessageItem';
import type { MessageItem as MessageItemType } from './types';

beforeAll(() => {
  Range.prototype.getClientRects = () => ({
    length: 0,
    item: () => null,
    [Symbol.iterator]: [][Symbol.iterator],
  }) as unknown as DOMRectList;
});

function renderText(message: MessageItemType) {
  return render(
    <FilePreviewProvider value={{ openPreview: vi.fn() }}>
      <MessageItem message={message} index={0} debugMode={false} />
    </FilePreviewProvider>,
  );
}

describe('正文 Markdown 表格宽度', () => {
  it('短表格按内容收缩，同时保留超宽表格的横向滚动容器', async () => {
    renderText({
      id: 'table',
      type: 'text',
      content: [
        '| 确认可复用模块 | 参考实现 |',
        '| --- | --- |',
        '| 工具管理 | ToolControlsManager / tool registry |',
        '| 积分扣费 | billing fixed debit |',
      ].join('\n'),
    });

    const table = await screen.findByRole('table');
    expect(table.className).toContain('w-max');
    expect(table.parentElement?.className).toContain('overflow-x-auto');
  });
});
