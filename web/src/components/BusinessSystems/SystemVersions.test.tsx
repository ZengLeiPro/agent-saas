import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { kyAppPost, KyAppManagementError } from '@/lib/kyAppManagementApi';
import type { SystemDetail } from '@/lib/kyAppManagementTypes';
import { SystemVersions } from './SystemVersions';
vi.mock('@/lib/kyAppManagementApi', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  kyAppPost: vi.fn(),
}));
afterEach(() => vi.restoreAllMocks());
const detail = (allowedActions?: string[]): SystemDetail =>
  ({
    definition: { systemId: 'demo', version: 7 },
    versions: [
      {
        digest: 'a'.repeat(64),
        status: 'draft',
        reviewStatus: 'pending',
        reviewReasons: ['新增外部写入能力'],
        createdBy: 'admin-a',
        manifest: {},
        allowedActions,
      },
    ],
  }) as SystemDetail;
describe('版本操作', () => {
  it('没有服务端动作时不出现复核发布按钮', () => {
    render(<SystemVersions detail={detail()} reload={vi.fn()} />);
    expect(screen.queryByRole('button', { name: '复核版本' })).toBeNull();
    expect(screen.queryByRole('button', { name: '发布版本' })).toBeNull();
    expect(screen.getByText('新增外部写入能力')).toBeTruthy();
  });
  it('发布提交权威版本基线，409 重新加载', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    vi.mocked(kyAppPost).mockRejectedValueOnce(
      new KyAppManagementError(409, 'conflict', '版本已变化', 'r1', false),
    );
    const reload = vi.fn();
    render(<SystemVersions detail={detail(['publish_version'])} reload={reload} />);
    fireEvent.click(screen.getByRole('button', { name: '发布版本' }));
    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
    expect(kyAppPost).toHaveBeenCalledWith(`/systems/demo/versions/${'a'.repeat(64)}/publish`, {
      expectedVersion: 7,
    });
    expect(screen.getByRole('alert').textContent).toBe('版本已变化');
  });
});
