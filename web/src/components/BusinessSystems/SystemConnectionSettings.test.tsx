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
          { id: 'read', name: '读取订单', riskLevel: 'read_only' },
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
  it('诊断只提供只读能力，数组参数不提交，保存失败可重新加载', async () => {
    vi.mocked(kyAppRequest).mockResolvedValue({
      settings: { baseUrl: '', origin: '' },
      version: 1,
    });
    render(<SystemConnectionSettings detail={detail} onSaved={vi.fn()} />);
    await screen.findByLabelText('默认业务服务地址');
    fireEvent.click(screen.getByText('接入诊断配置'));
    expect(screen.queryByText('修改订单')).toBeNull();
    fireEvent.change(screen.getByLabelText('诊断能力'), { target: { value: 'read' } });
    fireEvent.change(screen.getByLabelText('诊断参数（JSON）'), { target: { value: '[]' } });
    fireEvent.click(screen.getByRole('button', { name: '保存接入配置' }));
    await screen.findByText('诊断参数必须是 JSON 对象');
    expect(kyAppPost).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '重新加载已保存配置' }));
    await waitFor(() => expect(kyAppRequest).toHaveBeenCalledTimes(2));
  });
});
