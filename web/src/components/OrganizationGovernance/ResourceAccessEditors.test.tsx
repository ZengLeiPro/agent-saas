import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  OrganizationEntitlementScopeEditor,
  OrganizationResourceAssignmentEditor,
} from './ResourceAccessEditors';
import { SettingsDirtyBoundary } from '@/components/PersonalSettings/dirtyRegistry';

const mocks = vi.hoisted(() => ({
  getEntitlements: vi.fn(),
  listCatalog: vi.fn(),
  previewScope: vi.fn(),
  updateScope: vi.fn(),
  getAssignment: vi.fn(),
  listMemberships: vi.fn(),
  listGroups: vi.fn(),
  previewAssignment: vi.fn(),
  updateAssignment: vi.fn(),
}));

vi.mock('@agent/shared/lib/governanceApi', () => ({
  governanceAccessApi: {
    getEntitlements: mocks.getEntitlements,
    previewEntitlementScope: mocks.previewScope,
    updateEntitlementScope: mocks.updateScope,
    getAssignment: mocks.getAssignment,
    listMemberships: mocks.listMemberships,
    listDirectoryGroups: mocks.listGroups,
    previewAssignment: mocks.previewAssignment,
    updateAssignment: mocks.updateAssignment,
  },
  governanceResourcesApi: { listEntitlementResourceCatalog: mocks.listCatalog },
}));

describe('ResourceAccessEditors', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listMemberships.mockResolvedValue({
      memberships: [
        { userId: 'user-1', status: 'active', directoryProfile: { displayName: '张三' } },
      ],
    });
    mocks.listGroups.mockResolvedValue({
      groups: [{ groupId: 'group-1', displayName: '销售部', status: 'active' }],
    });
  });

  it('资源范围只通过 Entitlement preview → commit 更新', async () => {
    mocks.getEntitlements.mockResolvedValue({
      scopes: [
        {
          resourceType: 'model',
          mode: 'selected',
          resourceIds: ['group/model-a'],
          source: 'governance',
          version: 2,
        },
      ],
    });
    mocks.listCatalog.mockResolvedValue({
      resourceType: 'model',
      items: [
        { resourceId: 'group/model-a', label: '模型 A', version: 1 },
        { resourceId: 'group/model-b', label: '模型 B', version: 1 },
      ],
    });
    mocks.previewScope.mockResolvedValue({
      previewId: `gpv1.${'a'.repeat(64)}`,
      baselineDigest: 'b'.repeat(64),
      expiresAt: '2099-01-01T00:00:00.000Z',
      impact: { blockers: [] },
    });
    mocks.updateScope.mockResolvedValue({ changeId: 'change-1', auditId: 'audit-1' });

    render(
      <OrganizationEntitlementScopeEditor
        tenantId="tenant-a"
        resourceType="model"
        title="模型可用范围"
        description="测试"
      />,
    );
    fireEvent.click(await screen.findByText('模型 B'));
    fireEvent.click(screen.getByRole('button', { name: '预览范围变更' }));
    await waitFor(() =>
      expect(mocks.previewScope).toHaveBeenCalledWith(
        'model',
        {
          expectedVersion: 2,
          mode: 'selected',
          resourceIds: ['group/model-a', 'group/model-b'],
        },
        'tenant-a',
      ),
    );
    fireEvent.click(await screen.findByRole('button', { name: '确认提交' }));
    await waitFor(() =>
      expect(mocks.updateScope).toHaveBeenCalledWith(
        'model',
        expect.objectContaining({
          expectedVersion: 2,
          previewId: expect.stringMatching(/^gpv1\./),
        }),
        'tenant-a',
      ),
    );
  });

  it('资源指派支持成员与群组并严格执行签名预览', async () => {
    mocks.getAssignment.mockResolvedValue({ version: 0, assignments: [] });
    mocks.previewAssignment.mockResolvedValue({
      previewId: `apv1.${'a'.repeat(64)}`,
      baselineDigest: 'b'.repeat(64),
      expiresAt: '2099-01-01T00:00:00.000Z',
    });
    mocks.updateAssignment.mockResolvedValue({ changeId: 'change-2', auditId: 'audit-2' });

    render(
      <OrganizationResourceAssignmentEditor
        tenantId="tenant-a"
        resourceType="credential"
        resourceId="cred-1"
      />,
    );
    fireEvent.click(await screen.findByRole('button', { name: '添加规则' }));
    fireEvent.change(screen.getByLabelText('规则1主体类型'), {
      target: { value: 'directory_group' },
    });
    fireEvent.change(screen.getByLabelText('规则1主体'), { target: { value: 'group-1' } });
    fireEvent.click(screen.getByRole('button', { name: '预览指派变更' }));
    await waitFor(() =>
      expect(mocks.previewAssignment).toHaveBeenCalledWith(
        'credential',
        'cred-1',
        {
          expectedVersion: 0,
          assignments: [
            { assigneeType: 'directory_group', assigneeId: 'group-1', effect: 'allow' },
          ],
        },
        'tenant-a',
      ),
    );
    fireEvent.click(await screen.findByRole('button', { name: '确认提交' }));
    await waitFor(() =>
      expect(mocks.updateAssignment).toHaveBeenCalledWith(
        'credential',
        'cred-1',
        expect.objectContaining({ previewId: expect.stringMatching(/^apv1\./) }),
        'tenant-a',
      ),
    );
  });

  it('Entitlement 草稿切换页面前触发统一 dirty guard', async () => {
    mocks.getEntitlements.mockResolvedValue({
      scopes: [{ resourceType: 'tool', mode: 'all', resourceIds: [], source: 'governance', version: 1 }],
    });
    mocks.listCatalog.mockResolvedValue({
      resourceType: 'tool',
      items: [{ resourceId: 'search', label: '搜索', version: 1 }],
    });
    const navigated = vi.fn();
    render(
      <SettingsDirtyBoundary>{(controller) => <>
        <OrganizationEntitlementScopeEditor tenantId="tenant-a" resourceType="tool" title="工具可用范围" description="测试" />
        <button type="button" onClick={() => controller.requestNavigation(navigated)}>切换页面</button>
      </>}</SettingsDirtyBoundary>,
    );
    fireEvent.change(await screen.findByLabelText('工具可用范围模式'), { target: { value: 'selected' } });
    fireEvent.click(screen.getByRole('button', { name: '切换页面' }));
    expect(await screen.findByText('有未保存的更改')).toBeTruthy();
    expect(navigated).not.toHaveBeenCalled();
  });
});
