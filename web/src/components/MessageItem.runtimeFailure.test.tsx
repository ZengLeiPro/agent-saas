import { beforeAll, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MessageItem } from './MessageItem';
import { FilePreviewProvider } from '@/contexts/FilePreviewContext';

beforeAll(() => {
  Range.prototype.getClientRects = () => ({
    length: 0,
    item: () => null,
    [Symbol.iterator]: [][Symbol.iterator],
  }) as unknown as DOMRectList;
});

describe('运行中断提示', () => {
  it('未知运行错误 fail-safe 且不提供盲重试入口', () => {
    const onRetry = vi.fn();
    const message = {
      id: 'runtime-failure-1',
      type: 'system-error' as const,
      severity: 'error' as const,
      content: '回复已中断',
    };

    render(
      <FilePreviewProvider value={{ openPreview: vi.fn() }}>
        <MessageItem
          index={0}
          message={message}
          onRetry={onRetry}
        />
      </FilePreviewProvider>,
    );

    expect(screen.getByRole('alert').textContent).toContain('回复已中断');
    expect(screen.queryByRole('button')).toBeNull();
    expect(onRetry).not.toHaveBeenCalled();
  });

  it('策略拒绝只提供切换模型入口，不继续使用原模型', () => {
    const onRetry = vi.fn();
    const onSwitchModel = vi.fn();
    render(
      <FilePreviewProvider value={{ openPreview: vi.fn() }}>
        <MessageItem
          index={0}
          message={{
            id: 'runtime-policy-rejection',
            type: 'system-error',
            severity: 'error',
            content: '当前模型受策略限制，请切换其他模型继续。',
            failureKind: 'policy_rejection',
            recoveryAction: 'switch_model',
          }}
          onRetry={onRetry}
          onSwitchModel={onSwitchModel}
        />
      </FilePreviewProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: /切换模型/ }));
    expect(onSwitchModel).toHaveBeenCalledTimes(1);
    expect(onRetry).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: /继续生成/ })).toBeNull();
  });

  it('已有回复在运行时不重复提供续跑入口', () => {
    render(
      <FilePreviewProvider value={{ openPreview: vi.fn() }}>
        <MessageItem
          index={0}
          message={{
            id: 'runtime-failure-2',
            type: 'system-error',
            severity: 'error',
            content: '回复已中断',
          }}
          onRetry={vi.fn()}
          isLoading
        />
      </FilePreviewProvider>,
    );

    expect(screen.queryByRole('button', { name: /继续生成/ })).toBeNull();
  });
});
