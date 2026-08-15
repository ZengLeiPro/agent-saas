import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SkillManager } from './index';

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
}));

vi.mock('@agent/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent/shared')>()),
  fetchTenantSkillPool: mocks.fetchTenantSkillPool,
  fetchTenantOwnSkills: mocks.fetchTenantOwnSkills,
  updateTenantSkillSettings: vi.fn(async () => undefined),
  updateTenantOwnSkillSettings: vi.fn(async () => undefined),
}));

vi.mock('./hooks', () => ({
  useSkillAdmin: () => ({
    poolSkills: [{
      id: 'platform-skill',
      name: '平台检索技能',
      description: '平台技能',
      enabled: false,
      exposure: 'deny_tenants',
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
    updatePlatformSettings: vi.fn(async () => undefined),
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

afterEach(cleanup);

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

  it('组织自有与平台下发技能的控件名称包含各自技能名', async () => {
    render(<SkillManager mode="tenant" tenantIdScope="tenant-a" tenantName="甲组织" />);

    expect(await screen.findByRole('combobox', { name: '设置技能 组织自有技能 的成员开放范围' })).toBeTruthy();
    expect(screen.getByRole('switch', { name: '启用技能 组织自有技能' })).toBeTruthy();
    expect(screen.getByRole('checkbox', { name: '设置技能 组织自有技能 对成员 爱丽丝 的开放范围' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '编辑技能 组织自有技能' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '提升技能 组织自有技能 到平台技能池' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '删除技能 组织自有技能' })).toBeTruthy();

    expect(screen.getByRole('combobox', { name: '设置技能 组织平台技能 的成员开放范围' })).toBeTruthy();
    expect(screen.getByRole('switch', { name: '启用技能 组织平台技能' })).toBeTruthy();
    expect(screen.getByRole('checkbox', { name: '设置技能 组织平台技能 对成员 爱丽丝 的开放范围' })).toBeTruthy();
  });
});
