import { beforeAll, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MessageItem } from './MessageItem';
import { FilePreviewProvider } from '@/contexts/FilePreviewContext';
import { requestOpenBillingBadge } from '@/lib/billingBadgeBus';

vi.mock('@/lib/billingBadgeBus', () => ({
  requestOpenBillingBadge: vi.fn(),
}));

beforeAll(() => {
  Range.prototype.getClientRects = () => ({
    length: 0,
    item: () => null,
    [Symbol.iterator]: [][Symbol.iterator],
  }) as unknown as DOMRectList;
});

describe('积分余额不足提示', () => {
  it('使用独立积分卡片并提供查看积分入口', () => {
    render(
      <FilePreviewProvider value={{ openPreview: vi.fn() }}>
        <MessageItem
          index={0}
          message={{
            id: 'billing-1',
            type: 'system-error',
            severity: 'billing',
            content: '当前组织积分余额不足，本次任务尚未开始。请补充积分或联系组织管理员调整额度后再试。',
          }}
        />
      </FilePreviewProvider>,
    );

    expect(screen.getByRole('status')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByText('积分余额不足')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '查看积分' }));
    expect(requestOpenBillingBadge).toHaveBeenCalledTimes(1);
  });
});
