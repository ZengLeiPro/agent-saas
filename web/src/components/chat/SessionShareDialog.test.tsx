import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChatSessionIndexItem } from '@/types/sidebar';

const apiMocks = vi.hoisted(() => ({
  getSessionShare: vi.fn(),
  revokeSessionShare: vi.fn(),
  updateSessionShare: vi.fn(),
}));

vi.mock('@/lib/sessionShareApi', () => apiMocks);

import { SessionShareDialog } from './SessionShareDialog';

const session: ChatSessionIndexItem = {
  id: 'session-1',
  title: '捷运环境项目经理培养与客户共评管理体系建设方案超长标题',
  createdAt: 1,
  updatedAt: 1,
};

describe('SessionShareDialog', () => {
  beforeEach(() => {
    apiMocks.getSessionShare.mockReset().mockResolvedValue({ enabled: false });
    apiMocks.revokeSessionShare.mockReset().mockResolvedValue({ enabled: false });
    apiMocks.updateSessionShare.mockReset().mockResolvedValue({
      enabled: true,
      url: '/share/session-token',
      expiresAt: '2026-09-11T00:00:00.000Z',
    });
  });

  it('一键分享完整会话，不再要求确认或逐个选择成果文件', async () => {
    render(<SessionShareDialog open session={session} onOpenChange={vi.fn()} />);

    const generate = screen.getByRole('button', { name: '生成链接' }) as HTMLButtonElement;
    await waitFor(() => expect(generate.disabled).toBe(false));
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(screen.queryByText(/选择要公开的成果文件/)).toBeNull();
    expect(screen.queryByDisplayValue('尚未生成')).toBeNull();

    fireEvent.click(generate);

    await waitFor(() => expect(apiMocks.updateSessionShare).toHaveBeenCalledWith('session-1'));
    expect(
      await screen.findByDisplayValue('http://localhost:3000/share/session-token'),
    ).toBeTruthy();
  });

  it('现有分享只展示链接操作和简洁的更新入口', async () => {
    apiMocks.getSessionShare.mockResolvedValue({
      enabled: true,
      url: '/share/existing-token',
      expiresAt: '2026-09-11T00:00:00.000Z',
    });

    render(<SessionShareDialog open session={session} onOpenChange={vi.fn()} />);

    expect(await screen.findByRole('button', { name: '更新分享' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '复制链接' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '打开链接' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '撤销分享' })).toBeTruthy();
  });

  it('弹窗受视口约束，会话标题允许收缩并保留完整提示', async () => {
    render(<SessionShareDialog open session={session} onOpenChange={vi.fn()} />);

    await waitFor(() => expect(apiMocks.getSessionShare).toHaveBeenCalledWith('session-1'));
    await screen.findByRole('button', { name: '生成链接' });
    const dialog = screen.getByRole('dialog');
    expect(dialog.className).toContain('max-h-[calc(100dvh-24px)]');
    expect(dialog.className).toContain('w-[calc(100vw-24px)]');
    expect(screen.getByTitle(session.title).className).toContain('truncate');
  });
});
