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

describe('ActivityGroupBlock 局部异常语义', () => {
  it('单条工具异常使用警告语义，不显示任务失败', () => {
    render(<ActivityGroupBlock items={[failedTool]} isActive={false} debugMode />);

    const badge = screen.getByText('有异常');
    expect(badge.className).toContain('text-warning');
    expect(screen.queryByText('失败')).toBeNull();
  });

  it('分组折叠时按正常完成显示，展开后才显示具体异常', () => {
    const failedToolWithDuration = { ...failedTool, durationMs: 1200 };
    render(<ActivityGroupBlock
      items={[
        { id: 'thinking', type: 'thinking', content: '换一种方法', streaming: false },
        failedToolWithDuration,
      ]}
      isActive={false}
      debugMode
    />);

    const summary = screen.getByText('已完成 2 条：1 次思考 · 1 个工具');
    expect(screen.getByText('已完成 1.2s').className).toContain('text-success');
    expect(screen.queryByText('有异常')).toBeNull();

    fireEvent.click(summary.closest('button')!);

    expect(screen.getByText(/^有异常(?:\s|$)/).className).toContain('text-warning');
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
    expect(screen.getByText('处理中').className).toContain('text-primary');
    expect(screen.queryByText(/异常/)).toBeNull();
  });

  it('关闭调试模式后单条异常仍保留弱提示', () => {
    render(<ActivityGroupBlock items={[failedTool]} isActive={false} debugMode={false} />);

    expect(screen.getByText('已执行，有异常').className).toContain('text-warning');
  });

  it('关闭调试模式后分组异常不污染汇总状态', () => {
    render(<ActivityGroupBlock
      items={[
        { id: 'thinking', type: 'thinking', content: '换一种方法', streaming: false },
        failedTool,
      ]}
      isActive={false}
      debugMode={false}
    />);

    expect(screen.getByText('已执行').className).toContain('text-success');
    expect(screen.queryByText(/异常/)).toBeNull();
  });
});
