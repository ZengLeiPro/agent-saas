import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { KyAppManagementError } from '@/lib/kyAppManagementApi';
import { InstallationRuntime } from './InstallationRuntime';

const mocks = vi.hoisted(() => ({ post: vi.fn(), reload: vi.fn() }));

vi.mock('@/lib/kyAppManagementApi', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/kyAppManagementApi')>();
  return {
    ...original,
    installationPath: (id: string, suffix: string) => `/installations/${id}${suffix}`,
    kyAppPost: mocks.post,
  };
});
vi.mock('./ManagementResource', () => ({
  useManagementResource: () => ({
    data: {
      runtime: {
        liveStatus: 'ok',
        readyStatus: 'failed',
        manifestDigest: 'a'.repeat(64),
        lastError: 'ready failed',
      },
      digestConsistent: true,
    },
    reload: mocks.reload,
    error: '',
  }),
  ResourceState: () => null,
}));

describe('业务系统一键诊断', () => {
  beforeEach(() => vi.clearAllMocks());

  it('接口返回逐项报告时保留报告并突出失败原因', async () => {
    mocks.post.mockRejectedValue(
      new KyAppManagementError(409, 'diagnostic_failed', '诊断未通过', 'req-1', false, {
        passed: false,
        checkedAt: '2026-09-15T00:00:00.000Z',
        checks: [
          { id: 'live', label: '页面服务', status: 'passed', detail: '可达' },
          {
            id: 'admin_me',
            label: '管理员身份',
            status: 'failed',
            detail: 'HTTP 401（invalid_issuer：SAT 签发方不匹配）',
          },
        ],
      }),
    );
    render(<InstallationRuntime installationId="iid-v2" canDiagnose compact />);
    fireEvent.click(screen.getByRole('button', { name: '一键诊断' }));
    await waitFor(() => expect(mocks.post).toHaveBeenCalled());
    expect(screen.getByText('发现需要处理的问题')).toBeTruthy();
    expect(screen.getByText(/invalid_issuer/)).toBeTruthy();
    expect(screen.getByText('管理员身份')).toBeTruthy();
    expect(screen.queryByText(/V[12]/)).toBeNull();
  });
});
