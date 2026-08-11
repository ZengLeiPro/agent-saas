import type { Express } from 'express';

import type { WebChannel } from '../channels/web/channel.js';
import { createGovernanceAccessRouter } from '../routes/governanceAccess.js';
import { createGovernanceResourcesRouter } from '../routes/governanceResources.js';
import { createGovernanceUiRouter } from '../routes/governanceUi.js';
import { inventoryPersonalWorkspace } from './governancePersonalDataRetention.js';
import type { ExecuteUserOffboarding } from './governanceOffboarding.js';
import type { AppRuntime } from './runtime.js';
import { createAssignmentResourceResolver, createEntitlementResourceCatalogResolver, createEntitlementResourceResolver } from './runtimeAssignmentResourceResolver.js';
import { createOAuthGrantReconciler } from './runtimeOAuthGrantReconciler.js';

const scheduledOffboardingRuntimes = new WeakSet<AppRuntime>();

export function registerGovernanceRoutes(
  app: Express,
  runtime: AppRuntime,
  options: { webChannel?: WebChannel; executeUserOffboarding?: ExecuteUserOffboarding },
): void {
  const previewSecret = runtime.config.auth?.jwtSecret;
  app.use(createGovernanceUiRouter({
    users: runtime.userStore,
    tenants: runtime.tenantStore,
    memberships: runtime.membershipStore,
    entitlements: runtime.entitlementStore,
    assignments: runtime.assignmentStore,
    agents: runtime.agentResourceStore,
    skills: runtime.skillGovernanceStore,
    connectors: runtime.connectorCatalogStore,
    credentials: runtime.credentialStore,
    environments: runtime.environmentStore,
    audit: runtime.governanceAuditStore,
  }));

  if (
    runtime.membershipStore
    && runtime.entitlementStore
    && runtime.assignmentStore
    && runtime.governanceAuditStore
    && runtime.governanceProjectionOutboxStore
    && previewSecret
  ) {
    app.use('/api/governance/access', createGovernanceAccessRouter({
      memberships: runtime.membershipStore,
      entitlements: runtime.entitlementStore,
      assignments: runtime.assignmentStore,
      ...(runtime.governanceChangeJobStore ? { changeJobs: runtime.governanceChangeJobStore } : {}),
      ...(runtime.oauthGrantStore ? {
        oauthGrants: runtime.oauthGrantStore,
        reconcileOAuthGrants: createOAuthGrantReconciler(runtime),
        revokeOAuthGrant: async (grant, user) => {
          if (grant.provider === 'google' && runtime.googleWorkspaceOAuthService) {
            await runtime.googleWorkspaceOAuthService.disconnect(user.sub, user.username, grant.tenantId);
            return;
          }
          if (grant.provider.startsWith('mcp:') && grant.connectorId && runtime.mcpOAuthService) {
            await runtime.mcpOAuthService.disconnect(user.username, grant.tenantId, grant.connectorId);
            return;
          }
          throw new Error('OAuth revocation authority unavailable');
        },
      } : {}),
      resolveAssignmentResource: createAssignmentResourceResolver(runtime),
      resolveEntitlementResource: createEntitlementResourceResolver(runtime),
      listEntitlementResources: createEntitlementResourceCatalogResolver(runtime),
      getPlatformAdminProfile: userId => {
        const user = runtime.userStore?.findById(userId);
        return user ? {
          username: user.username,
          displayName: user.realName ?? user.username,
          accountStatus: user.disabled ? 'disabled' as const : 'active' as const,
        } : null;
      },
      getMemberProfile: (tenantId, userId) => {
        const user = runtime.userStore?.findById(userId);
        if (!user || user.tenantId !== tenantId) return null;
        return {
          userId: user.id,
          username: user.username,
          displayName: user.realName ?? user.username,
          ...(user.position ? { position: user.position } : {}),
          accountStatus: user.disabled ? 'disabled' as const : 'active' as const,
          dingtalkBound: Boolean(user.dingtalkStaffId),
          createdAt: user.createdAt,
          updatedAt: user.updatedAt,
        };
      },
      ...(runtime.billingService ? {
        getMemberBudgetOverview: (tenantId: string, userId: string) =>
          runtime.billingService!.store.getMemberBudgetOverview(tenantId, userId),
      } : {}),
      ...(runtime.tenantStore ? {
        getTenantLifecycle: (tenantId: string) => runtime.tenantStore!.findById(tenantId),
        setTenantDisabled: async (tenantId: string, disabled: boolean, actorUserId: string) => {
          const tenant = await runtime.tenantStore!.setDisabled(tenantId, disabled, actorUserId);
          if (disabled) options.webChannel?.disconnectTenant(tenantId);
          return tenant;
        },
      } : {}),
      audit: runtime.governanceAuditStore,
      contentAccess: runtime.contentAccessGrantStore,
      projectionOutbox: runtime.governanceProjectionOutboxStore,
      projectionReconciler: runtime.governanceProjectionReconciler,
      membershipPreviewSecret: previewSecret,
    }));
  }

  if (
    runtime.membershipStore
    && runtime.agentResourceStore
    && runtime.skillGovernanceStore
    && runtime.connectorCatalogStore
    && runtime.credentialStore
    && runtime.environmentStore
    && runtime.governanceChangeJobStore
    && runtime.governanceChangePlanner
    && runtime.secretVault
    && runtime.governanceAuditStore
    && runtime.governanceProjectionOutboxStore
    && previewSecret
  ) {
    app.use('/api/governance/resources', createGovernanceResourcesRouter({
      memberships: runtime.membershipStore,
      agents: runtime.agentResourceStore,
      skills: runtime.skillGovernanceStore,
      connectors: runtime.connectorCatalogStore,
      credentials: runtime.credentialStore,
      environments: runtime.environmentStore,
      changeJobs: runtime.governanceChangeJobStore,
      changePlanner: runtime.governanceChangePlanner,
      tenantExists: tenantId => Boolean(runtime.tenantStore?.findById(tenantId)),
      resolveUserTenantId: userId => runtime.userStore?.findById(userId)?.tenantId,
      listCronIdsByOwner: async userId => (await runtime.cronRuntime.service?.list({ includeDisabled: true }) ?? [])
        .filter(job => job.owner === userId)
        .map(job => ({ id: job.id, version: JSON.stringify([job.updatedAtMs, job.enabled, job.schedule]) })),
      ...(runtime.runtimeRunStore?.listActiveByUser ? {
        listActiveRunIdsByUser: async (tenantId: string, userId: string) =>
          (await runtime.runtimeRunStore!.listActiveByUser!(userId))
            .filter(run => run.tenantId === tenantId)
            .map(run => ({ id: run.runId, version: JSON.stringify([run.status, run.updatedAt]) })),
      } : {}),
      ...(runtime.runtimeSessionProjectionStore ? {
        listActiveSessionIdsByUser: (tenantId: string, userId: string) =>
          runtime.runtimeSessionProjectionStore!.listSnapshotsByUser(tenantId, userId),
      } : {}),
      ...(runtime.oauthGrantStore ? {
        listActiveOAuthGrantIdsByUser: async (tenantId: string, userId: string) =>
          (await runtime.oauthGrantStore!.listForSubject(tenantId, userId))
            .filter(grant => grant.status !== 'revoked')
            .map(grant => ({
              id: grant.grantId,
              version: JSON.stringify([grant.version, grant.status, grant.revocationStage, grant.expiresAt]),
            })),
      } : {}),
      ...(runtime.connectorConnectionStore && runtime.mcpConfigStore ? {
        listExternalConnectionIdsByUser: async (tenantId: string, userId: string) => {
          const user = runtime.userStore?.findById(userId);
          if (!user || user.tenantId !== tenantId) throw new Error('OFFBOARDING_CONNECTOR_SUBJECT_MISMATCH');
          const native = runtime.connectorConnectionStore!.listForUser(user.username)
            .filter(item => item.userId === userId && item.tenantId === tenantId && item.status === 'connected')
            .map(item => ({ id: `connector:${item.connectorId}`, version: JSON.stringify([item.status, item.updatedAt]) }));
          const mcp = runtime.mcpConfigStore!.listUserOAuthConnections(user.username)
            .filter(item => item.userId === userId && item.tenantId === tenantId && item.status === 'connected')
            .map(item => ({ id: `mcp:${item.serverId}`, version: JSON.stringify([item.status, item.updatedAt]) }));
          return [...native, ...mcp].sort((left, right) => left.id.localeCompare(right.id));
        },
      } : {}),
      listPersonalMemoryIds: async (tenantId, userId) => {
        const user = runtime.userStore?.findById(userId);
        if (!user || user.tenantId !== tenantId) throw new Error('OFFBOARDING_PERSONAL_DATA_SUBJECT_MISMATCH');
        return (await inventoryPersonalWorkspace(runtime.agentCwd, user)).personalMemoryIds;
      },
      listFileOwnership: async (tenantId, userId) => {
        const user = runtime.userStore?.findById(userId);
        if (!user || user.tenantId !== tenantId) throw new Error('OFFBOARDING_PERSONAL_DATA_SUBJECT_MISMATCH');
        const inventory = await inventoryPersonalWorkspace(runtime.agentCwd, user);
        return { personalFileIds: inventory.personalFileIds, organizationFileIds: inventory.organizationFileIds };
      },
      executeUserOffboarding: options.executeUserOffboarding,
      offboardingPreviewSecret: previewSecret,
      projectionOutbox: runtime.governanceProjectionOutboxStore,
      projectionReconciler: runtime.governanceProjectionReconciler,
      vault: runtime.secretVault,
      audit: runtime.governanceAuditStore,
    }));
    if (options.executeUserOffboarding?.retry && !scheduledOffboardingRuntimes.has(runtime)) {
      scheduledOffboardingRuntimes.add(runtime);
      const resumeDue = async () => {
        const jobs = await runtime.governanceChangeJobStore!.listDue('user_offboarding');
        for (const job of jobs) {
          await options.executeUserOffboarding!.retry!({
            tenantId: job.tenantId, jobId: job.jobId, expectedRevision: job.revision,
            requestedBy: 'system:governance-offboarding-scheduler',
          }).catch(() => undefined);
        }
      };
      const timer = setInterval(() => void resumeDue().catch(() => undefined), 30_000);
      timer.unref();
      queueMicrotask(() => void resumeDue().catch(() => undefined));
    }
  }
}
