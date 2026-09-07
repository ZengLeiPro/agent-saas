import { StrictMode } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuth } from '@/contexts/AuthContext';
import { kyAppRequest } from '@/lib/kyAppManagementApi';
import { KyAppCredentialClaimPage } from './KyAppCredentialClaimPage';
vi.mock('@/contexts/AuthContext', () => ({ useAuth: vi.fn() }));
vi.mock('@/components/LoginPage', () => ({ LoginPage: () => <p>登录表单</p> }));
vi.mock('@/components/AuthShell', () => ({
  AuthShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('@/lib/kyAppManagementApi', async (original) => ({
  ...(await original<object>()),
  kyAppRequest: vi.fn(),
}));
const secret = {
  serviceCredential: 'one-time-test-value',
  installationKey: 'test-key',
  keyVersion: 'v1',
  ackDeadlineAt: '2026-09-08',
};
beforeEach(() => {
  vi.clearAllMocks();
  window.history.replaceState({}, '', '/ky-app/credential-claim/iid-demo#ticket=test-ticket');
  vi.mocked(useAuth).mockReturnValue({ isAuthenticated: true, isLoading: false } as ReturnType<
    typeof useAuth
  >);
});
afterEach(() => vi.restoreAllMocks());
describe('一次性凭据领取', () => {
  it('StrictMode 中清理票据，确认前不请求，不写入 storage，隐藏时销毁明文', async () => {
    const storage = vi.spyOn(Storage.prototype, 'setItem');
    vi.mocked(kyAppRequest).mockResolvedValue({ credential: secret });
    render(
      <StrictMode>
        <KyAppCredentialClaimPage installationId="iid-demo" />
      </StrictMode>,
    );
    expect(window.location.hash).toBe('');
    expect(kyAppRequest).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '确认风险并领取' }));
    expect(await screen.findByText(/KY_SERVICE_CREDENTIAL=one-time-test-value/)).toBeTruthy();
    expect(storage).not.toHaveBeenCalled();
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    fireEvent(document, new Event('visibilitychange'));
    expect(screen.queryByText(/KY_SERVICE_CREDENTIAL=/)).toBeNull();
    expect(screen.getByText(/本次领取已结束/)).toBeTruthy();
  });
  it('登录前捕获并清理票据，登录后仍须显式确认', () => {
    vi.mocked(useAuth).mockReturnValue({ isAuthenticated: false, isLoading: false } as ReturnType<
      typeof useAuth
    >);
    const { rerender } = render(<KyAppCredentialClaimPage installationId="iid-demo" />);
    expect(screen.getByText('登录表单')).toBeTruthy();
    expect(window.location.hash).toBe('');
    vi.mocked(useAuth).mockReturnValue({ isAuthenticated: true, isLoading: false } as ReturnType<
      typeof useAuth
    >);
    rerender(<KyAppCredentialClaimPage installationId="iid-demo" />);
    expect(screen.getByRole('button', { name: '确认风险并领取' })).toBeTruthy();
    expect(kyAppRequest).not.toHaveBeenCalled();
  });
  it('页面隐藏后迟到的领取响应不能再展示', async () => {
    let finish!: (value: unknown) => void;
    vi.mocked(kyAppRequest).mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    render(<KyAppCredentialClaimPage installationId="iid-demo" />);
    fireEvent.click(screen.getByRole('button', { name: '确认风险并领取' }));
    await waitFor(() => expect(kyAppRequest).toHaveBeenCalledTimes(1));
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    fireEvent(document, new Event('visibilitychange'));
    await act(async () => finish({ credential: secret }));
    expect(screen.queryByText(/one-time-test-value/)).toBeNull();
  });
});
