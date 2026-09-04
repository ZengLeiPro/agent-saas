import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MessageItem } from './MessageItem';
import type { MessageItem as MessageItemType } from './types';

function renderUserMessage(content: string) {
  const message: MessageItemType = {
    id: 'line-user-collapse',
    type: 'user',
    content,
  };
  return render(<MessageItem message={message} index={0} />);
}

function mockTextMeasurements(scrollHeight: number, clientHeight: number) {
  const scrollHeightSpy = vi
    .spyOn(HTMLElement.prototype, 'scrollHeight', 'get')
    .mockReturnValue(scrollHeight);
  const clientHeightSpy = vi
    .spyOn(HTMLElement.prototype, 'clientHeight', 'get')
    .mockReturnValue(clientHeight);
  return () => {
    scrollHeightSpy.mockRestore();
    clientHeightSpy.mockRestore();
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('用户消息气泡折叠交互', () => {
  it('超过五行时自动折叠，点击整个气泡展开', () => {
    const restoreMeasurements = mockTextMeasurements(120, 100);
    try {
      const { container } = renderUserMessage('第一行\n第二行\n第三行\n第四行\n第五行\n第六行');
      const bubble = screen.getByTestId('user-message-bubble');
      const content = screen.getByText(/第一行/);

      expect(content.className).toContain('line-clamp-5');
      expect(bubble.className).toContain('cursor-pointer');
      expect(container.querySelector('.lucide-chevron-down')).not.toBeNull();

      fireEvent.click(bubble);

      expect(content.className).not.toContain('line-clamp-5');
      expect(bubble.className).not.toContain('cursor-pointer');
      expect(screen.getByRole('button', { name: '收起消息' })).toBeTruthy();
    } finally {
      restoreMeasurements();
    }
  });

  it('展开后点击气泡不收起，只有点击向上箭头才收起', () => {
    const restoreMeasurements = mockTextMeasurements(120, 100);
    try {
      renderUserMessage('第一行\n第二行\n第三行\n第四行\n第五行\n第六行');
      const bubble = screen.getByTestId('user-message-bubble');
      const content = screen.getByText(/第一行/);

      fireEvent.click(bubble);
      fireEvent.click(bubble);
      expect(content.className).not.toContain('line-clamp-5');

      fireEvent.click(screen.getByRole('button', { name: '收起消息' }));
      expect(content.className).toContain('line-clamp-5');
      expect(bubble.className).toContain('cursor-pointer');
    } finally {
      restoreMeasurements();
    }
  });

  it('未超过五行时不显示箭头且气泡不可点击展开', () => {
    const restoreMeasurements = mockTextMeasurements(100, 100);
    try {
      const { container } = renderUserMessage('短消息');
      const bubble = screen.getByTestId('user-message-bubble');

      expect(bubble.className).not.toContain('cursor-pointer');
      expect(container.querySelector('.lucide-chevron-down')).toBeNull();
      expect(screen.queryByRole('button', { name: '收起消息' })).toBeNull();
    } finally {
      restoreMeasurements();
    }
  });
});
