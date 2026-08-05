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
  it('rows 布局按内容收缩，并使用品牌色标题栏与清晰卡片边界', () => {
    const { container } = render(<PresentationBlocks blocks={[{
      kind: 'records', layout: 'rows', title: '核对清单',
      items: [{ label: '发票抬头', value: '一致', tag: { tone: 'success', text: '通过' } }],
      footer: '共 1 项',
    }]} />);
    const records = container.querySelector('[data-records-block]');
    expect(records?.className).toContain('w-fit');
    expect(records?.className).toContain('max-w-full');
    expect(records?.className).toContain('rounded-xl');
    expect(records?.className).toContain('border-primary/20');
    expect(records?.className).not.toMatch(/\bm[by]-/);

    const title = container.querySelector('[data-records-title]');
    expect(title?.className).toContain('bg-primary/5');
    expect(title?.className).toContain('border-primary/15');
    expect(title?.querySelector('svg')).toBeNull();
    expect(screen.getByText('核对清单')).toBeTruthy();
    const label = screen.getByText('发票抬头');
    expect(label.className).toContain('text-muted-foreground');
    expect(label.closest('div')?.className).toContain('border-b');
    expect(screen.getByText('一致').className).toContain('text-foreground');
    expect(screen.getByText('通过')).toBeTruthy();
    expect(screen.getByText('共 1 项')).toBeTruthy();
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
