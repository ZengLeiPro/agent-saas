import type { ConnectorConnectionStore } from '../connectors/connectionStore.js';
import type { OAuthGrant, OAuthGrantProjectionInput } from '../data/oauthGrants/types.js';
import type { AppRuntime } from './runtime.js';

export function buildGoogleWorkspaceOAuthGrantProjection(
  connectionStore: Pick<ConnectorConnectionStore, 'get'> | undefined,
  context: { userId: string; username: string; tenantId: string },
): OAuthGrantProjectionInput | undefined {
  const google = connectionStore?.get(context.username, 'google-workspace');
  const scopeSummary = typeof google?.metadata?.grantedScopes === 'string'
    ? [...new Set(google.metadata.grantedScopes.split(/\s+/).filter(Boolean))].sort()
    : [];
  if (google?.status !== 'connected' || google.tenantId !== context.tenantId
    || google.userId !== context.userId || scopeSummary.length === 0) return undefined;
  return {
    grantId: `google-workspace:${context.tenantId}:${context.userId}`,
    provider: 'google', connectorId: 'google-workspace',
    approvedAt: google.connectedAt ?? google.updatedAt,
    purpose: 'legacy_google_workspace_backfill', scopeSummary,
    tenantId: context.tenantId, subjectUserId: context.userId,
    status: 'active', action: 'approved', actorUserId: context.userId,
  };
}

async function revokeProvider(runtime: AppRuntime, grant: OAuthGrant): Promise<void> {
  const user = runtime.userStore?.findById(grant.subjectUserId);
  if (!user || user.tenantId !== grant.tenantId) throw new Error('OAUTH_GRANT_SUBJECT_INACTIVE');
  if (grant.provider === 'google') {
    if (!runtime.googleWorkspaceOAuthService) throw new Error('OAUTH_PROVIDER_REVOKER_UNAVAILABLE');
    await runtime.googleWorkspaceOAuthService.disconnect(user.id, user.username, user.tenantId);
    return;
  }
  if (grant.provider.startsWith('mcp:')) {
    if (!runtime.mcpOAuthService || !grant.connectorId) throw new Error('OAUTH_PROVIDER_REVOKER_UNAVAILABLE');
    await runtime.mcpOAuthService.disconnect(user.username, user.tenantId, grant.connectorId);
    return;
  }
  throw new Error('OAUTH_PROVIDER_REVOKER_UNAVAILABLE');
}

export async function reconcileOAuthGrantRevocations(runtime: AppRuntime): Promise<void> {
  const grants = runtime.oauthGrantStore;
  if (!grants) return;
  for (const grant of await grants.listRevocationsDue()) {
    if (grant.revocationStage === 'provider_revoked') {
      await grants.recordRevocation({ grantId: grant.grantId, tenantId: grant.tenantId, subjectUserId: grant.subjectUserId });
      continue;
    }
    if (grant.revocationStage !== 'local_blocked' && grant.revocationStage !== 'provider_revoking') continue;
    try {
      await grants.markProviderRevoking({ grantId: grant.grantId, tenantId: grant.tenantId, subjectUserId: grant.subjectUserId });
    } catch {
      continue;
    }
    try {
      await revokeProvider(runtime, grant);
    } catch {
      await grants.markRevocationRetry({
        grantId: grant.grantId, tenantId: grant.tenantId, subjectUserId: grant.subjectUserId,
        errorCode: 'OAUTH_REVOCATION_RETRY_FAILED',
      }).catch(() => undefined);
      continue;
    }
    await grants.markProviderRevoked({ grantId: grant.grantId, tenantId: grant.tenantId, subjectUserId: grant.subjectUserId });
    await grants.recordRevocation({
      grantId: grant.grantId, tenantId: grant.tenantId, subjectUserId: grant.subjectUserId,
    }).catch(() => undefined);
  }
}

export function createOAuthGrantReconciler(runtime: AppRuntime) {
  const grants = runtime.oauthGrantStore;
  const users = runtime.userStore;
  if (!grants || !users) return undefined;
  const reconcileDue = () => reconcileOAuthGrantRevocations(runtime);

  const reconcileSubject = async (tenantId: string, subjectUserId: string): Promise<void> => {
    const user = users.findById(subjectUserId);
    if (!user || user.tenantId !== tenantId || user.disabled) throw new Error('OAUTH_GRANT_SUBJECT_INACTIVE');
    const projections: Array<{
      grantId: string; provider: string; connectorId: string; approvedAt: string; purpose: string; scopeSummary: string[];
    }> = [];
    for (const connection of runtime.mcpConfigStore?.listUserOAuthConnections(user.username) ?? []) {
      if (connection.tenantId !== tenantId || connection.status !== 'connected'
        || connection.userId !== subjectUserId || !connection.grantedScopes?.length) continue;
      projections.push({
        grantId: `mcp:${tenantId}:${subjectUserId}:${connection.serverId}`,
        provider: `mcp:${connection.serverId}`, connectorId: connection.serverId,
        approvedAt: connection.connectedAt ?? connection.updatedAt,
        purpose: 'legacy_mcp_oauth_backfill', scopeSummary: [...connection.grantedScopes],
      });
    }
    const googleProjection = buildGoogleWorkspaceOAuthGrantProjection(
      runtime.connectorConnectionStore,
      { userId: subjectUserId, username: user.username, tenantId },
    );
    if (googleProjection) {
      projections.push({
        grantId: googleProjection.grantId,
        provider: googleProjection.provider,
        connectorId: googleProjection.connectorId!,
        approvedAt: googleProjection.approvedAt,
        purpose: googleProjection.purpose,
        scopeSummary: googleProjection.scopeSummary,
      });
    }
    for (const projection of projections) {
      await grants.ensureProjection({
        ...projection, tenantId, subjectUserId, status: 'active',
        action: 'approved', actorUserId: subjectUserId,
      });
    }
    const externalGrantIds = new Set(projections.map(item => item.grantId));
    for (const grant of await grants.listForSubject(tenantId, subjectUserId)) {
      if (grant.status === 'active' && (grant.provider === 'google' || grant.provider.startsWith('mcp:'))
        && !externalGrantIds.has(grant.grantId)) {
        await grants.markRevocationPending({
          grantId: grant.grantId, tenantId, subjectUserId,
          purpose: 'external_connection_missing', actorUserId: subjectUserId,
        });
      }
    }
    await reconcileDue();
  };

  const timer = setInterval(() => void reconcileDue().catch(() => undefined), 30_000);
  timer.unref();
  queueMicrotask(() => void reconcileDue().catch(() => undefined));
  return reconcileSubject;
}
