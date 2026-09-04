import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { OverviewPage } from './OverviewPage';

const overviewSnapshot = vi.fn();
const billingTrend = vi.fn();
const overviewTrends = vi.fn();

vi.mock('../api', () => ({
  platformAdminApi: {
    overviewSnapshot: (...args: unknown[]) => overviewSnapshot(...args),
    billingTrend: (...args: unknown[]) => billingTrend(...args),
    overviewTrends: (...args: unknown[]) => overviewTrends(...args),
  },
}));

const baseSnapshot = {
  generatedAt: '2026-08-29T17:00:00.000Z',
  health: {
    activeRuns: { total: 0, byStatus: {} },
    sandboxes: { total: 0, running: 0, paused: 0, broken: 0 },
    todayRuns: 0,
    completionRateToday: 1,
    toolRouting24h: { total: 0, acsCount: 0, localCount: 0, failedCount: 0 },
    dispatch: null,
    sessionMetaProjection: null,
    handFailures1h: 0,
    storage: null,
  },
  attention: [],
};

const identity = (overrides: Record<string, unknown>) => ({
  schemaVersion: 1,
  status: 'consistent',
  expected: { schemaVersion: 1, digest: `sha256:${'a'.repeat(64)}` },
  observed: {
    schemaVersion: 1,
    digest: `sha256:${'a'.repeat(64)}`,
    credentialVersionDigest: null,
    versionResolution: 'resolved',
    secretRefCount: 0,
  },
  releaseId: 'rc-20260829-01',
  lastObservedAt: '2026-08-29T12:00:00.000Z',
  ...overrides,
});

function identityWithObserved(overrides: Record<string, unknown>) {
  const fixture = identity({});
  return {
    ...fixture,
    observed: { ...fixture.observed, ...overrides },
  };
}

function identityWithoutObservedField(field: string) {
  const fixture = identity({});
  const observed = { ...fixture.observed } as Record<string, unknown>;
  delete observed[field];
  return { ...fixture, observed };
}

function setup(snapshotResponse: unknown) {
  overviewSnapshot.mockResolvedValue(snapshotResponse);
  billingTrend.mockResolvedValue({ audit: { days: 14, daily: [] } });
  overviewTrends.mockResolvedValue({
    available: true,
    missingSources: [],
    days: 14,
    timezone: 'Asia/Shanghai',
    daily: [],
  });
}

describe('平台概览「配置身份」区块（TASK-318）', () => {
  beforeEach(() => {
    overviewSnapshot.mockReset();
    billingTrend.mockReset();
    overviewTrends.mockReset();
    window.history.replaceState({}, '', '/platform-console/overview/overview');
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1024 });
    window.history.replaceState({}, '', '/');
  });

  it('一致：渲染 digest 摘要与 Release ID，不出现任何修改/接受漂移按钮', async () => {
    setup({ ...baseSnapshot, configIdentity: identity({}) });
    render(<OverviewPage />);

    const card = await screen.findByTestId('config-identity-card');
    expect(card).toBeTruthy();
    expect(screen.getByTestId('config-identity-status').textContent).toBe('一致');
    expect(screen.getByTestId('config-identity-release-id').textContent).toBe('rc-20260829-01');
    expect(screen.getByTestId('config-identity-expected').textContent).toContain('sha256:aaaaa');
    expect(screen.getByTestId('config-identity-observed').textContent).toContain('sha256:aaaaa');
    // 只读契约：没有修改配置、接受漂移、查看 raw config 的入口。
    expect(screen.queryByRole('button', { name: /接受漂移|修改配置|查看原始配置/ })).toBeNull();
  });

  it('漂移：显示漂移状态与提示文案', async () => {
    setup({
      ...baseSnapshot,
      configIdentity: identity({
        status: 'drifted',
        observed: {
          schemaVersion: 1,
          digest: `sha256:${'b'.repeat(64)}`,
          credentialVersionDigest: null,
          versionResolution: 'resolved',
          secretRefCount: 0,
        },
        lastChangedAt: '2026-08-29T12:30:00.000Z',
      }),
    });
    render(<OverviewPage />);

    expect(await screen.findByTestId('config-identity-status')).toBeTruthy();
    await waitFor(() => {
      expect(screen.getByTestId('config-identity-status').textContent).toBe('漂移');
    });
    expect(screen.getByTestId('config-identity-observed').textContent).toContain('sha256:bbbbb');
  });

  it('不可验证：显示不可验证状态与原因说明', async () => {
    setup({
      ...baseSnapshot,
      configIdentity: identity({
        status: 'unverifiable',
        reason: 'expected_not_bound',
        expected: undefined,
      }),
    });
    render(<OverviewPage />);

    await waitFor(() => {
      expect(screen.getByTestId('config-identity-status').textContent).toBe('不可验证');
    });
    expect(screen.getByTestId('config-identity-reason').textContent).toContain('未绑定');
  });

  it('未采集：configIdentity 为 null 时显式显示未采集，而不是渲染成正常值', async () => {
    setup({ ...baseSnapshot, configIdentity: null });
    render(<OverviewPage />);

    await waitFor(() => {
      expect(screen.getByTestId('config-identity-status').textContent).toBe('未采集');
    });
    // 未知数据不得被渲染成 digest 正常值（占位符，不是完整 digest/undefined）。
    expect(screen.getByTestId('config-identity-expected').textContent?.trim()).toBe('—');
    expect(screen.getByTestId('config-identity-observed').textContent?.trim()).toBe('—');
  });

  it('旧 schema 不被渲染成正常状态，客户端降级为未采集', async () => {
    setup({
      ...baseSnapshot,
      configIdentity: identity({ schemaVersion: 0 }),
    });
    render(<OverviewPage />);

    await waitFor(() => {
      expect(screen.getByTestId('config-identity-status').textContent).toBe('未采集');
    });
    expect(screen.getByTestId('config-identity-expected').textContent?.trim()).toBe('—');
    expect(screen.getByTestId('config-identity-observed').textContent?.trim()).toBe('—');
  });

  it.each([
    ['partial consistent', identityWithObserved({
      credentialVersionDigest: `sha256:${'c'.repeat(64)}`,
      versionResolution: 'partial',
      secretRefCount: 1,
    })],
    ['关系矛盾', identityWithObserved({ digest: `sha256:${'b'.repeat(64)}` })],
    ['缺 digest', identityWithoutObservedField('digest')],
    ['缺 versionResolution', identityWithoutObservedField('versionResolution')],
    ['缺 secretRefCount', identityWithoutObservedField('secretRefCount')],
  ])('组件防御式降级畸形身份为未采集且隐藏摘要（%s）', async (_label, configIdentity) => {
    setup({ ...baseSnapshot, configIdentity });
    render(<OverviewPage />);

    await waitFor(() => {
      expect(screen.getByTestId('config-identity-status').textContent).toBe('未采集');
    });
    expect(screen.getByTestId('config-identity-expected').textContent?.trim()).toBe('—');
    expect(screen.getByTestId('config-identity-observed').textContent?.trim()).toBe('—');
  });

  it('首次接口失败（snapshot 请求 reject）时显示未采集，不崩溃', async () => {
    overviewSnapshot.mockRejectedValue(new Error('network down'));
    billingTrend.mockResolvedValue({ audit: { days: 14, daily: [] } });
    overviewTrends.mockResolvedValue({
      available: true,
      missingSources: [],
      days: 14,
      timezone: 'Asia/Shanghai',
      daily: [],
    });
    render(<OverviewPage />);

    await waitFor(() => {
      expect(screen.getByTestId('config-identity-status').textContent).toBe('未采集');
    });
  });

  it('部分字段缺失（只有 observed 无 expected）时使用 - 占位，不把 undefined 渲染出来', async () => {
    setup({
      ...baseSnapshot,
      configIdentity: identity({
        status: 'unverifiable',
        reason: 'expected_not_bound',
        expected: undefined,
        releaseId: undefined,
      }),
    });
    render(<OverviewPage />);

    await waitFor(() => {
      expect(screen.getByTestId('config-identity-status').textContent).toBe('不可验证');
    });
    expect(screen.getByTestId('config-identity-expected').textContent?.trim()).toBe('—');
    expect(screen.getByTestId('config-identity-release-id').textContent?.trim()).toBe('—');
    expect(document.body.textContent).not.toContain('undefined');
  });

  it('窄屏保持单列字段流与安全截断，不产生固定双列布局', async () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 375 });
    window.dispatchEvent(new Event('resize'));
    setup({ ...baseSnapshot, configIdentity: identity({}) });
    render(<OverviewPage />);

    const fields = await screen.findByTestId('config-identity-fields');
    const classes = fields.className.split(/\s+/u);
    expect(classes).toContain('sm:grid-cols-2');
    expect(classes).not.toContain('grid-cols-2');
    expect(screen.getByTestId('config-identity-expected')).toBeTruthy();
    expect(screen.getByTestId('config-identity-observed')).toBeTruthy();
  });

  it('刷新按钮触发重新拉取 snapshot 并更新状态', async () => {
    setup({ ...baseSnapshot, configIdentity: null });
    render(<OverviewPage />);
    await screen.findByTestId('config-identity-status');

    overviewSnapshot.mockResolvedValue({
      ...baseSnapshot,
      configIdentity: identity({}),
    });
    const refresh = await screen.findByRole('button', { name: /刷新/ });
    fireEvent.click(refresh);

    await waitFor(() => {
      expect(screen.getByTestId('config-identity-status').textContent).toBe('一致');
    });
  });

  it('成功后手动刷新失败时立刻从一致降级为未采集', async () => {
    setup({ ...baseSnapshot, configIdentity: identity({}) });
    render(<OverviewPage />);
    await waitFor(() => {
      expect(screen.getByTestId('config-identity-status').textContent).toBe('一致');
    });

    overviewSnapshot.mockRejectedValueOnce(new Error('refresh failed'));
    fireEvent.click(await screen.findByRole('button', { name: /刷新/ }));

    await waitFor(() => {
      expect(screen.getByTestId('config-identity-status').textContent).toBe('未采集');
    });
    expect(document.body.textContent).toContain('refresh failed');
  });

  it('成功后定时刷新失败时也降级，不保留旧 consistent 绿态', async () => {
    vi.useFakeTimers();
    setup({ ...baseSnapshot, configIdentity: identity({}) });
    overviewSnapshot
      .mockResolvedValueOnce({ ...baseSnapshot, configIdentity: identity({}) })
      .mockRejectedValueOnce(new Error('poll failed'));
    render(<OverviewPage />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByTestId('config-identity-status').textContent).toBe('一致');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });

    expect(screen.getByTestId('config-identity-status').textContent).toBe('未采集');
    expect(document.body.textContent).toContain('poll failed');
  });

  it('较早请求晚到时不能覆盖较新失败后的保守降级', async () => {
    vi.useFakeTimers();
    let resolveInitial!: (value: unknown) => void;
    overviewSnapshot
      .mockImplementationOnce(() => new Promise((resolve) => { resolveInitial = resolve; }))
      .mockRejectedValueOnce(new Error('newer poll failed'));
    billingTrend.mockResolvedValue({ audit: { days: 14, daily: [] } });
    overviewTrends.mockResolvedValue({
      available: true,
      missingSources: [],
      days: 14,
      timezone: 'Asia/Shanghai',
      daily: [],
    });
    render(<OverviewPage />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(overviewSnapshot).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId('config-identity-status').textContent).toBe('未采集');

    await act(async () => {
      resolveInitial({ ...baseSnapshot, configIdentity: identity({}) });
      await Promise.resolve();
    });
    expect(screen.getByTestId('config-identity-status').textContent).toBe('未采集');
    expect(screen.getByTestId('config-identity-release-id').textContent?.trim()).toBe('—');
  });

  it('摘要只显示截断 digest，不把完整 digest 或任何敏感值渲染进 DOM', async () => {
    const fullDigest = `sha256:${'c'.repeat(64)}`;
    setup({
      ...baseSnapshot,
      configIdentity: identity({
        status: 'drifted',
        observed: {
          schemaVersion: 1,
          digest: fullDigest,
          credentialVersionDigest: null,
          versionResolution: 'resolved',
          secretRefCount: 0,
        },
      }),
    });
    render(<OverviewPage />);

    await waitFor(() => {
      expect(screen.getByTestId('config-identity-observed').textContent).toContain('sha256:ccccc');
    });
    expect(document.body.textContent).not.toContain(fullDigest);
  });
});
