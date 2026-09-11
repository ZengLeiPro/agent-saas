import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ save: vi.fn(), update: vi.fn() }));
vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({
    user: {
      preferences: {
        sessionOrganizationEnabled: false,
        titlePromptAddition: '按客户命名',
        sessionGroupingPromptAddition: '按部门分组',
      },
    },
    updatePreferences: mocks.update,
  }),
}));
vi.mock('@agent/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent/shared')>()),
  saveUserPreferences: mocks.save,
}));

import { SessionOrganizationSettings } from './SessionOrganizationSettings';

describe('SessionOrganizationSettings', () => {
  it('保存两个个人追加提示语', async () => {
    mocks.save.mockResolvedValue({
      sessionOrganizationEnabled: true,
      titlePromptAddition: '按项目命名',
      sessionGroupingPromptAddition: '按部门分组',
    });
    render(<SessionOrganizationSettings />);
    expect(screen.getByRole('switch', { name: '启用会话智能整理' }).getAttribute('aria-checked')).toBe('false');
    await userEvent.click(screen.getByRole('switch', { name: '启用会话智能整理' }));
    const title = screen.getByLabelText('我的标题生成要求');
    await userEvent.clear(title);
    await userEvent.type(title, '按项目命名');
    await userEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() =>
      expect(mocks.save).toHaveBeenCalledWith({
        sessionOrganizationEnabled: true,
        titlePromptAddition: '按项目命名',
        sessionGroupingPromptAddition: '按部门分组',
      }),
    );
    expect(mocks.update).toHaveBeenCalled();
  });
});
