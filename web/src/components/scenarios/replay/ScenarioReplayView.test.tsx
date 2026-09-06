/**
 * 场景回放视图测试。
 *
 * 最重要的一条是「回放与真实会话走同一主卡和详情投影」——它对应本批次的
 * 验收标准：演示与普通客户视图必须同构，不允许存在只有演示看得到的内容。
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ScenarioReplayView } from './ScenarioReplayView';
import source from './ScenarioReplayView.tsx?raw';
import { knowledgeQaScript } from '@agent/shared/scenarios/replay/knowledgeQaScript';
import { deadlineWatchScript } from '@agent/shared/scenarios/replay/deadlineWatchScript';
import type { ReplayScript } from '@agent/shared/scenarios/replay/types';
import { makeWorkflowScenario } from '../workflowTestFixtures';
import {
  buildTechnicalInquiryTraceScript,
  TECHNICAL_INQUIRY_TRACE_SCENARIO_ID,
} from '@agent/shared/scenarios/replay/technicalInquiryTraceScript';

let mobileViewport = false;

beforeAll(() => {
  Range.prototype.getClientRects = () => ({
    length: 0,
    item: () => null,
    [Symbol.iterator]: [][Symbol.iterator],
  }) as unknown as DOMRectList;
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn((query: string) => ({
      matches: mobileViewport,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }) as MediaQueryList),
  });
});

vi.mock('@/lib/authFetch', () => ({
  authFetch: vi.fn(async () => new Response(null, { status: 200 })),
  setOnUnauthorized: vi.fn(),
}));

// MessageList 读取登录态判断 debugMode；回放显式传 debugModeOverride={false}，
// 这里给一个 debugMode 为真的用户，正好验证 override 确实压过了用户设置。
vi.mock('@/contexts/AuthContext', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/contexts/AuthContext')>()),
  useAuth: () => ({ user: { username: 'tester', debugMode: true } }),
}));

function renderReplay() {
  // 既有交互测试关注步进/审批/面板，不等待动画；流式效果在独立用例中验证。
  return render(<ScenarioReplayView script={knowledgeQaScript} onExit={vi.fn()} typewriterIntervalMs={0} />);
}

function clickNext(times: number) {
  const toolbar = screen.getByRole('toolbar', { name: '演示回放控制' });
  for (let i = 0; i < times; i++) {
    fireEvent.click(within(toolbar).getByRole('button', { name: /下一步/ }));
  }
}

async function openBusinessStep(content: string) {
  const plan = await waitFor(() => {
    const current = document.querySelector<HTMLElement>('[data-business-step-plan]');
    expect(current).toBeTruthy();
    return current!;
  }, { timeout: 5_000 });
  const label = within(plan).getByText(content);
  fireEvent.click(label.closest('button')!);
}

describe('ScenarioReplayView', () => {
  it('打开时只显示用户消息，点击下一步后才显示第一条 Agent 输出', async () => {
    renderReplay();
    expect(screen.getByText(`0 / ${knowledgeQaScript.steps.length}`)).toBeTruthy();
    expect(screen.getByText(/住宿能报多少/)).toBeTruthy();
    expect(screen.queryByText('确认问题范围与可用资料')).toBeNull();
    expect(screen.queryByText('企业系统实况')).toBeNull();

    clickNext(1);
    expect(screen.getByText(`1 / ${knowledgeQaScript.steps.length}`)).toBeTruthy();
    expect(await screen.findByText('员工提问', {}, { timeout: 5_000 })).toBeTruthy();
    expect(screen.queryByText('员工提问已完成并形成可回读结果')).toBeNull();
  });

  it('旧版回放同样走真实业务步骤投影，并从步骤行打开终态摘要', async () => {
    renderReplay();
    expect(screen.queryByText('任务步骤')).toBeNull();

    clickNext(1);
    expect(await screen.findByText('任务步骤', {}, { timeout: 5_000 })).toBeTruthy();
    await openBusinessStep('员工提问');
    expect(await screen.findByText('员工提问已完成并形成可回读结果')).toBeTruthy();
    expect(document.querySelector('[data-scenario-business-step-panel]')).toBeTruthy();
  });

  it('移动端回放点击步骤使用底部 Sheet，不创建桌面详情右栏', async () => {
    mobileViewport = true;
    try {
      renderReplay();
      clickNext(1);
      await openBusinessStep('员工提问');
      await screen.findByRole('dialog');
      expect(document.querySelector('[data-business-step-detail-sheet]')).toBeTruthy();
      expect(document.querySelector('[data-scenario-business-step-panel]')).toBeNull();
    } finally {
      mobileViewport = false;
    }
  });

  it('右侧只高亮当前步骤 delta，推进到下一步后清除旧变化', () => {
    const deltaScript: ReplayScript = {
      scenarioId: 'panel-delta-test',
      title: '面板变化测试',
      sources: [],
      steps: [
        {
          caption: '识别本步变化',
          blocks: [{
            id: 'delta-tool-1', kind: 'tool_use', title: '扫描订单', defaultOpen: true,
            toolName: 'OrderScan', toolId: 'delta-1', content: '{}', executionStatus: 'completed',
            presentation: {
              title: '扫描订单',
              panelBase: {
                activeView: 'orders',
                views: [{
                  key: 'orders', label: '订单', winTitle: '订单中心',
                  widget: { kind: 'table', cols: [{ key: 'name', label: '订单' }], rows: [{ id: 'r1', cells: { name: '订单 1' } }] },
                }],
              },
              panel: [{ op: 'pulse', view: 'orders', ids: ['r1'], kind: 'hit' }],
            },
          }],
        },
        {
          caption: '进入下一步',
          blocks: [{
            id: 'delta-tool-2', kind: 'tool_use', title: '核对下一项', defaultOpen: true,
            toolName: 'OrderCheck', toolId: 'delta-2', content: '{}', executionStatus: 'completed',
            presentation: {
              title: '核对下一项',
              panel: [{ op: 'toolbar', view: 'orders', sub: '本步未修改订单行' }],
            },
          }],
        },
      ],
    };

    render(<ScenarioReplayView script={deltaScript} onExit={vi.fn()} typewriterIntervalMs={0} />);
    clickNext(1);
    expect(screen.getByRole('status', { name: '本步命中 1 项' })).toBeTruthy();
    expect(screen.getByText('订单 1').closest('tr')?.getAttribute('data-panel-delta')).toBe('hit');

    clickNext(1);
    expect(screen.queryByText('本步命中 1 项')).toBeNull();
    expect(screen.getByText('订单 1').closest('tr')?.hasAttribute('data-panel-delta')).toBe(false);
  });

  it('义务巡检首屏先显示员工的简单问题，推进后才扫描企业台账', async () => {
    render(<ScenarioReplayView script={deadlineWatchScript} onExit={vi.fn()} typewriterIntervalMs={0} />);
    expect(screen.getByText('本月哪些义务还没到权威终态？先处理会错过窗口的。')).toBeTruthy();
    expect(screen.queryByText('扫描到期事项台账')).toBeNull();

    clickNext(1);
    expect(await screen.findByText('一句话问清本月未结义务', {}, { timeout: 5_000 })).toBeTruthy();
    expect(screen.queryByText('一句话问清本月未结义务已完成并形成可回读结果')).toBeNull();
    expect(screen.getByText('企业系统实况')).toBeTruthy();
  });

  it('回放控制位于会话列底部，替代输入框而非横跨右侧面板', () => {
    renderReplay();
    const toolbar = screen.getByRole('toolbar', { name: '演示回放控制' });
    expect(toolbar.closest('[data-scenario-replay-conversation]')).toBeTruthy();
    expect(toolbar.closest('.content-container')).toBeTruthy();
  });

  it('AI 文本按真实 streaming 消息逐步吐出，完成前不能推进', () => {
    vi.useFakeTimers();
    const script: ReplayScript = {
      scenarioId: 'typewriter-test',
      title: '流式输出测试',
      sources: [],
      steps: [
        {
          caption: '生成回答',
          blocks: [
            { id: 'user-1', kind: 'prompt', title: '用户', defaultOpen: false, content: '开始' },
            { id: 'text-1', kind: 'text', title: '助手', defaultOpen: false, content: '逐字输出测试' },
          ],
        },
        {
          caption: '下一步',
          blocks: [
            { id: 'user-2', kind: 'prompt', title: '用户', defaultOpen: false, content: '继续' },
          ],
        },
      ],
    };

    render(<ScenarioReplayView script={script} onExit={vi.fn()} typewriterIntervalMs={10} />);
    expect(screen.getByText('开始')).toBeTruthy();
    expect(screen.queryByText('逐字输出测试')).toBeNull();
    const toolbar = screen.getByRole('toolbar', { name: '演示回放控制' });
    fireEvent.click(within(toolbar).getByRole('button', { name: /下一步/ }));

    const nextButton = within(toolbar).getByRole('button', { name: /生成中/ });
    expect(nextButton).toHaveProperty('disabled', true);

    act(() => vi.advanceTimersByTime(10));
    expect(screen.getByText('逐')).toBeTruthy();
    expect(screen.queryByText('逐字输出测试')).toBeNull();

    for (let index = 0; index < 6; index += 1) {
      act(() => vi.advanceTimersByTime(10));
    }
    expect(screen.getByText('逐字输出测试')).toBeTruthy();
    expect(within(toolbar).getByRole('button', { name: /下一步/ })).toHaveProperty('disabled', false);
    vi.useRealTimers();
  });

  it('末步仍在流式生成时不提前声称演示完成', () => {
    vi.useFakeTimers();
    const script: ReplayScript = {
      scenarioId: 'final-streaming-test',
      title: '末步流式测试',
      sources: [],
      steps: [{
        caption: '生成最终结果',
        blocks: [
          { id: 'final-user', kind: 'prompt', title: '用户', defaultOpen: false, content: '开始' },
          { id: 'final-text', kind: 'text', title: '助手', defaultOpen: false, content: '最终结果' },
        ],
      }],
    };

    render(<ScenarioReplayView script={script} onExit={vi.fn()} typewriterIntervalMs={10} />);
    const toolbar = screen.getByRole('toolbar', { name: '演示回放控制' });
    fireEvent.click(within(toolbar).getByRole('button', { name: '下一步' }));
    expect(within(toolbar).getByRole('button', { name: '生成中' })).toHaveProperty('disabled', true);
    expect(screen.queryByRole('button', { name: '演示完成' })).toBeNull();

    for (let index = 0; index < 6; index += 1) {
      act(() => vi.advanceTimersByTime(10));
    }
    expect(screen.getByRole('button', { name: '演示完成' })).toHaveProperty('disabled', true);
    vi.useRealTimers();
  });

  it('逐步推进时保留用户消息，并在同一主卡中累加步骤行', async () => {
    renderReplay();
    expect(screen.getByText(/住宿能报多少/)).toBeTruthy();
    clickNext(1);
    expect(await screen.findByText('员工提问', {}, { timeout: 5_000 })).toBeTruthy();
    clickNext(1);
    expect(screen.getByText(/住宿能报多少/)).toBeTruthy();
    expect(screen.getByText('员工提问')).toBeTruthy();
    expect(await screen.findByText('检索制度库', {}, { timeout: 5_000 })).toBeTruthy();
    expect(document.querySelectorAll('[data-business-step-plan]')).toHaveLength(1);
    expect(screen.queryByText('员工提问已完成并形成可回读结果')).toBeNull();
    expect(screen.queryByText('检索制度库已完成并形成可回读结果')).toBeNull();
  });

  it('客户同构视图隐藏工具摘要，但保留同源的企业系统面板', () => {
    renderReplay();
    clickNext(2);
    // 工具 presentation 仍驱动右侧面板，但不能在非调试会话流里泄露标题和明细。
    expect(screen.getAllByText('制度中心 · 财务与行政').length).toBeGreaterThan(0);
    expect(screen.queryByText('《差旅管理办法》2026 修订版')).toBeNull();
  });

  it('客户同构视图下不泄露原始工具 payload', () => {
    renderReplay();
    clickNext(1);
    expect(screen.queryByText(/"scope"/)).toBeNull();
    expect(screen.queryByText(/score=0\.91/)).toBeNull();
  });

  it('页面背景上的空格与方向键推进/回退（禁止自动播放）', () => {
    renderReplay();
    fireEvent.keyDown(window, { key: ' ' });
    expect(screen.getByText(`1 / ${knowledgeQaScript.steps.length}`)).toBeTruthy();
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    expect(screen.getByText(`2 / ${knowledgeQaScript.steps.length}`)).toBeTruthy();
    fireEvent.keyDown(window, { key: 'ArrowLeft' });
    expect(screen.getByText(`1 / ${knowledgeQaScript.steps.length}`)).toBeTruthy();
  });

  it('焦点位于步骤行或详情控件时不误触发回放热键', async () => {
    renderReplay();
    clickNext(1);

    const stepButton = (await screen.findByText('员工提问', {}, { timeout: 5_000 })).closest('button')!;
    stepButton.focus();
    fireEvent.keyDown(stepButton, { key: 'ArrowRight' });
    expect(screen.getByText(`1 / ${knowledgeQaScript.steps.length}`)).toBeTruthy();

    fireEvent.click(stepButton);
    const closeButton = await screen.findByRole('button', { name: '关闭步骤详情' });
    closeButton.focus();
    fireEvent.keyDown(closeButton, { key: ' ' });
    expect(screen.getByText(`1 / ${knowledgeQaScript.steps.length}`)).toBeTruthy();
    expect(await screen.findByText('员工提问已完成并形成可回读结果')).toBeTruthy();
  });

  it('走到末步时明确显示演示完成，重放回到仅有用户消息的初始态', () => {
    renderReplay();
    clickNext(knowledgeQaScript.steps.length);
    expect(screen.getByRole('button', { name: '演示完成' })).toHaveProperty('disabled', true);
    expect(screen.getByText('演示结束')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /重放/ }));
    expect(screen.getByText(`0 / ${knowledgeQaScript.steps.length}`)).toBeTruthy();
    expect(screen.queryByText('确认问题范围与可用资料')).toBeNull();
  });

  it('末步产物卡走真实 [FILE] 通道，点击后右侧渲染剧本内嵌 HTML', () => {
    renderReplay();
    clickNext(knowledgeQaScript.steps.length);
    // 该文件名同时出现在会话流产物卡与面板留痕卡里，取会话流那个（DOM 在前）
    const card = screen.getByText('制度条款引用.html');
    fireEvent.click(card);
    const frame = screen.getByTitle('制度条款引用.html') as HTMLIFrameElement;
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts');
    expect(frame.getAttribute('srcdoc')).toContain('Content-Security-Policy');
    expect(frame.getAttribute('srcdoc')).toContain('第四章 第 12 条');
  });
});

describe('右侧企业系统面板', () => {
  it('初始态不显示面板，第一次工具执行后再出现', async () => {
    renderReplay();
    expect(screen.queryByText('企业系统实况')).toBeNull();
    clickNext(1);
    expect(screen.getByText('企业系统实况')).toBeTruthy();
    expect(await screen.findByText('员工提问', {}, { timeout: 5_000 })).toBeTruthy();
    expect(screen.queryByText('员工提问已完成并形成可回读结果')).toBeNull();
  });

  it('会话区与业务系统数据区是有间距的独立圆角卡片', () => {
    renderReplay();
    clickNext(1);
    const conversation = document.querySelector('[data-scenario-replay-conversation]') as HTMLElement;
    const panel = document.querySelector('[data-scenario-replay-panel]') as HTMLElement;
    const divider = screen.getByRole('separator', { name: '调整右侧看板宽度' });

    expect(conversation.className).toContain('rounded-xl');
    expect(panel.className).toContain('rounded-xl');
    expect(panel.className).not.toContain('border-l');
    expect(divider.parentElement?.className).toContain('w-2.5');
    expect(source).toContain('<FloatingPanel\n            data-scenario-replay-panel');
    expect(source).not.toContain('REPLAY_FLOATING_PANEL_SURFACE');
  });

  it('可拖拽调整宽度，双击恢复默认宽度', () => {
    renderReplay();
    clickNext(1);
    const divider = screen.getByRole('separator', { name: '调整右侧看板宽度' });
    const panel = document.querySelector('[data-scenario-replay-panel]') as HTMLElement;
    const container = panel.parentElement as HTMLElement;
    vi.spyOn(container, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 1000,
      bottom: 800,
      width: 1000,
      height: 800,
      toJSON: () => ({}),
    });

    expect(panel.style.flexBasis).toBe('calc(30% - 5px)');
    fireEvent.mouseDown(divider, { clientX: 700 });
    fireEvent.mouseMove(window, { clientX: 300 });
    fireEvent.mouseUp(window);
    expect(panel.style.flexBasis).toBe('calc(50% - 5px)');

    fireEvent.doubleClick(divider);
    expect(panel.style.flexBasis).toBe('calc(30% - 5px)');
  });

  it('面板常驻于后续每一步', () => {
    renderReplay();
    clickNext(1);
    expect(screen.getByText('企业系统实况')).toBeTruthy();
    expect(screen.getByText('差旅管理办法(2026).md')).toBeTruthy();
    clickNext(1);
    expect(screen.getByText('企业系统实况')).toBeTruthy();
  });

  it('面板随步骤变化：检索命中 → 条款插入 → 档案填充 → 留痕', () => {
    renderReplay();
    clickNext(2);
    expect(screen.getAllByText('命中').length).toBeGreaterThan(0);

    clickNext(1);
    expect(screen.getByText('第四章 第 12 条 住宿标准')).toBeTruthy();

    clickNext(1);
    expect(screen.getByText('600 元/晚')).toBeTruthy();
    expect(screen.getByText('1,800 元')).toBeTruthy();

    clickNext(1);
    expect(screen.getByText(/生成条款出处清单并附于答复/)).toBeTruthy();
  });

  it('后退＝少喂 patch，面板回到上一步状态（无需逆运算）', () => {
    renderReplay();
    clickNext(4);
    expect(screen.getByText('600 元/晚')).toBeTruthy();
    fireEvent.keyDown(window, { key: 'ArrowLeft' });
    expect(screen.queryByText('600 元/晚')).toBeNull();
    expect(screen.getByText('第四章 第 12 条 住宿标准')).toBeTruthy();
  });

  it('面板可切 tab，且切过之后不被后续 focus patch 抢走', () => {
    renderReplay();
    clickNext(2);
    fireEvent.click(screen.getByRole('button', { name: '操作留痕' }));
    expect(screen.getByText('本次会话的系统动作')).toBeTruthy();
    clickNext(2);
    // step4 带 focus profile，但用户已手动选过 tab，焦点不被抢
    expect(screen.getByText('本次会话的系统动作')).toBeTruthy();
  });

  it('产物预览抢占面板，可一键退回系统实况', () => {
    renderReplay();
    clickNext(knowledgeQaScript.steps.length);
    fireEvent.click(screen.getByText('制度条款引用.html'));
    expect(screen.getByTitle('制度条款引用.html')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /系统实况/ }));
    expect(screen.queryByTitle('制度条款引用.html')).toBeNull();
    expect(screen.getByText('企业系统实况')).toBeTruthy();
  });
});

describe('Workflow Trace V1 Hero', () => {
  function traceScript() {
    return buildTechnicalInquiryTraceScript(makeWorkflowScenario(TECHNICAL_INQUIRY_TRACE_SCENARIO_ID, {
      workflowId: 'technical-inquiry-to-approved-quote-loop',
      title: '复杂询价推进到批准报价和订单',
      launch: {
        sampleAvailable: false,
        startMode: 'chat',
        entry: { kind: 'business_event', content: '客户询价中的消息和附件规格不一致。' },
        starterMessage: '请处理这条复杂询价。',
      },
    }));
  }

  it('第一步先显示任务导航与系统面板，显式选择后切换到步骤结果', async () => {
    const script = traceScript();
    render(<ScenarioReplayView script={script} onExit={vi.fn()} typewriterIntervalMs={0} />);

    expect(screen.getByText('客户询价中的消息和附件规格不一致。')).toBeTruthy();
    expect(screen.queryByText('任务步骤')).toBeNull();
    expect(screen.queryByText('企业系统实况')).toBeNull();

    clickNext(1);
    expect(await screen.findByText('任务步骤', {}, { timeout: 5_000 })).toBeTruthy();
    const plan = document.querySelector<HTMLElement>('[data-business-step-plan]');
    expect(within(plan!).getAllByText('先发现不能靠猜的规格冲突')).toHaveLength(1);
    expect(screen.queryByText('发现 1 项关键规格冲突，已停止继续报价')).toBeNull();
    expect(screen.getByText('企业系统实况')).toBeTruthy();
    expect(screen.getByText('防护等级 IP65')).toBeTruthy();
    expect(screen.getByText(/演示来源：询价资料库（不进入真实审计）/)).toBeTruthy();

    await openBusinessStep('先发现不能靠猜的规格冲突');
    expect(await screen.findByText('发现 1 项关键规格冲突，已停止继续报价')).toBeTruthy();
    expect(screen.queryByText('企业系统实况')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '关闭步骤详情' }));
    expect(screen.getByText('企业系统实况')).toBeTruthy();
  });

  it('Trace gate 退回不产生发送 effect，重新提交并批准后才继续', async () => {
    const script = traceScript();
    render(<ScenarioReplayView script={script} onExit={vi.fn()} typewriterIntervalMs={0} />);
    clickNext(2);

    expect(screen.getByRole('button', { name: '需先批准' })).toHaveProperty('disabled', true);
    expect(screen.getByRole('button', { name: '确认发送澄清' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '退回修改' }));
    expect(screen.getByText('已退回修改，未写入业务系统')).toBeTruthy();
    expect(screen.queryByText('澄清消息已模拟送达测试联系人。')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '重新提交审核' }));
    fireEvent.click(screen.getByRole('button', { name: '确认发送澄清' }));
    expect(screen.getByText('3 / 8')).toBeTruthy();
    expect(await screen.findAllByText('客户答复后从原任务继续', {}, { timeout: 5_000 })).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: '沟通' }));
    expect(screen.getByText('澄清消息已模拟送达测试联系人。')).toBeTruthy();
  });
});

describe('人工审批门禁', () => {
  const approvalScript: ReplayScript = {
    scenarioId: 'approval-demo',
    title: '审批门禁演示',
    mode: 'hero',
    sources: [],
    steps: [
      {
        caption: '等待负责人审批',
        blocks: [{
          id: 'approval-prompt',
          kind: 'prompt',
          title: '用户消息',
          defaultOpen: true,
          content: '请提交这份报价审批。',
        }],
        approval: {
          title: '确认报价边界',
          description: '批准后才会继续发送。',
          facts: [{ label: '报价金额', value: '128,000 元' }],
          approveLabel: '批准并继续',
          rejectLabel: '退回修改',
          approvedBlocks: [{
            id: 'approval-recorded',
            kind: 'text',
            title: '审批结果',
            defaultOpen: true,
            content: '人工确认已记录。',
          }],
          rejectedBlocks: [{
            id: 'approval-rejected',
            kind: 'text',
            title: '退回说明',
            defaultOpen: true,
            content: '已停在审核点：业务系统没有任何写入，退回记录已留痕。',
          }],
        },
      },
      {
        caption: '完成发送',
        blocks: [{
          id: 'approval-finished',
          kind: 'text',
          title: '业务结果',
          defaultOpen: true,
          content: '报价已经发送并取得送达回执。',
        }],
      },
    ],
  };

  it('末步仍在等待审批时不提前声称演示完成', () => {
    const finalApprovalScript: ReplayScript = {
      scenarioId: 'final-approval-demo',
      title: '末步审批演示',
      sources: [],
      steps: [{
        caption: '等待最终审批',
        blocks: [{
          id: 'final-approval-prompt',
          kind: 'prompt',
          title: '用户消息',
          defaultOpen: true,
          content: '请完成最终审批。',
        }],
        approval: {
          title: '确认最终写入',
          description: '批准后才算闭环完成。',
          facts: [{ label: '业务对象', value: 'SO-001' }],
          approveLabel: '批准并完成',
          approvedBlocks: [],
        },
      }],
    };

    render(<ScenarioReplayView script={finalApprovalScript} onExit={vi.fn()} typewriterIntervalMs={0} />);
    clickNext(1);
    expect(screen.getByRole('button', { name: '需先批准' })).toHaveProperty('disabled', true);
    expect(screen.queryByRole('button', { name: '演示完成' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '批准并完成' }));
    expect(screen.getByRole('button', { name: '演示完成' })).toHaveProperty('disabled', true);
  });

  it('未批准时按钮和键盘都不能越过门禁，批准后自动继续并留痕', () => {
    render(<ScenarioReplayView script={approvalScript} onExit={vi.fn()} typewriterIntervalMs={0} />);
    expect(screen.getByText('0 / 2')).toBeTruthy();
    clickNext(1);
    expect(screen.getByText('1 / 2')).toBeTruthy();
    expect(screen.getByRole('button', { name: '需先批准' })).toHaveProperty('disabled', true);

    fireEvent.keyDown(window, { key: 'ArrowRight' });
    expect(screen.getByText('1 / 2')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '批准并继续' }));
    expect(screen.getByText('2 / 2')).toBeTruthy();
    expect(screen.getByText('人工确认已记录。')).toBeTruthy();
    expect(screen.getByText('报价已经发送并取得送达回执。')).toBeTruthy();
    expect(screen.getByRole('button', { name: '演示完成' })).toHaveProperty('disabled', true);
  });

  it('退回时明确显示未写入系统，并允许重新提交审核', () => {
    render(<ScenarioReplayView script={approvalScript} onExit={vi.fn()} typewriterIntervalMs={0} />);
    clickNext(1);
    fireEvent.click(screen.getByRole('button', { name: '退回修改' }));
    expect(screen.getByText('已退回修改，未写入业务系统')).toBeTruthy();
    expect(screen.getByRole('button', { name: '重新提交审核' })).toBeTruthy();
    expect(screen.getByText('1 / 2')).toBeTruthy();
  });

  it('退回不是死路：会话里出现退回后的处理，重新提交后消失', () => {
    render(<ScenarioReplayView script={approvalScript} onExit={vi.fn()} typewriterIntervalMs={0} />);
    clickNext(1);
    fireEvent.click(screen.getByRole('button', { name: '退回修改' }));
    expect(screen.getByText('已停在审核点：业务系统没有任何写入，退回记录已留痕。')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '重新提交审核' }));
    expect(screen.queryByText('已停在审核点：业务系统没有任何写入，退回记录已留痕。')).toBeNull();
    expect(screen.getByRole('button', { name: '批准并继续' })).toBeTruthy();
  });
});

describe('剧本来源登记（治理条款）', () => {
  it('每个 presentation 都有对应的来源登记条目', () => {
    const presentationCount = knowledgeQaScript.steps
      .flatMap((step) => step.blocks)
      .filter((block) => block.presentation).length;
    // 4 个工具摘要 + 1 个产物 = 5 条中，工具摘要必须逐条登记
    expect(knowledgeQaScript.sources.length).toBeGreaterThanOrEqual(presentationCount);
  });

  it('登记条目的 producer 非空，且 state 非 exists 时必须写明 gap', () => {
    for (const source of knowledgeQaScript.sources) {
      expect(source.producer.trim().length).toBeGreaterThan(0);
      if (source.state !== 'exists') {
        expect(source.gap?.trim().length ?? 0).toBeGreaterThan(0);
      }
    }
  });
});
