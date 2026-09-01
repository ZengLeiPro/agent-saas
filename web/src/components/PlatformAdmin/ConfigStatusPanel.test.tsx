import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ConfigStatusPanel } from './ConfigStatusPanel';

const mocks = vi.hoisted(() => ({
  configStatus: vi.fn(),
  navigateGovernance: vi.fn(),
}));

vi.mock('./api', () => ({ platformAdminApi: { configStatus: mocks.configStatus } }));
vi.mock('@/lib/urlSync', () => ({ navigateGovernance: mocks.navigateGovernance }));

const status = {
  configSchemaVersion: 1,
  effectiveConfigFingerprint:
    'sha256:d3cbe4c93fc4aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  capabilityFingerprint: 'sha256:b8312cbc287caaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  secretReadiness: 'legacy_inline' as const,
  environment: 'staging' as const,
  processRole: 'ws-only',
  appliedAt: '2026-09-01T00:00:00.000Z',
  capabilities: {
    models: true,
    codex: true,
    tts: false,
  },
  secrets: {
    references: 1,
    inlineLegacy: 2,
    missing: 1,
    items: [
      {
        path: 'models.groups[0].apiKey',
        status: 'legacy_inline' as const,
        target: 'models' as const,
      },
      { path: 'webTools.search.apiKeyRef', status: 'reference' as const, target: 'tools' as const },
      { path: 'stt.apiKeyRef', status: 'missing' as const, target: 'tools' as const },
      { path: 'dingtalk.robots[0].appSecret', status: 'legacy_inline' as const, target: null },
    ],
  },
};

describe('ConfigStatusPanel', () => {
  beforeEach(() => {
    mocks.configStatus.mockReset().mockResolvedValue(status);
    mocks.navigateGovernance.mockReset();
  });

  it('逐项展示脱敏 Secret 状态并跳到对应业务配置页', async () => {
    render(<ConfigStatusPanel />);

    expect(await screen.findByText('models.groups[0].apiKey')).toBeTruthy();
    expect(screen.getByText('webTools.search.apiKeyRef')).toBeTruthy();
    expect(screen.getByText('stt.apiKeyRef')).toBeTruthy();
    expect(screen.getAllByText('历史内联')).toHaveLength(2);
    expect(screen.getByText('缺失')).toBeTruthy();
    expect(screen.getByText('引用就绪')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '配置 模型 models.groups[0].apiKey' }));
    expect(mocks.navigateGovernance).toHaveBeenCalledWith(
      expect.objectContaining({ routeId: 'platform.resource-center.models' }),
    );
  });

  it('能力列表保持只读，并对没有后台入口的能力明确提示', async () => {
    render(<ConfigStatusPanel />);

    expect(await screen.findByText('语音合成')).toBeTruthy();
    expect(screen.getAllByText('暂无后台入口').length).toBeGreaterThan(0);
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(screen.queryByRole('textbox')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '配置 Codex' }));
    expect(mocks.navigateGovernance).toHaveBeenCalledWith(
      expect.objectContaining({ routeId: 'platform.resource-center.models' }),
    );
  });
});
