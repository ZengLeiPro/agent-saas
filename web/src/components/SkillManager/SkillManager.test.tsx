import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SkillManager } from './index';
import { SettingsDirtyBoundary } from '@/components/PersonalSettings/dirtyRegistry';

const mocks = vi.hoisted(() => ({
  fetchTenantSkillPool: vi.fn(async () => ({
    skills: [{
      id: 'tenant-pool-skill',
      name: '组织平台技能',
      description: '来自平台',
      enabled: true,
      exposure: 'allow_users',
      usernames: [],
    }],
  })),
  fetchTenantOwnSkills: vi.fn(async () => ({
    skills: [{
      id: 'tenant-own-skill',
      name: '组织自有技能',
      description: '组织上传',
      enabled: true,
      exposure: 'allow_users',
      usernames: [],
    }],
  })),
  updatePlatformSettings: vi.fn(async () => undefined),
  platformExposure: { value: 'deny_tenants' as 'all' | 'allow_tenants' | 'deny_tenants' },
}));

vi.mock('@agent/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent/shared')>()),
  fetchTenantSkillPool: mocks.fetchTenantSkillPool,
  fetchTenantOwnSkills: mocks.fetchTenantOwnSkills,
}));

vi.mock('./hooks', () => ({
  useSkillAdmin: () => ({
    poolSkills: [{
      id: 'platform-skill',
      name: '平台检索技能',
      description: '平台技能',
      enabled: false,
      exposure: mocks.platformExposure.value,
      tenantIds: [],
    }],
    customData: {
      users: {
        alice: [{ id: 'custom-skill', name: '用户写作技能', description: '用户技能' }],
      },
    },
    loading: false,
    error: null,
    refresh: vi.fn(async () => undefined),
    updatePlatformSettings: mocks.updatePlatformSettings,
    promoteSkill: vi.fn(async () => undefined),
    deleteCustomSkill: vi.fn(async () => undefined),
    fetchCustomSkillDocument: vi.fn(async () => ({ content: '' })),
    updateCustomSkillDocument: vi.fn(async () => undefined),
    syncSkills: vi.fn(async () => undefined),
    syncProgress: null,
  }),
}));

vi.mock('@/components/UserManager/hooks', () => ({
  useUsers: () => ({
    users: [{ username: 'alice', realName: '爱丽丝', tenantId: 'tenant-a', disabled: false }],
    loading: false,
  }),
}));

vi.mock('@/components/TenantManager/hooks', () => ({
  useTenants: () => ({
    tenants: [{ id: 'tenant-a', name: '甲组织', disabled: false }],
    loading: false,
  }),
}));

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ isPlatformAdmin: true, canPlatform: () => true }),
}));

afterEach(() => {
  cleanup();
  mocks.updatePlatformSettings.mockClear();
  mocks.platformExposure.value = 'deny_tenants';
});

describe('SkillManager 技能操作可访问名称', () => {
  it('平台技能与用户技能操作名称包含技能名', async () => {
    const user = userEvent.setup();
    render(<SkillManager />);

    expect(screen.getByRole('combobox', { name: '设置技能 平台检索技能 的组织开放范围' })).toBeTruthy();
    expect(screen.getByRole('switch', { name: '启用技能 平台检索技能' })).toBeTruthy();
    expect(screen.getByRole('checkbox', { name: '设置技能 平台检索技能 对组织 甲组织 的开放范围' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '删除技能 平台检索技能' })).toBeTruthy();

    await user.click(screen.getByRole('tab', { name: /用户技能/ }));
    expect(screen.getByRole('button', { name: '接管编辑技能 用户写作技能' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '提升技能 用户写作技能到全局' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '删除技能 用户写作技能' })).toBeTruthy();
  });

  it('从全平台切换为仅指定组织时先保留现有全部组织，避免空白 allow list', async () => {
    const user = userEvent.setup();
    mocks.platformExposure.value = 'all';
    render(<SkillManager />);

    await user.click(screen.getByRole('combobox', { name: '设置技能 平台检索技能 的组织开放范围' }));
    await user.click(screen.getByRole('option', { name: '仅指定租户开放' }));

    expect(mocks.updatePlatformSettings).toHaveBeenCalledWith({
      'platform-skill': {
        enabled: false,
        exposure: 'allow_tenants',
        tenantIds: ['tenant-a'],
      },
    });
  });

  it('组织自有与平台下发技能只展示治理权威授权入口', async () => {
    render(<SkillManager mode="tenant" tenantIdScope="tenant-a" tenantName="甲组织" />);

    expect(await screen.findByRole('combobox', { name: '组织自有技能成员与群组授权资源' })).toBeTruthy();
    expect(screen.getByRole('option', { name: /组织自有技能/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: '编辑技能 组织自有技能' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '提升技能 组织自有技能 到平台技能池' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '删除技能 组织自有技能' })).toBeTruthy();
    expect(screen.getByText('Assignment 权威授权')).toBeTruthy();
    expect(screen.getByText('Entitlement + Assignment 权威授权')).toBeTruthy();
    expect(screen.queryByRole('switch', { name: '启用技能 组织自有技能' })).toBeNull();
  });

  it('技能编辑弹窗自身取消时经过 dirty guard', async () => {
    const user = userEvent.setup();
    render(
      <SettingsDirtyBoundary>
        {() => <SkillManager />}
      </SettingsDirtyBoundary>,
    );

    await user.click(screen.getByRole('tab', { name: /用户技能/ }));
    await user.click(screen.getByRole('button', { name: '接管编辑技能 用户写作技能' }));
    const dialog = await screen.findByRole('dialog');
    const editor = within(dialog).getByRole('textbox');
    await user.type(editor, '# 草稿');
    await user.click(screen.getByRole('button', { name: '取消' }));

    expect(await screen.findByRole('heading', { name: '有未保存的更改' })).toBeTruthy();
    expect(screen.getByDisplayValue('# 草稿')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: '放弃更改' }));
    expect(screen.queryByDisplayValue('# 草稿')).toBeNull();
  });
});
