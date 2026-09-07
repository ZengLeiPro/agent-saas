import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderQuotaSnapshot } from '@agent/shared';
const api = vi.hoisted(() => ({ setProviderPlanExpiry: vi.fn() }));
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
describe('ProviderPlanExpiryEditor', () => {
  beforeEach(() => api.setProviderPlanExpiry.mockReset().mockResolvedValue({ items: [] }));
  it('北京时间转换不受本地时区影响，拒绝不存在的日期', () => {
    expect(fromBeijingInput('2026-10-01T23:59')).toBe('2026-10-01T15:59:00.000Z');
    expect(toBeijingInput('2026-10-01T15:59:00Z')).toBe('2026-10-01T23:59');
    expect(fromBeijingInput('2026-02-30T12:00')).toBeNull();
    expect(fromBeijingInput('')).toBeNull();
  });
  it('保存填写时间并更新概览，取消不写入', async () => {
    const onSaved = vi.fn();
    render(<ProviderPlanExpiryEditor snapshot={snapshot} onSaved={onSaved} />);
    fireEvent.click(screen.getByRole('button', { name: /编辑/ }));
    fireEvent.click(screen.getByText('取消'));
    expect(api.setProviderPlanExpiry).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /编辑/ }));
    fireEvent.change(screen.getByLabelText('到期时间'), { target: { value: '2026-10-01T23:59' } });
    fireEvent.click(screen.getByText('保存'));
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith({ items: [] }));
    expect(api.setProviderPlanExpiry).toHaveBeenCalledWith('codex:a', '2026-10-01T15:59:00.000Z');
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
});
