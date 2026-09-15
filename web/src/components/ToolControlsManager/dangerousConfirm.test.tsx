import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const mocks = vi.hoisted(() => ({
  fetchToolControlsConfig: vi.fn(),
  updateToolControlsConfig: vi.fn(),
  updateSingleTool: vi.fn(),
  auth: { platformReadOnly: false },
  confirmMutation: vi.fn(() => undefined),
  acceptMetadata: vi.fn(),
}));

vi.mock('@agent/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent/shared')>();
  return {
    ...actual,
    fetchToolControlsConfig: mocks.fetchToolControlsConfig,
    updateToolControlsConfig: mocks.updateToolControlsConfig,
    updateSingleTool: mocks.updateSingleTool,
  };
});
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => mocks.auth }));
vi.mock('@/hooks/useAdminConfigWritePolicy', () => ({
  useAdminConfigWritePolicy: () => ({
    confirmMutation: mocks.confirmMutation,
    acceptMetadata: mocks.acceptMetadata,
    writePolicy: { canSave: true, environment: 'development', mode: 'online' },
    environmentBanner: null,
  }),
}));

import { ToolControlsManager } from './index';

describe('ToolControlsManager dangerous 开启确认', () => {
  beforeEach(() => {
    mocks.fetchToolControlsConfig.mockReset().mockResolvedValue({
      revision: 'r1',
      descriptionRevision: 'd1',
      writePolicy: { environment: 'development', mode: 'online', canSave: true },
      toolControls: { enabled: true, tools: { Shell: { enabled: false } } },
      webTools: { enabled: true },
      tools: [
        {
          id: 'Shell',
          name: 'Shell',
          label: '执行命令',
          category: 'workspace',
          risk: 'dangerous',
          approvalMode: 'web',
          enabled: false,
        },
      ],
      effectiveWebTools: [],
    });
    vi.spyOn(window, 'confirm').mockReturnValue(false);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('开启 dangerous 工具前弹出确认，取消则不切换', async () => {
    render(<ToolControlsManager />);
    const toggle = await screen.findByRole('switch', { name: '启用 Shell' });
    expect((toggle as HTMLButtonElement).getAttribute('data-state')).toBe('unchecked');
    await userEvent.click(toggle);
    expect(window.confirm).toHaveBeenCalled();
    expect(
      String((window.confirm as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0]),
    ).toMatch(/危险工具/);
    expect((toggle as HTMLButtonElement).getAttribute('data-state')).toBe('unchecked');
  });
});
