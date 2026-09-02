/**
 * 结构化事实（tool_result.metadata）对 ✓/✗ 徽标的作用。
 *
 * 不变量：退出码是进程的**原值**，平台合成的 executionStatus 是一条转译过的
 * 判定链；两者矛盾时以原值为准，但只做单向校正——退出码 0 不足以把一个已判
 * 失败的调用洗成成功（超时被杀、被中止都可能留下 0）。
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ToolBlock } from './ToolBlock';
import type { ToolResultMetadata } from '@agent/shared';

beforeAll(() => {
  Range.prototype.getClientRects = () => ({
    length: 0,
    item: () => null,
    [Symbol.iterator]: [][Symbol.iterator],
  }) as unknown as DOMRectList;
});

vi.mock('@/lib/authFetch', () => ({
  authFetch: vi.fn(async () => new Response(null, { status: 200 })),
  setOnUnauthorized: vi.fn(),
}));

function renderBlock(
  executionStatus: 'completed' | 'failed' | 'running' | 'cancelled' | 'pending',
  toolMetadata?: ToolResultMetadata,
) {
  return render(
    <ToolBlock
      toolName="Shell"
      toolInput='{"command":"dws todo create --title 复核合同"}'
      result="ok"
      resultReady
      executionStatus={executionStatus}
      {...(toolMetadata ? { toolMetadata } : {})}
      presentation={{ title: '钉钉 · 待办 · create' }}
      debugMode={false}
    />,
  );
}

describe('M40-04 ToolBlock canonical 状态与退出码徽标', () => {
  it('非零退出码把「已完成」校正成「有异常」——平台判定链漏判时以原值为准', () => {
    renderBlock('completed', { exitCode: 127, durationMs: 210 });
    expect(screen.getByText('有异常')).toBeTruthy();
    expect(screen.queryByText('已完成')).toBeNull();
  });

  it('退出码 0 不改变既有判定：completed 仍是已完成', () => {
    renderBlock('completed', { exitCode: 0, stdoutBytes: 128 });
    expect(screen.getByText('已完成')).toBeTruthy();
  });

  it('退出码 0 不得把已判失败的洗成成功——isError 回退链保留', () => {
    renderBlock('failed', { exitCode: 0 });
    expect(screen.getByText('有异常')).toBeTruthy();
  });

  it('无 metadata 时行为与改造前逐像素一致', () => {
    renderBlock('completed');
    expect(screen.getByText('已完成')).toBeTruthy();
    renderBlock('failed');
    expect(screen.getAllByText('有异常').length).toBeGreaterThan(0);
  });

  it('生命周期状态不受退出码影响：进行中/已取消描述的是生命周期而非结果', () => {
    renderBlock('running', { exitCode: 1 });
    expect(screen.getByText('执行中')).toBeTruthy();
    renderBlock('cancelled', { exitCode: 1 });
    expect(screen.getByText('已取消')).toBeTruthy();
  });

  it.each(['completed', 'failed', 'cancelled'] as const)('终态 %s 不残留 spinner', (status) => {
    const { container } = renderBlock(status);
    expect(container.querySelector('.animate-spin')).toBeNull();
  });

  it('未知工具与敏感入参使用安全标题且非 debug 不输出 raw', () => {
    const { container } = render(
      <ToolBlock
        toolName="https://evil.example/token"
        toolInput='{"token":"TOOL_SECRET","path":"/workspace/private"}'
        executionStatus="completed"
        debugMode={false}
      />,
    );
    expect(screen.getByText('工具')).toBeTruthy();
    expect(container.textContent).not.toContain('TOOL_SECRET');
    expect(container.textContent).not.toContain('/workspace');
  });
});
