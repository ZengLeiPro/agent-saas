import { beforeEach, describe, expect, it, vi } from 'vitest';
import { governanceAccessApi } from '@agent/shared/lib/governanceApi';
import { loadMySystems } from '@/lib/mySystemsSource';
import { previewResourceAssignment, updateResourceAssignment } from './installationAssignmentApi';
vi.mock('@agent/shared/lib/governanceApi', () => ({
  governanceAccessApi: {
    previewAssignmentBatch: vi.fn(),
    updateAssignmentBatch: vi.fn(),
    previewAssignment: vi.fn(),
    updateAssignment: vi.fn(),
  },
}));
vi.mock('@/lib/mySystemsSource', () => ({ loadMySystems: vi.fn() }));
beforeEach(() => vi.clearAllMocks());
describe('业务系统使用签名批量预览计算人数', () => {
  it('提交与预览使用同一资源、组织和规则；成功后刷新成员入口', async () => {
    const command = {
      expectedVersion: 2,
      assignments: [{ assigneeType: 'user', assigneeId: 'u1', effect: 'allow' }],
    };
    await previewResourceAssignment('system_installation', 'iid-1', command, 'tenant-a');
    expect(governanceAccessApi.previewAssignmentBatch).toHaveBeenCalledWith(
      {
        changes: [{ resourceType: 'system_installation', resourceId: 'iid-1', ...command }],
        reason: '业务系统访问范围调整',
      },
      'tenant-a',
    );
    await updateResourceAssignment(
      'system_installation',
      'iid-1',
      { ...command, previewId: 'signed', baselineDigest: 'baseline', expiresAt: 'future' },
      'tenant-a',
    );
    expect(governanceAccessApi.updateAssignmentBatch).toHaveBeenCalledWith(
      expect.objectContaining({
        previewId: 'signed',
        baselineDigest: 'baseline',
        changes: [{ resourceType: 'system_installation', resourceId: 'iid-1', ...command }],
      }),
      'tenant-a',
    );
    expect(loadMySystems).toHaveBeenCalledWith({ force: true });
  });
  it('提交失败不会伪造成员刷新成功', async () => {
    vi.mocked(governanceAccessApi.updateAssignmentBatch).mockRejectedValueOnce(
      new Error('baseline conflict'),
    );
    await expect(
      updateResourceAssignment('system_installation', 'iid-1', {}, 'tenant-a'),
    ).rejects.toThrow();
    expect(loadMySystems).not.toHaveBeenCalled();
  });
});
