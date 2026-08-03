/**
 * 工具执行摘要（ToolPresentation）渲染测试
 *
 * 核心不变量——本批次的验收标准就是它：
 * 「demo 里能看到的每一个像素，普通客户在真实会话里遇到同类数据时也能看到。」
 * 因此摘要必须在 debugMode=false（普通客户默认）下可见；
 * 而无摘要时的渲染必须与本批次之前逐像素一致（零破坏）。
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MessageItem } from './MessageItem';
import { ActivityGroupBlock } from './ActivityGroupBlock';
import { PresentationDetail } from './PresentationDetail';
import { FilePreviewProvider } from '@/contexts/FilePreviewContext';
import type { MessageItem as MessageItemType } from './types';
import type { ToolPresentation } from '@agent/shared';

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

const PRESENTATION: ToolPresentation = {
  title: '核对魏德米勒选型表',
  detail: [
    { k: '匹配型号', v: 'WDU 2.5' },
    { tree: '└', k: '库存', v: '1,240 件' },
  ],
};

function toolMessage(presentation?: ToolPresentation): MessageItemType {
  return {
    id: 'tool-1',
    type: 'tool_use',
    toolName: 'Shell',
    toolInput: '{"command":"rg -n selection /workspace/erp"}',
    toolId: 'tu-1',
    result: 'ok',
    resultReady: true,
    executionStatus: 'completed',
    durationMs: 3200,
    ...(presentation ? { presentation } : {}),
  };
}

function renderMessage(message: MessageItemType, debugMode: boolean) {
  return render(
    <FilePreviewProvider value={{ openPreview: vi.fn() }}>
      <MessageItem message={message} index={0} debugMode={debugMode} />
    </FilePreviewProvider>,
  );
}

describe('MessageItem 工具摘要分流', () => {
  it('有摘要 + 非 debug（普通客户默认）：折叠行显示摘要，展开后显示详情且不出现原始 payload', () => {
    renderMessage(toolMessage(PRESENTATION), false);
    const title = screen.getByText('核对魏德米勒选型表');
    expect(screen.queryByText('WDU 2.5')).toBeNull();
    expect(screen.queryByText(/rg -n selection/)).toBeNull();

    fireEvent.click(title.closest('button')!);

    expect(screen.getByText('WDU 2.5')).toBeTruthy();
    expect(screen.queryByText(/rg -n selection/)).toBeNull();
  });

  it('有摘要 + debug：默认折叠，展开后摘要与原始 payload 同时可见', () => {
    renderMessage(toolMessage(PRESENTATION), true);
    const title = screen.getByText('核对魏德米勒选型表');
    expect(screen.queryByText('WDU 2.5')).toBeNull();
    expect(screen.queryByText(/rg -n selection/)).toBeNull();

    fireEvent.click(title.closest('button')!);

    expect(screen.getByText('WDU 2.5')).toBeTruthy();
    expect(screen.getByText(/rg -n selection/)).toBeTruthy();
  });

  it('defaultExpanded + 摘要：首次挂载即展开详情，原始 payload 仍不出现（非 debug）', () => {
    renderMessage({ ...toolMessage(PRESENTATION), defaultExpanded: true } as MessageItemType, false);
    expect(screen.getByText('核对魏德米勒选型表')).toBeTruthy();
    expect(screen.getByText('WDU 2.5')).toBeTruthy();
    expect(screen.queryByText(/rg -n selection/)).toBeNull();
  });

  it('defaultExpanded 但无摘要：非 debug 仍是占位符，原始 payload 不因 defaultOpen 上主流', () => {
    renderMessage({ ...toolMessage(), defaultExpanded: true } as MessageItemType, false);
    expect(screen.queryByText(/rg -n selection/)).toBeNull();
  });

  it('receipt 存在时折叠行即显示外部系统回执徽标', () => {
    renderMessage(
      toolMessage({ title: '发送报价单', receipt: { id: 'QT-2026-0729', system: '企业邮箱', readBack: true } }),
      false,
    );
    // 未展开也能看到「→ 系统名」——写操作痕迹默认可见
    expect(screen.getByText('→ 企业邮箱')).toBeTruthy();
    expect(screen.queryByText('QT-2026-0729')).toBeNull();
  });

  it('无摘要 + 非 debug：维持占位符，不泄露原始 payload（零破坏）', () => {
    renderMessage(toolMessage(), false);
    expect(screen.queryByText(/rg -n selection/)).toBeNull();
    expect(screen.queryByText('核对魏德米勒选型表')).toBeNull();
  });

  it('无摘要 + debug：仍是工具名 + 入参的原有形态', () => {
    renderMessage(toolMessage(), true);
    expect(screen.getByText(/Shell/)).toBeTruthy();
  });
});

describe('ActivityGroupBlock 摘要不被整组吞掉', () => {
  const plainTool = { ...toolMessage(), id: 'tool-plain' } as MessageItemType;
  const richTool = { ...toolMessage(PRESENTATION), id: 'tool-rich' } as MessageItemType;

  it('整组无摘要 + 非 debug：使用统一活动摘要且不泄露原始 payload', () => {
    render(<ActivityGroupBlock items={[plainTool, { ...plainTool, id: 'tool-plain-2' }]} isActive={false} debugMode={false} />);
    expect(screen.queryByText('核对魏德米勒选型表')).toBeNull();
    expect(screen.getByText('已完成 2 条：2 个工具')).toBeTruthy();
    expect(screen.queryByText(/rg -n selection/)).toBeNull();
  });

  it('组内有摘要 + 非 debug：分组为静态摘要，无法展开工具详情', () => {
    render(<ActivityGroupBlock items={[plainTool, richTool]} isActive={false} debugMode={false} />);
    const groupSummary = screen.getByText('已完成 2 条：2 个工具');
    expect(groupSummary.closest('button')).toBeNull();
    expect(screen.queryByText('核对魏德米勒选型表')).toBeNull();
    expect(screen.queryByText('WDU 2.5')).toBeNull();
  });

  it('组内有摘要 + debug：可展开分组和工具详情', () => {
    render(<ActivityGroupBlock items={[plainTool, richTool]} isActive={false} debugMode />);
    const groupSummary = screen.getByText('已完成 2 条：2 个工具');

    fireEvent.click(groupSummary.closest('button')!);

    const title = screen.getByText('核对魏德米勒选型表');
    expect(screen.queryByText('WDU 2.5')).toBeNull();

    fireEvent.click(title.closest('button')!);
    expect(screen.getByText('WDU 2.5')).toBeTruthy();
  });

  it('组内有摘要 + 非 debug：同组无摘要的项仍不泄露原始 payload', () => {
    render(<ActivityGroupBlock items={[plainTool, richTool]} isActive={false} debugMode={false} />);
    expect(screen.queryByText(/rg -n selection/)).toBeNull();
  });

  it('单项分组带摘要 + 非 debug：直接渲染摘要，不套分组壳', () => {
    render(<ActivityGroupBlock items={[richTool]} isActive={false} debugMode={false} />);
    expect(screen.getByText('核对魏德米勒选型表')).toBeTruthy();
  });
});

describe('PresentationDetail 排版变体', () => {
  it('渲染 5 种 detail 行', () => {
    render(
      <PresentationDetail
        data={{
          title: 't',
          detail: [
            '纯文本行',
            { k: '键', v: '值' },
            { tree: '├', k: '树键', v: '树值' },
            { no: 3, text: '第三步' },
            { indent: 1, text: '⚠ 判定行' },
          ],
        }}
      />,
    );
    expect(screen.getByText('纯文本行')).toBeTruthy();
    expect(screen.getByText('值')).toBeTruthy();
    expect(screen.getByText('├')).toBeTruthy();
    expect(screen.getByText('③')).toBeTruthy();
    expect(screen.getByText('⚠ 判定行')).toBeTruthy();
  });

  it('渲染第二批 7 种 detail 行（demo 高频块）', () => {
    render(
      <PresentationDetail
        data={{
          title: 't',
          detail: [
            { section: '动作 1 · 写入脱敏副本' },
            { warn: '供电与结构承重未确认' },
            { insight: '当前状态不能放行', label: '结论' },
            { risk: 'high', text: '跨系统差异率 0.43%', action: '先止损再复验' },
            { verdict: 'pass', text: '域名与地址一致', note: '两个独立来源' },
            { quote: '新签的合同一律写七天', source: 'T-0142 [01:08:12]' },
            { original: 'need CE cert before Q4', translation: 'Q4 前需完成 CE 认证' },
          ],
        }}
      />,
    );
    expect(screen.getByText('动作 1 · 写入脱敏副本')).toBeTruthy();
    expect(screen.getByText('供电与结构承重未确认')).toBeTruthy();
    expect(screen.getByText('结论：')).toBeTruthy();
    expect(screen.getByText('当前状态不能放行')).toBeTruthy();
    expect(screen.getByText('跨系统差异率 0.43%')).toBeTruthy();
    expect(screen.getByText('先止损再复验')).toBeTruthy();
    expect(screen.getByText(/域名与地址一致/)).toBeTruthy();
    expect(screen.getByText(/两个独立来源/)).toBeTruthy();
    expect(screen.getByText('「新签的合同一律写七天」')).toBeTruthy();
    expect(screen.getByText(/T-0142/)).toBeTruthy();
    expect(screen.getByText('need CE cert before Q4')).toBeTruthy();
    expect(screen.getByText('中文摘要')).toBeTruthy();
    expect(screen.getByText('Q4 前需完成 CE 认证')).toBeTruthy();
  });

  it('字段网格渲染 2 列大字段，空值显示占位符', () => {
    render(
      <PresentationDetail
        data={{
          title: 't',
          detail: [{ fields: [{ k: '预算', v: '$120,000' }, { k: '交期', v: '2026 Q4' }, { k: '认证', v: '' }] }],
        }}
      />,
    );
    expect(screen.getByText('预算')).toBeTruthy();
    expect(screen.getByText('$120,000')).toBeTruthy();
    expect(screen.getByText('2026 Q4')).toBeTruthy();
    expect(screen.getByText('—')).toBeTruthy();
  });

  it('连续 warn 行聚合为橙底色块，默认标题「需要注意」', () => {
    render(
      <PresentationDetail
        data={{
          title: 't',
          detail: [
            { k: '上下文', v: '正常行' },
            { warn: '名单导入缺少处理依据' },
            { warn: '退订联系人保持停止触达' },
          ],
        }}
      />,
    );
    expect(screen.getByText('需要注意')).toBeTruthy();
    expect(screen.getByText('名单导入缺少处理依据')).toBeTruthy();
    expect(screen.getByText('退订联系人保持停止触达')).toBeTruthy();
  });

  it('warn 集组吸收紧邻前置 section 作为色块标题，不再另立小节条', () => {
    render(
      <PresentationDetail
        data={{
          title: 't',
          detail: [
            { section: '主动交出的缺口' },
            { warn: '决议④ 缺责任人' },
            '后续普通行',
          ],
        }}
      />,
    );
    expect(screen.getByText('主动交出的缺口')).toBeTruthy();
    expect(screen.queryByText('需要注意')).toBeNull();
    expect(screen.getByText('决议④ 缺责任人')).toBeTruthy();
    expect(screen.getByText('后续普通行')).toBeTruthy();
  });

  it('编号超出圈码范围时退回 "N."', () => {
    render(<PresentationDetail data={{ title: 't', detail: [{ no: 44, text: 'x' }] }} />);
    expect(screen.getByText('44.')).toBeTruthy();
  });

  it('status=ok 不占视觉预算，其余状态显示标签', () => {
    const { unmount } = render(<PresentationDetail data={{ title: 't', detail: ['a'], status: 'ok' }} />);
    expect(screen.queryByText('已拦截')).toBeNull();
    unmount();
    render(<PresentationDetail data={{ title: 't', detail: ['a'], status: 'blocked' }} />);
    expect(screen.getByText('已拦截')).toBeTruthy();
  });

  it('receipt 渲染系统名与单据号，readBack 通过时给出校验标识', () => {
    render(
      <PresentationDetail
        data={{ title: 't', receipt: { id: 'AUD-0723-1314', system: '钉钉审批', readBack: true } }}
      />,
    );
    expect(screen.getByText('钉钉审批')).toBeTruthy();
    expect(screen.getByText('AUD-0723-1314')).toBeTruthy();
    expect(screen.getByText('回读校验通过')).toBeTruthy();
  });

  it('无任何内容时不渲染空壳', () => {
    const { container } = render(<PresentationDetail data={{ title: 't' }} />);
    expect(container.firstChild).toBeNull();
  });
});
