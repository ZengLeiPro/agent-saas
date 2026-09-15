import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { kyAppPost } from '@/lib/kyAppManagementApi';
import type { OnboardExecution, OnboardResponse } from '@/lib/kyAppManagementTypes';
import { navigateCredentialClaim } from '../KyAppCredentialClaim/claimRoute';
import { useManagementResource } from '../BusinessSystems/ManagementResource';
import { SystemDeliveryPage } from './SystemDeliveryPage';

vi.mock('@/lib/kyAppManagementApi', async (original) => ({
  ...(await original<object>()),
  kyAppPost: vi.fn(),
}));
vi.mock('../KyAppCredentialClaim/claimRoute', () => ({
  navigateCredentialClaim: vi.fn(),
}));
vi.mock('../BusinessSystems/ManagementResource', async (original) => ({
  ...(await original<object>()),
  useManagementResource: vi.fn(),
}));
vi.mock('./CreateDeliveryForm', () => ({
  CreateDeliveryForm: ({ onStarted }: { onStarted: (result: OnboardResponse) => void }) => (
    <button
      onClick={() =>
        onStarted({
          execution,
          authorization: {
            path: '/ky-app/credential-claim/installation-1',
            installationId: 'installation-1',
          },
        })
      }
    >
      模拟确认接入
    </button>
  ),
}));

const execution: OnboardExecution = {
  executionId: 'execution-1',
  tenantId: 'tenant-1',
  systemId: 'system-1',
  installationId: 'installation-1',
  request: { mode: 'existing' } as OnboardExecution['request'],
  requestDigest: 'digest-1',
  status: 'waiting_external',
  currentStep: 'installation_credential',
  steps: [
    { id: 'existing_organization', status: 'completed' },
    {
      id: 'installation_credential',
      status: 'waiting',
      code: 'domain_verification_required',
    },
    { id: 'enable', status: 'pending' },
    { id: 'assignments', status: 'pending' },
  ],
  result: {},
  lastErrorCode: 'domain_verification_required',
};

describe('SystemDeliveryPage 恢复已有组织接入', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useManagementResource).mockImplementation(
      (path) =>
        (path.includes('/connection-options')
          ? {
              loading: false,
              data: { organizations: [{ id: 'tenant-1', name: '测试组织' }] },
              error: undefined,
              reload: vi.fn(),
            }
          : {
              loading: false,
              data: { execution },
              error: undefined,
              reload: vi.fn(),
            }) as unknown as ReturnType<typeof useManagementResource>,
    );
  });

  it('首次确认接入直接返回授权入口时立即进入 V2 自动授权页', () => {
    render(<SystemDeliveryPage systemId="system-1" />);

    fireEvent.click(screen.getByRole('button', { name: '模拟确认接入' }));

    expect(navigateCredentialClaim).toHaveBeenCalledWith('installation-1');
  });

  it('继续交付推进到授权阶段后立即进入 V2 自动授权页', async () => {
    const response: OnboardResponse = {
      execution: {
        ...execution,
        lastErrorCode: 'authorization_required',
        steps: execution.steps.map((step) =>
          step.id === 'installation_credential'
            ? { ...step, code: 'authorization_required' }
            : step,
        ),
      },
      authorization: {
        path: '/ky-app/credential-claim/installation-1',
        installationId: 'installation-1',
      },
    };
    vi.mocked(kyAppPost).mockResolvedValue(response);
    render(<SystemDeliveryPage executionId="execution-1" systemId="system-1" />);

    fireEvent.click(screen.getByRole('button', { name: '继续交付' }));

    await waitFor(() =>
      expect(kyAppPost).toHaveBeenCalledWith('/onboard-existing/execution-1/resume', {}),
    );
    expect(navigateCredentialClaim).toHaveBeenCalledWith('installation-1');
  });

  it('继续交付仍被外部条件阻塞时明确反馈重新检查结果', async () => {
    vi.mocked(kyAppPost).mockResolvedValue({ execution });
    render(<SystemDeliveryPage executionId="execution-1" systemId="system-1" />);

    fireEvent.click(screen.getByRole('button', { name: '继续交付' }));

    expect((await screen.findByRole('status')).textContent).toContain('已重新检查：待域名验证');
    expect(navigateCredentialClaim).not.toHaveBeenCalled();
  });
});
