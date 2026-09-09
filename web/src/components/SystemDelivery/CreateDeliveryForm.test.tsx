import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { kyAppPost, kyAppRequest } from '@/lib/kyAppManagementApi';
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
function members(id: string) {
  return {
    tenant: { id, name: id === 'org-a' ? '组织甲' : '组织乙' },
    eligible: true,
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
describe('已有组织接入表单', () => {
  it('选择已有组织和无手机号的成员，自动使用默认地址，提交不再携带创建组织等字段', async () => {
    const started = vi.fn();
    render(<CreateDeliveryForm defaultSystemId="demo" onStarted={started} />);
    fireEvent.change(await screen.findByRole('combobox', { name: '选择组织' }), {
      target: { value: 'org-a' },
    });
    const contact = await screen.findByRole('combobox', { name: '技术联系人' });
    expect((contact as HTMLSelectElement).value).toBe('org-a-admin');
    expect(screen.queryByLabelText('管理员手机号')).toBeNull();
    expect(screen.queryByLabelText('赠送积分')).toBeNull();
    expect(screen.queryByLabelText('业务服务地址')).toBeNull();
    fireEvent.change(contact, { target: { value: 'org-a-member' } });
    fireEvent.click(screen.getByRole('button', { name: '确认接入' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '确认接入' }));
    await waitFor(() => expect(started).toHaveBeenCalled());
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
    fireEvent.change(organization, { target: { value: 'org-b' } });
    expect(
      ((await screen.findByRole('combobox', { name: '技术联系人' })) as HTMLSelectElement).value,
    ).toBe('org-b-admin');
    finish(members('org-a'));
    await waitFor(() =>
      expect(screen.queryByRole('option', { name: 'org-a管理员（组织管理员）' })).toBeNull(),
    );
    fireEvent.click(screen.getByRole('button', { name: '确认接入' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '确认接入' }));
    await waitFor(() =>
      expect(kyAppPost).toHaveBeenCalledWith(
        '/onboard-existing',
        expect.objectContaining({ tenantId: 'org-b', techContactUserId: 'org-b-admin' }),
      ),
    );
  });
  it('权益不足时解释原因并提供配置入口，不允许提交', async () => {
    const original = vi.mocked(kyAppRequest).getMockImplementation()!;
    vi.mocked(kyAppRequest).mockImplementation(async (path) =>
      path.endsWith('/org-a')
        ? ({ ...members('org-a'), eligible: false } as never)
        : original(path),
    );
    render(<CreateDeliveryForm defaultSystemId="demo" onStarted={vi.fn()} />);
    fireEvent.change(await screen.findByRole('combobox', { name: '选择组织' }), {
      target: { value: 'org-a' },
    });
    await screen.findByRole('button', { name: '配置组织权益' });
    expect(screen.queryByRole('button', { name: '确认接入' })).toBeNull();
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
    fireEvent.click(screen.getByRole('button', { name: '确认接入' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '确认接入' }));
    await waitFor(() => expect((organization as HTMLSelectElement).disabled).toBe(true));
    expect((screen.getByRole('button', { name: '接入中…' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
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
