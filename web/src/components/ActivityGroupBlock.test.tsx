import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { MessageItem } from './types';
import { ActivityGroupBlock } from './ActivityGroupBlock';

const failedTool: Extract<MessageItem, { type: 'tool_use' }> = {
  id: 'tool-failed',
  type: 'tool_use',
  toolName: 'Shell',
  toolInput: '{"cmd":"exit 1"}',
  toolId: 'call-failed',
  executionStatus: 'failed',
  resultReady: true,
  result: 'tool error: exit code 1',
};

describe('ActivityGroupBlock 统一活动卡', () => {
  it('单条活动也使用统一外壳，展开后显示具体异常', () => {
    render(<ActivityGroupBlock items={[failedTool]} isActive={false} debugMode />);

    expect(screen.getByText('Agent 活动')).toBeTruthy();
    expect(screen.getByText('有异常')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { expanded: false }));
    expect(screen.getAllByText('有异常').length).toBeGreaterThanOrEqual(2);
  });

  it('分组折叠时保留异常状态，展开后显示具体异常', () => {
    const failedToolWithDuration = { ...failedTool, durationMs: 1200 };
    render(<ActivityGroupBlock
      items={[
        { id: 'thinking', type: 'thinking', content: '换一种方法', streaming: false },
        failedToolWithDuration,
      ]}
      isActive={false}
      debugMode
    />);

    const summary = screen.getByText('已处理 2 条：1 次思考 · 1 个工具');
    expect(screen.getByText('有异常')).toBeTruthy();
    expect(screen.getByText(/1\.2s.*2 项/)).toBeTruthy();

    fireEvent.click(summary.closest('button')!);

    expect(screen.getAllByText(/^有异常(?:\s|$)/).some((node) => node.className.includes('text-warning'))).toBe(true);
  });

  it('分组仍在运行时也不在折叠行暴露内部异常', () => {
    render(<ActivityGroupBlock
      items={[
        { id: 'thinking', type: 'thinking', content: '换一种方法', streaming: false },
        failedTool,
      ]}
      isActive
      debugMode
    />);

    expect(screen.getByText('正在处理')).toBeTruthy();
    expect(screen.getByText('运行中')).toBeTruthy();
    expect(screen.queryByText(/异常/)).toBeNull();
  });

  it('关闭调试模式后仍使用统一外壳', () => {
    render(<ActivityGroupBlock items={[failedTool]} isActive={false} debugMode={false} />);

    expect(screen.getByText('Agent 活动')).toBeTruthy();
    expect(screen.getByText('有异常')).toBeTruthy();
  });

  it('关闭调试模式后分组仍保留异常汇总，但不泄露内部细节', () => {
    render(<ActivityGroupBlock
      items={[
        { id: 'thinking', type: 'thinking', content: '换一种方法', streaming: false },
        failedTool,
      ]}
      isActive={false}
      debugMode={false}
    />);

    expect(screen.getByText('有异常')).toBeTruthy();
    expect(screen.getByText('已处理 2 条：1 次思考 · 1 个工具')).toBeTruthy();
    expect(screen.queryByText(/exit 1/)).toBeNull();
  });
});
