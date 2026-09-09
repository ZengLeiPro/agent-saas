import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { buildMemberAccessRules } from './InstallationAccessOverview';

const mocks = vi.hoisted(() => ({
  getAssignment: vi.fn(),
  preview: vi.fn(),
  update: vi.fn(),
  reload: vi.fn(),
}));

vi.mock('@agent/shared/lib/governanceApi', () => ({
  governanceAccessApi: { getAssignment: mocks.getAssignment },
}));
vi.mock('./installationAssignmentApi', () => ({
  previewResourceAssignment: mocks.preview,
  updateResourceAssignment: mocks.update,
}));
vi.mock('./ManagementResource', () => ({
  useManagementResource: () => ({
    data: {
      summary: {
        effectiveUserCount: 1,
        verifiedUsableUserCount: 0,
        effectiveAgentCount: 0,
      },
      users: [
        {
          userId: 'user-1',
          displayName: '张三',
          username: 'zhangsan',
          authorized: true,
          departmentNames: ['销售部'],
          accessSources: ['everyone'],
          personalAuthorizationStatus: 'not_required',
          agentCapabilityStatus: 'unverified',
          capabilityCheckedAt: null,
        },
        {
          userId: 'user-2',
          displayName: '李四',
          username: 'lisi',
          authorized: false,
          departmentNames: [],
          accessSources: [],
          personalAuthorizationStatus: 'not_applicable',
          agentCapabilityStatus: 'unverified',
          capabilityCheckedAt: null,
        },
      ],
      agents: [],
      nextCursor: null,
    },
    reload: mocks.reload,
    error: '',
  }),
  ResourceState: () => null,
}));

describe('业务系统成员逐行授权规则', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getAssignment.mockResolvedValue({
      version: 2,
      assignments: [{ assigneeType: 'everyone', effect: 'allow' }],
    });
    mocks.preview.mockResolvedValue({
      previewId: 'preview-1',
      baselineDigest: 'baseline-1',
      expiresAt: '2099-01-01T00:00:00.000Z',
      impact: { effectiveUserCount: 0, addedUserCount: 0, removedUserCount: 1 },
    });
    mocks.update.mockResolvedValue({ changeId: 'change-1' });
  });

  it('取消全员范围中的单个成员时追加成员拒绝规则', () => {
    expect(
      buildMemberAccessRules(
        [{ assigneeType: 'everyone', effect: 'allow', assignmentId: 'all-1', origin: 'direct' }],
        'user-1',
        false,
      ),
    ).toEqual([
      { assigneeType: 'everyone', effect: 'allow' },
      { assigneeType: 'user', assigneeId: 'user-1', effect: 'deny' },
    ]);
  });

  it('重新授权成员时替换该成员的拒绝规则且保留其他规则', () => {
    expect(
      buildMemberAccessRules(
        [
          { assigneeType: 'everyone', effect: 'allow' },
          { assigneeType: 'user', assigneeId: 'user-1', effect: 'deny' },
          { assigneeType: 'user', assigneeId: 'user-2', effect: 'deny' },
        ],
        'user-1',
        true,
      ),
    ).toEqual([
      { assigneeType: 'everyone', effect: 'allow' },
      { assigneeType: 'user', assigneeId: 'user-2', effect: 'deny' },
      { assigneeType: 'user', assigneeId: 'user-1', effect: 'allow' },
    ]);
  });

  it('成员表移除非必要列，并通过签名预览确认后逐行取消授权', async () => {
    const { InstallationAccessOverview } = await import('./InstallationAccessOverview');
    render(<InstallationAccessOverview installationId="iid-1" tenantId="tenant-a" />);

    expect(screen.queryByText('获得权限的原因')).toBeNull();
    expect(screen.queryByText('Agent 能力')).toBeNull();
    expect(screen.getByRole('button', { name: '授权' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '取消授权' }));

    await waitFor(() => expect(mocks.preview).toHaveBeenCalled());
    expect(screen.getByRole('dialog')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '确认' }));
    await waitFor(() =>
      expect(mocks.update).toHaveBeenCalledWith(
        'system_installation',
        'iid-1',
        expect.objectContaining({ previewId: 'preview-1', expectedVersion: 2 }),
        'tenant-a',
      ),
    );
    expect(mocks.reload).toHaveBeenCalled();
  });
});
