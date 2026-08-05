import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { CompactionDivider } from './CompactionDivider';

const item = {
  id: 'compaction-1',
  type: 'compaction' as const,
  status: 'done' as const,
  coveredEventCount: 42,
  summary: '压缩后的上下文摘要',
};

describe('CompactionDivider', () => {
  it('普通模式只显示压缩结果，不显示说明和摘要入口', () => {
    render(<CompactionDivider item={item} debugMode={false} />);

    expect(screen.getByText('已压缩 42 条历史消息')).toBeTruthy();
    expect(screen.queryByText('查看摘要')).toBeNull();
    expect(screen.queryByText(/分界线以上的内容/)).toBeNull();
    expect(screen.queryByText(item.summary)).toBeNull();
  });

  it('调试模式可以展开查看摘要', () => {
    render(<CompactionDivider item={item} debugMode />);

    const toggle = screen.getByRole('button', { name: '查看摘要' });
    expect(screen.queryByText(item.summary)).toBeNull();

    fireEvent.click(toggle);

    expect(screen.getByText(item.summary)).toBeTruthy();
  });
});
