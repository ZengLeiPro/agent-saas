import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MessageItem } from './MessageItem';
import type { MessageItem as MessageItemType } from './types';

type UserMessage = Extract<MessageItemType, { type: 'user' }>;

function userMessage(overrides: Partial<Omit<UserMessage, 'type'>> = {}): UserMessage {
  return {
    id: 'line-user-1',
    type: 'user',
    content: 'hello hover',
    ...overrides,
  };
}

describe('用户消息操作栏 hover 命中区', () => {
  it('操作栏在 group 内以文档流 footer 渲染，而非 h-0 absolute 悬空层', () => {
    const { container } = render(<MessageItem message={userMessage()} index={1} />);
    const actions = screen.getByTestId('user-message-actions');
    const group = container.querySelector('.group');

    expect(group).not.toBeNull();
    expect(group!.contains(actions)).toBe(true);
    expect(actions.className).toContain('flex');
    expect(actions.className).toContain('items-center');
    expect(actions.className).toContain('justify-end');
    // desktop hide-until-group-hover; mobile stays opacity-100
    expect(actions.className).toContain('opacity-100');
    expect(actions.className).toContain('md:opacity-0');
    expect(actions.className).toContain('md:group-hover:opacity-100');
    // regression: old pattern left actions outside the group's layout hover box
    expect(actions.className).not.toContain('absolute');
    expect(actions.className).not.toContain('h-0');
    expect(actions.parentElement?.className ?? '').not.toMatch(/\bh-0\b/);
    expect(screen.getByTitle('Copy')).toBeTruthy();
  });

  it('失败态不渲染操作栏，重试入口仍可用', () => {
    const onRetry = vi.fn();
    render(
      <MessageItem
        message={userMessage({ status: 'failed', failedReason: '网络错误' })}
        index={1}
        onRetry={onRetry}
      />,
    );

    expect(screen.queryByTestId('user-message-actions')).toBeNull();
    expect(screen.queryByTitle('Copy')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('fork 按钮仍出现在操作栏内', () => {
    const onFork = vi.fn();
    render(
      <MessageItem
        message={userMessage()}
        index={1}
        onFork={onFork}
        isFirstUser={false}
        isLoading={false}
      />,
    );

    const fork = screen.getByTitle('从此编辑');
    expect(screen.getByTestId('user-message-actions').contains(fork)).toBe(true);
    fireEvent.click(fork);
    expect(onFork).toHaveBeenCalledTimes(1);
  });
});
