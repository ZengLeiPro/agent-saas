/**
 * 组织管理「连接器映射」（2026-08-04 任务 E）。
 *
 * 守的重点：两层数据的展示语义——覆盖徽标不能骗人（有覆盖才标）、
 * 保存走租户 API（整条覆盖）、「恢复平台默认」只对已覆盖条目出现。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import { TenantConnectorDictionaryPanel } from './TenantPanel';

const fetchOrgConnectorDictionary = vi.fn();
const saveOrgConnectorEntry = vi.fn();
const deleteOrgConnectorOverride = vi.fn();

vi.mock('@agent/shared', () => ({
  fetchConnectorDictionary: vi.fn(),
  saveConnectorEntry: vi.fn(),
  deleteConnectorEntry: vi.fn(),
  resetConnectorDictionary: vi.fn(),
  fetchOrgConnectorDictionary: (...args: unknown[]) => fetchOrgConnectorDictionary(...args),
  saveOrgConnectorEntry: (...args: unknown[]) => saveOrgConnectorEntry(...args),
  deleteOrgConnectorOverride: (...args: unknown[]) => deleteOrgConnectorOverride(...args),
}));

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ platformReadOnly: false }),
}));

const PLATFORM_DWS = {
  binary: 'dws',
  systemName: '钉钉',
  enabled: true,
  modules: { todo: '待办' },
  actionVerbs: { create: { name: '创建', write: true } },
  excludePatterns: ['--help'],
  urlWhitelist: [],
};

const PLATFORM_FEISHU = {
  binary: 'feishu',
  systemName: '飞书',
  enabled: true,
  modules: {},
  actionVerbs: {},
  excludePatterns: [],
  urlWhitelist: [],
};

const KAIYAN_DWS_OVERRIDE = {
  ...PLATFORM_DWS,
  systemName: '钉钉',
  modules: { todo: '客户任务' },
  updatedAt: '2026-08-04T00:00:00.000Z',
  updatedBy: 'zenglei',
};

beforeEach(() => {
  vi.clearAllMocks();
  fetchOrgConnectorDictionary.mockResolvedValue({
    tenantId: 'kaiyan',
    platform: [PLATFORM_DWS, PLATFORM_FEISHU],
    overrides: [KAIYAN_DWS_OVERRIDE],
  });
  saveOrgConnectorEntry.mockResolvedValue({
    tenantId: 'kaiyan',
    platform: [PLATFORM_DWS, PLATFORM_FEISHU],
    overrides: [KAIYAN_DWS_OVERRIDE],
  });
  deleteOrgConnectorOverride.mockResolvedValue({
    tenantId: 'kaiyan',
    platform: [PLATFORM_DWS, PLATFORM_FEISHU],
    overrides: [],
  });
});

describe('TenantConnectorDictionaryPanel', () => {
  it('合并展示：覆盖条目带「已覆盖」徽标，纯平台条目不带', async () => {
    render(<TenantConnectorDictionaryPanel tenantId="kaiyan" tenantName="开沿科技" />);
    // dws 同时出现在列表项与编辑区标题（选中态），用 getAllByText
    await waitFor(() => expect(screen.getAllByText('dws').length).toBeGreaterThan(0));
    expect(fetchOrgConnectorDictionary).toHaveBeenCalledWith('kaiyan');
    expect(screen.getByText('已覆盖')).toBeTruthy();
    expect(screen.getByText('feishu')).toBeTruthy();
    // 选中覆盖条目 → 编辑区显示覆盖版模块映射
    await waitFor(() => expect(screen.getByLabelText('模块映射')).toBeTruthy());
    expect((screen.getByLabelText('模块映射') as HTMLTextAreaElement).value).toBe('todo = 客户任务');
  });

  it('已覆盖条目显示「恢复平台默认」，点击走 delete API 并回落', async () => {
    render(<TenantConnectorDictionaryPanel tenantId="kaiyan" />);
    await waitFor(() => expect(screen.getByText('已覆盖')).toBeTruthy());
    const restore = screen.getByRole('button', { name: /恢复平台默认/ });
    fireEvent.click(restore);
    await waitFor(() => expect(deleteOrgConnectorOverride).toHaveBeenCalledWith('dws', 'kaiyan'));
    // 覆盖被移除后徽标消失
    await waitFor(() => expect(screen.queryByText('已覆盖')).toBeNull());
  });

  it('未覆盖的平台条目不显示「恢复平台默认」；编辑保存走租户 API', async () => {
    render(<TenantConnectorDictionaryPanel tenantId="kaiyan" />);
    await waitFor(() => expect(screen.getByText('feishu')).toBeTruthy());
    fireEvent.click(screen.getByText('feishu'));
    await waitFor(() =>
      expect((screen.getByLabelText('系统名') as HTMLInputElement).value).toBe('飞书'));
    expect(screen.queryByRole('button', { name: /恢复平台默认/ })).toBeNull();

    fireEvent.change(screen.getByLabelText('系统名'), { target: { value: '飞书企业版' } });
    fireEvent.click(screen.getByRole('button', { name: /保存/ }));
    await waitFor(() => expect(saveOrgConnectorEntry).toHaveBeenCalled());
    const [entry, tenantId] = saveOrgConnectorEntry.mock.calls[0]!;
    expect((entry as { binary: string; systemName: string }).binary).toBe('feishu');
    expect((entry as { systemName: string }).systemName).toBe('飞书企业版');
    expect(tenantId).toBe('kaiyan');
  });
});
