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
  it('折叠行为统一的已运行摘要（无标题无卡片），单条异常不在折叠行暴露，展开后可见', () => {
    const { container } = render(<ActivityGroupBlock items={[failedTool]} isActive={false} debugMode />);

    // 摘要即标题：泛化「Agent 活动」标题与具体执行动作均不进入折叠态
    expect(screen.queryByText('Agent 活动')).toBeNull();
    expect(screen.getByText('已运行')).toBeTruthy();
    expect(screen.queryByText(/Shell/)).toBeNull();
    expect(screen.queryByText('有异常')).toBeNull();
    // 排版型：无卡片容器（rounded/border/bg 壳已移除）
    expect(container.querySelector('.rounded-lg.border')).toBeNull();

    const toggle = screen.getByRole('button', { expanded: false });
    expect(toggle.lastElementChild?.classList.contains('lucide-chevron-right')).toBe(true);
    fireEvent.click(toggle);
    expect(screen.getAllByText('有异常').length).toBeGreaterThanOrEqual(1);
  });

  it('多动作组只保留显式业务标题，不机械列举工具描述', () => {
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

    expect(screen.getByText('钉钉 · 待办 list')).toBeTruthy();
    expect(screen.queryByText(/列出工作区文件/)).toBeNull();
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

    // 完成态统一为「已运行」；异常不在折叠行暴露
    const summary = screen.getByText('已运行');
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

    expect(screen.getByText('执行中')).toBeTruthy();
    expect(screen.queryByText(/异常/)).toBeNull();
  });

  it('运行态只显示五种用户可理解的状态，不泄露具体执行内容', () => {
    const { rerender } = render(<ActivityGroupBlock
      items={[{ id: 'thinking', type: 'thinking', content: '分析具体实现', streaming: true }]}
      isActive
      debugMode={false}
    />);
    expect(screen.getByText('思考中')).toBeTruthy();
    expect(screen.queryByText(/分析具体实现/)).toBeNull();

    rerender(<ActivityGroupBlock
      items={[{
        id: 'tool-running',
        type: 'tool_use',
        toolName: 'Shell',
        toolInput: '{"command":"读取客户数据"}',
        toolId: 'tool-running',
        executionStatus: 'running',
        resultReady: false,
      }]}
      isActive
      debugMode={false}
    />);
    expect(screen.getByText('执行中')).toBeTruthy();
    expect(screen.queryByText(/读取客户数据/)).toBeNull();

    rerender(<ActivityGroupBlock
      items={[{ id: 'queued', type: 'runtime_status', status: 'queued', content: '前方还有 3 个任务' }]}
      isActive
      debugMode={false}
    />);
    expect(screen.getByText('排队中')).toBeTruthy();
    expect(screen.queryByText(/前方还有/)).toBeNull();

    rerender(<ActivityGroupBlock
      items={[{ id: 'approval', type: 'runtime_status', status: 'waiting_approval', content: '请授权 Shell' }]}
      isActive
      debugMode={false}
    />);
    expect(screen.getByText('等待授权')).toBeTruthy();
    expect(screen.queryByText(/请授权 Shell/)).toBeNull();

    rerender(<ActivityGroupBlock
      items={[{ id: 'user', type: 'runtime_status', status: 'waiting_user', content: '请选择数据库' }]}
      isActive
      debugMode={false}
    />);
    expect(screen.getByText('等待补充信息')).toBeTruthy();
    expect(screen.queryByText(/请选择数据库/)).toBeNull();
  });

  it('关闭调试模式后显示静态摘要，不渲染按钮、展开语义或 Chevron', () => {
    const { container } = render(<ActivityGroupBlock items={[{ ...failedTool, durationMs: 1200 }]} isActive={false} debugMode={false} />);

    const summary = screen.getByText('已运行');
    const meta = screen.getByText('1.2s · 1 项');
    expect(summary.closest('button')).toBeNull();
    expect(summary.parentElement).toBe(meta.parentElement);
    expect(container.querySelector('[aria-expanded]')).toBeNull();
    expect(container.querySelector('.lucide-chevron-right')).toBeNull();
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
    expect(screen.getByText('已运行')).toBeTruthy();
    expect(screen.queryByText(/exit 1/)).toBeNull();
  });

  it('关闭调试模式后不展示工具自动生成的 presentation 标题', () => {
    const technicalTool = {
      ...failedTool,
      id: 'technical-tool',
      presentation: { title: '读取 CLAUDE.md' },
    };
    const { rerender } = render(<ActivityGroupBlock
      items={[technicalTool]}
      isActive={false}
      debugMode={false}
    />);

    expect(screen.getByText('已运行')).toBeTruthy();
    expect(screen.queryByText('读取 CLAUDE.md')).toBeNull();

    rerender(<ActivityGroupBlock
      items={[
        technicalTool,
        { ...technicalTool, id: 'technical-tool-2', presentation: { title: '执行命令' } },
      ]}
      isActive={false}
      debugMode={false}
    />);

    expect(screen.getByText('已运行')).toBeTruthy();
    expect(screen.queryByText(/读取 CLAUDE\.md|执行命令/)).toBeNull();
  });

  it('调试模式始终保留活动组折叠层，展开后才显示组内动作', () => {
    render(<ActivityGroupBlock
      items={[
        { id: 'thinking', type: 'thinking', content: '换一种方法', streaming: false },
        failedTool,
      ]}
      isActive={false}
      debugMode
    />);

    const toggle = screen.getByRole('button', { name: /已运行.*2 项/ });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText(/有异常/)).toBeNull();

    fireEvent.click(toggle);
    expect(screen.getAllByText(/有异常/).length).toBeGreaterThanOrEqual(1);
  });
});
