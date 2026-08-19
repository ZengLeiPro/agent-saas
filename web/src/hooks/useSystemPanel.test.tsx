/**
 * 面板 fold 与停靠状态测试。
 *
 * 真实会话与演示回放共用这两个 hook——面板没有独立数据通道，
 * 这里的行为就是两处的行为。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import type { MessageItem, SystemPanelSnapshot, ToolPresentation } from '@agent/shared';
import { useSystemPanel, useSystemPanelDock } from './useSystemPanel';

const BASE: SystemPanelSnapshot = {
  activeView: 'kb',
  views: [
    { key: 'kb', label: '制度库', winTitle: '制度中心', widget: { kind: 'rows', rows: [{ id: 'r1', text: '差旅办法' }] } },
    { key: 'audit', label: '留痕', winTitle: '操作留痕', widget: { kind: 'feed', items: [] } },
  ],
};

function toolMessage(id: string, presentation: ToolPresentation): MessageItem {
  return {
    id,
    type: 'tool_use',
    toolName: 'Read',
    toolInput: '{}',
    toolId: id,
    presentation,
  } as MessageItem;
}

function todoMessage(id: string, todos: Array<Record<string, unknown>>): MessageItem {
  return {
    id,
    type: 'tool_use',
    toolName: 'TodoWrite',
    toolInput: JSON.stringify({ todos }),
    toolId: id,
  } as MessageItem;
}

describe('useSystemPanel', () => {
  it('没有 panelBase 时不产出面板——真实会话未触达系统前右侧就该是空的', () => {
    const { result } = renderHook(() => useSystemPanel([
      { id: 'm1', type: 'text', content: '你好' } as MessageItem,
    ]));
    expect(result.current.snapshot).toBeNull();
  });

  it('第一条带 panelBase 的摘要生效，后续 panelBase 被忽略', () => {
    const other: SystemPanelSnapshot = { ...BASE, title: '不该生效的底稿' };
    const { result } = renderHook(() => useSystemPanel([
      toolMessage('t1', { title: 'a', panelBase: BASE }),
      toolMessage('t2', { title: 'b', panelBase: other }),
    ]));
    expect(result.current.snapshot?.title).toBeUndefined();
  });

  it('按消息顺序 fold 出累积状态', () => {
    const { result } = renderHook(() => useSystemPanel([
      toolMessage('t1', { title: 'a', panelBase: BASE }),
      toolMessage('t2', { title: 'b', panel: [{ op: 'rowUpdate', view: 'kb', id: 'r1', set: { state: 'hit' } }] }),
      toolMessage('t3', { title: 'c', panel: [{ op: 'focus', view: 'audit' }] }),
    ]));
    const widget = result.current.snapshot!.views[0].widget;
    expect(widget.kind === 'rows' && widget.rows[0].state).toBe('hit');
    expect(result.current.snapshot!.activeView).toBe('audit');
  });

  it('只暴露最新一组 patch 的本步变化，下一组无 pulse 时清空旧高亮', () => {
    const first = [
      toolMessage('t1', { title: 'a', panelBase: BASE }),
      toolMessage('t2', { title: 'b', panel: [
        { op: 'rowUpdate', view: 'kb', id: 'r1', set: { state: 'hit' } },
        { op: 'pulse', view: 'kb', ids: ['r1'], kind: 'hit' },
      ] }),
    ];
    const { result, rerender } = renderHook(
      ({ items }: { items: MessageItem[] }) => useSystemPanel(items),
      { initialProps: { items: first } },
    );

    expect(result.current.pulse).toEqual({ op: 'pulse', view: 'kb', ids: ['r1'], kind: 'hit' });

    rerender({ items: [
      ...first,
      toolMessage('t3', { title: 'c', panel: [{ op: 'toolbar', view: 'kb', sub: '下一步未修改行' }] }),
    ] });
    expect(result.current.pulse).toBeNull();
  });

  it('同一步终态与短回复保留 delta，下一步只有 TodoWrite 与文本时清空', () => {
    const step1 = { id: 'step-1', kind: 'business', content: '扫描风险', status: 'in_progress' };
    const initial = [
      todoMessage('todo-1-start', [step1]),
      toolMessage('t1', { title: 'a', panelBase: BASE, panel: [
        { op: 'rowUpdate', view: 'kb', id: 'r1', set: { state: 'hit' } },
        { op: 'pulse', view: 'kb', ids: ['r1'], kind: 'hit' },
      ] }),
    ];
    const { result, rerender } = renderHook(
      ({ items }: { items: MessageItem[] }) => useSystemPanel(items),
      { initialProps: { items: initial } },
    );
    expect(result.current.pulse?.ids).toEqual(['r1']);

    rerender({ items: [
      ...initial,
      todoMessage('todo-1-end', [{ ...step1, status: 'completed' }]),
      { id: 'summary', type: 'text', content: '本步完成' } as MessageItem,
    ] });
    expect(result.current.pulse?.ids).toEqual(['r1']);

    rerender({ items: [
      ...initial,
      todoMessage('todo-1-end', [{ ...step1, status: 'completed' }]),
      todoMessage('todo-2-start', [
        { ...step1, status: 'completed' },
        { id: 'step-2', kind: 'business', content: '生成摘要', status: 'in_progress' },
      ]),
      { id: 'next-text', type: 'text', content: '正在生成摘要' } as MessageItem,
    ] });
    expect(result.current.pulse).toBeNull();
  });

  it('新用户输入、空 panel 组和新 run 的无面板工具都会清除旧 delta', () => {
    const first = [toolMessage('t1', { title: 'a', panelBase: BASE, panel: [
      { op: 'rowUpdate', view: 'kb', id: 'r1', set: { state: 'hit' } },
      { op: 'pulse', view: 'kb', ids: ['r1'], kind: 'hit' },
    ] })];
    const withUser = renderHook(() => useSystemPanel([
      ...first,
      { id: 'u2', type: 'user', content: '下一步' } as MessageItem,
    ]));
    expect(withUser.result.current.pulse).toBeNull();

    const withEmptyPanel = renderHook(() => useSystemPanel([
      ...first,
      toolMessage('t2', { title: '空变化组', panel: [] }),
    ]));
    expect(withEmptyPanel.result.current.pulse).toBeNull();

    const run1Panel = { ...first[0], runId: 'run-1' } as MessageItem;
    const withNewRunTool = renderHook(() => useSystemPanel([
      run1Panel,
      { id: 't3', type: 'tool_use', toolName: 'Read', toolInput: '{}', toolId: 't3', runId: 'run-2' } as MessageItem,
    ]));
    expect(withNewRunTool.result.current.pulse).toBeNull();

    const withNewRunText = renderHook(() => useSystemPanel([
      run1Panel,
      { id: 'answer', type: 'text', content: '新运行开始', runId: 'run-2' } as MessageItem,
    ]));
    expect(withNewRunText.result.current.pulse).toBeNull();
  });

  it('无步骤归属的 delta 遇到首个 TodoWrite 时清除，不冒充新步骤变化', () => {
    const { result } = renderHook(() => useSystemPanel([
      toolMessage('t1', { title: 'a', panelBase: BASE, panel: [
        { op: 'rowUpdate', view: 'kb', id: 'r1', set: { state: 'hit' } },
        { op: 'pulse', view: 'kb', ids: ['r1'], kind: 'hit' },
      ] }),
      todoMessage('todo-new', [
        { id: 'step-new', kind: 'business', content: '新步骤', status: 'in_progress' },
      ]),
    ]));
    expect(result.current.pulse).toBeNull();
  });

  it('用户切 tab 后不被后续 focus patch 抢走焦点', () => {
    const messages = [
      toolMessage('t1', { title: 'a', panelBase: BASE }),
      toolMessage('t2', { title: 'b', panel: [{ op: 'focus', view: 'audit' }] }),
    ];
    const { result } = renderHook(() => useSystemPanel(messages));
    act(() => result.current.selectView('kb'));
    expect(result.current.snapshot!.activeView).toBe('kb');
  });
});

describe('useSystemPanelDock', () => {
  beforeEach(() => sessionStorage.clear());

  it('有面板即自动打开', () => {
    const { result } = renderHook(() => useSystemPanelDock([toolMessage('t1', { title: 'a', panelBase: BASE })], 's1'));
    expect(result.current.open).toBe(true);
  });

  it('用户关闭一次后本会话不再自动打开——显式意图压过自动行为', () => {
    const messages = [toolMessage('t1', { title: 'a', panelBase: BASE })];
    const { result } = renderHook(() => useSystemPanelDock(messages, 's1'));
    act(() => result.current.dismiss());
    expect(result.current.open).toBe(false);
    // 快照仍在：面板只是被收起，不是被销毁
    expect(result.current.snapshot).toBeTruthy();
  });

  it('关闭态按 sessionId 隔离，切到别的会话仍会自动打开', () => {
    const messages = [toolMessage('t1', { title: 'a', panelBase: BASE })];
    const first = renderHook(() => useSystemPanelDock(messages, 's1'));
    act(() => first.result.current.dismiss());
    expect(first.result.current.open).toBe(false);

    const second = renderHook(() => useSystemPanelDock(messages, 's2'));
    expect(second.result.current.open).toBe(true);
  });

  it('关闭态跨重新挂载保留（刷新后仍记得用户关过）', () => {
    const messages = [toolMessage('t1', { title: 'a', panelBase: BASE })];
    const first = renderHook(() => useSystemPanelDock(messages, 's3'));
    act(() => first.result.current.dismiss());
    first.unmount();

    const again = renderHook(() => useSystemPanelDock(messages, 's3'));
    expect(again.result.current.open).toBe(false);
  });

  it('无面板数据时 open 恒为 false', () => {
    const { result } = renderHook(() => useSystemPanelDock([{ id: 'm1', type: 'text', content: 'x' } as MessageItem], 's4'));
    expect(result.current.open).toBe(false);
  });
});
