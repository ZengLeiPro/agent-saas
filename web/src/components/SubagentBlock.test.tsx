import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { SubagentBlock } from './SubagentBlock';

vi.mock('@/lib/authFetch', () => ({
  authFetch: vi.fn(async () => new Response(JSON.stringify({
    sessionId: 'sub-child',
    stats: { lines: 2, parsedLines: 2, parseErrors: 0 },
    lastRunState: { runId: 'child-run', status: 'failed', error: 'upstream EOF' },
    blocks: [
      { id: 'prompt', kind: 'prompt', title: '输入', defaultOpen: true, content: '调研任务' },
      { id: 'result', kind: 'text', title: '输出', defaultOpen: true, content: '部分结果' },
    ],
  }), { status: 200, headers: { 'content-type': 'application/json' } })),
}));

describe('SubagentBlock', () => {
  it('expands metrics and opens the child transcript read-only dialog', async () => {
    const user = userEvent.setup();
    render(
      <SubagentBlock
        agentType="调研金球奖"
        status="failed"
        childSessionId="sub-child"
        childRunId="child-run"
        model="gpt-5.6"
        durationMs={600_000}
        totalTokens={123_456}
        toolUseCount={67}
        turnCount={42}
        errorMessage="upstream EOF"
        resultPreview="部分材料"
      />,
    );

    await user.click(screen.getByRole('button', { name: /子任务 调研金球奖/ }));
    expect(screen.getByText('42 turns')).toBeTruthy();
    expect(screen.getByText('67 次工具')).toBeTruthy();
    expect(screen.getByText('upstream EOF')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: '查看完整过程' }));
    expect(await screen.findByRole('dialog', { name: '调研金球奖完整过程' })).toBeTruthy();
    expect(await screen.findByText('终止原因：upstream EOF')).toBeTruthy();
    expect(screen.getByText('调研任务')).toBeTruthy();
  });
});
