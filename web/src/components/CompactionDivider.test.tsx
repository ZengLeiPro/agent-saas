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
  it('普通模式不渲染压缩结果', () => {
    const { container } = render(<CompactionDivider item={item} debugMode={false} />);

    expect(screen.queryByText('已压缩 42 条历史消息')).toBeNull();
    expect(screen.queryByText('查看摘要')).toBeNull();
    expect(screen.queryByText(item.summary)).toBeNull();
    expect(container.firstChild).toBeNull();
  });

  it('调试模式显示压缩结果，并可以展开查看摘要', () => {
    render(<CompactionDivider item={item} debugMode />);

    expect(screen.getByText('已压缩 42 条历史消息')).toBeTruthy();
    const toggle = screen.getByRole('button', { name: '查看摘要' });
    expect(screen.queryByText(item.summary)).toBeNull();

    fireEvent.click(toggle);

    expect(screen.getByText(item.summary)).toBeTruthy();
  });
});
