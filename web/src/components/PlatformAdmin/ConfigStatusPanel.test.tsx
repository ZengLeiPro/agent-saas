import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ConfigStatusPanel } from './ConfigStatusPanel';
import type { CapabilityReadiness, EffectiveConfigStatus } from './types';

const mocks = vi.hoisted(() => ({
  configStatus: vi.fn(),
  navigateGovernance: vi.fn(),
}));

vi.mock('./api', () => ({ platformAdminApi: { configStatus: mocks.configStatus } }));
vi.mock('@/lib/urlSync', () => ({ navigateGovernance: mocks.navigateGovernance }));

const readiness = (overrides: Partial<CapabilityReadiness>): CapabilityReadiness => ({
  state: 'disabled',
  verification: 'never',
  missing: [],
  blockers: [],
  targetRouteId: null,
  ...overrides,
});

const status: EffectiveConfigStatus = {
  configSchemaVersion: 1,
  effectiveConfigFingerprint:
    'sha256:d3cbe4c93fc4aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  capabilityFingerprint: 'sha256:b8312cbc287caaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  secretReadiness: 'legacy_inline',
  environment: 'staging',
  processRole: 'ws-only',
  appliedAt: '2026-09-01T00:00:00.000Z',
  capabilities: {
    models: true,
    codex: true,
    webTools: false,
    memoryConsolidation: false,
    stt: true,
    tts: false,
  },
  capabilityStates: {
    models: readiness({ state: 'enabled', targetRouteId: 'platform.resource-center.models' }),
    codex: readiness({
      state: 'enabled',
      verification: 'passed',
      targetRouteId: 'platform.resource-center.models',
      lastValidation: {
        status: 'passed',
        validatedAt: '2026-08-31T10:00:00.000Z',
        configFingerprint: 'sha256:codex',
      },
    }),
    webTools: readiness({
      state: 'incomplete',
      missing: ['webTools.search.apiKeyRef'],
      targetRouteId: 'platform.resource-center.tools',
    }),
    memoryConsolidation: readiness({
      state: 'blocked',
      blockers: [
        {
          code: 'CAPABILITY_RUNTIME_STORE_UNSUPPORTED',
          message: '记忆整合要求 runtimeEventStore.backend="pg"',
        },
      ],
      targetRouteId: 'platform.governance.memory-policy',
    }),
    stt: readiness({
      state: 'degraded',
      verification: 'stale',
      targetRouteId: 'platform.resource-center.tools',
      lastValidation: {
        status: 'passed',
        validatedAt: '2026-08-20T10:00:00.000Z',
        configFingerprint: 'sha256:before-the-hand-edit',
      },
    }),
    tts: readiness({ state: 'incomplete', missing: ['tts.doubaoAppId'] }),
  },
  secrets: {
    references: 1,
    inlineLegacy: 2,
    missing: 1,
    items: [
      { path: 'models.groups[0].apiKey', status: 'legacy_inline', target: 'models' },
      { path: 'webTools.search.apiKeyRef', status: 'reference', target: 'tools' },
      { path: 'stt.apiKeyRef', status: 'missing', target: 'tools' },
      { path: 'dingtalk.robots[0].appSecret', status: 'legacy_inline', target: null },
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
    expect(screen.getByText('dingtalk.robots[0].appSecret')).toBeTruthy();
    expect(screen.getByText('stt.apiKeyRef')).toBeTruthy();
    expect(screen.getAllByText('历史内联')).toHaveLength(2);
    expect(screen.getByText('缺失')).toBeTruthy();
    expect(screen.getByText('引用就绪')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '配置 模型 models.groups[0].apiKey' }));
    expect(mocks.navigateGovernance).toHaveBeenCalledWith(
      expect.objectContaining({ routeId: 'platform.resource-center.models' }),
    );
  });

  it('按能力状态区分文案，缺失项与阻塞项分别展示', async () => {
    render(<ConfigStatusPanel />);

    expect(await screen.findByText('语音合成')).toBeTruthy();
    expect(screen.getAllByText('已启用')).toHaveLength(2);
    expect(screen.getAllByText('缺少配置')).toHaveLength(2);
    expect(screen.getByText('受阻塞')).toBeTruthy();
    const missingHints = screen.getAllByText(/待补齐：/u);
    expect(missingHints).toHaveLength(2);
    expect(missingHints[0]?.textContent).toContain('webTools.search.apiKeyRef');
    expect(screen.getByText('记忆整合要求 runtimeEventStore.backend="pg"')).toBeTruthy();
    expect(screen.getAllByText(/最近验证：通过/u)).toHaveLength(2);
    // 验证过期的已启用能力必须显式提示重新验证，而不是继续显示运行正常。
    expect(screen.getByText('运行异常')).toBeTruthy();
    expect(screen.getByText('配置已变更，需重新验证')).toBeTruthy();
    // 从未验证过的能力不能冒充「验证通过」。
    expect(screen.getAllByText('未验证').length).toBeGreaterThan(0);
    // 状态页保持只读汇总，不出现任何配置输入控件。
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(screen.queryByRole('textbox')).toBeNull();
    // 没有后台入口的能力不给操作按钮。
    expect(screen.queryByRole('button', { name: /语音合成$/u })).toBeNull();
    expect(screen.getAllByText('暂无后台入口').length).toBeGreaterThan(0);
  });

  it('操作按钮带上能力标识 deep link 到目标业务页面', async () => {
    render(<ConfigStatusPanel />);

    fireEvent.click(await screen.findByRole('button', { name: '配置并启用 WebTools' }));
    expect(mocks.navigateGovernance).toHaveBeenCalledWith(
      expect.objectContaining({
        routeId: 'platform.resource-center.tools',
        search: '?capability=webTools',
      }),
    );

    fireEvent.click(screen.getByRole('button', { name: '查看阻塞项 记忆整合' }));
    expect(mocks.navigateGovernance).toHaveBeenLastCalledWith(
      expect.objectContaining({
        routeId: 'platform.governance.memory-policy',
        search: '?capability=memoryConsolidation',
      }),
    );
  });

  it('服务端未返回 capabilityStates 时退回布尔能力表', async () => {
    const { capabilityStates: _omitted, ...legacy } = status;
    mocks.configStatus.mockResolvedValue(legacy);
    render(<ConfigStatusPanel />);

    expect((await screen.findAllByText('WebTools')).length).toBeGreaterThan(0);
    expect(screen.getAllByText('已启用')).toHaveLength(3);
    expect(screen.getAllByText('已配置未启用')).toHaveLength(3);
    expect(screen.getAllByText('暂无后台入口')).toHaveLength(7);
  });
});
