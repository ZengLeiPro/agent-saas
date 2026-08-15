import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SkillManager } from './index';

const mocks = vi.hoisted(() => ({
  importTenantSkillPackage: vi.fn(),
  legacyImportTenantSkill: vi.fn(),
  fetchTenantSkillPool: vi.fn(),
  fetchTenantOwnSkills: vi.fn(),
  refreshAdmin: vi.fn(),
}));

vi.mock('@agent/shared/lib/governanceApi', () => ({
  governanceResourcesApi: {
    importTenantSkillPackage: (...args: unknown[]) => mocks.importTenantSkillPackage(...args),
  },
}));

vi.mock('@agent/shared', () => ({
  fetchTenantSkillPool: (...args: unknown[]) => mocks.fetchTenantSkillPool(...args),
  fetchTenantOwnSkills: (...args: unknown[]) => mocks.fetchTenantOwnSkills(...args),
  importTenantSkill: (...args: unknown[]) => mocks.legacyImportTenantSkill(...args),
  importPoolSkill: vi.fn(),
  updateTenantSkillSettings: vi.fn(),
  updateTenantOwnSkillSettings: vi.fn(),
  fetchTenantOwnSkillDocument: vi.fn(),
  updateTenantOwnSkillDocument: vi.fn(),
  deleteTenantOwnSkill: vi.fn(),
  promoteSkillToTenant: vi.fn(),
  promoteTenantSkillToPool: vi.fn(),
  fetchPoolSkillDeleteImpact: vi.fn(),
  deletePoolSkill: vi.fn(),
}));

vi.mock('./hooks', () => ({
  useSkillAdmin: () => ({
    poolSkills: [], customData: { users: {} }, loading: false, error: null,
    refresh: mocks.refreshAdmin,
    updatePlatformSettings: vi.fn(), promoteSkill: vi.fn(), deleteCustomSkill: vi.fn(),
    fetchCustomSkillDocument: vi.fn(), updateCustomSkillDocument: vi.fn(),
    syncSkills: vi.fn(), syncProgress: null,
  }),
}));

vi.mock('@/components/TenantManager/hooks', () => ({
  useTenants: () => ({ tenants: [], loading: false }),
}));

vi.mock('@/components/UserManager/hooks', () => ({
  useUsers: () => ({ users: [], loading: false }),
}));

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ isPlatformAdmin: true, canPlatform: () => true }),
}));

const governedSkill = {
  id: 'managed-skill', name: 'managed-skill', description: 'managed',
  enabled: true, exposure: 'all', usernames: [],
  governance: {
    tenantId: 'kaiyan', status: 'published', version: 1,
    source: 'governance_upload', createdBy: 'platform-1',
  },
};

function uploadSkillFile(container: HTMLElement) {
  fireEvent.click(screen.getByRole('button', { name: '上传技能' }));
  const input = container.querySelector('input[accept=".md,text/markdown"]') as HTMLInputElement;
  const file = new File([
    '---\nname: managed-skill\ndescription: managed\n---\nbody',
  ], 'SKILL.md', { type: 'text/markdown' });
  fireEvent.change(input, { target: { files: [file] } });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.fetchTenantSkillPool.mockResolvedValue({ tenantId: 'kaiyan', skills: [] });
  mocks.fetchTenantOwnSkills
    .mockResolvedValueOnce({ tenantId: 'kaiyan', skills: [] })
    .mockResolvedValue({ tenantId: 'kaiyan', skills: [governedSkill] });
  mocks.refreshAdmin.mockResolvedValue(undefined);
  mocks.importTenantSkillPackage.mockResolvedValue({
    ok: true,
    status: 'succeeded',
    skill: { id: 'managed-skill', name: 'managed-skill', description: 'managed' },
    resource: {
      skillId: 'managed-skill', tenantId: 'kaiyan', scope: 'tenant', status: 'published',
      currentVersionId: 'skillv-1', revision: 2, createdBy: 'platform-1',
    },
    version: { versionId: 'skillv-1', skillId: 'managed-skill', versionNumber: 1, digest: 'digest-1' },
    auditCompletion: 'pending',
  });
});

describe('SkillManager 组织治理上传', () => {
  it('平台管理员代管组织时只调用治理上传，并刷新显示权威版本与组织作用域', async () => {
    const { container } = render(<SkillManager mode="tenant" tenantIdScope="kaiyan" tenantName="开沿科技" />);
    await waitFor(() => expect((screen.getByRole('button', { name: '上传技能' }) as HTMLButtonElement).disabled).toBe(false));

    uploadSkillFile(container);

    await waitFor(() => expect(mocks.importTenantSkillPackage).toHaveBeenCalledWith('kaiyan', [expect.any(File)]));
    expect(mocks.legacyImportTenantSkill).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByText(/已上传并发布技能：managed-skill/)).toBeTruthy());
    expect(screen.getByText(/审计记录同步中/)).toBeTruthy();
    await waitFor(() => expect(screen.getByText(/已发布 · v1 · 治理上传 · 组织 kaiyan/)).toBeTruthy());
  });

  it('治理接口失败时保留可重试入口并显示具体业务原因', async () => {
    mocks.importTenantSkillPackage.mockRejectedValueOnce(new Error('技能“managed-skill”已存在，请修改 name 或版本后重试'));
    const { container } = render(<SkillManager mode="tenant" tenantIdScope="kaiyan" tenantName="开沿科技" />);
    await waitFor(() => expect((screen.getByRole('button', { name: '上传技能' }) as HTMLButtonElement).disabled).toBe(false));

    uploadSkillFile(container);

    await waitFor(() => expect(screen.getByText(/上传失败：技能“managed-skill”已存在/)).toBeTruthy());
    expect((screen.getByRole('button', { name: '上传 SKILL.md' }) as HTMLButtonElement).disabled).toBe(false);
    expect(mocks.legacyImportTenantSkill).not.toHaveBeenCalled();
  });
});
