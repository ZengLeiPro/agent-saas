import { beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  authFetch: vi.fn(),
  createCredential: vi.fn(),
  listCredentials: vi.fn(),
  previewCredentialRotation: vi.fn(),
  rotateCredential: vi.fn(),
  previewCredentialRevoke: vi.fn(),
  revokeCredential: vi.fn(),
}));

vi.mock('./authFetch', () => ({ authFetch: api.authFetch }));
vi.mock('./governanceApi', () => ({
  governanceResourcesApi: {
    createCredential: api.createCredential,
    listCredentials: api.listCredentials,
    previewCredentialRotation: api.previewCredentialRotation,
    rotateCredential: api.rotateCredential,
    previewCredentialRevoke: api.previewCredentialRevoke,
    revokeCredential: api.revokeCredential,
  },
}));

import { connectX, disconnectX } from './connectorsApi';

function jsonResponse(body: unknown): Response {
  return { ok: true, json: async () => body } as Response;
}

const disconnected = {
  connection: { connectorId: 'x', status: 'disconnected', runtimeEnabled: true },
};

describe('X governance connector API', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.listCredentials.mockResolvedValue({ credentials: [] });
    api.createCredential.mockResolvedValue({ credentialId: 'credential-x', version: 1 });
    api.previewCredentialRevoke.mockResolvedValue({
      previewId: 'cpv2.revoke-preview', baselineDigest: 'revoke-baseline', expiresAt: '2026-08-20T10:05:00.000Z',
    });
    api.revokeCredential.mockResolvedValue({ status: 'revoked' });
    api.authFetch.mockResolvedValue(jsonResponse({
      connection: {
        connectorId: 'x', status: 'connected', runtimeEnabled: true,
        credentialId: 'credential-x', credentialVersion: 1,
      },
    }));
  });

  it('通过治理资源 API 创建个人 X Credential，再从治理状态读取连接', async () => {
    await expect(connectX({ authToken: ' auth-cookie ', ct0: ' ct0-cookie ' })).resolves.toEqual({
      connection: {
        connectorId: 'x', status: 'connected', runtimeEnabled: true,
        credentialId: 'credential-x', credentialVersion: 1,
      },
    });
    expect(api.createCredential).toHaveBeenCalledWith({
      connectorId: 'x',
      kind: 'personal_grant',
      purpose: 'X bird CLI 用户凭据',
      scopeSummary: { scopes: ['x:*'] },
      secret: JSON.stringify({ authToken: 'auth-cookie', ct0: 'ct0-cookie' }),
    });
    expect(api.authFetch).toHaveBeenCalledWith('/api/connectors/x');
  });

  it('已有治理 Credential 时走治理 rotation，而不是重复创建', async () => {
    api.listCredentials.mockResolvedValueOnce({ credentials: [{
      credentialId: 'credential-x', connectorId: 'x', kind: 'personal_grant',
      status: 'active', version: 3, updatedAt: '2026-08-20T10:00:00.000Z',
    }] });
    api.previewCredentialRotation.mockResolvedValue({
      previewId: 'cpv2.preview', baselineDigest: 'baseline', expiresAt: '2026-08-20T10:05:00.000Z',
    });
    api.rotateCredential.mockResolvedValue({ credentialId: 'credential-x', version: 4 });
    api.authFetch.mockResolvedValueOnce(jsonResponse({
      connection: {
        connectorId: 'x', status: 'connected', runtimeEnabled: true,
        credentialId: 'credential-x', credentialVersion: 4,
      },
    }));

    await connectX({ authToken: 'auth-cookie', ct0: 'ct0-cookie' });

    expect(api.createCredential).not.toHaveBeenCalled();
    expect(api.previewCredentialRotation).toHaveBeenCalledWith('credential-x', {
      expectedVersion: 3,
      secret: JSON.stringify({ authToken: 'auth-cookie', ct0: 'ct0-cookie' }),
      reason: '更新 X bird CLI 用户凭据',
    });
    expect(api.rotateCredential).toHaveBeenCalledWith('credential-x', {
      expectedVersion: 3,
      secret: JSON.stringify({ authToken: 'auth-cookie', ct0: 'ct0-cookie' }),
      reason: '更新 X bird CLI 用户凭据',
      previewId: 'cpv2.preview', baselineDigest: 'baseline', expiresAt: '2026-08-20T10:05:00.000Z',
    });
  });

  it('断开 X 只调用治理 Credential 撤销，不调用旧 DELETE', async () => {
    api.listCredentials.mockResolvedValueOnce({ credentials: [
      { credentialId: 'credential-old', connectorId: 'x', kind: 'personal_grant', status: 'active', version: 2 },
      { credentialId: 'credential-current', connectorId: 'x', kind: 'personal_grant', status: 'rotation_due', version: 4 },
      { credentialId: 'other', connectorId: 'github', kind: 'personal_grant', status: 'active', version: 1 },
    ] });
    api.authFetch.mockResolvedValueOnce(jsonResponse(disconnected));

    await expect(disconnectX()).resolves.toEqual(disconnected);
    expect(api.previewCredentialRevoke).toHaveBeenNthCalledWith(1, 'credential-old', {
      expectedVersion: 2, reason: '用户主动断开 X',
    });
    expect(api.previewCredentialRevoke).toHaveBeenNthCalledWith(2, 'credential-current', {
      expectedVersion: 4, reason: '用户主动断开 X',
    });
    expect(api.revokeCredential).toHaveBeenNthCalledWith(1, 'credential-old', {
      expectedVersion: 2, reason: '用户主动断开 X',
      previewId: 'cpv2.revoke-preview', baselineDigest: 'revoke-baseline', expiresAt: '2026-08-20T10:05:00.000Z',
    });
    expect(api.revokeCredential).toHaveBeenNthCalledWith(2, 'credential-current', {
      expectedVersion: 4, reason: '用户主动断开 X',
      previewId: 'cpv2.revoke-preview', baselineDigest: 'revoke-baseline', expiresAt: '2026-08-20T10:05:00.000Z',
    });
    expect(api.authFetch).toHaveBeenCalledWith('/api/connectors/x');
    expect(api.authFetch).not.toHaveBeenCalledWith('/api/connectors/x', { method: 'DELETE' });
  });

  it('拒绝空白 X Cookie，不创建无效治理凭据', async () => {
    await expect(connectX({ authToken: ' ', ct0: 'ct0-cookie' })).rejects.toThrow('X 连接凭据不能为空');
    expect(api.createCredential).not.toHaveBeenCalled();
    expect(api.listCredentials).not.toHaveBeenCalled();
  });
});
