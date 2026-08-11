import { describe, expect, it, vi } from 'vitest';

import type { OAuthGrant } from '../data/oauthGrants/types.js';
import { reconcileOAuthGrantRevocations } from '../app/runtimeOAuthGrantReconciler.js';
import type { AppRuntime } from '../app/runtime.js';

const baseGrant: OAuthGrant = {
  grantId: 'grant-1', tenantId: 'tenant-a', subjectUserId: 'user-1', provider: 'google',
  connectorId: 'google-workspace', status: 'error', scopeSummary: ['drive.readonly'],
  approvedAt: '2026-08-11T00:00:00.000Z', version: 2, revocationStage: 'local_blocked',
};

function rig(grant: OAuthGrant, options: { providerFails?: boolean; finalizeFails?: boolean; claimFails?: boolean } = {}) {
  const disconnect = vi.fn(async () => {
    if (options.providerFails) throw new Error('provider unavailable');
  });
  const grants = {
    listRevocationsDue: vi.fn().mockResolvedValue([grant]),
    markProviderRevoking: options.claimFails ? vi.fn().mockRejectedValue(new Error('claim conflict')) : vi.fn().mockResolvedValue({ ...grant, revocationStage: 'provider_revoking' }),
    markProviderRevoked: vi.fn().mockResolvedValue({ ...grant, revocationStage: 'provider_revoked' }),
    markRevocationRetry: vi.fn().mockResolvedValue({ ...grant, revocationStage: 'local_blocked' }),
    recordRevocation: options.finalizeFails ? vi.fn().mockRejectedValue(new Error('finalize unavailable')) : vi.fn().mockResolvedValue({ ...grant, status: 'revoked' }),
  };
  const runtime = {
    oauthGrantStore: grants,
    userStore: { findById: vi.fn().mockReturnValue({ id: 'user-1', username: 'alice', tenantId: 'tenant-a' }) },
    googleWorkspaceOAuthService: { disconnect },
  } as unknown as AppRuntime;
  return { runtime, grants, disconnect };
}

describe('OAuth Grant durable revocation reconciler', () => {
  it('provider 撤销失败后保持本地阻断并进入退避重试', async () => {
    const test = rig(baseGrant, { providerFails: true });
    await reconcileOAuthGrantRevocations(test.runtime);
    expect(test.grants.markRevocationRetry).toHaveBeenCalledWith(expect.objectContaining({ errorCode: 'OAUTH_REVOCATION_RETRY_FAILED' }));
    expect(test.grants.markProviderRevoked).not.toHaveBeenCalled();
    expect(test.grants.recordRevocation).not.toHaveBeenCalled();
  });

  it('provider 已成功但本地 finalize 失败时保留 provider_revoked，不重复外部撤销', async () => {
    const test = rig(baseGrant, { finalizeFails: true });
    await reconcileOAuthGrantRevocations(test.runtime);
    expect(test.disconnect).toHaveBeenCalledTimes(1);
    expect(test.grants.markProviderRevoked).toHaveBeenCalledTimes(1);
    expect(test.grants.markRevocationRetry).not.toHaveBeenCalled();
  });

  it('provider_revoked 记录只执行本地 finalize', async () => {
    const test = rig({ ...baseGrant, revocationStage: 'provider_revoked' });
    await reconcileOAuthGrantRevocations(test.runtime);
    expect(test.grants.recordRevocation).toHaveBeenCalledTimes(1);
    expect(test.disconnect).not.toHaveBeenCalled();
    expect(test.grants.markProviderRevoking).not.toHaveBeenCalled();
  });

  it('多实例 claim 冲突时未持有 claim 的实例不调用 provider', async () => {
    const test = rig({ ...baseGrant, revocationStage: 'provider_revoking' }, { claimFails: true });
    await reconcileOAuthGrantRevocations(test.runtime);
    expect(test.disconnect).not.toHaveBeenCalled();
    expect(test.grants.markRevocationRetry).not.toHaveBeenCalled();
  });
});
