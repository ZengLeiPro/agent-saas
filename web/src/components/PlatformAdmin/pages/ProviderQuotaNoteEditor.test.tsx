import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderQuotaOverviewResponse, ProviderQuotaSnapshot } from '@agent/shared';

const api = vi.hoisted(() => ({ setProviderPlanNote: vi.fn() }));
vi.mock('../api', () => ({ platformAdminApi: api }));

import { ProviderQuotaNoteEditor } from './ProviderQuotaNoteEditor';

const snapshot: ProviderQuotaSnapshot = {
  accountKey: 'codex:a',
  accountLabel: 'a@example.com',
  sourceKind: 'codex_subscription',
  windows: [],
  limitReached: false,
  ok: true,
  collectedAt: '',
  planExpiry: { editable: true, note: '已有备注' },
};

const savedOverview = {} as ProviderQuotaOverviewResponse;

describe('ProviderQuotaNoteEditor', () => {
  beforeEach(() => {
    api.setProviderPlanNote.mockReset().mockResolvedValue(savedOverview);
  });

  afterEach(cleanup);

  it('读取服务端备注，保存新备注并保持长文本展示截断', async () => {
    const onSaved = vi.fn();
    const longNote = '这是一个较长的套餐备注，用于确认展示区域不会挤压右侧的到期时间。';
    render(<ProviderQuotaNoteEditor snapshot={{ ...snapshot, planExpiry: { editable: true, note: longNote } }} onSaved={onSaved} />);

    const displayedNote = screen.getByTitle(longNote);
    expect(displayedNote.className).toContain('truncate');
    expect(displayedNote.parentElement?.className).toContain('max-w-40');

    fireEvent.click(screen.getByRole('button', { name: '编辑 a@example.com 备注' }));
    fireEvent.change(screen.getByRole('textbox', { name: '备注内容' }), { target: { value: '续费前确认额度' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => expect(api.setProviderPlanNote).toHaveBeenCalledWith('codex:a', '续费前确认额度'));
    expect(onSaved).toHaveBeenCalledWith(savedOverview);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('保存空备注时向服务端发送 null，并保留失败时的弹窗和错误', async () => {
    api.setProviderPlanNote.mockRejectedValueOnce(new Error('连接失败'));
    render(<ProviderQuotaNoteEditor snapshot={snapshot} onSaved={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: '编辑 a@example.com 备注' }));
    fireEvent.change(screen.getByRole('textbox', { name: '备注内容' }), { target: { value: '   ' } });
    fireEvent.click(screen.getByText('保存'));
    await screen.findByText('连接失败');
    expect(api.setProviderPlanNote).toHaveBeenCalledWith('codex:a', null);
    expect(screen.getByRole('dialog')).toBeTruthy();
  });
});
