/**
 * 场景回放视图测试。
 *
 * 最重要的一条是「摘要在 debugModeOverride=false 下可见」——它对应本批次的
 * 验收标准：演示与普通客户视图必须同构，不允许存在只有演示看得到的内容。
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ScenarioReplayView } from './ScenarioReplayView';
import { knowledgeQaScript } from './knowledgeQaScript';
import type { ReplayScript } from './types';

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

// MessageList 读取登录态判断 debugMode；回放显式传 debugModeOverride={false}，
// 这里给一个 debugMode 为真的用户，正好验证 override 确实压过了用户设置。
vi.mock('@/contexts/AuthContext', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/contexts/AuthContext')>()),
  useAuth: () => ({ user: { username: 'tester', debugMode: true } }),
}));

function renderReplay() {
  return render(<ScenarioReplayView script={knowledgeQaScript} onExit={vi.fn()} />);
}

function clickNext(times: number) {
  for (let i = 0; i < times; i++) fireEvent.click(screen.getByRole('button', { name: /下一步/ }));
}

describe('ScenarioReplayView', () => {
  it('打开即显示第一步，不再出现 0/N 空屏', () => {
    renderReplay();
    expect(screen.getByText(`1 / ${knowledgeQaScript.steps.length}`)).toBeTruthy();
    expect(screen.getByText(/住宿能报多少/)).toBeTruthy();
  });

  it('逐步推进，内容累加而非替换', () => {
    renderReplay();
    expect(screen.getByText(/住宿能报多少/)).toBeTruthy();
    clickNext(1);
    // 第一步的用户消息仍在
    expect(screen.getByText(/住宿能报多少/)).toBeTruthy();
    expect(screen.getByText('检索企业制度库')).toBeTruthy();
  });

  it('工具摘要在客户同构视图（debugModeOverride=false）下可见', () => {
    renderReplay();
    clickNext(1);
    expect(screen.getByText('检索企业制度库')).toBeTruthy();
    // 同一文本也出现在右侧面板工具栏里，说明两处同源；此处只断言会话流里有
    expect(screen.getAllByText('制度中心 · 财务与行政').length).toBeGreaterThan(0);
    expect(screen.getByText('《差旅管理办法》2026 修订版')).toBeTruthy();
  });

  it('客户同构视图下不泄露原始工具 payload', () => {
    renderReplay();
    clickNext(1);
    expect(screen.queryByText(/"scope"/)).toBeNull();
    expect(screen.queryByText(/score=0\.91/)).toBeNull();
  });

  it('空格与方向键推进/回退（与客户演示稿一致，禁止自动播放）', () => {
    renderReplay();
    fireEvent.keyDown(window, { key: ' ' });
    expect(screen.getByText(`2 / ${knowledgeQaScript.steps.length}`)).toBeTruthy();
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    expect(screen.getByText(`3 / ${knowledgeQaScript.steps.length}`)).toBeTruthy();
    fireEvent.keyDown(window, { key: 'ArrowLeft' });
    expect(screen.getByText(`2 / ${knowledgeQaScript.steps.length}`)).toBeTruthy();
  });

  it('走到末步时下一步禁用，重放回到第一步', () => {
    renderReplay();
    clickNext(knowledgeQaScript.steps.length - 1);
    expect(screen.getByRole('button', { name: /下一步/ })).toHaveProperty('disabled', true);
    expect(screen.getByText('演示结束')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /重放/ }));
    expect(screen.getByText(`1 / ${knowledgeQaScript.steps.length}`)).toBeTruthy();
  });

  it('末步产物卡走真实 [FILE] 通道，点击后右侧渲染剧本内嵌 HTML', () => {
    renderReplay();
    clickNext(knowledgeQaScript.steps.length - 1);
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
  // 07-26 修订：原断言是「第一步不出现面板」。实机走查发现首屏因此只有一句提问 +
  // 80% 空白，客户第一眼看不到「它接到了哪些系统」。剧本改为第一步就做一次真实的
  // 范围确认工具调用——面板依旧跟着工具执行出现，没有凭空冒出来的通道。
  it('面板跟着第一次工具执行出现，首屏就不是空的', () => {
    renderReplay();
    expect(screen.getByText('企业系统实况')).toBeTruthy();
    expect(screen.getByText('确认问题范围与可用资料')).toBeTruthy();
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
    clickNext(1);
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
    clickNext(3);
    expect(screen.getByText('600 元/晚')).toBeTruthy();
    fireEvent.keyDown(window, { key: 'ArrowLeft' });
    expect(screen.queryByText('600 元/晚')).toBeNull();
    expect(screen.getByText('第四章 第 12 条 住宿标准')).toBeTruthy();
  });

  it('面板可切 tab，且切过之后不被后续 focus patch 抢走', () => {
    renderReplay();
    clickNext(1);
    fireEvent.click(screen.getByRole('button', { name: '操作留痕' }));
    expect(screen.getByText('本次会话的系统动作')).toBeTruthy();
    clickNext(2);
    // step4 带 focus profile，但用户已手动选过 tab，焦点不被抢
    expect(screen.getByText('本次会话的系统动作')).toBeTruthy();
  });

  it('产物预览抢占面板，可一键退回系统实况', () => {
    renderReplay();
    clickNext(knowledgeQaScript.steps.length - 1);
    fireEvent.click(screen.getByText('制度条款引用.html'));
    expect(screen.getByTitle('制度条款引用.html')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /系统实况/ }));
    expect(screen.queryByTitle('制度条款引用.html')).toBeNull();
    expect(screen.getByText('企业系统实况')).toBeTruthy();
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

  it('未批准时按钮和键盘都不能越过门禁，批准后自动继续并留痕', () => {
    render(<ScenarioReplayView script={approvalScript} onExit={vi.fn()} />);
    expect(screen.getByText('1 / 2')).toBeTruthy();
    expect(screen.getByRole('button', { name: '需先批准' })).toHaveProperty('disabled', true);

    fireEvent.keyDown(window, { key: 'ArrowRight' });
    expect(screen.getByText('1 / 2')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '批准并继续' }));
    expect(screen.getByText('2 / 2')).toBeTruthy();
    expect(screen.getByText('人工确认已记录。')).toBeTruthy();
    expect(screen.getByText('报价已经发送并取得送达回执。')).toBeTruthy();
  });

  it('退回时明确显示未写入系统，并允许重新提交审核', () => {
    render(<ScenarioReplayView script={approvalScript} onExit={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '退回修改' }));
    expect(screen.getByText('已退回修改，未写入业务系统')).toBeTruthy();
    expect(screen.getByRole('button', { name: '重新提交审核' })).toBeTruthy();
    expect(screen.getByText('1 / 2')).toBeTruthy();
  });

  it('退回不是死路：会话里出现退回后的处理，重新提交后消失', () => {
    render(<ScenarioReplayView script={approvalScript} onExit={vi.fn()} />);
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
