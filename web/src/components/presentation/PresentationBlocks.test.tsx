/**
 * 呈现块渲染层测试。
 *
 * 两条最要紧的不变量：
 * ① 无回写通道的动作按钮必须 disabled——不允许出现「点了没反应」的按钮，
 *    那正是演示与真实脱节最典型的表现；
 * ② message.display 缺省时必须直通 MessageItem，现状零破坏。
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { PresentationBlock } from '@agent/shared';
import { BLOCK_VIEWS, PresentationBlocks } from './PresentationBlocks';
import { MessageItemWithDisplay } from '../MessageItemWithDisplay';
import { FilePreviewProvider } from '@/contexts/FilePreviewContext';
import type { MessageItem as MessageItemType } from '../types';

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

vi.mock('@/contexts/AuthContext', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/contexts/AuthContext')>()),
  useAuth: () => ({ user: { username: 'tester', debugMode: false } }),
}));

describe('渲染注册表', () => {
  it('冻结，且与 shared 归一层的 kind 一一对应', () => {
    expect(Object.isFrozen(BLOCK_VIEWS)).toBe(true);
    expect(Object.keys(BLOCK_VIEWS).sort()).toEqual(['callout', 'gate', 'records']);
  });

  it('未知 kind 不渲染也不崩（旧客户端读新快照）', () => {
    const { container } = render(
      <PresentationBlocks blocks={[{ kind: '未来的块' } as unknown as PresentationBlock]} />,
    );
    expect(container.textContent).toBe('');
  });
});

describe('callout', () => {
  it('渲染标题、多段正文与依据行，并由外层统一控制块间距', () => {
    const { container } = render(<PresentationBlocks blocks={[{
      kind: 'callout', tone: 'warn', title: '发现 2 处不一致',
      body: ['第一段', '第二段'],
      detail: [{ k: '合同金额', v: '¥154,500' }],
    }]} />);
    const callout = container.firstElementChild as HTMLElement;
    expect(callout.className).not.toMatch(/\bm[by]-/);
    expect(screen.getByText('发现 2 处不一致')).toBeTruthy();
    expect(screen.getByText('第二段').className).toContain('leading-5');
    expect(screen.getByText('第二段').className).not.toContain('leading-relaxed');
    expect(screen.getByText('¥154,500')).toBeTruthy();
  });

  it('collapsible 可折叠展开', () => {
    render(<PresentationBlocks blocks={[{
      kind: 'callout', tone: 'info', title: '点我', body: ['藏起来的内容'], collapsible: true, defaultOpen: false,
    }]} />);
    expect(screen.queryByText('藏起来的内容')).toBeNull();
    fireEvent.click(screen.getByText('点我'));
    expect(screen.getByText('藏起来的内容')).toBeTruthy();
  });
});

describe('records', () => {
  it('rows 布局按内容收缩边框、共享自然列宽，并保留横向滚动兜底', () => {
    const { container } = render(<PresentationBlocks blocks={[{
      kind: 'records', layout: 'rows', title: '核对清单',
      items: [
        { label: '发票抬头', value: '一致', tag: { tone: 'success', text: '通过' } },
        { label: '较长字段名称', value: '另一项值' },
      ],
      footer: '共 2 项',
    }]} />);
    const records = container.querySelector('[data-records-block]');
    expect(records?.className).toContain('inline-block');
    expect(records?.className).toContain('self-start');
    expect(records?.className).toContain('max-w-full');
    expect(records?.className).toContain('overflow-x-auto');
    expect(records?.className).toContain('rounded-xl');
    expect(records?.className).toContain('border-primary/20');
    expect(records?.className).not.toMatch(/\bm[by]-/);
    expect(records?.getAttribute('tabindex')).toBe('0');
    expect(records?.getAttribute('aria-label')).toBe('核对清单，可横向滚动');
    expect(records?.firstElementChild?.className).toContain('w-max');
    expect(records?.firstElementChild?.className).not.toContain('min-w-[32rem]');

    const table = container.querySelector('[data-records-table]');
    expect(table?.className).toContain('w-max');
    expect(table?.className).toContain('gap-x-4');
    expect(table?.className).toContain('grid-cols-[minmax(0,max-content)_minmax(0,max-content)_auto_auto]');
    expect(table?.className).not.toContain('1fr');

    const title = container.querySelector('[data-records-title]');
    expect(title?.className).toContain('bg-primary/5');
    expect(title?.className).toContain('border-primary/15');
    expect(title?.querySelector('svg')).toBeNull();
    expect(screen.getByText('核对清单')).toBeTruthy();
    const label = screen.getByText('发票抬头');
    expect(label.className).toContain('max-w-80');
    expect(label.className).toContain('text-muted-foreground');
    expect(label.closest('div')?.className).toContain('grid-cols-[subgrid]');
    expect(label.closest('div')?.className).toContain('border-b');
    const row = label.closest('button');
    expect(row?.className).toContain('grid-cols-[subgrid]');
    expect(row?.className).not.toContain('w-full');
    const value = screen.getByText('一致');
    expect(value.className).toContain('max-w-[min(48rem,70vw)]');
    expect(value.className).toContain('text-foreground');
    expect(value.className).toContain('text-left');
    expect(screen.getByText('通过')).toBeTruthy();
    expect(screen.getByText('共 2 项')).toBeTruthy();
  });

  it('grid 布局使用 max-content 轨道，不把短 facts 平均撑满容器', () => {
    const { container } = render(<PresentationBlocks blocks={[{
      kind: 'records', layout: 'grid', title: '订单字段',
      items: [
        { label: '订单', value: 'SO-1001' },
        { label: '客户', value: '开沿科技' },
        { label: '阶段', value: '已核验' },
      ],
    }]} />);

    const records = container.querySelector('[data-records-block]');
    const grid = container.querySelector('[data-records-grid]');
    expect(records?.getAttribute('tabindex')).toBeNull();
    expect(grid?.className).toContain('inline-grid');
    expect(grid?.className).toContain('grid-cols-[repeat(2,minmax(0,max-content))]');
    expect(grid?.className).toContain('sm:grid-cols-[repeat(3,minmax(0,max-content))]');
    expect(grid?.className).toContain('gap-x-8');
    expect(grid?.className).not.toMatch(/\bgrid-cols-[23]\b/);
  });

  it('四个 facts 在桌面端保持 2×2 四宫格', () => {
    const { container } = render(<PresentationBlocks blocks={[{
      kind: 'records', layout: 'grid', title: '开发基线',
      items: [
        { label: '基线分支', value: 'main' },
        { label: '基线提交', value: '9c2d35eb824af22d6c7e2236990f161227904185' },
        { label: '开发分支', value: 'feat/context-plane' },
        { label: '仓库状态', value: '创建前无未提交改动' },
      ],
    }]} />);

    const grid = container.querySelector('[data-records-grid]');
    expect(grid?.className).toContain('grid-cols-[repeat(2,minmax(0,max-content))]');
    expect(grid?.className).not.toContain('sm:grid-cols-[repeat(3,minmax(0,max-content))]');
    expect(grid?.children).toHaveLength(4);
  });

  it('comparison 数值列按内容收缩，移动端按单项卡片重排并突出差异', () => {
    const longValue = '这是一段需要在比较列内换行的长文本'.repeat(8);
    const { container } = render(<PresentationBlocks blocks={[{
      kind: 'records', layout: 'comparison', title: '阶段停留对照',
      items: [
        { label: '海川机械', baseline: '10 天', current: '22 天', delta: '+12 天', tone: 'warn' },
        { label: '恒岳重工', baseline: '9 天', current: '9 天', delta: '一致', tone: 'success' },
        { label: '长文本', baseline: longValue, current: longValue, delta: longValue },
      ],
    }]} />);

    const records = container.querySelector('[data-records-block]');
    const table = container.querySelector('[data-comparison-table]');
    const rows = container.querySelectorAll('[data-comparison-row]');
    const header = table?.firstElementChild;
    const row = rows[0]?.querySelector('button');
    const columns = 'sm:grid-cols-[minmax(10rem,1.2fr)_minmax(6rem,max-content)_minmax(6rem,max-content)_minmax(6rem,max-content)_auto]';
    expect(records?.className).toContain('w-full');
    expect(records?.firstElementChild?.className).toContain('sm:min-w-[36rem]');
    expect(header?.className).toContain(columns);
    expect(header?.className).toContain('gap-x-3');
    expect(row?.className).toContain(columns);
    expect(row?.className).toContain('gap-x-3');
    expect(row?.className).toContain('gap-y-1.5');
    expect(rows[0]?.className).toContain('py-2.5');
    expect(table).toBeTruthy();
    expect(rows).toHaveLength(3);
    const constrainedValues = screen.getAllByText(longValue);
    expect(constrainedValues).toHaveLength(3);
    for (const value of constrainedValues) {
      expect(value.className).toContain('block');
      expect(value.className).toContain('max-w-64');
      expect(value.className).toContain('break-words');
    }
    expect(screen.getByText('对照项')).toBeTruthy();
    expect(screen.getAllByText('基准/之前').length).toBeGreaterThan(1);
    expect(screen.getAllByText('当前/实际').length).toBeGreaterThan(1);
    expect(screen.getAllByText('差异').length).toBeGreaterThan(1);
    expect(screen.getByText('+12 天').className).toContain('max-w-64');
    expect(screen.getByText('+12 天').className).toContain('text-warning');
    expect(screen.getByText('一致').className).toContain('text-success');
  });

  it('checklist 使用品牌色标题栏并按 tone 显示判定图标', () => {
    const { container } = render(<PresentationBlocks blocks={[{
      kind: 'records', layout: 'checklist', title: '需求看板验收',
      items: [
        { label: '字段迁移完成', tone: 'success' },
        { label: '回读失败', tone: 'danger' },
        { label: '存在差异', tone: 'warn' },
        { label: '等待确认', tone: 'muted' },
      ],
    }]} />);

    expect(container.querySelector('[data-records-title]')?.className).toContain('bg-primary/5');
    expect(screen.getByText('字段迁移完成').className).toContain('text-foreground');
    expect(screen.getByText('字段迁移完成').closest('button')?.querySelector('svg')?.classList.contains('text-success')).toBe(true);
    expect(screen.getByText('回读失败').closest('button')?.querySelector('svg')?.classList.contains('text-destructive')).toBe(true);
    expect(screen.getByText('回读失败').className).not.toContain('line-through');
    expect(screen.getByText('存在差异').closest('button')?.querySelector('svg')?.classList.contains('text-warning')).toBe(true);
    expect(screen.getByText('等待确认').closest('button')?.querySelector('svg')?.classList.contains('text-muted-foreground/70')).toBe(true);
  });

  it('条目详情可展开', () => {
    render(<PresentationBlocks blocks={[{
      kind: 'records', layout: 'rows',
      items: [{ label: '可展开', detail: ['来源：合同库 v3'] }],
    }]} />);
    expect(screen.queryByText('来源：合同库 v3')).toBeNull();
    fireEvent.click(screen.getByText('可展开'));
    expect(screen.getByText('来源：合同库 v3')).toBeTruthy();
  });
});

describe('gate 与动作按钮', () => {
  const gate: PresentationBlock = {
    kind: 'gate', title: '需要人工确认', body: ['该操作会写入外部系统'],
    meta: [{ k: '目标系统', v: '钉钉审批' }],
    actions: [{ kind: 'primary', label: '批准', interactionId: 'i-1' }, { kind: 'danger', label: '拒绝', interactionId: 'i-1' }],
  };

  it('正文使用 14px/20px 档位且根节点不补流向 margin', () => {
    const { container } = render(<PresentationBlocks blocks={[gate]} />);
    expect((container.firstElementChild as HTMLElement).className).not.toMatch(/\bm[by]-/);
    expect(screen.getByText('该操作会写入外部系统').className).toContain('leading-5');
  });

  it('有回写通道时按钮可点，回调带 interactionId', () => {
    const onAction = vi.fn();
    render(<PresentationBlocks blocks={[gate]} ctx={{ onAction }} />);
    fireEvent.click(screen.getByRole('button', { name: '批准' }));
    expect(onAction).toHaveBeenCalledWith({ interactionId: 'i-1', label: '批准' });
  });

  it('无回写通道时按钮 disabled——不允许「点了没反应」', () => {
    render(<PresentationBlocks blocks={[gate]} />);
    expect(screen.getByRole('button', { name: '批准' })).toHaveProperty('disabled', true);
  });

  it('只读上下文下按钮 disabled', () => {
    render(<PresentationBlocks blocks={[gate]} ctx={{ readOnly: true, onAction: vi.fn() }} />);
    expect(screen.getByRole('button', { name: '批准' })).toHaveProperty('disabled', true);
  });

  it('缺 interactionId 的动作 disabled', () => {
    render(<PresentationBlocks blocks={[{ ...gate, actions: [{ kind: 'primary', label: '无通道' }] } as PresentationBlock]} ctx={{ onAction: vi.fn() }} />);
    expect(screen.getByRole('button', { name: '无通道' })).toHaveProperty('disabled', true);
  });

  it('link 动作渲染为外链', () => {
    render(<PresentationBlocks blocks={[{ ...gate, actions: [{ kind: 'link', label: '查看单据', href: 'https://example.com/x' }] } as PresentationBlock]} />);
    expect(screen.getByRole('link', { name: /查看单据/ }).getAttribute('href')).toBe('https://example.com/x');
  });
});

describe('MessageItemWithDisplay 外挂层', () => {
  function renderMessage(message: MessageItemType) {
    return render(
      <FilePreviewProvider value={{ openPreview: vi.fn() }}>
        <MessageItemWithDisplay message={message} index={0} />
      </FilePreviewProvider>,
    );
  }

  it('display 缺省时直通 MessageItem（现状零破坏）', () => {
    renderMessage({ id: 'm1', type: 'text', content: '普通回复' });
    expect(screen.getByText('普通回复')).toBeTruthy();
  });

  it('display 有值时正文与呈现块同时渲染', () => {
    renderMessage({
      id: 'm2', type: 'text', content: '结论如下',
      display: [{ kind: 'callout', tone: 'success', body: ['三项均已核对一致'] }],
    });
    expect(screen.getByText('结论如下')).toBeTruthy();
    expect(screen.getByText('三项均已核对一致')).toBeTruthy();
  });
});
