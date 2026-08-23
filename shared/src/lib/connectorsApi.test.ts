import { beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  authFetch: vi.fn(),
  createCredential: vi.fn(),
  listCredentials: vi.fn(),
  previewCredentialRotation: vi.fn(),
  rotateCredential: vi.fn(),
  previewCredentialRevoke: vi.fn(),
  revokeCredential: vi.fn(),
  listOAuthGrants: vi.fn(),
  previewOAuthGrantRevocation: vi.fn(),
  revokeOAuthGrant: vi.fn(),
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
  governanceAccessApi: {
    listOAuthGrants: api.listOAuthGrants,
    previewOAuthGrantRevocation: api.previewOAuthGrantRevocation,
    revokeOAuthGrant: api.revokeOAuthGrant,
  },
}));

import {
  connectAliyun,
  connectGithub,
  connectX,
  disconnectAliyun,
  disconnectGithub,
  disconnectGoogleWorkspace,
  disconnectX,
} from './connectorsApi';

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
      scopeSummary: { scopes: ['x:*'] },
    });
    expect(api.rotateCredential).toHaveBeenCalledWith('credential-x', {
      expectedVersion: 3,
      secret: JSON.stringify({ authToken: 'auth-cookie', ct0: 'ct0-cookie' }),
      reason: '更新 X bird CLI 用户凭据',
      scopeSummary: { scopes: ['x:*'] },
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

  it('断开 X 会重试已落为 revoked 的 Credential 清理', async () => {
    api.listCredentials.mockResolvedValueOnce({ credentials: [
      { credentialId: 'credential-retry', connectorId: 'x', kind: 'personal_grant', status: 'revoked', version: 6 },
      { credentialId: 'other', connectorId: 'github', kind: 'personal_grant', status: 'revoked', version: 1 },
    ] });
    api.authFetch.mockResolvedValueOnce(jsonResponse(disconnected));

    await expect(disconnectX()).resolves.toEqual(disconnected);
    expect(api.previewCredentialRevoke).toHaveBeenCalledWith('credential-retry', {
      expectedVersion: 6, reason: '用户主动断开 X',
    });
    expect(api.revokeCredential).toHaveBeenCalledWith('credential-retry', expect.objectContaining({
      expectedVersion: 6, reason: '用户主动断开 X',
    }));
  });

  it('GitHub 连接和断开只操作 personal_grant 治理凭据', async () => {
    api.authFetch.mockResolvedValueOnce(jsonResponse({
      connection: { connectorId: 'github', status: 'connected', runtimeEnabled: true, credentialId: 'credential-github' },
    }));
    await expect(connectGithub({ token: ' github_pat_test ' })).resolves.toMatchObject({
      connection: { connectorId: 'github', status: 'connected' },
    });
    expect(api.createCredential).toHaveBeenCalledWith({
      connectorId: 'github', kind: 'personal_grant', purpose: 'GitHub CLI 用户凭据',
      scopeSummary: { scopes: ['github:*'] }, secret: 'github_pat_test',
    });
    expect(api.authFetch).not.toHaveBeenCalledWith('/api/connectors/github', expect.objectContaining({ method: 'POST' }));

    api.listCredentials.mockResolvedValueOnce({ credentials: [
      { credentialId: 'credential-github', connectorId: 'github', kind: 'personal_grant', status: 'active', version: 2 },
    ] });
    api.authFetch.mockResolvedValueOnce(jsonResponse({
      connection: { connectorId: 'github', status: 'disconnected', runtimeEnabled: true },
    }));
    await expect(disconnectGithub()).resolves.toMatchObject({
      connection: { connectorId: 'github', status: 'disconnected' },
    });
    expect(api.authFetch).not.toHaveBeenCalledWith('/api/connectors/github', { method: 'DELETE' });
  });

  it('Google Workspace 断开通过 OAuth Grant 撤销，而不是已封闭的旧 Connector 写入口', async () => {
    api.listOAuthGrants.mockResolvedValueOnce({ grants: [{
      grantId: 'grant-google', provider: 'google', connectorId: 'google-workspace', status: 'active',
    }] });
    api.previewOAuthGrantRevocation.mockResolvedValueOnce({
      previewId: 'ogpv1.google-preview', baselineDigest: 'google-baseline', expiresAt: '2026-08-20T10:05:00.000Z',
      impact: { blockers: [] },
    });
    api.revokeOAuthGrant.mockResolvedValueOnce({ grantId: 'grant-google', status: 'revoked', version: 2 });
    const result = {
      connection: { connectorId: 'google-workspace', status: 'disconnected', runtimeEnabled: true }, available: true,
    };
    api.authFetch.mockResolvedValueOnce(jsonResponse(result));

    await expect(disconnectGoogleWorkspace()).resolves.toEqual(result);
    expect(api.previewOAuthGrantRevocation).toHaveBeenCalledWith('grant-google', '用户主动断开 Google Workspace');
    expect(api.revokeOAuthGrant).toHaveBeenCalledWith('grant-google', {
      reason: '用户主动断开 Google Workspace',
      previewId: 'ogpv1.google-preview', baselineDigest: 'google-baseline', expiresAt: '2026-08-20T10:05:00.000Z',
    });
    expect(api.authFetch).not.toHaveBeenCalledWith('/api/connectors/google-workspace', { method: 'DELETE' });
  });

  it('阿里云连接把 AccessKey 写入治理凭据并保留地域元数据', async () => {
    api.authFetch.mockResolvedValueOnce(jsonResponse({
      connection: { connectorId: 'aliyun', status: 'connected', runtimeEnabled: true, regionId: 'cn-shenzhen' },
    }));
    await expect(connectAliyun({
      accessKeyId: ' LTAI-test ', accessKeySecret: ' secret-test ', regionId: ' cn-shenzhen ',
    })).resolves.toMatchObject({
      connection: { connectorId: 'aliyun', status: 'connected' },
    });
    expect(api.createCredential).toHaveBeenCalledWith({
      connectorId: 'aliyun', kind: 'personal_grant', purpose: '阿里云 CLI 用户凭据',
      scopeSummary: { regionId: 'cn-shenzhen', scopes: ['aliyun:*'] },
      secret: JSON.stringify({ accessKeyId: 'LTAI-test', accessKeySecret: 'secret-test', regionId: 'cn-shenzhen' }),
    });
    expect(api.authFetch).not.toHaveBeenCalledWith('/api/connectors/aliyun', expect.objectContaining({ method: 'POST' }));

    api.listCredentials.mockResolvedValueOnce({ credentials: [
      { credentialId: 'credential-aliyun', connectorId: 'aliyun', kind: 'personal_grant', status: 'active', version: 1 },
    ] });
    api.authFetch.mockResolvedValueOnce(jsonResponse({
      connection: { connectorId: 'aliyun', status: 'disconnected', runtimeEnabled: true },
    }));
    await expect(disconnectAliyun()).resolves.toMatchObject({
      connection: { connectorId: 'aliyun', status: 'disconnected' },
    });
    expect(api.authFetch).not.toHaveBeenCalledWith('/api/connectors/aliyun', { method: 'DELETE' });
  });

  it('阿里云跨地域轮换把新的 scopeSummary 一起提交治理 API', async () => {
    api.listCredentials.mockResolvedValueOnce({ credentials: [{
      credentialId: 'credential-aliyun', connectorId: 'aliyun', kind: 'personal_grant',
      status: 'active', version: 4, updatedAt: '2026-08-20T10:00:00.000Z',
    }] });
    api.previewCredentialRotation.mockResolvedValue({
      previewId: 'cpv2.aliyun-preview', baselineDigest: 'aliyun-baseline', expiresAt: '2026-08-20T10:05:00.000Z',
    });
    api.rotateCredential.mockResolvedValue({ credentialId: 'credential-aliyun', version: 5 });
    api.authFetch.mockResolvedValueOnce(jsonResponse({
      connection: { connectorId: 'aliyun', status: 'connected', runtimeEnabled: true, regionId: 'cn-hangzhou', credentialVersion: 5 },
    }));

    await expect(connectAliyun({
      accessKeyId: 'LTAI-new', accessKeySecret: 'secret-new', regionId: 'cn-hangzhou',
    })).resolves.toMatchObject({ connection: { regionId: 'cn-hangzhou', credentialVersion: 5 } });

    const command = {
      expectedVersion: 4,
      secret: JSON.stringify({ accessKeyId: 'LTAI-new', accessKeySecret: 'secret-new', regionId: 'cn-hangzhou' }),
      reason: '更新阿里云 CLI 用户凭据',
      scopeSummary: { regionId: 'cn-hangzhou', scopes: ['aliyun:*'] },
    };
    expect(api.previewCredentialRotation).toHaveBeenCalledWith('credential-aliyun', command);
    expect(api.rotateCredential).toHaveBeenCalledWith('credential-aliyun', {
      ...command, previewId: 'cpv2.aliyun-preview', baselineDigest: 'aliyun-baseline', expiresAt: '2026-08-20T10:05:00.000Z',
    });
  });

  it('拒绝空白 X Cookie，不创建无效治理凭据', async () => {
    await expect(connectX({ authToken: ' ', ct0: 'ct0-cookie' })).rejects.toThrow('X 连接凭据不能为空');
    expect(api.createCredential).not.toHaveBeenCalled();
    expect(api.listCredentials).not.toHaveBeenCalled();
  });
});
