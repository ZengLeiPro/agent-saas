import { render, screen } from '@testing-library/react';
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

  it('分组异常显示未成功步骤数，不把整组标成失败', () => {
    render(<ActivityGroupBlock
      items={[
        { id: 'thinking', type: 'thinking', content: '换一种方法', streaming: false },
        failedTool,
      ]}
      isActive={false}
      debugMode
    />);

    expect(screen.getByText('执行结束 · 1 个步骤未成功')).toBeTruthy();
    expect(screen.getByText('有异常').className).toContain('text-warning');
    expect(screen.queryByText(/执行异常/)).toBeNull();
  });

  it('关闭调试模式后仍保留弱异常提示', () => {
    render(<ActivityGroupBlock items={[failedTool]} isActive={false} debugMode={false} />);

    expect(screen.getByText('已执行，有异常').className).toContain('text-warning');
  });
});
