import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { SettingsDirtyBoundary } from '@/components/PersonalSettings/dirtyRegistry';
import { ResetUserPasswordDialog } from './ResetUserPasswordDialog';
import type { UserInfo } from './types';

const member = {
  id: 'user-1',
  username: 'alice',
  realName: 'Alice',
  role: 'user',
  tenantId: 'tenant-a',
  createdAt: '2026-09-01T00:00:00.000Z',
} as UserInfo;

describe('ResetUserPasswordDialog', () => {
  it('X、Esc、遮罩和取消共用的关闭回调会经过 dirty guard', async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    render(
      <SettingsDirtyBoundary>
        {() => (
          <ResetUserPasswordDialog
            open
            onOpenChange={onOpenChange}
            user={member}
            onConfirm={vi.fn()}
          />
        )}
      </SettingsDirtyBoundary>,
    );

    await user.type(screen.getByLabelText('新密码'), 'secret123');
    await user.click(screen.getByRole('button', { name: '取消' }));

    expect(await screen.findByRole('heading', { name: '有未保存的更改' })).toBeTruthy();
    expect(onOpenChange).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: '放弃更改' }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
