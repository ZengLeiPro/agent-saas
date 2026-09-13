import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./authFetch', () => ({ authFetch: vi.fn() }));

import { authFetch } from './authFetch';
import { governanceAccessApi } from './governanceApi';

const mockAuthFetch = vi.mocked(authFetch);

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  }) as unknown as Response;
}

describe('OAuth 撤销回执接受治理写中间件注入的 effectiveAt', () => {
  beforeEach(() => mockAuthFetch.mockReset());

  it('preview 与 revoke 均接受终态审计成功时的 effectiveAt', async () => {
    const preview = {
      previewId: `ogpv1.${'a'.repeat(64)}`,
      baselineDigest: 'b'.repeat(64),
      expiresAt: '2026-08-10T08:00:00.000Z',
      impact: {
        provider: 'google', connectorId: 'google-workspace', action: 'revoke', immediatelyUnavailable: true,
        newRuns: 'blocked', reversible: false, effectiveMode: 'immediate', affectedAgents: [],
        affectedAutomations: [], brokenReferences: [], blockers: [], warnings: [],
        currentVersion: 1, nextVersion: 2,
      },
      changeId: 'preview-intent',
      auditId: 'preview-terminal',
      effectiveAt: '2026-08-10T08:00:00.000Z',
    };
    mockAuthFetch.mockResolvedValueOnce(jsonResponse(preview));
    await expect(governanceAccessApi.previewOAuthGrantRevocation('grant-1', '用户主动断开 Google Workspace'))
      .resolves.toEqual(preview);

    const revoked = {
      grantId: 'grant-1', status: 'revoked', version: 2,
      changeId: 'commit-intent', auditId: 'commit-terminal',
      effectiveAt: '2026-08-10T08:00:01.000Z',
    };
    mockAuthFetch.mockResolvedValueOnce(jsonResponse(revoked));
    await expect(governanceAccessApi.revokeOAuthGrant('grant-1', {
      reason: '用户主动断开 Google Workspace',
      previewId: preview.previewId,
      baselineDigest: preview.baselineDigest,
      expiresAt: preview.expiresAt,
    })).resolves.toEqual(revoked);
  });
});
