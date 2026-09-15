import { StrictMode } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuth } from '@/contexts/AuthContext';
import { KyAppManagementError, kyAppV2Post, kyAppV2Request } from '@/lib/kyAppManagementApi';
import type { EnrollmentOperationView } from '@/lib/kyAppManagementTypes';
import { KyAppCredentialClaimPage } from './KyAppCredentialClaimPage';

vi.mock('@/contexts/AuthContext', () => ({ useAuth: vi.fn() }));
vi.mock('@/components/LoginPage', () => ({ LoginPage: () => <p>登录表单</p> }));
vi.mock('@/components/AuthShell', () => ({
  AuthShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('@/lib/kyAppManagementApi', async (original) => ({
  ...(await original<object>()),
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

  it('V2 未开放时只提示管理员检查配置，不再提供旧版手动授权入口', async () => {
    vi.mocked(kyAppV2Post).mockRejectedValue(
      new KyAppManagementError(409, 'conflict', 'V2 未开放', 'request-1', false),
    );
    render(<KyAppCredentialClaimPage installationId="iid-demo" />);
    fireEvent.click(screen.getByRole('button', { name: '开始安全检查' }));
    expect(await screen.findByText(/请联系平台管理员检查 V2 接入配置/)).toBeTruthy();
    expect(screen.queryByText(/手动配置旧版系统/)).toBeNull();
    expect(screen.queryByText(/领取旧版配置/)).toBeNull();
  });
});
