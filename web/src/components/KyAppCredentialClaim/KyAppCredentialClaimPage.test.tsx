import { StrictMode } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuth } from '@/contexts/AuthContext';
import { kyAppRequest, kyAppV2Post, kyAppV2Request } from '@/lib/kyAppManagementApi';
import type { EnrollmentOperationView } from '@/lib/kyAppManagementTypes';
import { KyAppCredentialClaimPage } from './KyAppCredentialClaimPage';

vi.mock('@/contexts/AuthContext', () => ({ useAuth: vi.fn() }));
vi.mock('@/components/LoginPage', () => ({ LoginPage: () => <p>登录表单</p> }));
vi.mock('@/components/AuthShell', () => ({
  AuthShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('@/lib/kyAppManagementApi', async (original) => ({
  ...(await original<object>()),
  kyAppRequest: vi.fn(),
  kyAppV2Post: vi.fn(),
  kyAppV2Request: vi.fn(),
}));

const operation: EnrollmentOperationView = {
  operationId: 'op-demo-001',
  installationId: 'iid-demo',
  status: 'awaiting_consent',
  version: 2,
  organization: { id: 'tenant-a', name: '示例组织' },
  system: { id: 'demo-erp', name: '示例 ERP' },
  origin: 'https://erp.example.com',
  deploymentId: 'deployment-1',
  keyFingerprint: 'AbCd1234',
  scopes: ['installation.activate', 'directory.snapshot'],
  codeExpiresAt: null,
  updatedAt: '2026-09-14T00:00:00.000Z',
  problem: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
  vi.stubGlobal('crypto', { ...crypto, randomUUID: () => 'op-demo-001' });
  vi.mocked(useAuth).mockReturnValue({ isAuthenticated: true, isLoading: false } as ReturnType<
    typeof useAuth
  >);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('自动接入页面', () => {
  it('显式开始后只保存非敏感 operationId，并展示组织、系统、域名、范围和身份短码', async () => {
    vi.mocked(kyAppV2Post).mockResolvedValue({ operation });
    const localWrite = vi.spyOn(window.localStorage, 'setItem');
    render(
      <StrictMode>
        <KyAppCredentialClaimPage installationId="iid-demo" />
      </StrictMode>,
    );
    expect(kyAppV2Post).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '开始安全检查' }));
    expect(await screen.findByText('示例组织')).toBeTruthy();
    expect(screen.getByText('示例 ERP')).toBeTruthy();
    expect(screen.getByText('https://erp.example.com')).toBeTruthy();
    expect(screen.getByText('AbCd1234')).toBeTruthy();
    expect(screen.getByText('读取组织成员目录')).toBeTruthy();
    expect(sessionStorage.getItem('ky-app-enrollment:iid-demo')).toBe('op-demo-001');
    expect(localWrite).not.toHaveBeenCalled();
    expect(JSON.stringify(sessionStorage)).not.toContain('token');
  });

  it('刷新后查询原 operation，不创建第二次授权', async () => {
    sessionStorage.setItem('ky-app-enrollment:iid-demo', operation.operationId);
    vi.mocked(kyAppV2Request).mockResolvedValue({ operation });
    render(<KyAppCredentialClaimPage installationId="iid-demo" />);
    await waitFor(() =>
      expect(kyAppV2Request).toHaveBeenCalledWith('/enrollment-operations/op-demo-001'),
    );
    expect(kyAppV2Post).not.toHaveBeenCalled();
    expect(await screen.findByRole('button', { name: '确认授权并接入' })).toBeTruthy();
  });

  it('旧版明文入口默认折叠，领取后页面隐藏立即销毁', async () => {
    vi.mocked(kyAppRequest).mockResolvedValue({
      credential: {
        serviceCredential: 'one-time-test-value',
        installationKey: 'test-key',
        keyVersion: 'v1',
        ackDeadlineAt: '2026-09-15',
      },
    });
    render(<KyAppCredentialClaimPage installationId="iid-demo" initialTicket="legacy-ticket" />);
    expect(screen.queryByText(/one-time-test-value/)).toBeNull();
    fireEvent.click(screen.getByText('手动配置旧版系统'));
    fireEvent.click(screen.getByRole('button', { name: '领取旧版配置' }));
    expect(await screen.findByText(/one-time-test-value/)).toBeTruthy();
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    fireEvent(document, new Event('visibilitychange'));
    expect(screen.queryByText(/one-time-test-value/)).toBeNull();
  });
});
