import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  fetchSignupConfig: vi.fn(),
  updateSignupConfig: vi.fn(),
  auth: { platformReadOnly: false },
}));

vi.mock('@agent/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent/shared')>();
  return {
    ...actual,
    fetchSignupConfig: mocks.fetchSignupConfig,
    updateSignupConfig: mocks.updateSignupConfig,
  };
});
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => mocks.auth }));

import { SignupConfigManager } from './index';

describe('SignupConfigManager AccessKey 脱敏', () => {
  beforeEach(() => {
    mocks.fetchSignupConfig.mockReset().mockResolvedValue({
      revision: 'rev-1',
      writePolicy: { environment: 'development', mode: 'online', canSave: true },
      config: {
        enabled: true,
        grantCredits: 100,
        maxRunCredits: 20,
        sms: {
          provider: 'aliyun',
          accessKeyId: 'LTAI5tFullAccessKeyIdExample',
          signName: '开沿',
          templateCode: 'SMS_1',
        },
      },
      publicEnabled: true,
      smsError: null,
      smsSecretConfigured: true,
      smsSecretSource: 'vault',
      effectiveAllowedModels: [],
      updatedAt: null,
      updatedBy: null,
    });
  });

  it('初始渲染不展示完整 AccessKey ID 明文', async () => {
    render(<SignupConfigManager />);
    const input = await screen.findByTestId('signup-access-key-id');
    expect((input as HTMLInputElement).value).toBe('LTAI****mple');
    expect(screen.queryByDisplayValue('LTAI5tFullAccessKeyIdExample')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: '显示' }));
    expect((input as HTMLInputElement).value).toBe('LTAI5tFullAccessKeyIdExample');
  });
});
