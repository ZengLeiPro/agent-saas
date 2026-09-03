import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SettingsDirtyBoundary } from '@/components/PersonalSettings/dirtyRegistry';
import { authFetch } from '@/lib/authFetch';
import { MemberAccountSecurity } from './MemberAccountSecurity';

vi.mock('@/lib/authFetch', () => ({ authFetch: vi.fn() }));

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn().mockResolvedValue(body),
  } as unknown as Response;
}

function renderSecurity() {
  render(
    <SettingsDirtyBoundary>
      {() => (
        <MemberAccountSecurity
          tenantId="tenant-a"
          userId="user-1"
          username="member"
          displayName="成员一"
        />
      )}
    </SettingsDirtyBoundary>,
  );
}

describe('MemberAccountSecurity', () => {
  beforeEach(() => {
    vi.mocked(authFetch)
      .mockReset()
      .mockResolvedValue(jsonResponse({ entries: [], total: 0 }));
  });

  it('登录记录按目标组织和成员账号读取', async () => {
    renderSecurity();

    await screen.findByText('暂无登录记录');
    expect(authFetch).toHaveBeenCalledWith(
      '/api/auth/login-logs?username=member&tenantId=tenant-a&offset=0&limit=20',
    );
  });

  it('校验两次密码并只向目标成员提交 password 字段', async () => {
    renderSecurity();
    await screen.findByText('暂无登录记录');
    vi.mocked(authFetch)
      .mockResolvedValueOnce(jsonResponse({ ok: true }))
      .mockResolvedValueOnce(jsonResponse({ entries: [], total: 0 }));

    fireEvent.click(screen.getByRole('button', { name: '重置密码' }));
    fireEvent.change(screen.getByLabelText('新密码'), { target: { value: 'new-pass-1' } });
    fireEvent.change(screen.getByLabelText('确认新密码'), { target: { value: 'new-pass-1' } });
    fireEvent.click(screen.getByRole('button', { name: '确认重置' }));

    await waitFor(() =>
      expect(authFetch).toHaveBeenCalledWith('/api/auth/users/user-1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: 'new-pass-1' }),
      }),
    );
    expect((await screen.findByRole('status')).textContent).toBe('密码已重置');
  });
});
