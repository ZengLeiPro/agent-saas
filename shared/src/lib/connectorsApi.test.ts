import { beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  authFetch: vi.fn(),
  createCredential: vi.fn(),
}));

vi.mock('./authFetch', () => ({ authFetch: api.authFetch }));
vi.mock('./governanceApi', () => ({
  governanceResourcesApi: { createCredential: api.createCredential },
}));

import { connectX } from './connectorsApi';

describe('connectX', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.createCredential.mockResolvedValue({ credentialId: 'credential-x' });
  });

  it('通过治理资源 API 创建个人 X Credential，不再写入旧连接器接口', async () => {
    await expect(connectX({ authToken: ' auth-cookie ', ct0: ' ct0-cookie ' })).resolves.toEqual({
      connection: { connectorId: 'x', status: 'connected', runtimeEnabled: true },
    });
    expect(api.createCredential).toHaveBeenCalledWith({
      connectorId: 'x',
      kind: 'personal_grant',
      purpose: 'X bird CLI 用户凭据',
      scopeSummary: { scopes: ['x:*'] },
      secret: JSON.stringify({ authToken: 'auth-cookie', ct0: 'ct0-cookie' }),
    });
    expect(api.authFetch).not.toHaveBeenCalled();
  });

  it('拒绝空白 X Cookie，不创建无效治理凭据', async () => {
    await expect(connectX({ authToken: ' ', ct0: 'ct0-cookie' })).rejects.toThrow('X 连接凭据不能为空');
    expect(api.createCredential).not.toHaveBeenCalled();
  });
});
