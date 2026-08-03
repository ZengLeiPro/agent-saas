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

describe('ActivityGroupBlock 排版型活动行', () => {
  it('折叠行为一行摘要（无标题无卡片），单条异常不在折叠行暴露，展开后可见', () => {
    const { container } = render(<ActivityGroupBlock items={[failedTool]} isActive={false} debugMode />);

    // 摘要即标题：泛化「Agent 活动」标题已删除
    expect(screen.queryByText('Agent 活动')).toBeNull();
    // 无业务标题可列举时给最轻的一句话，且不落到英文工具名
    expect(screen.getByText(/已完成 1 项/)).toBeTruthy();
    expect(screen.queryByText(/Shell/)).toBeNull();
    expect(screen.queryByText('有异常')).toBeNull();
    // 排版型：无卡片容器（rounded/border/bg 壳已移除）
    expect(container.querySelector('.rounded-lg.border')).toBeNull();

    fireEvent.click(screen.getByRole('button', { expanded: false }));
    expect(screen.getAllByText('有异常').length).toBeGreaterThanOrEqual(1);
  });

  it('折叠行列举业务标题（presentation.title 优先，description 兜底），不再输出机器计数', () => {
    render(<ActivityGroupBlock
      items={[
        { id: 'thinking', type: 'thinking', content: '先查待办', streaming: false },
        {
          id: 'tool-dws',
          type: 'tool_use',
          toolName: 'Shell',
          toolInput: '{"command":"dws todo list"}',
          toolId: 'call-dws',
          executionStatus: 'completed',
          resultReady: true,
          result: 'ok',
          presentation: { title: '钉钉 · 待办 list' },
        },
        {
          id: 'tool-desc',
          type: 'tool_use',
          toolName: 'Shell',
          toolInput: '{"command":"ls","description":"列出工作区文件"}',
          toolId: 'call-desc',
          executionStatus: 'completed',
          resultReady: true,
          result: 'ok',
        },
      ]}
      isActive={false}
      debugMode
    />);

    expect(screen.getByText(/钉钉 · 待办 list、列出工作区文件/)).toBeTruthy();
    expect(screen.queryByText(/次思考/)).toBeNull();
    expect(screen.queryByText(/个工具/)).toBeNull();
  });

  it('分组内一条失败不影响折叠行的正常完成展示，展开后显示具体异常', () => {
    const failedToolWithDuration = { ...failedTool, durationMs: 1200 };
    render(<ActivityGroupBlock
      items={[
        { id: 'thinking', type: 'thinking', content: '换一种方法', streaming: false },
        failedToolWithDuration,
      ]}
      isActive={false}
      debugMode
    />);

    // 无业务标题、含思考 → 「已思考」；异常不在折叠行暴露
    const summary = screen.getByText('已思考');
    expect(screen.queryByText('有异常')).toBeNull();
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

    expect(screen.getByText(/正在处理/)).toBeTruthy();
    expect(screen.queryByText(/异常/)).toBeNull();
  });

  it('关闭调试模式后保留原折叠态与摘要元信息，但禁用展开交互', () => {
    render(<ActivityGroupBlock items={[{ ...failedTool, durationMs: 1200 }]} isActive={false} debugMode={false} />);

    const summary = screen.getByText(/已完成 1 项/);
    const button = summary.closest('button') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(button.querySelector('.lucide-chevron-right')).toBeTruthy();
    expect(screen.getByText(/1\.2s.*1 项/)).toBeTruthy();
    fireEvent.click(button);
    expect(screen.queryByText('有异常')).toBeNull();
    expect(screen.queryByText(/已执行，有异常/)).toBeNull();
    expect(screen.queryByText(/exit 1/)).toBeNull();
  });

  it('关闭调试模式后分组折叠行保持正常完成展示，且不泄露内部细节', () => {
    render(<ActivityGroupBlock
      items={[
        { id: 'thinking', type: 'thinking', content: '换一种方法', streaming: false },
        failedTool,
      ]}
      isActive={false}
      debugMode={false}
    />);

    expect(screen.queryByText('有异常')).toBeNull();
    expect(screen.getByText('已思考')).toBeTruthy();
    expect(screen.queryByText(/exit 1/)).toBeNull();
  });

  it('flat 模式（业务步骤节内）直接平铺内容，无折叠壳', () => {
    render(<ActivityGroupBlock
      items={[
        { id: 'thinking', type: 'thinking', content: '换一种方法', streaming: false },
        failedTool,
      ]}
      isActive={false}
      debugMode
      flat
    />);

    // 无折叠行摘要（组级 meta「N 项」不出现），内容直接平铺（节的「过程」折叠是唯一收纳层）；
    // ThinkingBlock / ToolBlock 保持各自的一级折叠行为。
    expect(screen.queryByText(/2 项/)).toBeNull();
    expect(screen.getAllByText(/有异常/).length).toBeGreaterThanOrEqual(1);
  });
});
