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

describe('最终输出分隔线', () => {
  it('只在 finalOutput 文本上方渲染弱分隔线', () => {
    renderText({
      id: 'final',
      type: 'text',
      content: '这是最终回答',
      finalOutput: true,
    });

    const divider = screen.getByTestId('final-output-divider');
    expect(divider.getAttribute('aria-hidden')).toBe('true');
    expect(divider.className).toContain('border-border/70');
  });

  it('阶段性 commentary 与普通历史文本不渲染分隔线', () => {
    const { rerender } = renderText({
      id: 'commentary',
      type: 'text',
      content: '我先检查一下',
      runId: 'run-1',
    });
    expect(screen.queryByTestId('final-output-divider')).toBeNull();

    rerender(
      <FilePreviewProvider value={{ openPreview: vi.fn() }}>
        <MessageItem
          message={{ id: 'legacy', type: 'text', content: '旧历史回答' }}
          index={0}
          debugMode={false}
        />
      </FilePreviewProvider>,
    );
    expect(screen.queryByTestId('final-output-divider')).toBeNull();
  });
});
