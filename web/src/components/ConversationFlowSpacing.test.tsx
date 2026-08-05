import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { AskUserBlock } from './AskUserBlock';
import { CompactionDivider } from './CompactionDivider';
import { ExecutionHiddenPlaceholder } from './ActivityGroupBlock';
import { RuntimeStatusBlock } from './RuntimeStatusBlock';
import { ThinkingBlock } from './ThinkingBlock';
import { ToolBlock } from './ToolBlock';

function expectNoFlowMargin(element: Element | null) {
  expect(element).toBeTruthy();
  expect((element as HTMLElement).className).not.toMatch(/\bm[tyb]-/);
}

describe('主会话非 Markdown 流向间距', () => {
  it('活动、工具、运行状态与压缩分界线根节点均不自行添加纵向 margin', () => {
    const views = [
      <ThinkingBlock key="thinking" content="思考过程" />,
      <ToolBlock key="tool" toolName="Read" toolInput="{}" executionStatus="completed" />,
      <RuntimeStatusBlock key="runtime" status="running" />,
      <ExecutionHiddenPlaceholder key="hidden" isActive={false} durationMs={1200} />,
      <CompactionDivider key="compaction" item={{ id: 'c-1', type: 'compaction', status: 'done', coveredEventCount: 3 }} />,
    ];

    for (const view of views) {
      const { container, unmount } = render(view);
      expectNoFlowMargin(container.firstElementChild);
      unmount();
    }
  });

  it('AskUser 根节点不补底部 margin，选项说明固定使用 11px/16px 档位', () => {
    const { container } = render(
      <AskUserBlock
        questions={[{
          question: '选择处理方式',
          header: '方式',
          multiSelect: false,
          options: [{ label: '继续', description: '保留当前设置继续执行' }],
        }]}
        status="pending"
        onSubmit={vi.fn()}
      />,
    );

    expectNoFlowMargin(container.firstElementChild);
    const description = screen.getByText('保留当前设置继续执行');
    expect(description.className).toContain('text-2xs');
    expect(description.className).toContain('leading-4');
  });
});
