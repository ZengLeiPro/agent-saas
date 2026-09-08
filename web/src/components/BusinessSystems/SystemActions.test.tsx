import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { kyAppPost } from '@/lib/kyAppManagementApi';
import type { SystemDetail } from '@/lib/kyAppManagementTypes';
import { SystemActions } from './SystemActions';
import { SystemVersions } from './SystemVersions';

vi.mock('@/lib/kyAppManagementApi', async (original) => ({
  ...(await original<object>()),
  kyAppPost: vi.fn(),
}));
const detail = {
  definition: {
    systemId: 'demo',
    name: '演示系统',
    status: 'published',
    version: 3,
    publishedDigest: 'digest',
  },
  versions: [],
  allowedActions: ['disable_system', 'retire_system'],
} as unknown as SystemDetail;
afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});
describe('系统生命周期操作', () => {
  it('危险操作收进菜单，停用必须确认且保留外部数据说明', async () => {
    const reload = vi.fn();
    render(<SystemActions detail={detail} reload={reload} />);
    expect(screen.queryByText('停用系统')).toBeNull();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: '更多系统操作' }));
    await user.click(screen.getByRole('menuitem', { name: '停用系统' }));
    expect(screen.getByText(/不删除外部业务数据/)).toBeTruthy();
    expect(kyAppPost).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: '确认停用' }));
    await waitFor(() => expect(reload).toHaveBeenCalledOnce());
    expect(kyAppPost).toHaveBeenCalledWith('/systems/demo/status', {
      status: 'disabled',
      expectedVersion: 3,
    });
  });
  it('退役必须准确输入名称，取消不发送请求', async () => {
    const user = userEvent.setup();
    render(<SystemActions detail={detail} reload={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: '更多系统操作' }));
    await user.click(screen.getByRole('menuitem', { name: '退役系统' }));
    const confirm = screen.getByRole('button', { name: '确认退役' }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('输入系统名称确认'), { target: { value: '错误名称' } });
    expect(confirm.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('输入系统名称确认'), { target: { value: '演示系统' } });
    expect(confirm.disabled).toBe(false);
    await user.click(screen.getByRole('button', { name: '取消' }));
    expect(kyAppPost).not.toHaveBeenCalled();
  });
  it('停用后能重新发布当前版本恢复系统', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const reload = vi.fn();
    render(
      <SystemVersions
        detail={
          {
            ...detail,
            definition: { ...detail.definition, status: 'disabled' },
            versions: [
              {
                digest: 'digest',
                status: 'published',
                reviewReasons: [],
                manifest: {},
                allowedActions: ['publish_version'],
              },
            ],
          } as unknown as SystemDetail
        }
        reload={reload}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '重新发布并恢复系统' }));
    await waitFor(() => expect(reload).toHaveBeenCalledOnce());
    expect(kyAppPost).toHaveBeenCalledWith('/systems/demo/versions/digest/publish', {
      expectedVersion: 3,
    });
  });
});
