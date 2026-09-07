import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { InstallationManagement } from '@/lib/kyAppManagementTypes';
import { useManagementResource } from './ManagementResource';
import { InstallationLifecycle } from './InstallationLifecycle';
vi.mock('./ManagementResource', () => ({
  useManagementResource: vi.fn(),
  ResourceState: () => <p>loading</p>,
}));
const detail = {
  installation: { installationId: 'iid-1', registeredDigest: 'old' },
  allowedActions: ['switch_digest', 'plan_offboarding', 'execute_offboarding'],
  upgrade: { publishedDigest: 'a'.repeat(64) },
} as InstallationManagement;
describe('生命周期操作门禁', () => {
  it('digest 不符禁止切换，离场需要已保存计划、确认 ID 和外部责任确认', () => {
    vi.mocked(useManagementResource).mockImplementation(
      (path) =>
        ({
          data: path.endsWith('/runtime')
            ? { runtime: { manifestDigest: 'wrong', readyStatus: 'ok' } }
            : { delivery: { offboardingStatus: 'planned' } },
          reload: vi.fn(),
          error: undefined,
        }) as never,
    );
    render(<InstallationLifecycle detail={detail} reload={vi.fn()} />);
    expect(
      (screen.getByRole('button', { name: '切换登记版本' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    const execute = screen.getByRole('button', { name: '执行平台离场' });
    expect((execute as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('输入安装实例 ID 二次确认'), {
      target: { value: 'iid-1' },
    });
    expect((execute as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByLabelText('已完成必要数据导出'));
    fireEvent.click(screen.getByLabelText('已完成外部系统责任项'));
    expect((execute as HTMLButtonElement).disabled).toBe(false);
  });
});
