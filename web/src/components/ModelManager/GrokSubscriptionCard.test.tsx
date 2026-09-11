import { render, screen, waitFor, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { authFetch } from '@/lib/authFetch';
import { GrokSubscriptionCard } from './GrokSubscriptionCard';
import { safeGrokVerificationUri } from './grokSubscriptionClient';
vi.mock('@/lib/authFetch', () => ({ authFetch: vi.fn() }));
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const state = {
  revision: 'revision-grok',
  writePolicy: { environment: 'development', mode: 'online', canSave: true },
  config: {
    enabled: true,
    quotaCooldownMinutes: 60,
    endpoint: 'https://cli-chat-proxy.grok.com/v1/responses',
    oauthClientId: 'registered-client',
  },
  credentials: [
    {
      id: 'grok-a',
      priority: 1,
      configured: true,
      connected: true,
      email: 'a***@example.invalid',
      availability: 'available',
    },
    {
      id: 'grok-b',
      priority: 2,
      configured: true,
      connected: true,
      email: 'b***@example.invalid',
      availability: 'available',
    },
  ],
};
beforeEach(() => {
  vi.mocked(authFetch).mockReset();
  vi.mocked(authFetch).mockResolvedValue(json(state));
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
describe('Grok subscription management UI T31-T32', () => {
  it('saves exact-revision settings and orders the shared pool through Grok-only endpoints', async () => {
    vi.mocked(authFetch).mockImplementation(async (path, init) => {
      if (String(path).endsWith('/credentials/order')) {
        const body = JSON.parse(String(init?.body));
        return json({
          ...state,
          credentials: body.credentialRefs.map((id: string) =>
            state.credentials.find((c) => c.id === id),
          ),
        });
      }
      return json(state);
    });
    const user = userEvent.setup();
    render(<GrokSubscriptionCard readOnly={false} />);
    await screen.findByText('a***@example.invalid');
    expect(screen.queryByText('启用 WebSocket 会话接力')).toBeNull();
    await user.click(screen.getByRole('button', { name: '保存设置' }));
    const save = vi.mocked(authFetch).mock.calls.find((c) => c[1]?.method === 'PUT')!;
    expect(save[0]).toBe('/api/admin/grok-subscription');
    expect(JSON.parse(String(save[1]?.body))).toMatchObject({
      expectedRevision: 'revision-grok',
      operationId: expect.any(String),
      quotaCooldownMinutes: 60,
    });
    await waitFor(() =>
      expect(
        (screen.getAllByRole('button', { name: '上移' })[1] as HTMLButtonElement).disabled,
      ).toBe(false),
    );
    await user.click(screen.getAllByRole('button', { name: '上移' })[1]);
    await waitFor(() =>
      expect(
        vi.mocked(authFetch).mock.calls.some((c) => String(c[0]).endsWith('/credentials/order')),
      ).toBe(true),
    );
    expect(
      vi.mocked(authFetch).mock.calls.every((c) => String(c[0]).includes('/grok-subscription')),
    ).toBe(true);
  });
  it('keeps account read-only and an unsupported backend non-writable', async () => {
    const view = render(<GrokSubscriptionCard readOnly={true} />);
    await screen.findByText('a***@example.invalid');
    expect(
      (screen.getByRole('button', { name: '添加授权账号' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    view.unmount();
    vi.mocked(authFetch).mockResolvedValue(json({}, 404));
    render(<GrokSubscriptionCard readOnly={false} />);
    await screen.findByText('服务端未支持');
    expect((screen.getByRole('button', { name: '保存设置' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });
  it('withdraws write permission after a failed refresh without erasing the visible accounts', async () => {
    const user = userEvent.setup();
    render(<GrokSubscriptionCard readOnly={false} />);
    await screen.findByText('a***@example.invalid');
    vi.mocked(authFetch).mockResolvedValueOnce(json({ error: '读取失败' }, 503));
    await user.click(screen.getByRole('button', { name: '刷新 Grok 订阅状态' }));
    await screen.findByText('读取失败');
    expect(screen.getByText('a***@example.invalid')).toBeTruthy();
    expect((screen.getByRole('button', { name: '保存设置' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });
  it('shows a safe fallback authorization link when the popup is blocked and permits cancellation', async () => {
    vi.spyOn(window, 'open').mockReturnValue(null);
    vi.mocked(authFetch).mockImplementation(async (path, init) => {
      if (String(path).endsWith('/device/start'))
        return json(
          {
            sessionId: 'session-fixture',
            status: 'pending',
            userCode: 'TEST-CODE',
            verificationUri: 'https://auth.x.ai/activate',
            intervalSeconds: 300,
            expiresAt: new Date(Date.now() + 600000).toISOString(),
          },
          201,
        );
      if (init?.method === 'DELETE') return json({ status: 'cancelled' });
      return json(state);
    });
    const user = userEvent.setup();
    render(<GrokSubscriptionCard readOnly={false} />);
    await screen.findByText('a***@example.invalid');
    await user.click(screen.getByRole('button', { name: '添加授权账号' }));
    await screen.findByText('TEST-CODE');
    expect(screen.getByRole('link', { name: '打开 xAI 授权页面' }).getAttribute('href')).toBe(
      'https://auth.x.ai/activate',
    );
    await user.click(screen.getByRole('button', { name: '取消本次授权' }));
    await waitFor(() => expect(screen.queryByText('TEST-CODE')).toBeNull());
    expect(safeGrokVerificationUri('javascript:alert(1)')).toBeUndefined();
    expect(safeGrokVerificationUri('https://auth.x.ai.evil.invalid')).toBeUndefined();
  });
});
