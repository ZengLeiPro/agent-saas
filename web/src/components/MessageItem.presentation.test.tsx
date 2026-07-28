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

  it('组内有摘要 + 非 debug：分组和工具详情均默认折叠', () => {
    render(<ActivityGroupBlock items={[plainTool, richTool]} isActive={false} debugMode={false} />);
    const groupSummary = screen.getByText('已完成 2 条：2 个工具');
    expect(screen.queryByText('核对魏德米勒选型表')).toBeNull();
    expect(screen.queryByText('WDU 2.5')).toBeNull();

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
