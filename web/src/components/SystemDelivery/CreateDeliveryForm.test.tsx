import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { kyAppPost, kyAppRequest } from '@/lib/kyAppManagementApi';
import type { OrganizationConnectionOptions } from '@/lib/kyAppConnectionTypes';
import { CreateDeliveryForm } from './CreateDeliveryForm';
vi.mock('@/lib/kyAppManagementApi', () => ({ kyAppPost: vi.fn(), kyAppRequest: vi.fn() }));
vi.mock('@/lib/urlSync', () => ({ navigateGovernance: vi.fn() }));
const options = {
  settings: {
    baseUrl: 'https://{tenantId}.apps.kaiyancn.com',
    origin: 'https://{tenantId}.apps.kaiyancn.com',
  },
  version: 1,
  published: true,
  publishedDigest: 'a'.repeat(64),
  organizations: [
    { id: 'org-a', name: '组织甲', connection: null },
    { id: 'org-b', name: '组织乙', connection: null },
    {
      id: 'connected',
      name: '已接入组织',
      connection: { installationId: 'instance', status: 'pending', executionId: 'execution' },
    },
  ],
};
function members(id: string): OrganizationConnectionOptions {
  return {
    tenant: { id, name: id === 'org-a' ? '组织甲' : '组织乙' },
    installation: null,
    members: [
      { userId: `${id}-admin`, name: `${id}管理员`, isAdmin: true },
      { userId: `${id}-member`, name: `${id}成员`, isAdmin: false },
    ],
  };
}
beforeEach(() => {
  vi.mocked(kyAppRequest).mockImplementation(async (path) => {
    if (path === '/systems') return { systems: [] } as never;
    if (path === '/systems/demo/connection-options') return structuredClone(options) as never;
    if (path.startsWith('/systems/demo/connection-options/'))
      return members(path.split('/').at(-1)!) as never;
    throw new Error(`unexpected ${path}`);
  });
  vi.mocked(kyAppPost).mockResolvedValue({ execution: { executionId: 'new' } });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});
async function selectOrganization() {
  fireEvent.change(await screen.findByRole('combobox', { name: '选择组织' }), {
    target: { value: 'org-a' },
  });
}
function confirmConnection() {
  fireEvent.click(screen.getByRole('button', { name: '确认接入' }));
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '确认接入' }));
}
describe('已有组织接入表单', () => {
  it('无 eligible 字段仍可选择已有组织和无手机号成员，提交不携带创建组织等字段', async () => {
    const started = vi.fn();
    render(<CreateDeliveryForm defaultSystemId="demo" onStarted={started} />);
    await selectOrganization();
    const contact = await screen.findByRole('combobox', { name: '技术联系人' });
    expect((contact as HTMLSelectElement).value).toBe('org-a-admin');
    expect(screen.queryByLabelText('管理员手机号')).toBeNull();
    expect(screen.queryByLabelText('赠送积分')).toBeNull();
    expect(screen.queryByLabelText('业务服务地址')).toBeNull();
    expect(screen.queryByRole('button', { name: '配置组织权益' })).toBeNull();
    fireEvent.change(contact, { target: { value: 'org-a-member' } });
    confirmConnection();
    await waitFor(() => expect(started).toHaveBeenCalledTimes(1));
    expect(kyAppPost).toHaveBeenCalledWith('/onboard-existing', {
      systemId: 'demo',
      tenantId: 'org-a',
      techContactUserId: 'org-a-member',
      expectedSettingsVersion: 1,
      expectedDigest: 'a'.repeat(64),
    });
  });
  it('按名称搜索，已接入组织可直接打开进度', async () => {
    const open = vi.fn();
    render(
      <CreateDeliveryForm defaultSystemId="demo" onStarted={vi.fn()} onOpenExecution={open} />,
    );
    fireEvent.change(await screen.findByRole('searchbox', { name: '搜索组织' }), {
      target: { value: '已接入' },
    });
    expect(screen.queryByRole('option', { name: '组织甲' })).toBeNull();
    fireEvent.change(screen.getByRole('combobox', { name: '选择组织' }), {
      target: { value: 'connected' },
    });
    fireEvent.click(screen.getByRole('button', { name: '打开已有接入' }));
    expect(open).toHaveBeenCalledWith('execution');
    expect(kyAppPost).not.toHaveBeenCalled();
  });
  it('切换组织不会显示或提交旧组织联系人，迟到响应不会覆盖新组织', async () => {
    let finish!: (value: unknown) => void;
    const original = vi.mocked(kyAppRequest).getMockImplementation()!;
    vi.mocked(kyAppRequest).mockImplementation((path) =>
      path.endsWith('/org-a')
        ? new Promise((resolve) => {
            finish = resolve;
          })
        : original(path),
    );
    render(<CreateDeliveryForm defaultSystemId="demo" onStarted={vi.fn()} />);
    const organization = await screen.findByRole('combobox', { name: '选择组织' });
    fireEvent.change(organization, { target: { value: 'org-a' } });
    await waitFor(() => expect(finish).toBeTypeOf('function'));
    expect(screen.queryByRole('button', { name: '确认接入' })).toBeNull();
    fireEvent.change(organization, { target: { value: 'org-b' } });
    expect(
      ((await screen.findByRole('combobox', { name: '技术联系人' })) as HTMLSelectElement).value,
    ).toBe('org-b-admin');
    finish(members('org-a'));
    await waitFor(() =>
      expect(screen.queryByRole('option', { name: 'org-a管理员（组织管理员）' })).toBeNull(),
    );
    confirmConnection();
    await waitFor(() =>
      expect(kyAppPost).toHaveBeenCalledWith(
        '/onboard-existing',
        expect.objectContaining({ tenantId: 'org-b', techContactUserId: 'org-b-admin' }),
      ),
    );
  });
  it('忽略旧响应中的安装资格，不再引导用户配置已退役的组织白名单', async () => {
    const original = vi.mocked(kyAppRequest).getMockImplementation()!;
    vi.mocked(kyAppRequest).mockImplementation(async (path) =>
      path.endsWith('/org-a')
        ? ({ ...members('org-a'), eligible: false } as never)
        : original(path),
    );
    const started = vi.fn();
    render(<CreateDeliveryForm defaultSystemId="demo" onStarted={started} />);
    await selectOrganization();
    await screen.findByRole('combobox', { name: '技术联系人' });
    expect(screen.queryByRole('button', { name: '配置组织权益' })).toBeNull();
    confirmConnection();
    await waitFor(() => expect(started).toHaveBeenCalledTimes(1));
  });
  it('没有有效成员时仍禁止按钮和程序化表单提交', async () => {
    const original = vi.mocked(kyAppRequest).getMockImplementation()!;
    vi.mocked(kyAppRequest).mockImplementation(async (path) =>
      path.endsWith('/org-a') ? ({ ...members('org-a'), members: [] } as never) : original(path),
    );
    render(<CreateDeliveryForm defaultSystemId="demo" onStarted={vi.fn()} />);
    await selectOrganization();
    const contact = await screen.findByRole('combobox', { name: '技术联系人' });
    expect((screen.getByRole('button', { name: '确认接入' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.submit(contact.closest('form')!);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(kyAppPost).not.toHaveBeenCalled();
  });
  it.each([
    { published: false, publishedDigest: null },
    { published: true, publishedDigest: null },
  ])('未发布或缺少发布摘要时不能接入：%j', async (publication) => {
    const original = vi.mocked(kyAppRequest).getMockImplementation()!;
    vi.mocked(kyAppRequest).mockImplementation(async (path) =>
      path === '/systems/demo/connection-options'
        ? ({ ...structuredClone(options), ...publication } as never)
        : original(path),
    );
    render(<CreateDeliveryForm defaultSystemId="demo" onStarted={vi.fn()} />);
    await selectOrganization();
    await screen.findByText('请先发布业务系统版本。');
    expect(screen.queryByRole('button', { name: '确认接入' })).toBeNull();
    expect(kyAppPost).not.toHaveBeenCalled();
  });
  it('成员数据请求失败不能被解释为允许接入', async () => {
    const original = vi.mocked(kyAppRequest).getMockImplementation()!;
    vi.mocked(kyAppRequest).mockImplementation(async (path) => {
      if (path.endsWith('/org-a')) throw new Error('组织成员服务不可用');
      return original(path);
    });
    render(<CreateDeliveryForm defaultSystemId="demo" onStarted={vi.fn()} />);
    await selectOrganization();
    await screen.findByText('组织成员服务不可用');
    expect(screen.queryByRole('button', { name: '确认接入' })).toBeNull();
    expect(kyAppPost).not.toHaveBeenCalled();
  });
  it('服务端拒绝时展示错误、不报成功，并恢复组织切换', async () => {
    vi.mocked(kyAppPost).mockRejectedValue(new Error('无权操作此组织'));
    const started = vi.fn();
    render(<CreateDeliveryForm defaultSystemId="demo" onStarted={started} />);
    await selectOrganization();
    await screen.findByRole('combobox', { name: '技术联系人' });
    confirmConnection();
    await waitFor(() => expect(kyAppPost).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect((within(screen.getByRole('dialog')).getByRole('button', { name: '取消' }) as HTMLButtonElement).disabled).toBe(false),
    );
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '取消' }));
    await screen.findByText('无权操作此组织');
    expect(started).not.toHaveBeenCalled();
    expect((screen.getByRole('combobox', { name: '选择组织' }) as HTMLSelectElement).disabled).toBe(false);
  });
  it('独立部署时才填写实例地址；提交中禁用组织切换与重复提交', async () => {
    vi.mocked(kyAppPost).mockReturnValue(new Promise(() => {}));
    render(<CreateDeliveryForm defaultSystemId="demo" onStarted={vi.fn()} />);
    const organization = await screen.findByRole('combobox', { name: '选择组织' });
    fireEvent.change(organization, { target: { value: 'org-a' } });
    fireEvent.click(await screen.findByRole('checkbox'));
    fireEvent.change(screen.getByLabelText('业务服务地址'), {
      target: { value: 'https://custom.apps.kaiyancn.com' },
    });
    confirmConnection();
    await waitFor(() => expect((organization as HTMLSelectElement).disabled).toBe(true));
    const pending = within(screen.getByRole('dialog')).getByRole('button', { name: '接入中…' });
    expect((pending as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(pending);
    expect(kyAppPost).toHaveBeenCalledTimes(1);
    expect(kyAppPost).toHaveBeenCalledWith(
      '/onboard-existing',
      expect.objectContaining({
        deployment: {
          baseUrl: 'https://custom.apps.kaiyancn.com',
          origin: 'https://org-a.apps.kaiyancn.com',
        },
      }),
    );
  });
});
