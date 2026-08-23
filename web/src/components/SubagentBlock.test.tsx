import { useState, type ReactNode } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import {
  SubagentTranscriptProvider,
  useSubagentTranscript,
  type SubagentTranscriptTarget,
} from '@/contexts/SubagentTranscriptContext';
import { SubagentBlock } from './SubagentBlock';
import { SubagentTranscriptPanel } from './SubagentTranscriptPanel';

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

function TestSubagentTranscriptProvider({ children }: { children: ReactNode }) {
  const [transcript, setTranscript] = useState<SubagentTranscriptTarget | null>(null);
  return (
    <SubagentTranscriptProvider value={{
      transcript,
      openTranscript: setTranscript,
      closeTranscript: () => setTranscript(null),
    }}>
      {children}
    </SubagentTranscriptProvider>
  );
}

function TranscriptPanelHost() {
  const context = useSubagentTranscript();
  if (!context?.transcript) return null;
  return (
    <SubagentTranscriptPanel
      childSessionId={context.transcript.childSessionId}
      title={context.transcript.title}
      onClose={context.closeTranscript}
    />
  );
}

describe('SubagentBlock', () => {
  it('expands metrics and opens the child transcript in the shared side panel', async () => {
    const user = userEvent.setup();
    const onSwitchModel = vi.fn();
    render(
      <TestSubagentTranscriptProvider>
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
          errorMessage="当前模型受策略限制，请切换其他模型继续。"
          failureKind="policy_rejection"
          recoveryAction="switch_model"
          resultPreview="部分材料"
          onSwitchModel={onSwitchModel}
        />
        <TranscriptPanelHost />
      </TestSubagentTranscriptProvider>,
    );

    // 排版型外壳：状态文字标签已删，失败语义由红色 icon 承载；折叠行只显示标题和指标。
    expect(screen.queryByText('部分材料')).toBeNull();
    expect(screen.getByText('gpt-5.6 · 10m · 42 轮 · 123.5k tokens')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: '切换模型' }));
    expect(onSwitchModel).toHaveBeenCalledOnce();

    await user.click(screen.getByRole('button', { name: /子任务 调研金球奖/ }));
    expect(screen.getByText('42 轮')).toBeTruthy();
    expect(screen.getByText('67 次工具')).toBeTruthy();
    expect(screen.getByText('当前模型受策略限制，请切换其他模型继续。')).toBeTruthy();
    expect(screen.getAllByText('部分材料').some((node) => node.className.includes('leading-4'))).toBe(true);

    await user.click(screen.getAllByRole('button', { name: '查看完整过程' })[0]);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(await screen.findByRole('region', { name: '子任务完整过程 · 调研金球奖' })).toBeTruthy();
    expect(await screen.findByText('终止原因：upstream EOF')).toBeTruthy();
    expect(screen.getByText('调研任务')).toBeTruthy();
  });
});
