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
  it('表格限制在内容区内，并保留超宽表格的横向滚动容器', async () => {
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
    expect(table.className).not.toContain('w-max');
    expect(table.parentElement?.className).toContain('max-w-full');
    expect(table.parentElement?.className).toContain('overflow-x-auto');
  });

  it('将 GFM 右对齐列改为左对齐，但保留居中列', async () => {
    renderText({
      id: 'aligned-table',
      type: 'text',
      content: [
        '| 左对齐 | 右对齐 | 居中 |',
        '| --- | ---: | :---: |',
        '| 文本 | 数值 | 状态 |',
      ].join('\n'),
    });

    const table = await screen.findByRole('table');
    const [left, right, center] = Array.from(table.querySelectorAll('th'));
    expect(left.style.textAlign).toBe('');
    expect(right.style.textAlign).toBe('left');
    expect(center.style.textAlign).toBe('center');
  });
});
