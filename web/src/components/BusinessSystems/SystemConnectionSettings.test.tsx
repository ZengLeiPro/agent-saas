import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { kyAppPost, kyAppRequest } from '@/lib/kyAppManagementApi';
import type { SystemDetail } from '@/lib/kyAppManagementTypes';
import { SystemConnectionSettings } from './SystemConnectionSettings';

vi.mock('@/lib/kyAppManagementApi', async (original) => ({
  ...(await original<object>()),
  kyAppPost: vi.fn(),
  kyAppRequest: vi.fn(),
}));
const detail = {
  definition: { systemId: 'demo', publishedDigest: 'digest' },
  versions: [
    {
      digest: 'digest',
      manifest: {
        capabilities: [
          {
            id: 'read',
            name: '读取订单',
            riskLevel: 'read_only',
            inputSchema: {
              type: 'object',
              properties: {
                customerName: { type: 'string', description: '客户名称' },
                internalIds: { type: 'array', description: '内部编号' },
              },
            },
          },
          { id: 'write', name: '修改订单', riskLevel: 'external_write' },
        ],
      },
    },
  ],
} as unknown as SystemDetail;
afterEach(() => vi.clearAllMocks());
describe('系统默认接入配置', () => {
  it('保存模板携带版本号，成功后刷新且不修改安装实例', async () => {
    vi.mocked(kyAppRequest).mockResolvedValue({
      settings: { baseUrl: '', origin: '' },
      version: 2,
    });
    vi.mocked(kyAppPost).mockResolvedValue({});
    const saved = vi.fn();
    render(<SystemConnectionSettings detail={detail} onSaved={saved} />);
    fireEvent.change(await screen.findByLabelText('默认业务服务地址'), {
      target: { value: 'https://{tenantId}.example.com' },
    });
    fireEvent.change(screen.getByLabelText('默认业务页面地址'), {
      target: { value: 'https://{tenantId}.example.com' },
    });
    fireEvent.click(screen.getByRole('button', { name: '保存接入配置' }));
    await waitFor(() => expect(saved).toHaveBeenCalledOnce());
    expect(kyAppPost).toHaveBeenCalledWith('/systems/demo/connection-settings', {
      expectedVersion: 2,
      settings: {
        baseUrl: 'https://{tenantId}.example.com',
        origin: 'https://{tenantId}.example.com',
      },
    });
  });
  it('诊断只提供只读能力和可安全编辑的标量参数，保存失败可重新加载', async () => {
    vi.mocked(kyAppRequest).mockResolvedValue({
      settings: { baseUrl: '', origin: '' },
      version: 1,
    });
    vi.mocked(kyAppPost).mockRejectedValue(new Error('保存失败'));
    render(<SystemConnectionSettings detail={detail} onSaved={vi.fn()} />);
    await screen.findByLabelText('默认业务服务地址');
    fireEvent.click(screen.getByText('接入诊断配置'));
    expect(screen.queryByText('修改订单')).toBeNull();
    fireEvent.change(screen.getByLabelText('诊断能力'), { target: { value: 'read' } });
    fireEvent.change(screen.getByLabelText('客户名称'), { target: { value: '开沿科技' } });
    expect(screen.queryByLabelText('内部编号')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '保存接入配置' }));
    await waitFor(() =>
      expect(kyAppPost).toHaveBeenCalledWith('/systems/demo/connection-settings', {
        expectedVersion: 1,
        settings: {
          baseUrl: '',
          origin: '',
          diagnostic: {
            readOnlyCapabilityId: 'read',
            readOnlyInput: { customerName: '开沿科技' },
          },
        },
      }),
    );
    await screen.findByText('保存失败');
    fireEvent.click(screen.getByRole('button', { name: '重新加载已保存配置' }));
    await waitFor(() => expect(kyAppRequest).toHaveBeenCalledTimes(2));
  });
});
