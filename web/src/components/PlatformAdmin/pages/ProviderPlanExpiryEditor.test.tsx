import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderQuotaSnapshot } from '@agent/shared';
const api = vi.hoisted(() => ({
  setProviderPlanExpiry: vi.fn(),
  setProviderPlanNote: vi.fn(),
}));
vi.mock('../api', () => ({ platformAdminApi: api }));
import {
  ProviderPlanExpiryEditor,
  fromBeijingInput,
  toBeijingInput,
} from './ProviderPlanExpiryEditor';
const snapshot: ProviderQuotaSnapshot = {
  accountKey: 'codex:a',
  accountLabel: 'a@example.com',
  sourceKind: 'codex_subscription',
  windows: [],
  limitReached: false,
  ok: true,
  collectedAt: '',
  planExpiry: { editable: true },
};
const saved = { items: [] };
describe('ProviderPlanExpiryEditor', () => {
  beforeEach(() => {
    api.setProviderPlanExpiry.mockReset().mockResolvedValue(saved);
    api.setProviderPlanNote.mockReset().mockResolvedValue(saved);
  });
  it('北京时间转换不受本地时区影响，拒绝不存在的日期', () => {
    expect(fromBeijingInput('2026-10-01T23:59')).toBe('2026-10-01T15:59:00.000Z');
    expect(toBeijingInput('2026-10-01T15:59:00Z')).toBe('2026-10-01T23:59');
    expect(fromBeijingInput('2026-02-30T12:00')).toBeNull();
    expect(fromBeijingInput('')).toBeNull();
  });
  it('点击文字进入同一表单，保存到期时间并更新概览，取消不写入', async () => {
    const onSaved = vi.fn();
    render(<ProviderPlanExpiryEditor snapshot={snapshot} onSaved={onSaved} />);
    fireEvent.click(screen.getByRole('button', { name: /编辑/ }));
    fireEvent.click(screen.getByText('取消'));
    expect(api.setProviderPlanExpiry).not.toHaveBeenCalled();
    expect(api.setProviderPlanNote).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /编辑/ }));
    fireEvent.change(screen.getByLabelText('到期时间'), { target: { value: '2026-10-01T23:59' } });
    fireEvent.click(screen.getByText('保存'));
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(saved));
    expect(api.setProviderPlanExpiry).toHaveBeenCalledWith('codex:a', '2026-10-01T15:59:00.000Z');
    expect(api.setProviderPlanNote).toHaveBeenCalledWith('codex:a', null);
    expect(screen.queryByRole('dialog')).toBeNull();
  });
  it('保存失败保留输入，清除发送 null 并展示供应商参考时间', async () => {
    api.setProviderPlanExpiry.mockRejectedValueOnce(new Error('连接失败'));
    render(
      <ProviderPlanExpiryEditor
        snapshot={{
          ...snapshot,
          planExpiry: {
            editable: true,
            endTime: '2026-10-01T15:59:00Z',
            manualEndTime: '2026-10-01T15:59:00Z',
            providerEndTime: '2026-11-01T15:59:00Z',
          },
        }}
        onSaved={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /编辑/ }));
    expect(screen.getByText('供应商时间：11/01 23:59')).toBeTruthy();
    fireEvent.click(screen.getByText('保存'));
    await screen.findByText('连接失败');
    expect((screen.getByLabelText('到期时间') as HTMLInputElement).value).toBe('2026-10-01T23:59');
    fireEvent.click(screen.getByText('清除手动设置'));
    await waitFor(() =>
      expect(api.setProviderPlanExpiry).toHaveBeenLastCalledWith('codex:a', null),
    );
  });
  it('到期与备注同一行展示，点击文字编辑并截断长备注', async () => {
    const onSaved = vi.fn();
    const longNote = '这是一个较长的套餐备注，用于确认展示区域不会挤压账号标题。';
    render(
      <ProviderPlanExpiryEditor
        snapshot={{
          ...snapshot,
          planExpiry: {
            editable: true,
            endTime: '2026-10-01T15:59:00Z',
            note: longNote,
          },
        }}
        onSaved={onSaved}
      />,
    );
    expect(screen.getByText(/^到期 /).textContent).toContain('10/01 23:59');
    const displayedNote = screen.getByTitle(longNote);
    expect(displayedNote.className).toContain('truncate');
    expect(screen.queryByRole('button', { name: '编辑 a@example.com 备注' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '编辑 a@example.com 到期时间与备注' }));
    fireEvent.change(screen.getByRole('textbox', { name: '备注内容' }), { target: { value: '续费前确认额度' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(api.setProviderPlanNote).toHaveBeenCalledWith('codex:a', '续费前确认额度'));
    expect(api.setProviderPlanExpiry).toHaveBeenCalledWith('codex:a', '2026-10-01T15:59:00.000Z');
    expect(onSaved).toHaveBeenCalledWith(saved);
    expect(screen.queryByRole('dialog')).toBeNull();
  });
  it('保存空备注时向服务端发送 null，并保留失败时的弹窗和错误', async () => {
    api.setProviderPlanNote.mockRejectedValueOnce(new Error('连接失败'));
    render(
      <ProviderPlanExpiryEditor
        snapshot={{ ...snapshot, planExpiry: { editable: true, note: '已有备注' } }}
        onSaved={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '编辑 a@example.com 到期时间与备注' }));
    fireEvent.change(screen.getByRole('textbox', { name: '备注内容' }), { target: { value: '   ' } });
    fireEvent.click(screen.getByText('保存'));
    await screen.findByText('连接失败');
    expect(api.setProviderPlanNote).toHaveBeenCalledWith('codex:a', null);
    expect(api.setProviderPlanExpiry).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeTruthy();
  });
});
