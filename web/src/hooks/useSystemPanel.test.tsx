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
