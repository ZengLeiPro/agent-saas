import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { PanelView, SystemPanelSnapshot } from '@agent/shared';

import { SystemPanel } from './index';

function view(index: number): PanelView {
  return {
    key: `view-${index}`,
    label: `视图 ${index}`,
    winTitle: `系统视图 ${index}`,
    toolbar: {
      title: `第 ${index} 个系统视图的完整业务标题`,
      sub: `第 ${index} 个视图的完整变化说明`,
    },
    widget: { kind: 'rows', rows: [] },
  };
}

function snapshot(activeView = 'view-6'): SystemPanelSnapshot {
  return {
    title: '企业系统实况',
    activeView,
    views: Array.from({ length: 6 }, (_, index) => view(index + 1)),
    foot: '演示来源：CRM · ERP · 供应链系统（不进入真实审计）',
  };
}

describe('SystemPanel', () => {
  it('视图超过四个时始终保留 active tab，其余收进“更多”且可切换', async () => {
    const user = userEvent.setup();
    const onSelectView = vi.fn();
    render(<SystemPanel snapshot={snapshot()} onSelectView={onSelectView} />);

    const active = screen.getByRole('button', { name: '视图 6' });
    expect(active.getAttribute('aria-current')).toBe('page');
    expect(screen.queryByRole('button', { name: '视图 4' })).toBeNull();
    const more = screen.getByRole('button', { name: '更多系统视图，共 2 个' });
    expect(more).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '视图 1' }));
    expect(onSelectView).toHaveBeenCalledWith('view-1');

    await user.click(more);
    await user.click(await screen.findByRole('menuitem', { name: '视图 4' }));
    expect(onSelectView).toHaveBeenCalledWith('view-4');
  });

  it('stats 变化与其他业务对象共用 delta 高亮和摘要', () => {
    const panel: SystemPanelSnapshot = {
      activeView: 'stats',
      views: [{
        key: 'stats',
        label: '指标',
        winTitle: '业务指标',
        widget: { kind: 'stats', items: [{ k: '风险订单', v: '3' }, { k: '正常订单', v: '12' }] },
      }],
    };
    const { container } = render(<SystemPanel
      snapshot={panel}
      pulse={{ op: 'pulse', view: 'stats', ids: ['风险订单'], kind: 'scan' }}
    />);
    expect(screen.getByRole('status', { name: '本步扫描 1 项' })).toBeTruthy();
    expect(container.querySelectorAll('[data-panel-delta="scan"]')).toHaveLength(1);
  });

  it('面板标题、工具栏说明和来源脚注保留完整文本', () => {
    const panel = snapshot();
    panel.title = '企业系统实况 · 本次采购缺料闭环的完整标题';
    render(<SystemPanel snapshot={panel} />);

    expect(screen.getByTitle('企业系统实况 · 本次采购缺料闭环的完整标题').textContent)
      .toBe('企业系统实况 · 本次采购缺料闭环的完整标题');
    expect(screen.getByTitle('第 6 个系统视图的完整业务标题').textContent).toBe('第 6 个系统视图的完整业务标题');
    expect(screen.getByTitle('第 6 个视图的完整变化说明').textContent).toBe('第 6 个视图的完整变化说明');
    expect(screen.getByTitle('演示来源：CRM · ERP · 供应链系统（不进入真实审计）').textContent)
      .toBe('演示来源：CRM · ERP · 供应链系统（不进入真实审计）');
  });
});
