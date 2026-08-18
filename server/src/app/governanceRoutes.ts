import type { Express } from 'express';

import { isDebugModeAvailable } from '../../../shared/src/types/tenant.js';
import type { WebChannel } from '../channels/web/channel.js';
import { serverLogger } from '../utils/logger.js';
import { createGovernanceAccessRouter } from '../routes/governanceAccess.js';
import { createGovernanceResourcesRouter } from '../routes/governanceResources.js';
import { createGovernanceUiRouter } from '../routes/governanceUi.js';
import { provisionTenant, rollbackProvisionedTenant } from '../data/tenants/provision.js';
import { validateGovernanceCredentialHealth } from '../governance/credentialHealth.js';
import { inventoryPersonalWorkspace } from './governancePersonalDataRetention.js';
import type { ExecuteUserOffboarding } from './governanceOffboarding.js';
import type { AppRuntime } from './runtime.js';
import { createAssignmentResourceResolver, createEntitlementResourceCatalogResolver, createEntitlementResourceResolver } from './runtimeAssignmentResourceResolver.js';
import { createOAuthGrantReconciler } from './runtimeOAuthGrantReconciler.js';
import {
  createPersonalSkillGovernanceUpload,
  createTenantSkillGovernanceUpload,
} from '../services/tenantSkillGovernanceUpload.js';
import { applyTenantLifecycleChange, type TenantLifecycleChange } from './tenantLifecycleEffects.js';
import { resolveUserCwd, ensureUserWorkspace } from '../workspace/resolver.js';
import type { MembershipCreateInput } from '../routes/governanceAccessValidation.js';

const scheduledOffboardingRuntimes = new WeakSet<AppRuntime>();

export async function resolveRuntimeTenantLifecycleImpact(
  runtime: Pick<AppRuntime, 'tenantStore' | 'membershipStore'>,
  tenantId: string,
  action: 'suspend' | 'resume',
) {
  if (!runtime.tenantStore || !runtime.membershipStore) {
    throw new Error('Tenant lifecycle impact authority unavailable');
  }
  const tenant = typeof runtime.tenantStore.findByIdStrict === 'function'
    ? runtime.tenantStore.findByIdStrict(tenantId)
    : runtime.tenantStore.findById(tenantId);
  if (!tenant) throw new Error('Tenant not found');
  const memberships = await runtime.membershipStore.listMemberships(tenantId);
  const affectedResources = memberships
    .filter(membership => membership.status === 'active')
    .map(membership => ({ type: 'membership', id: membership.userId, version: membership.version }))
    .sort((left, right) => left.id.localeCompare(right.id));
  const activeCount = typeof runtime.tenantStore.activeCountStrict === 'function'
    ? runtime.tenantStore.activeCountStrict()
    : runtime.tenantStore.activeCount();
  const blockers = action === 'suspend' && activeCount <= 1
    ? ['不能暂停最后一个启用组织']
    : [];
  return { affectedResources, blockers };
}

export function registerGovernanceRoutes(
  app: Express,
  runtime: AppRuntime,
  options: { webChannel?: WebChannel; executeUserOffboarding?: ExecuteUserOffboarding },
): void {
  const previewSecret = runtime.config.auth?.jwtSecret;
  const applyLifecycleChange = async (change: TenantLifecycleChange): Promise<'applied' | 'pending'> => {
    let broadcastApplied = !runtime.runtimePgEventStore;
    if (runtime.runtimePgEventStore) {
      let lastError: unknown;
      for (let attempt = 1; attempt <= 3 && !broadcastApplied; attempt += 1) {
        try {
          await runtime.runtimePgEventStore.append({
            type: 'tenant_lifecycle_changed',
            sessionId: `__tenant_lifecycle__:${change.tenantId}`,
            ...change,
          }, { tenantId: change.tenantId });
          broadcastApplied = true;
        } catch (error) {
          lastError = error;
        }
      }
      if (!broadcastApplied) {
        serverLogger.error(
          `Tenant lifecycle broadcast failed after persisted change: tenant=${change.tenantId} error=${lastError instanceof Error ? lastError.message : String(lastError)}`,
        );
      }
    }

    let localApplied = true;
    try {
      await applyTenantLifecycleChange(change, {
        tenantStore: runtime.tenantStore,
        webChannel: options.webChannel,
        runStore: runtime.runtimeRunStore,
      });
    } catch (error) {
      localApplied = false;
      serverLogger.error(
        `Tenant lifecycle local effect failed after persisted change: tenant=${change.tenantId} error=${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return broadcastApplied && localApplied ? 'applied' : 'pending';
  };
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
      ...(runtime.directoryGroupStore ? { directoryGroups: runtime.directoryGroupStore } : {}),
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
        const debugModeAvailable = isDebugModeAvailable(
          tenantId,
          runtime.tenantStore?.getSettings(tenantId)?.features,
        );
        return {
          userId: user.id,
          username: user.username,
          displayName: user.realName ?? user.username,
          ...(user.position ? { position: user.position } : {}),
          accountStatus: user.disabled ? 'disabled' as const : 'active' as const,
          dingtalkBound: Boolean(user.dingtalkStaffId),
          debugMode: user.debugMode === true && debugModeAvailable,
          debugModeAvailable,
          createdAt: user.createdAt,
          updatedAt: user.updatedAt,
        };
      },
      ...(runtime.userStore ? {
        onDebugModeDisabled: async (tenantId: string) => {
          await runtime.userStore!.disableDebugModeForTenant(tenantId);
        },
      } : {}),
      ...(runtime.tenantStore ? {
        validateMemberDebugMode: (tenantId: string, debugMode: boolean) => {
          if (!debugMode) return null;
          return isDebugModeAvailable(
            tenantId,
            runtime.tenantStore!.getSettings(tenantId)?.features,
          ) ? null : '上级未开放调试模式，不能为成员开启';
        },
      } : {}),
      ...(runtime.userStore && runtime.tenantStore ? {
        createMember: async (input: MembershipCreateInput & { tenantId: string; createdBy: string }) => {
          const tenant = runtime.tenantStore!.findById(input.tenantId);
          if (!tenant) throw new Error('Tenant not found');
          if (tenant.disabled) throw new Error('Tenant disabled');
          if (input.debugMode === true && !isDebugModeAvailable(input.tenantId, tenant.settings?.features)) {
            throw new Error('上级未开放调试模式，不能为成员开启');
          }
          const user = await runtime.userStore!.create({
            username: input.username,
            password: input.password,
            role: input.role,
            tenantId: input.tenantId,
            createdBy: input.createdBy,
            realName: input.realName,
            position: input.position,
            dingtalkStaffId: input.dingtalkStaffId,
            debugMode: input.debugMode,
            permissions: input.permissions,
          });
          try {
            await ensureUserWorkspace(
              resolveUserCwd(runtime.agentCwd, user),
              runtime.agentCwd,
              runtime.sharedDir,
              user,
              { realName: input.realName, position: input.position },
              runtime.skillConfigStore,
              runtime.tenantSkillsRootDir,
            );
            const membership = await runtime.membershipStore!.createMembership({
              tenantId: input.tenantId,
              userId: user.id,
              persona: input.role === 'admin' ? 'org_admin' : 'member',
              createdBy: input.createdBy,
            });
            return { userId: user.id, membership };
          } catch (error) {
            await runtime.userStore!.delete(user.id).catch(() => undefined);
            throw error;
          }
        },
      } : {}),
      ...(runtime.billingService ? {
        getMemberBudgetOverview: (tenantId: string, userId: string) =>
          runtime.billingService!.store.getMemberBudgetOverview(tenantId, userId),
      } : {}),
      ...(runtime.tenantStore ? {
        createTenant: (input: { id: string; name: string; createdBy: string }) => provisionTenant({
          tenantStore: runtime.tenantStore!,
          sharedDir: runtime.sharedDir,
          ...(runtime.orgAgentStore ? { orgAgentStore: runtime.orgAgentStore } : {}),
        }, input),
        rollbackTenantCreate: (tenantId: string) => rollbackProvisionedTenant({
          tenantStore: runtime.tenantStore!,
          sharedDir: runtime.sharedDir,
          ...(runtime.orgAgentStore ? { orgAgentStore: runtime.orgAgentStore } : {}),
        }, tenantId),
        getTenantSettings: (tenantId: string) => {
          const tenant = runtime.tenantStore!.findByIdStrict(tenantId);
          const settings = runtime.tenantStore!.getSettings(tenantId);
          if (!tenant || !settings) return undefined;
          return {
            settings,
            updatedAt: tenant.updatedAt,
            memoryFeatureStatus: runtime.getTenantMemoryFeatureStatus(tenantId),
          };
        },
        updateTenantSettings: async (tenantId, settings, expectedUpdatedAt) => {
          const updatedSettings = await runtime.tenantStore!.updateSettings(
            tenantId,
            settings,
            expectedUpdatedAt,
          );
          if (
            runtime.userStore
            && !isDebugModeAvailable(tenantId, updatedSettings.features)
          ) {
            await runtime.userStore.disableDebugModeForTenant(tenantId);
          }
          const tenant = runtime.tenantStore!.findByIdStrict(tenantId);
          if (!tenant) throw new Error('Tenant not found');
          return {
            settings: updatedSettings,
            updatedAt: tenant.updatedAt,
            memoryFeatureStatus: runtime.getTenantMemoryFeatureStatus(tenantId),
          };
        },
        getTenantLifecycle: (tenantId: string) => runtime.tenantStore!.findByIdStrict(tenantId),
        resolveDependencyImpact: input => input.kind === 'tenant' && input.action
          ? resolveRuntimeTenantLifecycleImpact(runtime, input.tenantId, input.action)
          : Promise.reject(new Error('Dependency impact authority unavailable')),
        setTenantDisabled: async (
          tenantId: string,
          disabled: boolean,
          actorUserId: string,
          expectedUpdatedAt: string,
        ) => {
          return runtime.tenantStore!.setDisabled(
            tenantId,
            disabled,
            actorUserId,
            expectedUpdatedAt,
          );
        },
        onTenantLifecycleChanged: applyLifecycleChange,
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
      ...(runtime.validateOrgAgentDispatcherRuntime
        ? { validateOrgAgentDispatcherRuntime: runtime.validateOrgAgentDispatcherRuntime }
        : {}),
      skills: runtime.skillGovernanceStore,
      ...(runtime.skillConfigStore && runtime.userStore ? {
        importTenantSkill: createTenantSkillGovernanceUpload({
          skills: runtime.skillGovernanceStore,
          skillConfigStore: runtime.skillConfigStore,
          userStore: runtime.userStore,
          agentCwd: runtime.agentCwd,
          sharedDir: runtime.sharedDir,
          tenantSkillsRootDir: runtime.tenantSkillsRootDir,
        }),
        importPersonalSkill: createPersonalSkillGovernanceUpload({
          skills: runtime.skillGovernanceStore,
          skillConfigStore: runtime.skillConfigStore,
          userStore: runtime.userStore,
          agentCwd: runtime.agentCwd,
          sharedDir: runtime.sharedDir,
          tenantSkillsRootDir: runtime.tenantSkillsRootDir,
        }),
      } : {}),
      connectors: runtime.connectorCatalogStore,
      credentials: runtime.credentialStore,
      environments: runtime.environmentStore,
      changeJobs: runtime.governanceChangeJobStore,
      changePlanner: runtime.governanceChangePlanner,
      tenantExists: tenantId => Boolean(runtime.tenantStore?.findById(tenantId)),
      isCustomSkillsEnabled: tenantId => runtime.tenantStore?.getSettings(tenantId)?.features.customSkillsEnabled !== false,
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
      credentialHealthCheck: validateGovernanceCredentialHealth,
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
