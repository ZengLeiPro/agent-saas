import type { Server } from 'node:http';
import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { GovernanceCredential } from '../data/credentials/types.js';
import { registerGovernanceCredentialRoutes } from '../routes/governanceCredentialRoutes.js';

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
});

const NOW = '2026-08-14T03:00:00.000Z';
const credential = (overrides: Record<string, unknown> = {}) => ({
  credentialId: 'cred-1', tenantId: 'tenant-a', connectorId: 'github', kind: 'org_shared',
  custodianUserId: 'admin-1', purpose: 'shared automation', scopeSummary: {}, status: 'active',
  generation: 1, secretRef: 'vault-ref-hidden', source: 'governance', version: 1,
  createdAt: NOW, createdBy: 'admin-1', updatedAt: NOW, updatedBy: 'admin-1', ...overrides,
});

function json(body: unknown): RequestInit {
  return { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

async function rig(input: {
  create?: ReturnType<typeof vi.fn>;
  completeRotation?: ReturnType<typeof vi.fn>;
  transferCustodian?: ReturnType<typeof vi.fn>;
  getCredential?: ReturnType<typeof vi.fn>;
  getBySecretRef?: ReturnType<typeof vi.fn>;
  putSecret?: ReturnType<typeof vi.fn>;
  rotateSecret?: ReturnType<typeof vi.fn>;
  revokeSecret?: ReturnType<typeof vi.fn>;
  updateStatus?: ReturnType<typeof vi.fn>;
  finishCommit?: ReturnType<typeof vi.fn>;
  claimCommit?: ReturnType<typeof vi.fn>;
  recordCommitProgress?: ReturnType<typeof vi.fn>;
  credentialHealthCheck?: (connectorId: string, secret: string) => Promise<{ healthy: boolean; code: string; metadata?: Record<string, string> }>;
  onPersonalCredentialRevoked?: (input: { credential: GovernanceCredential; actorUserId: string }) => Promise<void>;
  now?: () => Date;
} = {}) {
  const commits = new Map<string, { identity: string; status: string; leaseToken: string; credentialId?: string; recovery?: Record<string, unknown> }>();
  const defaultClaimCommit = vi.fn(async (value: Record<string, unknown>) => {
    const key = `${value.tenantId}:${value.operation}:${value.idempotencyKey}`;
    const identity = JSON.stringify([value.nonceDigest, value.requestDigest, value.targetId, value.actorUserId]);
    const current = commits.get(key);
    if (!current && value.existingOnly) return { state: 'missing' };
    if (!current) {
      const leaseToken = `lease-${commits.size + 1}`;
      commits.set(key, { identity, status: 'running', leaseToken });
      return { state: 'acquired', leaseToken };
    }
    if (current.identity !== identity) return { state: 'conflict' };
    if (current.status === 'running') return { state: 'in_progress', retryAfterMs: 30_000 };
    if (current.status === 'succeeded') return { state: 'replayed', credentialId: current.credentialId };
    return { state: 'terminal', status: current.status };
  });
  const claimCommit = input.claimCommit ?? defaultClaimCommit;
  const defaultFinishCommit = vi.fn(async (value: Record<string, unknown>) => {
    const key = `${value.tenantId}:${value.operation}:${value.idempotencyKey}`;
    const current = commits.get(key);
    if (!current || current.status !== 'running' || current.leaseToken !== value.leaseToken) throw new Error('commit conflict');
    commits.set(key, { ...current, status: String(value.status), ...(value.credentialId ? { credentialId: String(value.credentialId) } : {}) });
  });
  const finishCommit = input.finishCommit ?? defaultFinishCommit;
  const defaultRecordCommitProgress = vi.fn(async (value: Record<string, unknown>) => {
    const key = `${value.tenantId}:${value.operation}:${value.idempotencyKey}`;
    const current = commits.get(key);
    if (!current || current.leaseToken !== value.leaseToken) throw new Error('commit lease lost');
    current.recovery = value.progress as Record<string, unknown>;
  });
  const recordCommitProgress = input.recordCommitProgress ?? defaultRecordCommitProgress;
  const create = input.create ?? vi.fn().mockResolvedValue(credential());
  const completeRotation = input.completeRotation ?? vi.fn().mockResolvedValue(credential({ generation: 2, version: 2 }));
  const transferCustodian = input.transferCustodian ?? vi.fn().mockResolvedValue(credential({ custodianUserId: 'member-2', version: 2 }));
  const getCredential = input.getCredential ?? vi.fn().mockResolvedValue(credential());
  const putSecret = input.putSecret ?? vi.fn().mockResolvedValue({ id: 'vault-ref-new' });
  const rotateSecret = input.rotateSecret ?? vi.fn().mockResolvedValue({ id: 'vault-ref-hidden' });
  const revokeSecret = input.revokeSecret ?? vi.fn().mockResolvedValue(undefined);
  const updateStatus = input.updateStatus ?? vi.fn().mockResolvedValue(credential({ status: 'revoked', generation: 2, version: 2 }));
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.user = { sub: 'admin-1', username: 'admin', tenantId: 'tenant-a', role: 'admin' };
    res.locals.governanceChangeId = 'audit-intent-1';
    next();
  });
  const router = express.Router();
  registerGovernanceCredentialRoutes({
    router,
    connectors: { get: vi.fn().mockResolvedValue({ connectorId: 'github', status: 'published', version: 3 }) } as never,
    credentials: {
      create, get: getCredential, getBySecretRef: input.getBySecretRef ?? vi.fn().mockResolvedValue(null),
      claimCommit, recordCommitProgress, finishCommit, completeRotation, transferCustodian,
      updateStatus, recordValidation: vi.fn(),
    } as never,
    memberships: { getMembership: vi.fn(async (tenantId: string, userId: string) => (
      tenantId === 'tenant-a' && ['admin-1', 'member-2'].includes(userId)
        ? { tenantId, userId, status: 'active', persona: userId === 'admin-1' ? 'org_admin' : 'member', version: 4 }
        : null
    )) } as never,
    changeJobs: { findActiveForTarget: vi.fn().mockResolvedValue(null) } as never,
    vault: {
      putSecret, revokeSecret, rotateSecret,
      getSecret: vi.fn().mockResolvedValue('previous-secret-sensitive'),
    } as never,
    previewSecret: 'credential-preview-secret-at-least-32-characters',
    now: input.now ?? (() => new Date(NOW)),
    personaFor: () => 'org_admin',
    canManageOrganization: () => true,
    resourceTenantFor: (req, requested) => !requested || requested === req.user!.tenantId ? req.user!.tenantId : null,
    ...(input.credentialHealthCheck ? { credentialHealthCheck: input.credentialHealthCheck } : {}),
    ...(input.onPersonalCredentialRevoked ? { onPersonalCredentialRevoked: input.onPersonalCredentialRevoked } : {}),
  });
  app.use('/api/governance/resources', router);
  const server: Server = await new Promise(resolve => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  servers.push(server);
  const address = server.address();
  const base = typeof address === 'object' && address ? `http://127.0.0.1:${address.port}` : '';
  return {
    request: (path: string, init?: RequestInit) => fetch(`${base}${path}`, init),
    create, completeRotation, transferCustodian, getCredential, putSecret, rotateSecret, revokeSecret,
    claimCommit, recordCommitProgress, finishCommit, updateStatus,
  };
}

async function preview(test: Awaited<ReturnType<typeof rig>>, path: string, body: Record<string, unknown>) {
  const response = await test.request(path, json(body));
  expect(response.status).toBe(200);
  return await response.json() as Record<string, unknown>;
}

describe('governance credential signed commits', () => {
  it('阿里云个人 Credential 在写入 Vault 前执行 STS 验证', async () => {
    const health = vi.fn().mockResolvedValue({ healthy: false, code: 'UPSTREAM_IDENTITY_CHECK_FAILED' });
    const putSecret = vi.fn();
    const test = await rig({ credentialHealthCheck: health, putSecret });
    const secret = JSON.stringify({ accessKeyId: 'LTAI-invalid', accessKeySecret: 'invalid', regionId: 'cn-shenzhen' });
    const response = await test.request('/api/governance/resources/credentials', json({
      connectorId: 'aliyun', kind: 'personal_grant', purpose: '阿里云 CLI 用户凭据',
      scopeSummary: { regionId: 'cn-shenzhen', scopes: ['aliyun:*'] }, secret,
    }));
    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toEqual({ error: 'Credential validation failed', code: 'UPSTREAM_IDENTITY_CHECK_FAILED' });
    expect(health).toHaveBeenCalledWith('aliyun', secret);
    expect(putSecret).not.toHaveBeenCalled();
  });
  it('无效 X Cookie 不会创建治理 Credential 或写入 Vault', async () => {
    const health = vi.fn().mockResolvedValue({ healthy: false, code: 'CREDENTIAL_AUTHENTICATION_FAILED' });
    const putSecret = vi.fn();
    const create = vi.fn();
    const test = await rig({ credentialHealthCheck: health, putSecret, create });
    const secret = JSON.stringify({ authToken: 'invalid-auth', ct0: 'invalid-ct0' });
    const response = await test.request('/api/governance/resources/credentials', json({
      connectorId: 'x', kind: 'personal_grant', purpose: 'X bird CLI 用户凭据', secret,
    }));
    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toEqual({ error: 'Credential validation failed', code: 'CREDENTIAL_AUTHENTICATION_FAILED' });
    expect(health).toHaveBeenCalledWith('x', secret);
    expect(putSecret).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });
  it('阿里云 STS 身份元数据写入治理 scopeSummary 供连接状态展示', async () => {
    const health = vi.fn().mockResolvedValue({
      healthy: true, code: 'UPSTREAM_IDENTITY_VERIFIED',
      metadata: { accountId: '1234567890123456', identityArn: 'acs:ram::1234567890123456:user/agent-saas', identityType: 'RAMUser' },
    });
    const create = vi.fn().mockResolvedValue(credential({ connectorId: 'aliyun', kind: 'personal_grant', ownerUserId: 'admin-1' }));
    const test = await rig({ credentialHealthCheck: health, create });
    const secret = JSON.stringify({ accessKeyId: 'LTAI-valid', accessKeySecret: 'valid', regionId: 'cn-shenzhen' });
    const response = await test.request('/api/governance/resources/credentials', json({
      connectorId: 'aliyun', kind: 'personal_grant', purpose: '阿里云 CLI 用户凭据',
      scopeSummary: { regionId: 'cn-shenzhen', scopes: ['aliyun:*'] }, secret,
    }));

    expect(response.status).toBe(201);
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      scopeSummary: {
        regionId: 'cn-shenzhen', scopes: ['aliyun:*'], accountId: '1234567890123456',
        identityArn: 'acs:ram::1234567890123456:user/agent-saas', identityType: 'RAMUser',
      },
    }));
  });

  it('阿里云个人 Credential rotation 在写入新 Secret 前执行 STS 验证', async () => {
    const health = vi.fn().mockResolvedValue({ healthy: false, code: 'UPSTREAM_IDENTITY_CHECK_FAILED' });
    const rotateSecret = vi.fn();
    const test = await rig({
      credentialHealthCheck: health,
      getCredential: vi.fn().mockResolvedValue(credential({ connectorId: 'aliyun', kind: 'personal_grant', ownerUserId: 'admin-1' })),
      rotateSecret,
    });
    const command = {
      expectedVersion: 1,
      secret: JSON.stringify({ accessKeyId: 'LTAI-invalid', accessKeySecret: 'invalid', regionId: 'cn-shenzhen' }),
      reason: '更新阿里云 CLI 用户凭据',
    };
    const signed = await preview(test, '/api/governance/resources/credentials/cred-1/rotate/preview', command);
    const response = await test.request('/api/governance/resources/credentials/cred-1/rotate', json({
      ...command, previewId: signed.previewId, baselineDigest: signed.baselineDigest, expiresAt: signed.expiresAt,
    }));

    expect(response.status).toBe(422);
    expect(health).toHaveBeenCalledWith('aliyun', command.secret);
    expect(rotateSecret).not.toHaveBeenCalled();
  });
  it('无效 X Cookie 不会轮换或激活治理 Credential', async () => {
    const health = vi.fn().mockResolvedValue({ healthy: false, code: 'CREDENTIAL_AUTHENTICATION_FAILED' });
    const rotateSecret = vi.fn();
    const completeRotation = vi.fn();
    const test = await rig({
      credentialHealthCheck: health,
      getCredential: vi.fn().mockResolvedValue(credential({ connectorId: 'x', kind: 'personal_grant', ownerUserId: 'admin-1' })),
      rotateSecret,
      completeRotation,
    });
    const command = { expectedVersion: 1, secret: JSON.stringify({ authToken: 'invalid-auth', ct0: 'invalid-ct0' }), reason: '更新 X bird CLI 用户凭据' };
    const signed = await preview(test, '/api/governance/resources/credentials/cred-1/rotate/preview', command);
    const response = await test.request('/api/governance/resources/credentials/cred-1/rotate', json({
      ...command, previewId: signed.previewId, baselineDigest: signed.baselineDigest, expiresAt: signed.expiresAt,
    }));
    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toEqual({ error: 'Credential validation failed', code: 'CREDENTIAL_AUTHENTICATION_FAILED' });
    expect(health).toHaveBeenCalledWith('x', command.secret);
    expect(rotateSecret).not.toHaveBeenCalled();
    expect(completeRotation).not.toHaveBeenCalled();
  });
  it('阿里云跨地域跨账号 rotation 原子持久化新 scopeSummary', async () => {
    const personal = credential({
      connectorId: 'aliyun', kind: 'personal_grant', ownerUserId: 'admin-1', custodianUserId: undefined,
      purpose: '阿里云 CLI 用户凭据', scopeSummary: {
        regionId: 'cn-shenzhen', accountId: 'old-account', identityType: 'RAMUser', scopes: ['aliyun:*'],
      },
    });
    const health = vi.fn().mockResolvedValue({
      healthy: true, code: 'UPSTREAM_IDENTITY_VERIFIED',
      metadata: {
        regionId: 'cn-hangzhou', accountId: 'new-account',
        identityArn: 'acs:ram::new-account:user/agent-saas', identityType: 'RAMUser',
      },
    });
    const nextScopeSummary = {
      regionId: 'cn-hangzhou', accountId: 'new-account',
      identityArn: 'acs:ram::new-account:user/agent-saas', identityType: 'RAMUser', scopes: ['aliyun:*'],
    };
    const completeRotation = vi.fn().mockResolvedValue(credential({
      ...personal, generation: 2, version: 2, scopeSummary: nextScopeSummary,
    }));
    const test = await rig({
      credentialHealthCheck: health,
      getCredential: vi.fn().mockResolvedValue(personal),
      completeRotation,
    });
    const command = {
      expectedVersion: 1,
      secret: JSON.stringify({ accessKeyId: 'LTAI-new', accessKeySecret: 'new-secret', regionId: 'cn-hangzhou' }),
      reason: '更新阿里云 CLI 用户凭据', scopeSummary: { regionId: 'cn-hangzhou', scopes: ['aliyun:*'] },
    };
    const signed = await preview(test, '/api/governance/resources/credentials/cred-1/rotate/preview', command);
    const response = await test.request('/api/governance/resources/credentials/cred-1/rotate', json({
      ...command, previewId: signed.previewId, baselineDigest: signed.baselineDigest, expiresAt: signed.expiresAt,
    }));

    expect(response.status).toBe(200);
    expect(health).toHaveBeenCalledWith('aliyun', command.secret);
    expect(completeRotation).toHaveBeenCalledWith('tenant-a', 'cred-1', 1, 'admin-1', false, nextScopeSummary);
    await expect(response.json()).resolves.toMatchObject({ scopeSummary: nextScopeSummary });
  });

  it('阿里云 scopeSummary 持久化失败时回滚 Secret，不报告轮换成功', async () => {
    const personal = credential({
      connectorId: 'aliyun', kind: 'personal_grant', ownerUserId: 'admin-1', custodianUserId: undefined,
      purpose: '阿里云 CLI 用户凭据', scopeSummary: { regionId: 'cn-shenzhen', accountId: 'old-account' },
    });
    const health = vi.fn().mockResolvedValue({
      healthy: true, code: 'UPSTREAM_IDENTITY_VERIFIED',
      metadata: { regionId: 'cn-hangzhou', accountId: 'new-account', identityType: 'RAMUser' },
    });
    const rotateSecret = vi.fn().mockResolvedValueOnce(undefined).mockResolvedValueOnce(undefined);
    const completeRotation = vi.fn().mockRejectedValue(new Error('credential version conflict'));
    const test = await rig({
      credentialHealthCheck: health,
      getCredential: vi.fn().mockResolvedValue(personal), rotateSecret, completeRotation,
    });
    const command = {
      expectedVersion: 1,
      secret: JSON.stringify({ accessKeyId: 'LTAI-new', accessKeySecret: 'new-secret-never-echo', regionId: 'cn-hangzhou' }),
      reason: '更新阿里云 CLI 用户凭据', scopeSummary: { regionId: 'cn-hangzhou', scopes: ['aliyun:*'] },
    };
    const signed = await preview(test, '/api/governance/resources/credentials/cred-1/rotate/preview', command);
    const response = await test.request('/api/governance/resources/credentials/cred-1/rotate', json({
      ...command, previewId: signed.previewId, baselineDigest: signed.baselineDigest, expiresAt: signed.expiresAt,
    }));

    expect(response.status).toBe(409);
    const body = await response.json() as Record<string, unknown>;
    expect(body).toMatchObject({ code: 'CREDENTIAL_ROTATE_COMPENSATED', status: 'failed' });
    expect(JSON.stringify(body)).not.toContain('new-secret-never-echo');
    expect(rotateSecret).toHaveBeenCalledTimes(2);
    expect(completeRotation).toHaveBeenCalledOnce();
  });

  it('个人 Credential 所有者可以使用治理 rotation 更新 X Cookie', async () => {
    const personal = credential({
      connectorId: 'x', kind: 'personal_grant', ownerUserId: 'admin-1', custodianUserId: undefined,
      purpose: 'X bird CLI 用户凭据',
    });
    const getCredential = vi.fn().mockResolvedValue(personal);
    const completeRotation = vi.fn().mockResolvedValue({ ...personal, status: 'active', generation: 2, version: 2 });
    const test = await rig({ getCredential, completeRotation });
    const command = {
      expectedVersion: 1, secret: JSON.stringify({ authToken: 'new-auth', ct0: 'new-ct0' }),
      reason: '更新 X bird CLI 用户凭据',
    };
    const signed = await preview(test, '/api/governance/resources/credentials/cred-1/rotate/preview', command);
    const response = await test.request('/api/governance/resources/credentials/cred-1/rotate', json({
      ...command, previewId: signed.previewId, baselineDigest: signed.baselineDigest, expiresAt: signed.expiresAt,
    }));

    expect(response.status).toBe(200);
    expect(test.rotateSecret).toHaveBeenCalledWith('vault-ref-hidden', command.secret, expect.objectContaining({
      userId: 'admin-1', tenantId: 'tenant-a',
    }));
    expect(completeRotation).toHaveBeenCalledWith('tenant-a', 'cred-1', 1, 'admin-1', false);
  });

  it('个人 X Credential 撤销后触发旧连接器凭据清理回调', async () => {
    const personal = credential({
      connectorId: 'x', kind: 'personal_grant', ownerUserId: 'admin-1', custodianUserId: undefined,
      secretRef: 'governance-secret',
    });
    const getCredential = vi.fn().mockResolvedValue(personal);
    const updateStatus = vi.fn().mockResolvedValue({ ...personal, status: 'revoked', generation: 2, version: 2 });
    const onPersonalCredentialRevoked = vi.fn<(input: { credential: GovernanceCredential; actorUserId: string }) => Promise<void>>().mockResolvedValue(undefined);
    const test = await rig({ getCredential, updateStatus, onPersonalCredentialRevoked });

    const signed = await preview(test, '/api/governance/resources/credentials/cred-1/revoke/preview', {
      expectedVersion: 1, reason: '用户主动断开 X',
    });
    const response = await test.request('/api/governance/resources/credentials/cred-1/revoke', json({
      expectedVersion: 1, reason: '用户主动断开 X',
      previewId: signed.previewId, baselineDigest: signed.baselineDigest, expiresAt: signed.expiresAt,
    }));

    expect(response.status).toBe(200);
    expect(onPersonalCredentialRevoked).toHaveBeenCalledWith({
      credential: personal, actorUserId: 'admin-1',
    });
    expect(test.revokeSecret).toHaveBeenCalledWith('governance-secret', expect.any(Object));
    expect(updateStatus).toHaveBeenCalledOnce();
  });

  it('Vault 撤销失败时保持 Credential 可重试，成功重试后才写入 revoked', async () => {
    const personal = credential({
      connectorId: 'x', kind: 'personal_grant', ownerUserId: 'admin-1', custodianUserId: undefined,
      secretRef: 'governance-secret',
    });
    const getCredential = vi.fn().mockResolvedValue(personal);
    const updateStatus = vi.fn().mockResolvedValue({ ...personal, status: 'revoked', generation: 2, version: 2 });
    const revokeSecret = vi.fn()
      .mockRejectedValueOnce(new Error('vault unavailable'))
      .mockResolvedValue(undefined);
    const test = await rig({ getCredential, updateStatus, revokeSecret });
    const command = { expectedVersion: 1, reason: '用户主动断开 X' };

    const firstPreview = await preview(test, '/api/governance/resources/credentials/cred-1/revoke/preview', command);
    const first = await test.request('/api/governance/resources/credentials/cred-1/revoke', json({
      ...command, previewId: firstPreview.previewId, baselineDigest: firstPreview.baselineDigest, expiresAt: firstPreview.expiresAt,
    }));
    expect(first.status).toBe(503);
    await expect(first.json()).resolves.toMatchObject({ code: 'CREDENTIAL_VAULT_REVOKE_FAILED', retryable: true });
    expect(updateStatus).not.toHaveBeenCalled();

    const secondPreview = await preview(test, '/api/governance/resources/credentials/cred-1/revoke/preview', command);
    const second = await test.request('/api/governance/resources/credentials/cred-1/revoke', json({
      ...command, previewId: secondPreview.previewId, baselineDigest: secondPreview.baselineDigest, expiresAt: secondPreview.expiresAt,
    }));
    expect(second.status).toBe(200);
    expect(updateStatus).toHaveBeenCalledOnce();
    expect(revokeSecret).toHaveBeenCalledTimes(2);
  });

  it('旧连接器清理失败时保持 Credential 可重试，重试可收口治理撤销', async () => {
    const personal = credential({
      connectorId: 'x', kind: 'personal_grant', ownerUserId: 'admin-1', custodianUserId: undefined,
      secretRef: 'governance-secret',
    });
    const getCredential = vi.fn().mockResolvedValue(personal);
    const updateStatus = vi.fn().mockResolvedValue({ ...personal, status: 'revoked', generation: 2, version: 2 });
    const onPersonalCredentialRevoked = vi.fn<(input: { credential: GovernanceCredential; actorUserId: string }) => Promise<void>>()
      .mockRejectedValueOnce(new Error('legacy cleanup unavailable'))
      .mockResolvedValue(undefined);
    const test = await rig({ getCredential, updateStatus, onPersonalCredentialRevoked });
    const command = { expectedVersion: 1, reason: '用户主动断开 X' };

    const firstPreview = await preview(test, '/api/governance/resources/credentials/cred-1/revoke/preview', command);
    const first = await test.request('/api/governance/resources/credentials/cred-1/revoke', json({
      ...command, previewId: firstPreview.previewId, baselineDigest: firstPreview.baselineDigest, expiresAt: firstPreview.expiresAt,
    }));
    expect(first.status).toBe(503);
    await expect(first.json()).resolves.toMatchObject({ code: 'CREDENTIAL_LEGACY_CLEANUP_FAILED', retryable: true, changed: true });
    expect(updateStatus).not.toHaveBeenCalled();

    const secondPreview = await preview(test, '/api/governance/resources/credentials/cred-1/revoke/preview', command);
    const second = await test.request('/api/governance/resources/credentials/cred-1/revoke', json({
      ...command, previewId: secondPreview.previewId, baselineDigest: secondPreview.baselineDigest, expiresAt: secondPreview.expiresAt,
    }));
    expect(second.status).toBe(200);
    expect(updateStatus).toHaveBeenCalledOnce();
    expect(onPersonalCredentialRevoked).toHaveBeenCalledTimes(2);
  });

  it('已落为 revoked 的 Credential 仍可签名重试清理且不重复写状态', async () => {
    const personal = credential({
      connectorId: 'x', kind: 'personal_grant', ownerUserId: 'admin-1', custodianUserId: undefined,
      secretRef: 'governance-secret', status: 'revoked', generation: 2, version: 2,
    });
    const getCredential = vi.fn().mockResolvedValue(personal);
    const updateStatus = vi.fn();
    const onPersonalCredentialRevoked = vi.fn<(input: { credential: GovernanceCredential; actorUserId: string }) => Promise<void>>().mockResolvedValue(undefined);
    const test = await rig({ getCredential, updateStatus, onPersonalCredentialRevoked });
    const command = { expectedVersion: 2, reason: '补偿 X 旧凭据清理' };
    const signed = await preview(test, '/api/governance/resources/credentials/cred-1/revoke/preview', command);
    expect(signed.impact).toMatchObject({ cleanupRetry: true, currentVersion: 2, nextVersion: 2 });
    const response = await test.request('/api/governance/resources/credentials/cred-1/revoke', json({
      ...command, previewId: signed.previewId, baselineDigest: signed.baselineDigest, expiresAt: signed.expiresAt,
    }));

    expect(response.status).toBe(200);
    expect(updateStatus).not.toHaveBeenCalled();
    expect(onPersonalCredentialRevoked).toHaveBeenCalledOnce();
  });

  it('过期但仍 active 的 Credential rotation 会清除旧 expiresAt', async () => {
    const expired = credential({
      connectorId: 'x', kind: 'personal_grant', ownerUserId: 'admin-1', custodianUserId: undefined,
      purpose: 'X bird CLI 用户凭据', expiresAt: '2026-08-13T03:00:00.000Z',
    });
    const getCredential = vi.fn().mockResolvedValue(expired);
    const completeRotation = vi.fn().mockResolvedValue({
      ...expired, status: 'active', generation: 2, version: 2, expiresAt: undefined,
    });
    const test = await rig({ getCredential, completeRotation });
    const command = {
      expectedVersion: 1, secret: JSON.stringify({ authToken: 'new-auth', ct0: 'new-ct0' }),
      reason: '更新 X bird CLI 用户凭据',
    };
    const signed = await preview(test, '/api/governance/resources/credentials/cred-1/rotate/preview', command);
    const response = await test.request('/api/governance/resources/credentials/cred-1/rotate', json({
      ...command, previewId: signed.previewId, baselineDigest: signed.baselineDigest, expiresAt: signed.expiresAt,
    }));

    expect(response.status).toBe(200);
    expect(completeRotation).toHaveBeenCalledWith('tenant-a', 'cred-1', 1, 'admin-1', true);
    await expect(response.json()).resolves.not.toHaveProperty('expiresAt');
  });

  it('并发创建只执行一次，完成后同一 preview 重放被拒绝', async () => {
    let releaseCreate!: () => void;
    const createStarted = new Promise<void>(resolve => { releaseCreate = resolve; });
    let allowCreate!: () => void;
    const createGate = new Promise<void>(resolve => { allowCreate = resolve; });
    const create = vi.fn(async () => {
      releaseCreate();
      await createGate;
      return credential();
    });
    const test = await rig({ create });
    const command = { connectorId: 'github', kind: 'org_shared', purpose: 'shared automation', secret: 'never-echo-this-secret', reason: 'initial shared setup' };
    const signed = await preview(test, '/api/governance/resources/credentials/preview', command);
    expect(signed.previewId).toMatch(/^cpv2\.[0-9a-f-]{36}\.[0-9a-f-]{36}\.[a-f0-9]{64}$/);
    const commit = { ...command, previewId: signed.previewId, baselineDigest: signed.baselineDigest, expiresAt: signed.expiresAt };

    const firstPromise = test.request('/api/governance/resources/credentials', json(commit));
    await createStarted;
    const concurrent = await test.request('/api/governance/resources/credentials', json(commit));
    expect(concurrent.status).toBe(409);
    await expect(concurrent.json()).resolves.toMatchObject({ code: 'CREDENTIAL_COMMIT_IN_PROGRESS' });
    allowCreate();
    expect((await firstPromise).status).toBe(201);

    const replay = await test.request('/api/governance/resources/credentials', json(commit));
    expect(replay.status).toBe(409);
    await expect(replay.json()).resolves.toMatchObject({ code: 'GOVERNANCE_PREVIEW_REPLAYED' });
    expect(test.create).toHaveBeenCalledOnce();
    expect(test.putSecret).toHaveBeenCalledOnce();
  });

  it('创建持久化失败且 vault 补偿失败时返回 compensation_failed，且不回显 Secret', async () => {
    const test = await rig({
      create: vi.fn().mockRejectedValue(new Error('database write failed')),
      revokeSecret: vi.fn().mockRejectedValue(new Error('vault revoke failed')),
    });
    const command = { connectorId: 'github', kind: 'org_shared', purpose: 'shared automation', secret: 'never-echo-this-secret', reason: 'initial shared setup' };
    const signed = await preview(test, '/api/governance/resources/credentials/preview', command);
    const response = await test.request('/api/governance/resources/credentials', json({
      ...command, previewId: signed.previewId, baselineDigest: signed.baselineDigest, expiresAt: signed.expiresAt,
    }));
    expect(response.status).toBe(500);
    const body = await response.json() as Record<string, unknown>;
    expect(body).toMatchObject({ code: 'CREDENTIAL_CREATE_COMPENSATION_FAILED', status: 'compensation_failed', partial: true, changed: true });
    expect(JSON.stringify(body)).not.toContain('never-echo-this-secret');
    expect(JSON.stringify(body)).not.toContain('vault-ref-new');
    expect(test.finishCommit).toHaveBeenCalledWith(expect.objectContaining({ status: 'compensation_failed', errorCode: 'CREDENTIAL_CREATE_COMPENSATION_FAILED' }));
  });

  it('补偿失败后的 ledger 终态写入失败升级为 critical diagnostic，且不泄漏内部线索', async () => {
    const test = await rig({
      create: vi.fn().mockRejectedValue(new Error('database write failed')),
      revokeSecret: vi.fn().mockRejectedValue(new Error('vault revoke failed')),
      finishCommit: vi.fn().mockRejectedValue(new Error('ledger unavailable vault-ref-must-not-echo')),
    });
    const command = { connectorId: 'github', kind: 'org_shared', purpose: 'shared automation', secret: 'client-secret-must-not-echo', reason: 'initial shared setup' };
    const signed = await preview(test, '/api/governance/resources/credentials/preview', command);
    const response = await test.request('/api/governance/resources/credentials', json({
      ...command, previewId: signed.previewId, baselineDigest: signed.baselineDigest, expiresAt: signed.expiresAt,
    }));
    expect(response.status).toBe(503);
    const body = await response.json() as Record<string, unknown>;
    expect(body).toMatchObject({
      code: 'CREDENTIAL_CREATE_LEDGER_WRITE_FAILED', severity: 'critical',
      status: 'reconciliation_required', partial: true, changed: true,
      diagnosticId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      action: expect.any(String),
    });
    expect(body).not.toHaveProperty('idempotencyKey');
    expect(body).not.toHaveProperty('manualAction');
    expect(JSON.stringify(body)).not.toContain('client-secret-must-not-echo');
    expect(JSON.stringify(body)).not.toContain('vault-ref');
  });

  it('stale running 创建账本按内部 checkpoint 接管补偿，不盲写第二份 Secret', async () => {
    const claimCommit = vi.fn().mockResolvedValue({
      state: 'reconcile', leaseToken: 'lease-takeover',
      recovery: { phase: 'create_failed_compensation_pending', secretRef: 'vault-ref-orphan-internal' },
    });
    const test = await rig({ claimCommit, finishCommit: vi.fn().mockResolvedValue(undefined) });
    const command = { connectorId: 'github', kind: 'org_shared', purpose: 'shared automation', secret: 'client-secret-must-not-echo', reason: 'initial shared setup' };
    const signed = await preview(test, '/api/governance/resources/credentials/preview', command);
    const response = await test.request('/api/governance/resources/credentials', json({
      ...command, previewId: signed.previewId, baselineDigest: signed.baselineDigest, expiresAt: signed.expiresAt,
    }));
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ code: 'CREDENTIAL_CREATE_FAILED', status: 'failed' });
    expect(test.revokeSecret).toHaveBeenCalledWith('vault-ref-orphan-internal', expect.objectContaining({ tenantId: 'tenant-a' }));
    expect(test.putSecret).not.toHaveBeenCalled();
    expect(test.create).not.toHaveBeenCalled();
    expect(test.finishCommit).toHaveBeenCalledWith(expect.objectContaining({ leaseToken: 'lease-takeover', status: 'failed' }));
  });

  it('创建成功但 finishCommit 失败后，preview 过期仍按 checkpoint/实际状态收口且不重复副作用', async () => {
    let now = new Date(NOW);
    const created = credential({ secretRef: 'vault-ref-new' });
    const claimCommit = vi.fn()
      .mockResolvedValueOnce({ state: 'missing' })
      .mockResolvedValueOnce({ state: 'acquired', leaseToken: 'lease-first' })
      .mockResolvedValueOnce({
        state: 'reconcile', leaseToken: 'lease-takeover',
        recovery: { phase: 'credential_created', credentialId: 'cred-1', secretRef: 'vault-ref-new' },
      });
    const finishCommit = vi.fn()
      .mockRejectedValueOnce(new Error('ledger temporarily unavailable'))
      .mockResolvedValueOnce(undefined);
    const test = await rig({
      claimCommit, finishCommit, now: () => now,
      recordCommitProgress: vi.fn().mockResolvedValue(undefined),
      create: vi.fn().mockResolvedValue(created),
      getCredential: vi.fn().mockResolvedValue(created),
    });
    const command = { connectorId: 'github', kind: 'org_shared', purpose: 'shared automation', secret: 'create-secret-never-echo', reason: 'initial shared setup' };
    const signed = await preview(test, '/api/governance/resources/credentials/preview', command);
    const commit = { ...command, previewId: signed.previewId, baselineDigest: signed.baselineDigest, expiresAt: signed.expiresAt };

    const first = await test.request('/api/governance/resources/credentials', json(commit));
    expect(first.status).toBe(503);
    now = new Date(Date.parse(NOW) + 6 * 60_000);
    const recovered = await test.request('/api/governance/resources/credentials', json(commit));
    expect(recovered.status).toBe(409);
    const body = await recovered.json() as Record<string, unknown>;
    expect(body).toMatchObject({ code: 'GOVERNANCE_PREVIEW_REPLAYED', commitStatus: 'succeeded' });
    expect(JSON.stringify(body)).not.toContain('create-secret-never-echo');
    expect(JSON.stringify(body)).not.toContain('vault-ref-new');
    expect(test.putSecret).toHaveBeenCalledOnce();
    expect(test.create).toHaveBeenCalledOnce();
    expect(finishCommit).toHaveBeenLastCalledWith(expect.objectContaining({
      leaseToken: 'lease-takeover', status: 'succeeded', credentialId: 'cred-1',
    }));
  });

  it('轮换持久化失败且回滚 Secret 失败时返回 compensation_failed，不报告成功', async () => {
    const rotateSecret = vi.fn()
      .mockResolvedValueOnce({ id: 'vault-ref-hidden' })
      .mockRejectedValueOnce(new Error('rollback failed'));
    const test = await rig({
      rotateSecret,
      completeRotation: vi.fn().mockRejectedValue(new Error('credential version conflict')),
    });
    const command = { expectedVersion: 1, secret: 'new-secret-never-echo', reason: 'scheduled destructive rotation' };
    const signed = await preview(test, '/api/governance/resources/credentials/cred-1/rotate/preview', command);
    const response = await test.request('/api/governance/resources/credentials/cred-1/rotate', json({
      ...command, previewId: signed.previewId, baselineDigest: signed.baselineDigest, expiresAt: signed.expiresAt,
    }));
    expect(response.status).toBe(500);
    const body = await response.json() as Record<string, unknown>;
    expect(body).toMatchObject({ code: 'CREDENTIAL_ROTATE_COMPENSATION_FAILED', status: 'compensation_failed', changed: true });
    expect(JSON.stringify(body)).not.toContain('new-secret-never-echo');
    expect(JSON.stringify(body)).not.toContain('previous-secret-sensitive');
    expect(rotateSecret).toHaveBeenCalledTimes(2);
  });

  it('轮换成功但 finishCommit 失败后，preview 过期仍接管协调成功且不二次轮换 Secret', async () => {
    let now = new Date(NOW);
    let current = credential();
    const claimCommit = vi.fn()
      .mockResolvedValueOnce({ state: 'missing' })
      .mockResolvedValueOnce({ state: 'acquired', leaseToken: 'lease-first' })
      .mockResolvedValueOnce({
        state: 'reconcile', leaseToken: 'lease-takeover',
        recovery: { phase: 'credential_rotated', credentialId: 'cred-1' },
      });
    const finishCommit = vi.fn()
      .mockRejectedValueOnce(new Error('ledger temporarily unavailable'))
      .mockResolvedValueOnce(undefined);
    const completeRotation = vi.fn(async () => {
      current = credential({ generation: 2, version: 2 });
      return current;
    });
    const test = await rig({
      claimCommit, finishCommit, completeRotation,
      recordCommitProgress: vi.fn().mockResolvedValue(undefined),
      getCredential: vi.fn(async () => current),
      now: () => now,
    });
    const command = { expectedVersion: 1, secret: 'new-secret-never-echo', reason: 'scheduled destructive rotation' };
    const signed = await preview(test, '/api/governance/resources/credentials/cred-1/rotate/preview', command);
    const commit = { ...command, previewId: signed.previewId, baselineDigest: signed.baselineDigest, expiresAt: signed.expiresAt };

    const first = await test.request('/api/governance/resources/credentials/cred-1/rotate', json(commit));
    expect(first.status).toBe(503);
    await expect(first.json()).resolves.toMatchObject({
      code: 'CREDENTIAL_ROTATE_LEDGER_WRITE_FAILED', severity: 'critical',
      diagnosticId: expect.any(String),
    });
    now = new Date(Date.parse(NOW) + 6 * 60_000);
    const recovered = await test.request('/api/governance/resources/credentials/cred-1/rotate', json(commit));
    expect(recovered.status).toBe(409);
    await expect(recovered.json()).resolves.toMatchObject({ code: 'GOVERNANCE_PREVIEW_REPLAYED', commitStatus: 'succeeded' });
    expect(test.rotateSecret).toHaveBeenCalledOnce();
    expect(test.completeRotation).toHaveBeenCalledOnce();
    expect(finishCommit).toHaveBeenLastCalledWith(expect.objectContaining({
      leaseToken: 'lease-takeover', status: 'succeeded', credentialId: 'cred-1',
    }));
  });

  it('轮换 preview 过期不消费 nonce，版本漂移在 claim 后持久终结', async () => {
    let now = new Date(NOW);
    let current = credential();
    const getCredential = vi.fn(async () => current);
    const test = await rig({ getCredential, now: () => now });
    const command = { expectedVersion: 1, secret: 'rotate-secret', reason: 'scheduled destructive rotation' };
    const expiredPreview = await preview(test, '/api/governance/resources/credentials/cred-1/rotate/preview', command);
    now = new Date(Date.parse(NOW) + 6 * 60_000);
    const expired = await test.request('/api/governance/resources/credentials/cred-1/rotate', json({
      ...command, previewId: expiredPreview.previewId, baselineDigest: expiredPreview.baselineDigest, expiresAt: expiredPreview.expiresAt,
    }));
    expect(expired.status).toBe(409);
    await expect(expired.json()).resolves.toMatchObject({ code: 'GOVERNANCE_PREVIEW_EXPIRED' });

    now = new Date(NOW);
    const driftPreview = await preview(test, '/api/governance/resources/credentials/cred-1/rotate/preview', command);
    current = credential({ version: 2, generation: 2 });
    const drifted = await test.request('/api/governance/resources/credentials/cred-1/rotate', json({
      ...command, previewId: driftPreview.previewId, baselineDigest: driftPreview.baselineDigest, expiresAt: driftPreview.expiresAt,
    }));
    expect(drifted.status).toBe(409);
    await expect(drifted.json()).resolves.toMatchObject({ code: 'GOVERNANCE_PREVIEW_BASELINE_CONFLICT' });
    expect(test.claimCommit).toHaveBeenCalledTimes(3);
    expect(test.claimCommit).toHaveBeenNthCalledWith(1, expect.objectContaining({ existingOnly: true }));
    expect(test.finishCommit).toHaveBeenCalledWith(expect.objectContaining({
      status: 'failed', errorCode: 'GOVERNANCE_PREVIEW_BASELINE_CONFLICT',
    }));
    expect(test.rotateSecret).not.toHaveBeenCalled();
  });

  it('三种操作的过期 preview 在没有 ledger 时仍拒绝且不产生副作用或回显 Secret', async () => {
    let now = new Date(NOW);
    const test = await rig({ now: () => now });
    const createCommand = { connectorId: 'github', kind: 'org_shared', purpose: 'shared automation', secret: 'expired-create-secret', reason: 'initial shared setup' };
    const rotateCommand = { expectedVersion: 1, secret: 'expired-rotate-secret', reason: 'scheduled destructive rotation' };
    const transferCommand = { expectedVersion: 1, custodianUserId: 'member-2', reason: 'custodian handoff required' };
    const [createSigned, rotateSigned, transferSigned] = await Promise.all([
      preview(test, '/api/governance/resources/credentials/preview', createCommand),
      preview(test, '/api/governance/resources/credentials/cred-1/rotate/preview', rotateCommand),
      preview(test, '/api/governance/resources/credentials/cred-1/transfer/preview', transferCommand),
    ]);
    now = new Date(Date.parse(NOW) + 6 * 60_000);
    const commitToken = (signed: Record<string, unknown>) => ({
      previewId: signed.previewId, baselineDigest: signed.baselineDigest, expiresAt: signed.expiresAt,
    });
    const responses = await Promise.all([
      test.request('/api/governance/resources/credentials', json({ ...createCommand, ...commitToken(createSigned) })),
      test.request('/api/governance/resources/credentials/cred-1/rotate', json({ ...rotateCommand, ...commitToken(rotateSigned) })),
      test.request('/api/governance/resources/credentials/cred-1/transfer', json({ ...transferCommand, ...commitToken(transferSigned) })),
    ]);
    for (const response of responses) {
      expect(response.status).toBe(409);
      const body = await response.json() as Record<string, unknown>;
      expect(body).toMatchObject({ code: 'GOVERNANCE_PREVIEW_EXPIRED' });
      expect(JSON.stringify(body)).not.toMatch(/expired-(create|rotate)-secret|vault-ref-hidden/);
    }
    expect(test.claimCommit).toHaveBeenCalledTimes(3);
    for (const [input] of test.claimCommit.mock.calls) expect(input).toMatchObject({ existingOnly: true });
    expect(test.putSecret).not.toHaveBeenCalled();
    expect(test.create).not.toHaveBeenCalled();
    expect(test.rotateSecret).not.toHaveBeenCalled();
    expect(test.transferCustodian).not.toHaveBeenCalled();
  });

  it('transfer 成功但 finishCommit 失败后，过期且版本漂移仍按 checkpoint 收口并且不二次 transfer', async () => {
    let now = new Date(NOW);
    let current = credential();
    const claimCommit = vi.fn()
      .mockResolvedValueOnce({ state: 'missing' })
      .mockResolvedValueOnce({ state: 'acquired', leaseToken: 'lease-first' })
      .mockResolvedValueOnce({
        state: 'reconcile', leaseToken: 'lease-takeover',
        recovery: { phase: 'credential_transferred', credentialId: 'cred-1', custodianUserId: 'member-2', resultingVersion: 2 },
      });
    const finishCommit = vi.fn()
      .mockRejectedValueOnce(new Error('ledger temporarily unavailable'))
      .mockResolvedValueOnce(undefined);
    const transferCustodian = vi.fn(async () => {
      current = credential({ custodianUserId: 'member-2', version: 2 });
      return current;
    });
    const recordCommitProgress = vi.fn().mockResolvedValue(undefined);
    const test = await rig({
      claimCommit, finishCommit, transferCustodian, recordCommitProgress,
      getCredential: vi.fn(async () => current), now: () => now,
    });
    const command = { expectedVersion: 1, custodianUserId: 'member-2', reason: 'custodian handoff required' };
    const signed = await preview(test, '/api/governance/resources/credentials/cred-1/transfer/preview', command);
    const commit = { ...command, previewId: signed.previewId, baselineDigest: signed.baselineDigest, expiresAt: signed.expiresAt };

    const first = await test.request('/api/governance/resources/credentials/cred-1/transfer', json(commit));
    expect(first.status).toBe(503);
    now = new Date(Date.parse(NOW) + 6 * 60_000);
    const recovered = await test.request('/api/governance/resources/credentials/cred-1/transfer', json(commit));
    expect(recovered.status).toBe(409);
    const body = await recovered.json() as Record<string, unknown>;
    expect(body).toMatchObject({ code: 'GOVERNANCE_PREVIEW_REPLAYED', commitStatus: 'succeeded' });
    expect(JSON.stringify(body)).not.toContain('vault-ref-hidden');
    expect(transferCustodian).toHaveBeenCalledOnce();
    expect(recordCommitProgress).toHaveBeenCalledWith(expect.objectContaining({
      operation: 'transfer', progress: expect.objectContaining({
        phase: 'credential_transferred', credentialId: 'cred-1', custodianUserId: 'member-2', resultingVersion: 2,
      }),
    }));
    expect(finishCommit).toHaveBeenLastCalledWith(expect.objectContaining({
      leaseToken: 'lease-takeover', status: 'succeeded', credentialId: 'cred-1',
    }));
  });

  it('transfer preview 拒绝重放与版本漂移，并维持 tenant isolation', async () => {
    let current = credential();
    const getCredential = vi.fn(async () => current);
    const test = await rig({ getCredential });
    const command = { expectedVersion: 1, custodianUserId: 'member-2', reason: 'custodian handoff required' };
    const signed = await preview(test, '/api/governance/resources/credentials/cred-1/transfer/preview', command);
    const commit = {
      ...command, previewId: signed.previewId, baselineDigest: signed.baselineDigest, expiresAt: signed.expiresAt,
    };
    expect((await test.request('/api/governance/resources/credentials/cred-1/transfer', json(commit))).status).toBe(200);
    const replay = await test.request('/api/governance/resources/credentials/cred-1/transfer', json(commit));
    expect(replay.status).toBe(409);
    await expect(replay.json()).resolves.toMatchObject({ code: 'GOVERNANCE_PREVIEW_REPLAYED' });
    expect(test.transferCustodian).toHaveBeenCalledOnce();

    current = credential();
    const driftPreview = await preview(test, '/api/governance/resources/credentials/cred-1/transfer/preview', command);
    current = credential({ version: 2 });
    const drift = await test.request('/api/governance/resources/credentials/cred-1/transfer', json({
      ...command, previewId: driftPreview.previewId, baselineDigest: driftPreview.baselineDigest, expiresAt: driftPreview.expiresAt,
    }));
    expect(drift.status).toBe(409);
    const crossTenantTransfer = await test.request(
      '/api/governance/resources/credentials/cred-1/transfer?tenantId=tenant-b', json(commit),
    );
    expect(crossTenantTransfer.status).toBe(404);
    expect(JSON.stringify(await crossTenantTransfer.json())).not.toContain('vault-ref-hidden');
    const crossTenantCreate = await test.request('/api/governance/resources/credentials/preview', json({
      connectorId: 'github', tenantId: 'tenant-b', kind: 'org_shared', purpose: 'cross tenant', secret: 'hidden', reason: 'should be denied',
    }));
    expect(crossTenantCreate.status).toBe(403);
    expect(JSON.stringify(await crossTenantCreate.json())).not.toContain('hidden');
    expect(test.transferCustodian).toHaveBeenCalledOnce();
  });
});
