import { useState, type ComponentProps } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderQuotaOverviewResponse } from '@agent/shared';

const mocks = vi.hoisted(() => ({
  authFetch: vi.fn(),
  api: { providerQuota: vi.fn(), providerQuotaHistory: vi.fn(), refreshProviderQuota: vi.fn() },
}));
vi.mock('@/lib/authFetch', () => ({ authFetch: mocks.authFetch }));
vi.mock('../api', () => ({ platformAdminApi: mocks.api }));

import { GroupCredentialsFields, normalizeQuotaSourceForSave } from '@/components/ModelManager/GroupCredentialsFields';
import { ProviderQuotaPage } from './ProviderQuotaPage';

const savedGroup = {
  id: 'glm', baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4', hasApiKey: true,
};
type Group = ComponentProps<typeof GroupCredentialsFields>['group'];
function Form({ initial = savedGroup }: { initial?: Group }) {
  const [group, setGroup] = useState<Group>(initial);
  return <GroupCredentialsFields group={group} readOnly={false} hasOpenAiCompatible
    onChange={(patch) => setGroup((current) => ({ ...current, ...patch }))} />;
}

const overview: ProviderQuotaOverviewResponse = {
  items: [{
    sourceKind: 'zhipu_coding_plan', accountKey: 'zhipu:glm', accountLabel: '智谱测试分组', groupId: 'glm',
    windows: [
      { id: 'tokens_limit:3:5', label: '5 小时模型额度', windowSeconds: 18_000, usedPercent: 25 },
      { id: 'credit_limit:6:1', label: '每周模型积分', windowSeconds: 604_800, usedPercent: 80 },
    ],
    ok: true, limitReached: false, collectedAt: '2026-09-11T08:00:00.000Z',
    extra: { quotaScope: 'account' },
  }],
  collector: { enabled: true, intervalMs: 300_000, lastRunAt: null, lastError: null },
  generatedAt: '2026-09-11T08:00:00.000Z',
};

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  mocks.authFetch.mockReset().mockResolvedValue(new Response(JSON.stringify({
    windows: [{ id: 'five_hour', label: '5 小时模型额度', usedPercent: 25 }], limitReached: false,
  })));
  mocks.api.providerQuota.mockResolvedValue(overview);
  mocks.api.providerQuotaHistory.mockResolvedValue({ hours: 24, points: [], generatedAt: overview.generatedAt });
  mocks.api.refreshProviderQuota.mockResolvedValue(overview);
});
afterEach(cleanup);

describe('Zhipu quota model configuration', () => {
  it('recognizes existing official groups and tests the saved group key without returning it to the browser', async () => {
    render(<Form />);
    expect(screen.getByRole('note').textContent).toContain('账号共享');
    expect((screen.getByLabelText('套餐用量查询来源') as HTMLSelectElement).value).toBe('auto');
    expect(screen.queryByText('Access Key ID')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '测试额度查询' }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('25.0%'));
    const [url, options] = mocks.authFetch.mock.calls[0]!;
    expect(url).toBe('/api/admin/provider-quota/test');
    expect(JSON.parse(options.body)).toEqual({ provider: 'zhipu_coding_plan', groupId: 'glm' });
  });

  it('uses a newly typed key for a test and supports explicit monitoring behind a model proxy', async () => {
    render(<Form initial={{ ...savedGroup, baseUrl: 'https://proxy.example/v1', quotaSource: { provider: 'zhipu_coding_plan' } }} />);
    fireEvent.change(screen.getByPlaceholderText('已配置，留空则保留现有 Key'), { target: { value: ' dummy-draft-key ' } });
    fireEvent.click(screen.getByRole('button', { name: '测试额度查询' }));
    await waitFor(() => expect(mocks.authFetch).toHaveBeenCalledTimes(1));
    expect(JSON.parse(mocks.authFetch.mock.calls[0]![1].body)).toEqual({
      provider: 'zhipu_coding_plan', groupId: 'glm', apiKey: 'dummy-draft-key',
    });
  });

  it('persists an explicit opt-out instead of accidentally re-enabling automatic detection', () => {
    const onChange = vi.fn();
    const { rerender } = render(<GroupCredentialsFields group={savedGroup} readOnly={false} hasOpenAiCompatible onChange={onChange} />);
    fireEvent.change(screen.getByLabelText('套餐用量查询来源'), { target: { value: 'none' } });
    expect(onChange).toHaveBeenLastCalledWith({ quotaSource: { provider: 'none' } });
    expect(normalizeQuotaSourceForSave({ provider: 'none' })).toEqual({ provider: 'none' });
    rerender(<GroupCredentialsFields group={{ ...savedGroup, quotaSource: { provider: 'none' } }} readOnly={false} hasOpenAiCompatible onChange={onChange} />);
    expect(screen.queryByRole('button', { name: '测试额度查询' })).toBeNull();
    expect(screen.queryByRole('note')).toBeNull();
  });

  it('discards an in-flight test result after switching source', async () => {
    let resolve!: (value: Response) => void;
    mocks.authFetch.mockImplementationOnce(() => new Promise<Response>((done) => { resolve = done; }));
    render(<Form />);
    fireEvent.click(screen.getByRole('button', { name: '测试额度查询' }));
    fireEvent.change(screen.getByLabelText('套餐用量查询来源'), { target: { value: 'none' } });
    await act(async () => { resolve(new Response(JSON.stringify({ windows: [], limitReached: false, plan: { type: 'OLD-PLAN' } }))); });
    expect(screen.queryByText(/OLD-PLAN/u)).toBeNull();
  });

  it('preserves legacy volcano secret normalization and disables configuration in read-only mode', () => {
    expect(normalizeQuotaSourceForSave({ provider: 'volcengine_ark_plan', accessKeyId: ' AK ', secretAccessKey: ' ', hasQuotaSecret: true }))
      .toEqual({ provider: 'volcengine_ark_plan', accessKeyId: 'AK', region: 'cn-beijing' });
    expect(normalizeQuotaSourceForSave({ provider: 'zhipu_coding_plan' })).toEqual({ provider: 'zhipu_coding_plan' });
    render(<GroupCredentialsFields group={savedGroup} readOnly hasOpenAiCompatible onChange={vi.fn()} />);
    expect((screen.getByLabelText('套餐用量查询来源') as HTMLSelectElement).disabled).toBe(true);
    expect((screen.getByPlaceholderText('已配置，留空则保留现有 Key') as HTMLInputElement).disabled).toBe(true);
  });
});

describe('Zhipu quota dashboard card', () => {
  it('renders the provider, actual windows, shared-account warning and refresh actions', async () => {
    render(<ProviderQuotaPage />);
    await waitFor(() => expect(screen.getByTestId('quota-account-zhipu:glm')).toBeTruthy());
    expect(screen.getByText('智谱 Coding Plan')).toBeTruthy();
    expect(screen.getByTestId('zhipu-quota-scope').textContent).toContain('不是单 Key');
    expect(screen.getByText('25.0%')).toBeTruthy();
    expect(screen.getByText('80.0%')).toBeTruthy();
    expect(screen.getByText('接近上限')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '刷新 智谱测试分组' }));
    await waitFor(() => expect(mocks.api.refreshProviderQuota).toHaveBeenCalledWith('zhipu:glm'));
    await waitFor(() => expect((screen.getByRole('button', { name: '立即采集' }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: '立即采集' }));
    await waitFor(() => expect(mocks.api.refreshProviderQuota).toHaveBeenCalledWith(undefined));
  });

  it('shows a failed collection honestly while retaining last successful usage', async () => {
    mocks.api.providerQuota.mockResolvedValue({ ...overview, items: [{
      ...overview.items[0], ok: false, error: '智谱额度查询 HTTP 429',
      extra: { lastSuccessAt: '2026-09-11T07:55:00.000Z' },
    }] });
    render(<ProviderQuotaPage />);
    await waitFor(() => expect(screen.getByText('采集失败')).toBeTruthy());
    expect(screen.getByText(/最后一次成功数据/u)).toBeTruthy();
    expect(screen.getByText('25.0%')).toBeTruthy();
    expect(screen.queryByText('0.0%')).toBeNull();
  });
});
