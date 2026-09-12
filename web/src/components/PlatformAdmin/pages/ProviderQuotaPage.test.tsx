import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderQuotaHistoryResponse, ProviderQuotaOverviewResponse, ProviderQuotaSnapshot } from '@agent/shared';

const api = vi.hoisted(() => ({
  providerQuota: vi.fn(),
  providerQuotaHistory: vi.fn(),
  refreshProviderQuota: vi.fn(),
}));

vi.mock('../api', () => ({ platformAdminApi: api }));

import {
  ProviderQuotaPage,
  accountStatus,
  baselineUsedPercent,
  formatResetIn,
  formatResetTime,
  formatQuotaWindowLabel,
  formatWan,
  windowTone,
} from './ProviderQuotaPage';
import { ProviderQuotaPlanBadge } from './ProviderQuotaPlanBadge';
import {
  PROVIDER_QUOTA_ORDER_STORAGE_KEY,
  moveQuotaAccount,
  orderQuotaAccounts,
  readQuotaAccountOrder,
  writeQuotaAccountOrder,
} from './providerQuotaOrder';

const overview: ProviderQuotaOverviewResponse = {
  items: [
    {
      sourceKind: 'volcengine_ark_plan',
      accountKey: 'volcengine:ark',
      accountLabel: '火山 Agent Plan',
      groupId: 'ark',
      plan: { type: 'Max', status: 'Running', endTime: '2026-09-09T15:59:59Z', autoRenew: false },
      windows: [
        {
          id: 'five_hour',
          label: '5 小时',
          usedPercent: 0.48,
          used: 241.9,
          quota: 50000,
          unit: 'AFP',
          resetAt: '2026-09-05T11:12:02.000Z',
        },
        {
          id: 'monthly',
          label: '近一月',
          usedPercent: 94.07,
          used: 378005.7,
          quota: 401822.4,
          unit: 'AFP',
          resetAt: '2026-09-06T07:59:59.000Z',
        },
      ],
      limitReached: false,
      ok: true,
      collectedAt: '2026-09-05T06:30:00.000Z',
    },
    {
      sourceKind: 'codex_subscription',
      accountKey: 'codex:c1',
      accountLabel: 'kaiyankeji.3@gmail.com',
      plan: { type: 'pro' },
      windows: [{ id: 'primary', label: '每周', usedPercent: 100, unit: '%', limitReached: true }],
      limitReached: true,
      resetCredits: 2,
      credential: {
        expiresAt: '2026-09-14T06:22:10.000Z',
        availability: 'quota_cooldown',
        cooldownUntil: '2026-09-05T07:30:00.000Z',
        lastFailureCode: 'usage_limit_reached',
      },
      ok: false,
      error: 'Codex usage HTTP 401',
      collectedAt: '2026-09-05T06:30:00.000Z',
      extra: {
        lastSuccessAt: '2026-09-05T06:25:00.000Z',
        credits: { balance: '0', hasCredits: false, unlimited: false },
      },
    },
  ],
  collector: {
    enabled: true,
    intervalMs: 300_000,
    lastRunAt: '2026-09-05T06:30:00.000Z',
    lastError: 'kaiyankeji.3@gmail.com: Codex usage HTTP 401',
  },
  generatedAt: '2026-09-05T06:31:00.000Z',
};

const history: ProviderQuotaHistoryResponse = {
  hours: 24,
  points: [
    {
      accountKey: 'volcengine:ark',
      collectedAt: '2026-09-04T06:30:00.000Z',
      ok: true,
      windows: [{ id: 'monthly', usedPercent: 90 }],
    },
    {
      accountKey: 'volcengine:ark',
      collectedAt: '2026-09-05T06:30:00.000Z',
      ok: true,
      windows: [{ id: 'monthly', usedPercent: 94.07 }],
    },
  ],
  generatedAt: '2026-09-05T06:31:00.000Z',
};

const claudeAccount: ProviderQuotaSnapshot = {
  sourceKind: 'claude_subscription',
  accountKey: 'claude:c1',
  accountLabel: 'Claude 测试账号',
  windows: [{ id: 'seven_day', label: '每周', windowSeconds: 604_800, usedPercent: 20 }],
  limitReached: false,
  ok: true,
  collectedAt: '2026-09-05T06:30:00.000Z',
};
const sortableOverview: ProviderQuotaOverviewResponse = {
  ...overview,
  items: [...overview.items, claudeAccount],
};
const defaultOrder = ['codex:c1', 'claude:c1', 'volcengine:ark'];

function renderedAccountKeys(): string[] {
  return screen.getAllByTestId(/^quota-account-/u)
    .map((card) => card.getAttribute('data-testid')!.replace('quota-account-', ''));
}

function dragData() {
  return { effectAllowed: 'none', dropEffect: 'none', setData: vi.fn(), setDragImage: vi.fn() };
}

afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.removeItem(PROVIDER_QUOTA_ORDER_STORAGE_KEY);
});

describe('ProviderQuotaPage', () => {
  beforeEach(() => {
    window.localStorage.removeItem(PROVIDER_QUOTA_ORDER_STORAGE_KEY);
    api.providerQuota.mockReset().mockResolvedValue(overview);
    api.providerQuotaHistory.mockReset().mockResolvedValue(history);
    api.refreshProviderQuota.mockReset().mockResolvedValue(overview);
  });

  it('按账号渲染卡级状态、额度、凭据事实与采集器状态，不重复显示窗口级状态或 24h 变化', async () => {
    render(<ProviderQuotaPage />);
    await waitFor(() => expect(screen.getByTestId('quota-account-volcengine:ark')).toBeTruthy());
    expect(screen.getAllByText('接近上限')).toHaveLength(1);
    expect(screen.getByText('采集失败')).toBeTruthy();
    expect(screen.getByText('94.1%')).toBeTruthy();
    expect(screen.getByText('37.8万 / 40.2万')).toBeTruthy();
    expect(screen.queryByText(/已用 37\.8万 \/ 40\.2万 AFP/u)).toBeNull();
    expect(screen.getByText('100.0%')).toBeTruthy();
    expect(screen.getByText('Codex 订阅 · Pro · 重置券 2')).toBeTruthy();
    expect(screen.getByTitle(/^凭据到期 /u)).toBeTruthy();
    expect(screen.queryByText('冷却中')).toBeNull();
    expect(screen.getByText(/Codex usage HTTP 401。下方为/u)).toBeTruthy();
    expect(screen.queryByText(/24h [+-]/u)).toBeNull();
    expect(screen.queryByText('已撞限')).toBeNull();
    expect(screen.getByText(/每 5 分钟自动采集/u)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '查看说明' }));
    expect(screen.getByRole('dialog').textContent).toContain('每 5 分钟自动采集');
    expect(screen.getByText(/1 个异常/u)).toBeTruthy();
    expect(screen.getByTitle('采集失败 1 · 额度耗尽 0 · 凭据不可用 0')).toBeTruthy();
    expect(screen.getByText(/1 个需关注/u)).toBeTruthy();
    expect(api.providerQuotaHistory).toHaveBeenCalledWith(24);
  });

  it('「立即采集」全量刷新，卡上的刷新按钮只刷该账号', async () => {
    render(<ProviderQuotaPage />);
    await waitFor(() => expect(screen.getByTestId('quota-account-volcengine:ark')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /立即采集/u }));
    await waitFor(() => expect(api.refreshProviderQuota).toHaveBeenCalledWith(undefined));
    fireEvent.click(screen.getByRole('button', { name: '刷新 kaiyankeji.3@gmail.com' }));
    await waitFor(() => expect(api.refreshProviderQuota).toHaveBeenCalledWith('codex:c1'));
    expect(api.providerQuota).toHaveBeenCalledTimes(1);
  });

  it.each([0, '0', '0.00', undefined])('Credits 为 %s 时不显示占位', async (balance) => {
    api.providerQuota.mockResolvedValue({ ...overview, items: [{ ...overview.items[1], extra: { credits: { balance } } }] });
    render(<ProviderQuotaPage />);
    const card = await screen.findByTestId('quota-account-codex:c1');
    expect(within(card).queryByText(/Credits/)).toBeNull();
  });

  it.each([2.5, '12', -1])('非零 Credits %s 紧接套餐标签展示', async (balance) => {
    api.providerQuota.mockResolvedValue({ ...overview, items: [{ ...overview.items[1], extra: { credits: { balance } } }] });
    render(<ProviderQuotaPage />);
    const badge = await screen.findByText('Codex 订阅 · Pro · 重置券 2');
    expect(within(badge.parentElement!).getByText(`Credits ${balance}`)).toBeTruthy();
  });

  it('Claude 左侧 7 天、右侧 5 小时，附加模型默认折叠且无外框', async () => {
    const claude = {
      sourceKind: 'claude_subscription' as const,
      accountKey: 'claude:kaiyankeji.5@gmail.com',
      accountLabel: 'kaiyankeji.5@gmail.com',
      windows: [
        { id: 'five_hour', label: '5 小时', usedPercent: 22, resetAt: '2026-09-05T11:20:00.000Z' },
        { id: 'seven_day', label: '7 天', usedPercent: 37, resetAt: '2026-09-11T00:00:00.000Z' },
        { id: 'fable:seven_day', label: 'Fable · 7 天', windowSeconds: 604_800, usedPercent: 48, resetAt: '2026-09-11T00:00:00.000Z' },
      ],
      limitReached: false,
      ok: true,
      collectedAt: '2026-09-05T06:28:00.000Z',
    };
    api.providerQuota.mockResolvedValue({ ...overview, items: [...overview.items, claude] });
    render(<ProviderQuotaPage />);
    const card = await screen.findByTestId('quota-account-claude:kaiyankeji.5@gmail.com');
    expect(within(card).getByText('Claude 订阅')).toBeTruthy();
    const main = within(card).getByTestId('quota-window-seven_day').parentElement!;
    expect(main.className).toContain('sm:grid-cols-2');
    expect(within(main).getAllByRole('progressbar').map((bar) => bar.getAttribute('aria-label')))
      .toEqual(['周 已用', '5h 已用']);
    const summary = within(card).getByText(/其他（1）/u);
    const details = summary.closest('details')!;
    expect(details.open).toBe(false);
    expect(details.classList.contains('border')).toBe(false);
    expect(details.classList.contains('p-3')).toBe(false);
    expect(within(details).queryByTestId('quota-window-five_hour')).toBeNull();
    const additionalTile = within(details).getByTestId('quota-window-fable:seven_day');
    expect(additionalTile.parentElement?.className).not.toContain('sm:grid-cols-2');
    fireEvent.click(details.querySelector('summary')!);
    expect(details.open).toBe(true);
    expect(screen.queryByRole('button', { name: '刷新 kaiyankeji.5@gmail.com' })).toBeNull();
    expect(screen.getByRole('button', { name: '刷新 kaiyankeji.3@gmail.com' })).toBeTruthy();
    expect(claude.windows.map((window) => window.id)).toEqual(['five_hour', 'seven_day', 'fable:seven_day']);
  });

  it('Codex 周额度优先，附加模型默认折叠且不把账号标记为耗尽', async () => {
    const codex = {
      ...overview.items[1]!, ok: true, error: undefined, limitReached: false,
      credential: { availability: 'available' as const },
      windows: [
        { id: 'primary', label: '5 小时', usedPercent: 10, windowSeconds: 18000 },
        { id: 'secondary', label: '每周', usedPercent: 20, windowSeconds: 604800 },
        { id: 'mini:primary', label: 'Mini · 每周', usedPercent: 100, limitReached: true },
      ],
    };
    api.providerQuota.mockResolvedValue({ ...overview, items: [codex], collector: { ...overview.collector, lastRunAt: null } });
    render(<ProviderQuotaPage />);
    await waitFor(() => expect(screen.getByText('正常')).toBeTruthy());
    const windows = screen.getAllByRole('progressbar');
    expect(windows[0]?.getAttribute('aria-label')).toBe('周 已用');
    const summary = screen.getByText(/其他（1）/u);
    expect(summary.closest('details')?.open).toBe(false);
    expect(screen.getByText('1 个窗口已耗尽')).toBeTruthy();
    expect(screen.queryByText('已撞限')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '查看说明' }));
    expect(screen.getByRole('dialog').textContent).toContain('切回前台自动刷新');
    expect(screen.queryByText(/页面不自动刷新/u)).toBeNull();
    expect(screen.queryByText('可用')).toBeNull();
    expect(screen.queryByText('已耗尽')).toBeNull();
  });

  it('单个主额度占满一行、卡片采用工作流同款渐变底色，采集文字使用等宽数字', async () => {
    render(<ProviderQuotaPage />);
    const card = await screen.findByTestId('quota-account-codex:c1');
    const tile = screen.getByTestId('quota-window-primary');
    expect(tile.parentElement?.className).not.toContain('sm:grid-cols-2');
    expect(tile.textContent).toContain('100.0%');
    expect(tile.textContent).toContain('周');
    expect(tile.textContent).not.toContain('剩余');
    expect(card.className).toContain('bg-gradient-to-b');
    expect(card.className).toContain('from-brand-50/80');
    expect(card.className).not.toContain('border-l-[3px]');
    const timestamp = [...card.querySelectorAll('span')].find(el => el.textContent?.includes('采集 '));
    expect(timestamp?.className).toContain('tabular-nums');
    expect(timestamp?.textContent).not.toContain('采集于');
    expect(timestamp?.textContent).not.toMatch(/\d{2}:\d{2}:\d{2}/);
    expect(within(card).getByRole('button', { name: '刷新 kaiyankeji.3@gmail.com' })).toBeTruthy();
  });

  it('零重置券隐藏，采集与到期统一为两个字标签、相同字号与等宽数字', async () => {
    api.providerQuota.mockResolvedValue({ ...overview, items: overview.items.map(item => ({ ...item, resetCredits: 0 })) });
    render(<ProviderQuotaPage />);
    await screen.findByText('Codex 订阅 · Pro');
    expect(screen.queryByText(/重置券 0/)).toBeNull();
    expect(screen.getByText('火山 Agent Plan · Max')).toBeTruthy();
    const expiry = screen.getByText(/^到期 /);
    expect(expiry.textContent).not.toMatch(/\d{2}:\d{2}:\d{2}/);
    expect(expiry.className).toContain('text-xs');
    expect(expiry.className).toContain('tabular-nums');
    expect(screen.queryByText(/^套餐到期 /)).toBeNull();
    expect(screen.queryByText(/采集于|采集失败于/u)).toBeNull();
    expect(screen.queryByText('套餐状态')).toBeNull();
  });

  it.each([90, 100])('附加模型已用 %s%% 不显示窗口状态徽标，也不影响账号与顶部告警', async (usedPercent) => {
    const item = {
      ...overview.items[1]!, ok: true, error: undefined, limitReached: false,
      credential: { availability: 'available' as const },
      windows: [
        { id: 'primary', label: '每周', usedPercent: 20 },
        { id: 'mini:primary', label: 'Mini · 每周', usedPercent, limitReached: usedPercent >= 100 },
      ],
    };
    api.providerQuota.mockResolvedValue({ ...overview, items: [item] });
    render(<ProviderQuotaPage />);
    await screen.findByText('正常');
    expect(screen.queryByText(/个异常|个需关注/)).toBeNull();
    expect(screen.getByTestId('quota-window-primary').textContent).not.toMatch(/接近上限|已撞限/);
    expect(screen.queryByText('已撞限')).toBeNull();
    expect(screen.queryByText('已耗尽')).toBeNull();
  });

  it('没有任何数据源时给出配置指引', async () => {
    api.providerQuota.mockResolvedValue({ ...overview, items: [] });
    render(<ProviderQuotaPage />);
    await waitFor(() => expect(screen.getByText('尚未配置任何套餐用量来源')).toBeTruthy());
  });

  it('接口失败时显示错误而不是空白', async () => {
    api.providerQuota.mockRejectedValue(
      new Error('套餐额度采集未启用：需要 PG runtime event store'),
    );
    render(<ProviderQuotaPage />);
    await waitFor(() => expect(screen.getByText(/套餐额度采集未启用/u)).toBeTruthy());
  });

  it('火山左侧近一月、右侧近一周，其他窗口默认折叠，不修改接口窗口顺序', async () => {
    const volcano = {
      ...overview.items[0]!,
      windows: [
        ...overview.items[0]!.windows,
        { id: 'daily', label: '近一天', usedPercent: 10 },
        { id: 'weekly', label: '近一周', usedPercent: 40 },
      ],
    };
    api.providerQuota.mockResolvedValue({ ...overview, items: [volcano] });
    render(<ProviderQuotaPage />);
    const card = await screen.findByTestId('quota-account-volcengine:ark');
    const main = within(card).getByTestId('quota-window-monthly').parentElement!;
    expect(main.className).toContain('sm:grid-cols-2');
    expect(within(main).getAllByRole('progressbar').map((bar) => bar.getAttribute('aria-label')))
      .toEqual(['月 已用', '周 已用']);
    const details = within(card).getByText('其他（2）').closest('details')!;
    expect(details.open).toBe(false);
    expect(within(details).getByTestId('quota-window-five_hour')).toBeTruthy();
    expect(within(details).getByTestId('quota-window-daily')).toBeTruthy();
    fireEvent.click(details.querySelector('summary')!);
    expect(details.open).toBe(true);
    expect(within(details).getAllByRole('progressbar')).toHaveLength(2);
    expect(volcano.windows.map((window) => window.id)).toEqual(['five_hour', 'monthly', 'daily', 'weekly']);
  });

  it('火山未返回周额度时不补造窗口，5 小时仍在折叠区', async () => {
    render(<ProviderQuotaPage />);
    const card = await screen.findByTestId('quota-account-volcengine:ark');
    const main = within(card).getByTestId('quota-window-monthly').parentElement!;
    expect(within(main).getAllByRole('progressbar')).toHaveLength(1);
    expect(main.className).not.toContain('sm:grid-cols-2');
    expect(within(card).queryByTestId('quota-window-weekly')).toBeNull();
    expect(within(card).getByTestId('quota-window-five_hour').closest('details')?.open).toBe(false);
    expect(overview.items[0]!.windows.map((window) => window.id)).toEqual(['five_hour', 'monthly']);
  });

  it('用量恰好 70% 即使用提醒色，调度冷却不再单独展示或影响统计', async () => {
    const item = {
      ...overview.items[1]!, ok: true, error: undefined, limitReached: false,
      windows: [{ id: 'primary', label: '每周', usedPercent: 70 }],
    };
    api.providerQuota.mockResolvedValue({ ...overview, items: [item] });
    render(<ProviderQuotaPage />);
    await screen.findByText('接近上限');
    expect(screen.getByRole('progressbar').firstElementChild?.className).toContain('bg-warning');
    expect(screen.queryByText('冷却中')).toBeNull();
    expect(screen.getByText('1 个需关注')).toBeTruthy();
  });

  it('统一压缩不同供应商的周期标签，并保留模型前缀', () => {
    expect(formatQuotaWindowLabel('周用量模型积分')).toBe('周');
    expect(formatQuotaWindowLabel('Mini · 每周')).toBe('Mini · 周');
    expect(formatQuotaWindowLabel('Fable · 7 天')).toBe('Fable · 周');
    expect(formatQuotaWindowLabel('近一月')).toBe('月');
    expect(formatQuotaWindowLabel('5 小时模型额度')).toBe('5h');
    expect(formatQuotaWindowLabel('近一天')).toBe('天');
  });

  it('没有本地偏好时，默认按 Codex、Claude、火山排列', async () => {
    api.providerQuota.mockResolvedValue(sortableOverview);
    render(<ProviderQuotaPage />);
    await screen.findByTestId('quota-account-claude:c1');
    expect(renderedAccountKeys()).toEqual(defaultOrder);
    expect(window.localStorage.getItem(PROVIDER_QUOTA_ORDER_STORAGE_KEY)).toBeNull();
    expect(sortableOverview.items[0]!.accountKey).toBe('volcengine:ark');
  });

  it('优先恢复浏览器保存的顺序，忽略已删除账号', async () => {
    window.localStorage.setItem(PROVIDER_QUOTA_ORDER_STORAGE_KEY, JSON.stringify(['removed', 'volcengine:ark', 'claude:c1', 'codex:c1']));
    api.providerQuota.mockResolvedValue(sortableOverview);
    render(<ProviderQuotaPage />);
    await screen.findByTestId('quota-account-claude:c1');
    expect(renderedAccountKeys()).toEqual(['volcengine:ark', 'claude:c1', 'codex:c1']);
  });

  it('只通过六点手柄拖动，落下后保存顺序，刷新数据和重新进入页面均保持', async () => {
    api.providerQuota.mockResolvedValue(sortableOverview);
    api.refreshProviderQuota.mockResolvedValue(sortableOverview);
    const view = render(<ProviderQuotaPage />);
    const target = await screen.findByTestId('quota-account-volcengine:ark');
    const source = screen.getByRole('button', { name: '拖动排序 kaiyankeji.3@gmail.com' });
    const dataTransfer = dragData();
    expect(source.getAttribute('draggable')).toBe('true');
    expect(screen.getByTestId('quota-account-codex:c1').getAttribute('draggable')).toBeNull();
    expect(screen.getByRole('button', { name: '刷新 kaiyankeji.3@gmail.com' }).getAttribute('draggable')).toBeNull();
    fireEvent.dragStart(source, { dataTransfer, clientX: 12, clientY: 12 });
    expect(dataTransfer.setData).toHaveBeenCalledWith('text/plain', 'codex:c1');
    expect(dataTransfer.setDragImage).toHaveBeenCalled();
    fireEvent.dragOver(target, { dataTransfer });
    expect(target.parentElement?.className).toContain('ring-2');
    fireEvent.drop(target, { dataTransfer });
    fireEvent.dragEnd(source, { dataTransfer });
    const expected = ['claude:c1', 'volcengine:ark', 'codex:c1'];
    expect(renderedAccountKeys()).toEqual(expected);
    expect(window.localStorage.getItem(PROVIDER_QUOTA_ORDER_STORAGE_KEY)).toBe(JSON.stringify(expected));
    expect(api.refreshProviderQuota).not.toHaveBeenCalled();
    expect(api.providerQuota).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: '立即采集' }));
    await waitFor(() => expect(api.refreshProviderQuota).toHaveBeenCalledWith(undefined));
    await waitFor(() => expect(screen.getByRole('button', { name: '立即采集' }).hasAttribute('disabled')).toBe(false));
    expect(renderedAccountKeys()).toEqual(expected);
    view.unmount();
    render(<ProviderQuotaPage />);
    await screen.findByTestId('quota-account-claude:c1');
    expect(renderedAccountKeys()).toEqual(expected);
  });

  it('外部拖入、取消拖拽和原位放下均不改变或保存顺序', async () => {
    api.providerQuota.mockResolvedValue(sortableOverview);
    render(<ProviderQuotaPage />);
    const target = await screen.findByTestId('quota-account-volcengine:ark');
    const source = screen.getByRole('button', { name: '拖动排序 kaiyankeji.3@gmail.com' });
    const dataTransfer = dragData();
    fireEvent.dragOver(target, { dataTransfer });
    fireEvent.drop(target, { dataTransfer });
    fireEvent.dragStart(source, { dataTransfer });
    fireEvent.dragOver(target, { dataTransfer });
    fireEvent.dragEnd(source, { dataTransfer });
    expect(target.parentElement?.className).not.toContain('ring-2');
    fireEvent.dragStart(source, { dataTransfer });
    fireEvent.drop(screen.getByTestId('quota-account-codex:c1'), { dataTransfer });
    fireEvent.dragEnd(source, { dataTransfer });
    expect(renderedAccountKeys()).toEqual(defaultOrder);
    expect(window.localStorage.getItem(PROVIDER_QUOTA_ORDER_STORAGE_KEY)).toBeNull();
  });

  it('手柄支持上下方向键排序，到达边界不产生写入', async () => {
    api.providerQuota.mockResolvedValue(sortableOverview);
    render(<ProviderQuotaPage />);
    await screen.findByTestId('quota-account-claude:c1');
    const handle = screen.getByRole('button', { name: '拖动排序 kaiyankeji.3@gmail.com' });
    fireEvent.keyDown(handle, { key: 'ArrowUp' });
    expect(window.localStorage.getItem(PROVIDER_QUOTA_ORDER_STORAGE_KEY)).toBeNull();
    fireEvent.keyDown(handle, { key: 'ArrowDown' });
    expect(renderedAccountKeys()).toEqual(['claude:c1', 'codex:c1', 'volcengine:ark']);
    expect(screen.getByRole('status').textContent).toContain('移至第 2 位');
    expect(JSON.parse(window.localStorage.getItem(PROVIDER_QUOTA_ORDER_STORAGE_KEY)!)).toEqual(renderedAccountKeys());
  });

  it('浏览器禁止写入时，当前页面仍可调整顺序且不会触发后端请求', async () => {
    api.providerQuota.mockResolvedValue(sortableOverview);
    render(<ProviderQuotaPage />);
    await screen.findByTestId('quota-account-claude:c1');
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Storage disabled'); });
    fireEvent.keyDown(screen.getByRole('button', { name: '拖动排序 kaiyankeji.3@gmail.com' }), { key: 'ArrowDown' });
    expect(renderedAccountKeys()).toEqual(['claude:c1', 'codex:c1', 'volcengine:ark']);
    expect(screen.getByRole('status').textContent).toContain('浏览器存储不可用');
    expect(api.refreshProviderQuota).not.toHaveBeenCalled();
  });
});

describe('helpers', () => {
  it('windowTone：≥70 提醒，撞限或 ≥100 告警', () => {
    expect(windowTone({ usedPercent: 10 })).toBe('ok');
    expect(windowTone({ usedPercent: 69.99 })).toBe('ok');
    expect(windowTone({ usedPercent: 70 })).toBe('warning');
    expect(windowTone({ usedPercent: 85 })).toBe('warning');
    expect(windowTone({ usedPercent: 99.99 })).toBe('warning');
    expect(windowTone({ usedPercent: 99, limitReached: true })).toBe('critical');
    expect(windowTone({ usedPercent: 100 })).toBe('critical');
  });

  it('accountStatus：采集失败 > 凭据不可用 > 已耗尽 > 接近上限 > 正常，忽略调度冷却', () => {
    const okWindow = { id: 'w', label: 'w', usedPercent: 10 };
    expect(accountStatus({ ok: false, limitReached: false, windows: [] })).toEqual({ tone: 'critical', label: '采集失败' });
    expect(accountStatus({ ok: true, limitReached: false, windows: [okWindow], credential: { availability: 'auth_unavailable' } }).label).toBe('凭据不可用');
    expect(accountStatus({ ok: true, limitReached: true, windows: [okWindow], credential: { availability: 'quota_cooldown' } }).label).toBe('已耗尽');
    expect(accountStatus({ ok: true, limitReached: false, windows: [okWindow], credential: { availability: 'quota_cooldown' } })).toEqual({ tone: 'ok', label: '正常' });
    expect(accountStatus({ ok: true, limitReached: false, windows: [{ ...okWindow, usedPercent: 70 }], credential: { availability: 'quota_cooldown' } }).label).toBe('接近上限');
    expect(accountStatus({ ok: true, limitReached: false, windows: [{ ...okWindow, usedPercent: 90 }] }).label).toBe('接近上限');
    expect(accountStatus({ ok: true, limitReached: false, windows: [okWindow] })).toEqual({ tone: 'ok', label: '正常' });
  });

  it('重置时间显示星期且只精确到分钟，不对非零秒数进位', () => {
    expect(formatResetTime('2026-09-10T12:34:56')).toMatch(/09\/10 周四 12:34$/);
    expect(formatResetTime('2026-09-10T23:59:59')).toMatch(/09\/10 周四 23:59$/);
    expect(formatResetTime(undefined)).toBe('—');
    expect(formatResetTime('not-a-date')).toBe('—');
  });

  it('formatWan：万/亿量级与小数位', () => {
    expect(formatWan(378005.7)).toBe('37.8万');
    expect(formatWan(1_398.957)).toBe('1,399');
    expect(formatWan(50_000)).toBe('5.0万');
    expect(formatWan(2_500_000)).toBe('250万');
    expect(formatWan(123_456_789)).toBe('1.23亿');
    expect(formatWan(0.6)).toBe('0.6');
    expect(formatWan(0)).toBe('0');
  });

  it('formatResetIn：只保留剩余时长，不再追加「后重置」', () => {
    const now = Date.parse('2026-09-05T06:00:00Z');
    expect(formatResetIn(undefined, now)).toBeNull();
    expect(formatResetIn('2026-09-05T05:00:00Z', now)).toBe('即将重置');
    expect(formatResetIn('2026-09-05T06:30:00Z', now)).toBe('30 分钟');
    expect(formatResetIn('2026-09-05T09:15:00Z', now)).toBe('3 小时 15 分');
    expect(formatResetIn('2026-09-10T06:00:00Z', now)).toBe('5 天');
  });

  it('baselineUsedPercent 只取该账号该窗口最早的成功点', () => {
    expect(baselineUsedPercent(history.points, 'volcengine:ark', 'monthly')).toBe(90);
    expect(baselineUsedPercent(history.points, 'volcengine:ark', 'weekly')).toBeNull();
    expect(baselineUsedPercent(history.points, 'codex:c1', 'primary')).toBeNull();
  });
});

describe('quota account order', () => {
  it.each(['not-json', 'null', '{}', '42', '"codex:c1"'])('无效的本地存储 %s 回退默认顺序', (value) => {
    window.localStorage.setItem(PROVIDER_QUOTA_ORDER_STORAGE_KEY, value);
    expect(readQuotaAccountOrder()).toEqual([]);
    expect(orderQuotaAccounts(sortableOverview.items, readQuotaAccountOrder()).map((item) => item.accountKey)).toEqual(defaultOrder);
  });

  it('去除非字符串、空值和重复项，并保持首个有效位置', () => {
    window.localStorage.setItem(PROVIDER_QUOTA_ORDER_STORAGE_KEY, '["codex:c1",null,42,"","codex:c1","volcengine:ark"]');
    expect(readQuotaAccountOrder()).toEqual(['codex:c1', 'volcengine:ark']);
  });

  it('本地存储读写抛错不会影响页面', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('Storage disabled'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Storage disabled'); });
    expect(readQuotaAccountOrder()).toEqual([]);
    expect(writeQuotaAccountOrder(defaultOrder)).toBe(false);
  });

  it('失效账号被忽略，新账号按供应商顺序追加，同供应商保持接口顺序', () => {
    const items = [...sortableOverview.items, { ...overview.items[1]!, accountKey: 'codex:c2' }];
    const saved = ['removed', 'volcengine:ark'];
    expect(orderQuotaAccounts(items, saved).map((item) => item.accountKey))
      .toEqual(['volcengine:ark', 'codex:c1', 'codex:c2', 'claude:c1']);
    expect(orderQuotaAccounts(items, []).map((item) => item.accountKey))
      .toEqual(['codex:c1', 'codex:c2', 'claude:c1', 'volcengine:ark']);
    expect(items[0]!.accountKey).toBe('volcengine:ark');
  });

  it('移动不修改输入，支持向前向后，并忽略无效目标和原位移动', () => {
    expect(moveQuotaAccount(defaultOrder, 'codex:c1', 'volcengine:ark')).toEqual(['claude:c1', 'volcengine:ark', 'codex:c1']);
    expect(moveQuotaAccount(defaultOrder, 'volcengine:ark', 'codex:c1')).toEqual(['volcengine:ark', 'codex:c1', 'claude:c1']);
    expect(moveQuotaAccount(defaultOrder, 'removed', 'codex:c1')).toBeNull();
    expect(moveQuotaAccount(defaultOrder, 'codex:c1', 'removed')).toBeNull();
    expect(moveQuotaAccount(defaultOrder, 'codex:c1', 'codex:c1')).toBeNull();
    expect(defaultOrder).toEqual(['codex:c1', 'claude:c1', 'volcengine:ark']);
  });
});

describe('ProviderQuotaPlanBadge', () => {
  it.each([
    ['codex_subscription', 'pro', 'bg-blue-50'],
    ['codex_subscription', 'plus', 'bg-blue-50'],
    ['codex_subscription', 'enterprise', 'bg-blue-50'],
    ['codex_subscription', undefined, 'bg-blue-50'],
    ['volcengine_ark_plan', 'Pro', 'bg-violet-50'],
    ['volcengine_ark_plan', 'Lite', 'bg-violet-50'],
    ['volcengine_ark_plan', 'Max', 'bg-violet-50'],
    ['volcengine_ark_plan', undefined, 'bg-violet-50'],
    ['claude_subscription', 'pro', 'bg-orange-50'],
    ['claude_subscription', 'max', 'bg-amber-50'],
  ] as const)('%s 的 %s 套餐使用 %s', (sourceKind, planType, color) => {
    render(<ProviderQuotaPlanBadge sourceKind={sourceKind} planType={planType}>测试套餐</ProviderQuotaPlanBadge>);
    expect(screen.getByText('测试套餐').className).toContain(color);
  });
});
