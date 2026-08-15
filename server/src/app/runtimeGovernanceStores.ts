import { createHash } from 'node:crypto';
import type { AppConfig } from '../types/index.js';
import { serverLogger } from '../utils/logger.js';
import { PgEventStore } from '../runtime/pgEventStore.js';
import { PgGovernanceAuditStore, type GovernanceAuditStore } from '../data/governance-audit/index.js';
import { PgMembershipStore } from '../data/memberships/index.js';
import { normalizeLegacyEntitlementSettings, PgEntitlementStore } from '../data/entitlements/index.js';
import { PgAssignmentStore } from '../data/assignments/index.js';
import { PgDirectoryGroupStore } from '../data/directoryGroups/index.js';
import { PgOAuthGrantStore } from '../data/oauthGrants/index.js';
import { GovernanceShadowProjectionScheduler } from '../governance/migrations/shadowProjectionScheduler.js';
import { PgCredentialStore } from '../data/credentials/index.js';
import { PgConnectorCatalogStore } from '../data/connectorCatalog/index.js';
import { PgEnvironmentStore } from '../data/environments/index.js';
import { PgAgentResourceStore } from '../data/agentResources/index.js';
import { projectManagedOrgAgentVersion } from '../data/agentResources/orgAgentProjection.js';
import { PgAgentDwsAccountStore } from '../data/agentDwsAccounts/index.js';
import { PgAgentDwsMessageStore } from '../data/agentDwsMessages/index.js';
import { PgSkillGovernanceStore } from '../data/skillGovernance/index.js';
import { GovernanceChangePlanner, PgGovernanceChangeJobStore } from '../data/changeJobs/index.js';
import { PgContentAccessGrantStore } from '../data/contentAccess/index.js';
import { GovernanceProjectionReconciler, PgGovernanceProjectionOutboxStore } from '../data/governanceProjection/index.js';
import { GovernanceShadowComparator, GovernanceWriteGate, PgGovernanceMigrationControlStore } from '../data/migrationControl/index.js';
import { PgResourceReferenceStore } from '../data/resourceReferences/index.js';
import { PgRunResolutionSnapshotStore } from '../runtime/runResolutionSnapshotStore.js';
import { UserStore } from '../data/users/store.js';
import { TenantStore } from '../data/tenants/store.js';
import { DEFAULT_TENANT_ID, DEFAULT_TENANT_SETTINGS } from '../data/tenants/types.js';
import { OrgAgentStore } from '../data/orgAgents/store.js';
import { SkillConfigStore } from '../data/skills/index.js';
import { createAuthMiddleware } from '../auth/middleware.js';

export interface RuntimeGovernanceStoreDeps {
  pgEventStore: PgEventStore;
  tablePrefix?: string;
  config: Pick<AppConfig, 'auth' | 'serverRemote'>;
  userStore?: UserStore;
  tenantStore?: TenantStore;
  orgAgentStore?: OrgAgentStore;
  skillConfigStore?: SkillConfigStore;
}

const PERSONAL_SKILL_RESOURCE_ID_PATTERN = /^personal_[a-f0-9]{32}$/;

export function resolveLegacySkillIdForPreferenceProjection(
  resourceId: string,
  definition?: Record<string, unknown>,
): string | undefined {
  const legacySkillId = definition?.legacySkillId;
  if (typeof legacySkillId === 'string' && legacySkillId.length > 0) return legacySkillId;
  return PERSONAL_SKILL_RESOURCE_ID_PATTERN.test(resourceId) ? undefined : resourceId;
}

export async function resolveLegacyAssignmentAudience(input: {
  tenantId: string;
  assignments: Array<{
    assigneeType: 'everyone' | 'user' | 'directory_group' | 'agent';
    assigneeId?: string;
    effect: 'allow' | 'deny';
  }>;
  directoryGroups?: {
    getAssignmentSnapshot(tenantId: string, groupId: string): Promise<{
      memberUserIds: string[];
      fresh: boolean;
    } | null>;
  };
  findUserById(userId: string): { tenantId: string; username: string } | undefined;
}): Promise<{
  exposure: 'all' | 'allow_users' | 'deny_users';
  usernames: string[];
  departmentIds: string[];
}> {
  if (input.assignments.some(item => item.assigneeType === 'agent')) {
    throw new Error('GOVERNANCE_PROJECTION_UNSUPPORTED_ASSIGNEE');
  }

  const allowUserIds = new Set<string>();
  const denyUserIds = new Set<string>();
  const departmentIds: string[] = [];
  const seenDepartmentIds = new Set<string>();
  for (const assignment of input.assignments) {
    if (assignment.assigneeType === 'everyone') continue;
    if (assignment.assigneeType === 'user') {
      if (!assignment.assigneeId) throw new Error('GOVERNANCE_PROJECTION_INVALID');
      (assignment.effect === 'deny' ? denyUserIds : allowUserIds).add(assignment.assigneeId);
      continue;
    }
    if (assignment.assigneeType !== 'directory_group') {
      throw new Error('GOVERNANCE_PROJECTION_UNSUPPORTED_ASSIGNEE');
    }
    if (!assignment.assigneeId) throw new Error('GOVERNANCE_PROJECTION_INVALID');
    if (!input.directoryGroups) {
      throw new Error('GOVERNANCE_PROJECTION_DIRECTORY_GROUP_AUTHORITY_UNAVAILABLE');
    }
    const snapshot = await input.directoryGroups.getAssignmentSnapshot(input.tenantId, assignment.assigneeId);
    if (!snapshot || !snapshot.fresh) {
      throw new Error('GOVERNANCE_PROJECTION_DIRECTORY_GROUP_UNRESOLVED');
    }
    if (!seenDepartmentIds.has(assignment.assigneeId)) {
      seenDepartmentIds.add(assignment.assigneeId);
      departmentIds.push(assignment.assigneeId);
    }
    const target = assignment.effect === 'deny' ? denyUserIds : allowUserIds;
    for (const memberUserId of snapshot.memberUserIds) target.add(memberUserId);
  }

  const usernamesByUserId = new Map<string, string>();
  for (const userId of new Set([...allowUserIds, ...denyUserIds])) {
    const user = input.findUserById(userId);
    if (!user || user.tenantId !== input.tenantId || !user.username) {
      throw new Error('GOVERNANCE_PROJECTION_IDENTITY_UNRESOLVED');
    }
    usernamesByUserId.set(userId, user.username);
  }
  const usernamesFor = (userIds: Set<string>) => [...new Set(
    [...userIds].map(userId => usernamesByUserId.get(userId)!),
  )];
  const denyUsernames = usernamesFor(denyUserIds);
  const deniedUsernameSet = new Set(denyUsernames);
  const allowUsernames = usernamesFor(allowUserIds).filter(username => !deniedUsernameSet.has(username));

  const everyoneAssignments = input.assignments.filter(item => item.assigneeType === 'everyone');
  if (everyoneAssignments.some(item => item.effect === 'deny')) {
    return { exposure: 'allow_users', usernames: [], departmentIds };
  }
  if (everyoneAssignments.some(item => item.effect === 'allow')) {
    return denyUsernames.length > 0
      ? { exposure: 'deny_users', usernames: denyUsernames, departmentIds }
      : { exposure: 'all', usernames: [], departmentIds };
  }
  return { exposure: 'allow_users', usernames: allowUsernames, departmentIds };
}

/** Initializes durable governance stores in the same fail-closed order as runtime bootstrap. */
export async function initializeRuntimeGovernanceStores(deps: RuntimeGovernanceStoreDeps) {
  const { pgEventStore, tablePrefix, config, userStore, tenantStore, orgAgentStore, skillConfigStore } = deps;
  let authMiddleware: ReturnType<typeof createAuthMiddleware> | undefined;
  let governanceAuditStore: GovernanceAuditStore | undefined;
  let membershipStore: PgMembershipStore | undefined;
  let entitlementStore: PgEntitlementStore | undefined;
  let directoryGroupStore: PgDirectoryGroupStore | undefined;
  let oauthGrantStore: PgOAuthGrantStore | undefined;
  let assignmentStore: PgAssignmentStore | undefined;
  let credentialStore: PgCredentialStore | undefined;
  let connectorCatalogStore: PgConnectorCatalogStore | undefined;
  let environmentStore: PgEnvironmentStore | undefined;
  let agentResourceStore: PgAgentResourceStore | undefined;
  let agentDwsAccountStore: PgAgentDwsAccountStore | undefined;
  let agentDwsMessageStore: PgAgentDwsMessageStore | undefined;
  let skillGovernanceStore: PgSkillGovernanceStore | undefined;
  let resolveLegacySkillResourceId = (_user: { id: string; tenantId: string }, skillId: string) => skillId;
  let governanceChangeJobStore: PgGovernanceChangeJobStore | undefined;
  let governanceChangePlanner: GovernanceChangePlanner | undefined;
  let governanceMigrationControlStore: PgGovernanceMigrationControlStore | undefined;
  let governanceWriteGate: GovernanceWriteGate | undefined;
  let governanceShadowComparator: GovernanceShadowComparator | undefined;
  let contentAccessGrantStore: PgContentAccessGrantStore | undefined;
  let governanceProjectionOutboxStore: PgGovernanceProjectionOutboxStore | undefined;
  let governanceProjectionReconciler: GovernanceProjectionReconciler | undefined;
  let resourceReferenceStore: PgResourceReferenceStore | undefined;
  let runResolutionSnapshotStore: PgRunResolutionSnapshotStore | undefined;
  let flushGovernanceShadowProjections: (() => Promise<void>) | undefined;

    const pgGovernanceAuditStore = new PgGovernanceAuditStore({
      pool: pgEventStore.pool,
      tablePrefix: tablePrefix,
    });
    await pgGovernanceAuditStore.init();
    governanceAuditStore = pgGovernanceAuditStore;
    membershipStore = new PgMembershipStore({
      pool: pgEventStore.pool,
      tablePrefix: tablePrefix,
    });
    await membershipStore.init();
    if (userStore && tenantStore) {
      try {
        const backfill = await membershipStore.backfillLegacyIdentities({
          users: userStore.listAll(),
          tenants: tenantStore.listAll(),
          projectedBy: 'system:governance-m1',
          platformTenantId: DEFAULT_TENANT_ID,
        });
        serverLogger.info(
          `Governance Membership shadow backfill: memberships=${backfill.membershipsProjected} `
          + `platformAdmins=${backfill.platformAdminsProjected} issues=${backfill.issuesRecorded}`,
        );
      } catch (error) {
        serverLogger.warn(
          `Governance Membership shadow backfill failed; legacy authority remains active: `
          + `${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    if (config.auth?.enabled && config.auth.jwtSecret && userStore && tenantStore) {
      authMiddleware = createAuthMiddleware(
        config.auth.jwtSecret,
        userStore,
        tenantStore,
        config.auth.tokenExpiresIn || '30d',
        membershipStore,
      );
    }
    entitlementStore = new PgEntitlementStore({
      pool: pgEventStore.pool,
      tablePrefix: tablePrefix,
      platformTenantId: DEFAULT_TENANT_ID,
    });
    await entitlementStore.init();
    if (tenantStore) {
      try {
        const backfill = await entitlementStore.backfillLegacySettings({
          tenants: tenantStore.listAll(),
          projectedBy: 'system:governance-m1',
          platformTenantId: DEFAULT_TENANT_ID,
        });
        serverLogger.info(
          `Governance Entitlement shadow backfill: tenants=${backfill.tenantsProjected} `
          + `scopes=${backfill.scopesProjected} policies=${backfill.policiesProjected} `
          + `issues=${backfill.issuesRecorded}`,
        );
      } catch (error) {
        serverLogger.warn(
          `Governance Entitlement shadow backfill failed; legacy authority remains active: `
          + `${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    directoryGroupStore = new PgDirectoryGroupStore({
      pool: pgEventStore.pool,
      tablePrefix: tablePrefix,
      validateMember: async (tenantId, userId) => (await membershipStore!.getMembership(tenantId, userId))?.status === 'active',
    });
    await directoryGroupStore.init();
    oauthGrantStore = new PgOAuthGrantStore({ pool: pgEventStore.pool, tablePrefix });
    await oauthGrantStore.init();
    assignmentStore = new PgAssignmentStore({
      pool: pgEventStore.pool,
      tablePrefix: tablePrefix,
      platformTenantId: DEFAULT_TENANT_ID,
    });
    await assignmentStore.init();
    credentialStore = new PgCredentialStore({
      pool: pgEventStore.pool,
      tablePrefix: tablePrefix,
    });
    await credentialStore.init();
    connectorCatalogStore = new PgConnectorCatalogStore({
      pool: pgEventStore.pool,
      tablePrefix: tablePrefix,
    });
    await connectorCatalogStore.init();
    const connectorCatalogBackfill = await connectorCatalogStore.ensureBuiltins('system:builtin-catalog');
    serverLogger.info(
      `Connector Catalog builtin registration: created=${connectorCatalogBackfill.created} `
      + `unchanged=${connectorCatalogBackfill.unchanged}`,
    );
    environmentStore = new PgEnvironmentStore({
      pool: pgEventStore.pool,
      tablePrefix: tablePrefix,
    });
    await environmentStore.init();
    for (const provider of [
      { providerId: 'server-local', endpointRef: 'in-process', status: 'enabled' as const },
      ...(config.serverRemote?.baseUrl
        ? [{ providerId: 'server-remote', endpointRef: config.serverRemote.baseUrl, status: 'enabled' as const }]
        : []),
    ]) {
      const current = await environmentStore.getProvider(provider.providerId);
      await environmentStore.upsertProvider({
        ...provider,
        networkPolicy: {},
        rolloutPolicy: { source: 'legacy_runtime_projection' },
        updatedBy: 'system:governance-shadow',
        ...(current ? { expectedRevision: current.revision } : {}),
      });
    }
    contentAccessGrantStore = new PgContentAccessGrantStore({
      pool: pgEventStore.pool,
      tablePrefix: tablePrefix,
    });
    await contentAccessGrantStore.init();
    governanceProjectionOutboxStore = new PgGovernanceProjectionOutboxStore({
      pool: pgEventStore.pool,
      tablePrefix: tablePrefix,
    });
    governanceProjectionReconciler = new GovernanceProjectionReconciler({
      store: governanceProjectionOutboxStore,
      workerId: `runtime:${process.pid}`,
      executeFenced: async (item, operation) => {
        const payload = item.payload;
        const target = typeof payload.userId === 'string'
          ? payload.userId
          : typeof payload.resourceId === 'string'
            ? `${String(payload.resourceType ?? 'resource')}:${payload.resourceId}`
            : typeof payload.policyKey === 'string'
              ? payload.policyKey
              : item.tenantId;
        const projectsLegacyOrgAgents = item.projector === 'org_agent'
          || (item.projector === 'assignment' && payload.resourceType === 'org_agent');
        const fenceKey = projectsLegacyOrgAgents
          ? 'governance-projection:legacy-org-agents-file'
          : `${item.tenantId}:${item.projector}:${target}`;
        const client = await pgEventStore!.pool.connect();
        let locked = false;
        try {
          await client.query('SELECT pg_advisory_lock(hashtext($1))', [fenceKey]);
          locked = true;
          await operation();
        } finally {
          if (locked) {
            await client.query('SELECT pg_advisory_unlock(hashtext($1))', [fenceKey]).catch(() => undefined);
          }
          client.release();
        }
      },
      projectors: {
        audit_terminal: async (payload, outboxItem) => {
          if (!governanceAuditStore) throw new Error('GOVERNANCE_AUDIT_UNAVAILABLE');
          const result = payload.result === 'succeeded' ? 'succeeded' : payload.result === 'failed' ? 'failed' : undefined;
          const actorPersona = ['platform_admin', 'org_admin', 'member', 'service'].includes(String(payload.actorPersona))
            ? String(payload.actorPersona) as 'platform_admin' | 'org_admin' | 'member' | 'service'
            : undefined;
          if (!result || !actorPersona) throw new Error('GOVERNANCE_PROJECTION_INVALID');
          const metadata = Object.fromEntries(Object.entries(
            typeof payload.metadata === 'object' && payload.metadata ? payload.metadata : {},
          ).filter(([, value]) => value === null || ['string', 'number', 'boolean'].includes(typeof value))) as Record<string, string | number | boolean | null>;
          await governanceAuditStore.append({
            auditId: `projection:${outboxItem.outboxId}`,
            correlationId: String(payload.correlationId),
            ...(typeof payload.changeId === 'string' ? { changeId: payload.changeId } : {}),
            actorType: payload.actorType === 'service' ? 'service' : 'user',
            actorUserId: String(payload.actorUserId),
            actorPersona,
            ...(typeof payload.actorTenantId === 'string' ? { actorTenantId: payload.actorTenantId } : {}),
            action: String(payload.action),
            targetType: String(payload.targetType),
            targetId: String(payload.targetId),
            ...(typeof payload.targetTenantId === 'string' ? { targetTenantId: payload.targetTenantId } : {}),
            purpose: String(payload.purpose),
            result,
            metadata,
          });
        },
        org_agent: async payload => {
          if (!agentResourceStore || !orgAgentStore) throw new Error('GOVERNANCE_PROJECTION_INVALID');
          await projectManagedOrgAgentVersion({
            agents: agentResourceStore,
            legacyAgents: orgAgentStore,
          }, payload);
        },
        tenant_settings: async payload => {
          const tenantId = typeof payload.tenantId === 'string' ? payload.tenantId : '';
          const tenant = tenantStore?.findById(tenantId);
          const snapshot = await entitlementStore?.getProjectionSnapshot(tenantId) as {
            limits?: Record<string, number>;
            scopes?: Array<{ resourceType: string; mode: string; resourceIds: string[] }>;
            policies?: Array<{ policyKey: string; value: unknown }>;
          } | undefined;
          if (!tenant || !snapshot) throw new Error('GOVERNANCE_PROJECTION_INVALID');
          const current = tenant.settings ?? DEFAULT_TENANT_SETTINGS;
          const policy = new Map((snapshot.policies ?? []).map(item => [item.policyKey, item.value]));
          const bool = (key: string, fallback: boolean) => {
            const value = policy.get(key);
            return typeof value === 'boolean' ? value : fallback;
          };
          const modelScope = snapshot.scopes?.find(scope => scope.resourceType === 'model');
          await tenantStore!.updateSettings(tenantId, {
            ...current,
            features: {
              ...current.features,
              filesEnabled: bool('session.files.enabled', current.features.filesEnabled),
              cronEnabled: bool('automation.cron.enabled', current.features.cronEnabled),
              mcpEnabled: bool('connector.mcp.enabled', current.features.mcpEnabled),
              customSkillsEnabled: bool('skill.custom.enabled', current.features.customSkillsEnabled),
              debugModeAllowed: bool('runtime.debug_mode.allowed', current.features.debugModeAllowed),
              autoCompactEnabled: bool('session.auto_compact.enabled', current.features.autoCompactEnabled),
              personalAgentEnabled: bool('agent.personal.enabled', current.features.personalAgentEnabled ?? true),
              kbEnabled: bool('knowledge.org.enabled', current.features.kbEnabled ?? false),
              memoryPollingEnabled: bool('memory.polling.enabled', current.features.memoryPollingEnabled ?? false),
              memoryPollChargesCredits: bool('memory.polling.billable', current.features.memoryPollChargesCredits ?? false),
              memoryConsolidationEnabled: bool('memory.consolidation.enabled', current.features.memoryConsolidationEnabled ?? false),
              memoryWriteDelegationEnabled: bool('memory.write_delegation.enabled', current.features.memoryWriteDelegationEnabled ?? false),
              imageGenEnabled: bool('tool.image_gen.enabled', current.features.imageGenEnabled ?? false),
            },
            quotas: { ...current.quotas, ...(snapshot.limits ?? {}) },
            models: {
              ...current.models,
              ...(modelScope ? { allowedModels: modelScope.mode === 'selected' ? modelScope.resourceIds : [] } : {}),
              allowUserModelSwitch: bool('model.user_switch.allowed', current.models.allowUserModelSwitch),
              showGroupNames: bool('model.group_names.visible', current.models.showGroupNames),
              showContextTokens: bool('session.context_tokens.visible', current.models.showContextTokens ?? true),
              allowContextTokenDetails: bool('session.context_token_details.allowed', current.models.allowContextTokenDetails ?? false),
            },
            mcp: {
              ...current.mcp,
              allowTenantServers: bool('connector.tenant_servers.allowed', current.mcp.allowTenantServers),
              allowGlobalServers: bool('connector.global_servers.allowed', current.mcp.allowGlobalServers),
            },
            personalization: {
              ...current.personalization,
              firstDayGuideBarEnabled: bool('org.first_day_guide_bar.enabled', current.personalization.firstDayGuideBarEnabled),
            },
            security: {
              ...current.security,
              requireDingtalkBinding: bool('security.dingtalk_binding.required', current.security.requireDingtalkBinding),
            },
          });
        },
        assignment: async payload => {
          const tenantId = typeof payload.tenantId === 'string' ? payload.tenantId : '';
          const resourceType = typeof payload.resourceType === 'string' ? payload.resourceType : '';
          const resourceId = typeof payload.resourceId === 'string' ? payload.resourceId : '';
          const set = await assignmentStore?.getAssignmentSet(tenantId, resourceType as import('../data/assignments/types.js').AssignmentResourceType, resourceId);
          if (!set) throw new Error('GOVERNANCE_PROJECTION_INVALID');
          const audience = await resolveLegacyAssignmentAudience({
            tenantId,
            assignments: set.assignments,
            directoryGroups: directoryGroupStore,
            findUserById: userId => userStore?.findById(userId),
          });
          if (resourceType === 'org_agent') {
            const agent = orgAgentStore?.get(resourceId);
            if (!agent || agent.tenantId !== tenantId) throw new Error('GOVERNANCE_PROJECTION_INVALID');
            await orgAgentStore!.update(resourceId, {
              audience: {
                exposure: audience.exposure,
                usernames: audience.usernames,
                ...(audience.departmentIds.length > 0 ? { departmentIds: audience.departmentIds } : {}),
              },
            }, 'system:governance-projection');
          } else if (resourceType === 'skill') {
            const config = skillConfigStore?.getAllTenantConfigs()[tenantId];
            const rule = { enabled: true, exposure: audience.exposure, usernames: audience.usernames } as const;
            if (config?.ownSkills && Object.prototype.hasOwnProperty.call(config.ownSkills, resourceId)) {
              await skillConfigStore!.setTenantOwnSkillRules(tenantId, { [resourceId]: rule });
            } else {
              await skillConfigStore!.setTenantSkillRules(tenantId, { [resourceId]: rule });
            }
          }
        },
        preference: async payload => {
          const userId = typeof payload.userId === 'string' ? payload.userId : '';
          const user = userStore?.findById(userId);
          if (!user) throw new Error('GOVERNANCE_PROJECTION_INVALID');
          const preferences = await assignmentStore?.listUserPreferences(userId) ?? [];
          const selectedSkills: string[] = [];
          for (const item of preferences.filter(entry => entry.resourceType === 'skill' && entry.enabled)) {
            const resource = await skillGovernanceStore?.getResource(item.resourceId);
            const version = resource?.currentVersionId
              ? await skillGovernanceStore?.getVersion(resource.currentVersionId)
              : null;
            const legacySkillId = resolveLegacySkillIdForPreferenceProjection(
              item.resourceId,
              version?.definition,
            );
            if (legacySkillId) selectedSkills.push(legacySkillId);
          }
          await skillConfigStore?.setUserSelectedSkills(user.username, selectedSkills);
        },
        platform_admin: async payload => {
          const userId = typeof payload.userId === 'string' ? payload.userId : '';
          const platformAdmin = await membershipStore?.getPlatformAdmin(userId);
          const user = userStore?.findById(userId);
          if (!user || user.tenantId !== DEFAULT_TENANT_ID || !platformAdmin) {
            throw new Error('GOVERNANCE_PROJECTION_INVALID');
          }
          const expectedRole = platformAdmin.status === 'active' ? 'admin' : 'user';
          if (user.role !== expectedRole) {
            await userStore!.update(userId, { role: expectedRole });
          }
        },
        membership: async payload => {
          const userId = typeof payload.userId === 'string' ? payload.userId : '';
          const tenantId = typeof payload.tenantId === 'string' ? payload.tenantId : '';
          const membership = await membershipStore?.getMembership(tenantId, userId);
          const persona = membership?.persona;
          const status = membership?.status;
          const user = userStore?.findById(userId);
          if (!user || user.tenantId !== tenantId || !persona || !status) throw new Error('GOVERNANCE_PROJECTION_INVALID');
          if (tenantId !== DEFAULT_TENANT_ID) {
            await userStore!.update(userId, { role: persona === 'org_admin' ? 'admin' : 'user' });
          }
          if (Boolean(user.disabled) !== (status === 'disabled')) {
            await userStore!.setDisabled(userId, status === 'disabled', 'system:governance-projection');
          }
        },
      },
    });
    agentResourceStore = new PgAgentResourceStore({
      pool: pgEventStore.pool,
      tablePrefix: tablePrefix,
    });
    await agentResourceStore.init();
    agentDwsAccountStore = new PgAgentDwsAccountStore(pgEventStore.pool, tablePrefix);
    await agentDwsAccountStore.init();
    agentDwsMessageStore = new PgAgentDwsMessageStore(pgEventStore.pool, tablePrefix);
    await agentDwsMessageStore.init();
    skillGovernanceStore = new PgSkillGovernanceStore({
      pool: pgEventStore.pool,
      tablePrefix: tablePrefix,
    });
    await skillGovernanceStore.init();
    if (orgAgentStore && userStore && tenantStore && skillConfigStore) {
      const projectedBy = 'system:governance-shadow';
      for (const legacyAgent of orgAgentStore.listAll()) {
        let resource = await agentResourceStore.getForTenant(legacyAgent.tenantId, legacyAgent.id);
        if (!resource) {
          const owner = userStore.findById(legacyAgent.createdBy)
            ?? userStore.findByUsername(legacyAgent.createdBy)
            ?? userStore.listAll().find(user => user.tenantId === legacyAgent.tenantId && user.role === 'admin');
          if (!owner) continue;
          resource = await agentResourceStore.create({
            agentId: legacyAgent.id,
            tenantId: legacyAgent.tenantId,
            kind: 'org_agent',
            ownerUserId: owner.id,
            createdBy: projectedBy,
          });
        }
        if (resource.createdBy === projectedBy || resource.updatedBy === projectedBy) {
          const published = await agentResourceStore.publishVersion({
            tenantId: legacyAgent.tenantId,
            agentId: legacyAgent.id,
            expectedRevision: resource.revision,
            definition: {
              schemaVersion: 1,
              name: legacyAgent.name,
              description: legacyAgent.description,
              instructions: legacyAgent.instructions,
              skills: legacyAgent.allowedSkills.map(id => ({ id })),
              knowledge: legacyAgent.allowedKnowledge ?? [],
              guardrail: legacyAgent.guardrail,
              source: 'legacy_projection',
            },
            publishedBy: projectedBy,
          });
          resource = published.resource;
          const expectedStatus = legacyAgent.enabled ? 'enabled' : 'disabled';
          if (resource.status !== expectedStatus && resource.status !== 'draft') {
            await agentResourceStore.setStatus(
              legacyAgent.tenantId, legacyAgent.id, expectedStatus, resource.revision, projectedBy,
            );
          }
        }
      }
      for (const user of userStore.listAll().filter(item => item.tenantId !== DEFAULT_TENANT_ID)) {
        const agentId = `personal_agent_${createHash('sha256')
          .update(user.id)
          .digest('hex')
          .slice(0, 32)}`;
        let resource = await agentResourceStore.findPersonalByOwner(user.tenantId, user.id)
          ?? await agentResourceStore.getForTenant(user.tenantId, agentId);
        if (resource?.status === 'archived') continue;
        if (!resource) {
          resource = await agentResourceStore.create({
            agentId,
            tenantId: user.tenantId,
            kind: 'personal_agent',
            ownerUserId: user.id,
            createdBy: projectedBy,
          });
        }
        if (resource.createdBy === projectedBy || resource.updatedBy === projectedBy) {
          const published = await agentResourceStore.publishVersion({
            tenantId: user.tenantId,
            agentId: resource.agentId,
            expectedRevision: resource.revision,
            definition: { schemaVersion: 1, ownerUserId: user.id, source: 'legacy_projection' },
            publishedBy: projectedBy,
          });
          resource = published.resource;
          const expectedStatus = user.disabled ? 'disabled' : 'enabled';
          if (resource.status !== expectedStatus && resource.status !== 'draft') {
            await agentResourceStore.setStatus(
              user.tenantId, resource.agentId, expectedStatus, resource.revision, projectedBy,
            );
          }
        }
      }
      const tenantConfigs = skillConfigStore.getAllTenantConfigs();
      resolveLegacySkillResourceId = (user, skillId) => {
        const tenantConfig = tenantConfigs[user.tenantId];
        const shared = Boolean(
          tenantConfig?.enabledSkills?.includes(skillId)
          || Object.prototype.hasOwnProperty.call(tenantConfig?.skills ?? {}, skillId)
          || Object.prototype.hasOwnProperty.call(tenantConfig?.ownSkills ?? {}, skillId),
        );
        return shared ? skillId : `personal_${createHash('sha256')
          .update(`${user.id}\0${skillId}`)
          .digest('hex')
          .slice(0, 32)}`;
      };
      const platformSkillIds = new Set<string>();
      for (const configEntry of Object.values(tenantConfigs)) {
        for (const id of configEntry.enabledSkills ?? []) platformSkillIds.add(id);
        for (const id of Object.keys(configEntry.skills ?? {})) platformSkillIds.add(id);
      }
      const platformOwner = userStore.listAll().find(user => user.tenantId === DEFAULT_TENANT_ID && user.role === 'admin');
      if (platformOwner) {
        for (const skillId of platformSkillIds) {
          let resource = await skillGovernanceStore.getResource(skillId);
          if (!resource) {
            resource = await skillGovernanceStore.createResource({
              skillId, tenantId: DEFAULT_TENANT_ID, scope: 'platform',
              createdBy: projectedBy,
            });
          }
          if (resource.status === 'draft') {
            await skillGovernanceStore.publishVersion({
              tenantId: DEFAULT_TENANT_ID,
              skillId,
              expectedRevision: resource.revision,
              definition: { schemaVersion: 1, legacySkillId: skillId, source: 'legacy_projection' },
              publishedBy: projectedBy,
            });
          }
        }
      }
      for (const [tenantId, configEntry] of Object.entries(tenantConfigs)) {
        for (const skillId of Object.keys(configEntry.ownSkills ?? {})) {
          let resource = await skillGovernanceStore.getResource(skillId);
          if (resource && resource.tenantId !== tenantId) continue;
          if (!resource) {
            resource = await skillGovernanceStore.createResource({
              skillId, tenantId, scope: 'tenant', createdBy: projectedBy,
            });
          }
          if (resource.status === 'draft') {
            await skillGovernanceStore.publishVersion({
              tenantId, skillId, expectedRevision: resource.revision,
              definition: { schemaVersion: 1, legacySkillId: skillId, source: 'legacy_projection' },
              publishedBy: projectedBy,
            });
          }
        }
      }
      for (const [username, userConfig] of Object.entries(skillConfigStore.getAllUserConfigs())) {
        const user = userStore.findByUsername(username);
        if (!user || user.tenantId === DEFAULT_TENANT_ID) continue;
        for (const legacySkillId of new Set(userConfig.selectedSkills)) {
          const skillId = resolveLegacySkillResourceId(user, legacySkillId);
          if (skillId === legacySkillId) continue;
          let resource = await skillGovernanceStore.getResource(skillId);
          if (!resource) {
            resource = await skillGovernanceStore.createResource({
              skillId, tenantId: user.tenantId, scope: 'personal',
              ownerUserId: user.id, createdBy: projectedBy,
            });
          }
          if (resource.status === 'draft') {
            await skillGovernanceStore.publishVersion({
              tenantId: user.tenantId, skillId, expectedRevision: resource.revision,
              definition: { schemaVersion: 1, legacySkillId, source: 'legacy_projection' },
              publishedBy: projectedBy,
            });
          }
        }
      }
    }
    governanceChangeJobStore = new PgGovernanceChangeJobStore({
      pool: pgEventStore.pool,
      tablePrefix: tablePrefix,
    });
    await governanceChangeJobStore.init();
    governanceMigrationControlStore = new PgGovernanceMigrationControlStore({
      pool: pgEventStore.pool,
      tablePrefix: tablePrefix,
    });
    await governanceMigrationControlStore.init();
    governanceWriteGate = new GovernanceWriteGate(governanceMigrationControlStore);
    governanceShadowComparator = new GovernanceShadowComparator(governanceMigrationControlStore);
    if (userStore && tenantStore && membershipStore) {
      try {
        let matchedCount = 0;
        let differenceCount = 0;
        for (const user of userStore.listAll()) {
          const legacy = user.tenantId === DEFAULT_TENANT_ID
            ? user.role === 'admin'
              ? {
                  userId: user.id,
                  status: user.disabled ? 'disabled' : 'active',
                }
              : undefined
            : {
                tenantId: user.tenantId,
                userId: user.id,
                persona: user.role === 'admin' ? 'org_admin' : 'member',
                status: user.disabled ? 'disabled' : 'active',
              };
          const governance = user.tenantId === DEFAULT_TENANT_ID
            ? await membershipStore.getPlatformAdmin(user.id).then(projected => projected
              ? { userId: projected.userId, status: projected.status }
              : undefined)
            : await membershipStore.getMembership(user.tenantId, user.id).then(projected => projected
              ? {
                  tenantId: projected.tenantId,
                  userId: projected.userId,
                  persona: projected.persona,
                  status: projected.status,
                }
              : undefined);
          const compared = await governanceShadowComparator.compare({
            domain: 'membership',
            tenantId: user.tenantId,
            resourceType: user.tenantId === DEFAULT_TENANT_ID ? 'platform_admin' : 'membership',
            resourceId: user.id,
            legacy,
            governance,
            blocking: true,
          });
          if (compared.matched) matchedCount += 1;
          else differenceCount += 1;
        }
        const membershipDomain = (await governanceMigrationControlStore.listDomains())
          .find(domain => domain.domain === 'membership');
        if (membershipDomain) {
          await governanceMigrationControlStore.recordDomainSnapshot({
            domain: 'membership',
            expectedRevision: membershipDomain.revision,
            comparedCount: matchedCount + differenceCount,
            matchedCount,
            differenceCount,
            unresolvedBlockingCount: differenceCount,
            updatedBy: 'system:shadow-auditor',
          });
        }
      } catch (error) {
        serverLogger.warn(
          `Governance membership shadow comparison failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    resourceReferenceStore = new PgResourceReferenceStore({
      pool: pgEventStore.pool,
      tablePrefix: tablePrefix,
    });
    await resourceReferenceStore.init();
    governanceChangePlanner = new GovernanceChangePlanner({
      references: resourceReferenceStore,
      credentials: credentialStore,
      jobs: governanceChangeJobStore,
    });
    runResolutionSnapshotStore = new PgRunResolutionSnapshotStore(
      pgEventStore.pool,
      tablePrefix,
    );
    await runResolutionSnapshotStore.init();
    if (userStore && orgAgentStore && skillConfigStore) {
      try {
        const backfill = await assignmentStore.backfillLegacyAssignments({
          users: userStore.listAll(),
          orgAgents: orgAgentStore.listAll(),
          tenantSkillConfigs: skillConfigStore.getAllTenantConfigs(),
          userSkillConfigs: skillConfigStore.getAllUserConfigs(),
          projectedBy: 'system:governance-m1',
          platformTenantId: DEFAULT_TENANT_ID,
          resolveSkillResourceId: resolveLegacySkillResourceId,
        });
        serverLogger.info(
          `Governance Assignment shadow backfill: sets=${backfill.resourceSetsProjected} `
          + `assignments=${backfill.assignmentsProjected} preferences=${backfill.preferencesProjected} `
          + `issues=${backfill.issuesRecorded}`,
        );
      } catch (error) {
        serverLogger.warn(
          `Governance Assignment shadow backfill failed; legacy authority remains active: `
          + `${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    if (userStore && tenantStore && orgAgentStore && skillConfigStore) {
      const shadowScheduler = new GovernanceShadowProjectionScheduler({
        membership: async () => {
          await membershipStore!.backfillLegacyIdentities({
            users: userStore!.listAll(),
            tenants: tenantStore!.listAll(),
            projectedBy: 'system:governance-shadow',
            platformTenantId: DEFAULT_TENANT_ID,
          });
        },
        entitlement: async () => {
          await entitlementStore!.backfillLegacySettings({
            tenants: tenantStore!.listAll(),
            projectedBy: 'system:governance-shadow',
            platformTenantId: DEFAULT_TENANT_ID,
          });
        },
        assignment: async () => {
          await assignmentStore!.backfillLegacyAssignments({
            users: userStore!.listAll(),
            orgAgents: orgAgentStore!.listAll(),
            tenantSkillConfigs: skillConfigStore!.getAllTenantConfigs(),
            userSkillConfigs: skillConfigStore!.getAllUserConfigs(),
            projectedBy: 'system:governance-shadow',
            platformTenantId: DEFAULT_TENANT_ID,
            resolveSkillResourceId: resolveLegacySkillResourceId,
          });
        },
      }, (name, error) => {
        serverLogger.warn(
          `Governance ${name} shadow projection failed; next mutation or restart will retry: `
          + `${error instanceof Error ? error.message : String(error)}`,
        );
      });
      const scheduleMembership = () => shadowScheduler.schedule('membership');
      const scheduleEntitlement = () => shadowScheduler.schedule('entitlement');
      const scheduleAssignment = () => shadowScheduler.schedule('assignment');
      userStore.setPostPersistObserver(() => {
        scheduleMembership();
        scheduleAssignment();
      });
      tenantStore.setPostPersistObserver(() => {
        scheduleMembership();
        scheduleEntitlement();
      });
      orgAgentStore.setPostPersistObserver(scheduleAssignment);
      skillConfigStore.setPostPersistObserver(scheduleAssignment);
      flushGovernanceShadowProjections = () => shadowScheduler.flush();
    }

  return {
    authMiddleware,
    governanceAuditStore,
    membershipStore,
    entitlementStore,
    directoryGroupStore,
    oauthGrantStore,
    assignmentStore,
    credentialStore,
    connectorCatalogStore,
    environmentStore,
    agentResourceStore,
    agentDwsAccountStore,
    agentDwsMessageStore,
    skillGovernanceStore,
    resolveLegacySkillResourceId,
    governanceChangeJobStore,
    governanceChangePlanner,
    governanceMigrationControlStore,
    governanceWriteGate,
    governanceShadowComparator,
    contentAccessGrantStore,
    governanceProjectionOutboxStore,
    governanceProjectionReconciler,
    resourceReferenceStore,
    runResolutionSnapshotStore,
    flushGovernanceShadowProjections,
  };
}
