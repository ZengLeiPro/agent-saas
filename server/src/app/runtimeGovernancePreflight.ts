import { serverLogger } from '../utils/logger.js';
import { UserStore } from '../data/users/store.js';
import { TenantStore } from '../data/tenants/store.js';
import { DEFAULT_TENANT_ID } from '../data/tenants/types.js';
import { OrgAgentStore } from '../data/orgAgents/store.js';
import { PgMembershipStore } from '../data/memberships/index.js';
import { PgEntitlementStore } from '../data/entitlements/index.js';
import { PgAssignmentStore } from '../data/assignments/index.js';
import { PgCredentialStore } from '../data/credentials/index.js';
import { PgConnectorCatalogStore } from '../data/connectorCatalog/index.js';
import { PgEnvironmentStore } from '../data/environments/index.js';
import { PgAgentResourceStore } from '../data/agentResources/index.js';
import { PgSkillGovernanceStore } from '../data/skillGovernance/index.js';
import { GovernanceShadowComparator, PgGovernanceMigrationControlStore } from '../data/migrationControl/index.js';
import { SubjectResolver } from '../governance/subject/resolver.js';
import { AccessEvaluator } from '../governance/access/evaluator.js';
import {
  AssignmentPolicy,
  EntitlementPolicy,
  LongTermGrantPolicy,
  PersonaPolicy,
  PlatformInvariantPolicy,
  RuntimeApprovalPolicy,
  TenantPolicy,
} from '../governance/access/policies/index.js';
import { ReadinessEvaluator } from '../governance/readiness/evaluator.js';
import { RunPreflightService } from '../runtime/runPreflight.js';
import { PgRunResolutionSnapshotStore } from '../runtime/runResolutionSnapshotStore.js';
import { FileSessionCatalog } from '../runtime/sessionCatalog.js';
import { BillingService } from '../data/billing/service.js';
import type { ModelResolver } from './modelResolvers.js';

export interface RuntimeGovernancePreflightDeps {
  sessionCatalog: FileSessionCatalog;
  userStore?: UserStore;
  tenantStore?: TenantStore;
  orgAgentStore?: OrgAgentStore;
  membershipStore?: PgMembershipStore;
  entitlementStore?: PgEntitlementStore;
  assignmentStore?: PgAssignmentStore;
  credentialStore?: PgCredentialStore;
  connectorCatalogStore?: PgConnectorCatalogStore;
  environmentStore?: PgEnvironmentStore;
  agentResourceStore?: PgAgentResourceStore;
  skillGovernanceStore?: PgSkillGovernanceStore;
  governanceMigrationControlStore?: PgGovernanceMigrationControlStore;
  governanceShadowComparator?: GovernanceShadowComparator;
  runResolutionSnapshotStore?: PgRunResolutionSnapshotStore;
  billingService?: BillingService;
  modelResolver?: ModelResolver;
}

/** Builds the run preflight chain only when every mandatory governance authority is available. */
export function initializeRuntimeGovernancePreflight(deps: RuntimeGovernancePreflightDeps) {
  const {
    sessionCatalog, userStore, tenantStore, orgAgentStore, membershipStore, entitlementStore,
    assignmentStore, credentialStore, connectorCatalogStore, environmentStore, agentResourceStore,
    skillGovernanceStore, governanceMigrationControlStore, governanceShadowComparator,
    runResolutionSnapshotStore, billingService, modelResolver,
  } = deps;
  let runPreflightService: RunPreflightService | undefined;

  // Access/Run：统一 Subject → AccessDecision → Readiness → Preflight。
  // 迁移控制动态切换 shadow/enforce；控制 revision 在评估前后复核并写入 Snapshot。
  if (membershipStore && entitlementStore && assignmentStore && userStore && tenantStore && orgAgentStore) {
    runPreflightService = new RunPreflightService({
      enforcementMode: 'shadow',
      ...(governanceMigrationControlStore ? {
        resolveEnforcementState: async () => {
          const control = await governanceMigrationControlStore!.getControl();
          return { mode: control.mode === 'enforce' ? 'enforce' : 'shadow', revision: control.revision };
        },
      } : {}),
      subjectResolver: new SubjectResolver(userStore, membershipStore),
      accessEvaluator: new AccessEvaluator([
        new PlatformInvariantPolicy(),
        new EntitlementPolicy(entitlementStore),
        new PersonaPolicy(),
        new TenantPolicy(entitlementStore),
        new AssignmentPolicy(assignmentStore),
        new LongTermGrantPolicy(),
        new RuntimeApprovalPolicy(),
      ]),
      ...(governanceShadowComparator && governanceMigrationControlStore ? {
        compareLegacyAccess: async ({ request, governanceDecision }) => {
          const tenant = request.resource.tenantId ? tenantStore.findById(request.resource.tenantId) : undefined;
          const subjectActive = request.subject.subjectType === 'human'
            ? request.subject.accountStatus === 'active'
            : true;
          const sameTenant = !request.resource.tenantId || request.resource.tenantId === request.subject.tenantId;
          const orgAgent = request.resource.type === 'org_agent' ? orgAgentStore.get(request.resource.id) : undefined;
          const legacyAllowed = subjectActive
            && sameTenant
            && tenant?.disabled !== true
            && request.resource.enabled !== false
            && (!orgAgent || (orgAgent.tenantId === request.subject.tenantId && orgAgent.enabled));
          const comparison = await governanceShadowComparator!.compare({
            domain: 'run_snapshot',
            tenantId: request.subject.tenantId,
            resourceType: request.resource.type,
            resourceId: request.resource.id,
            legacy: { verdict: legacyAllowed ? 'allow' : 'deny' },
            governance: { verdict: governanceDecision.verdict },
            blocking: true,
          });
          await governanceMigrationControlStore!.incrementDomainComparison('run_snapshot', comparison.matched);
        },
      } : {}),
      readinessEvaluator: new ReadinessEvaluator(),
      sessionCatalog,
      orgAgentStore,
      ...(agentResourceStore ? { agentResourceStore } : {}),
      ...(credentialStore && connectorCatalogStore && skillGovernanceStore ? {
        resolveTypedBindings: async ({ tenantId, userId, agentId }) => {
          const [skillBindings, credentialBindings, preferences] = await Promise.all([
            assignmentStore.listEffectiveResourceIds(tenantId, userId, 'skill', agentId),
            assignmentStore.listEffectiveResourceIds(tenantId, userId, 'credential', agentId),
            assignmentStore.listUserPreferences(userId),
          ]);
          const disabledSkills = new Set(preferences
            .filter(item => item.resourceType === 'skill' && !item.enabled)
            .map(item => item.resourceId));
          const effectiveSkillBindings = [...skillBindings];
          const skills = [] as import('../runtime/runResolutionSnapshotStore.js').ResolvedResourceRef[];
          for (const binding of effectiveSkillBindings.filter(item => !disabledSkills.has(item.resourceId))) {
            const resource = await skillGovernanceStore!.getResource(binding.resourceId);
            if (!resource || resource.status !== 'published') continue;
            if (resource.scope === 'platform' && resource.tenantId !== DEFAULT_TENANT_ID) continue;
            if (resource.scope === 'tenant' && resource.tenantId !== tenantId) continue;
            if (resource.scope === 'personal'
              && (resource.tenantId !== tenantId || resource.ownerUserId !== userId)) continue;
            const version = resource.currentVersionId
              ? await skillGovernanceStore!.getVersion(resource.currentVersionId)
              : null;
            skills.push({
              id: resource.skillId, revision: resource.revision,
              bindingId: binding.bindingId,
              ...(version ? { versionId: version.versionId, version: version.versionNumber } : {}),
            });
          }
          for (const preference of preferences.filter(item => item.resourceType === 'skill' && item.enabled)) {
            if (skills.some(skill => skill.id === preference.resourceId)) continue;
            const resource = await skillGovernanceStore!.getResource(preference.resourceId);
            if (!resource || resource.status !== 'published' || resource.scope !== 'personal'
              || resource.tenantId !== tenantId || resource.ownerUserId !== userId) continue;
            const version = resource.currentVersionId
              ? await skillGovernanceStore!.getVersion(resource.currentVersionId)
              : null;
            skills.push({
              id: resource.skillId,
              revision: resource.revision,
              bindingId: `preference:${preference.userId}:${preference.resourceId}`,
              ...(version ? { versionId: version.versionId, version: version.versionNumber } : {}),
            });
          }
          const credentials = [] as import('../runtime/runResolutionSnapshotStore.js').ResolvedResourceRef[];
          const connectorsById = new Map<string, import('../runtime/runResolutionSnapshotStore.js').ResolvedResourceRef>();
          for (const binding of credentialBindings) {
            const credential = await credentialStore!.get(binding.resourceId);
            if (!credential || credential.tenantId !== tenantId
              || !['active', 'rotation_due'].includes(credential.status)
              || (credential.expiresAt && Date.parse(credential.expiresAt) <= Date.now())) continue;
            credentials.push({
              id: credential.credentialId, generation: credential.generation,
              revision: credential.version, bindingId: binding.bindingId,
              scopes: Array.isArray(credential.scopeSummary.scopes)
                ? credential.scopeSummary.scopes.filter((scope): scope is string => typeof scope === 'string')
                : [],
            });
            if (credential.connectorId) {
              const connector = await connectorCatalogStore!.get(credential.connectorId);
              if (connector?.status === 'published') {
                connectorsById.set(connector.connectorId, {
                  id: connector.connectorId, revision: connector.version,
                  ...(connector.currentVersionId ? { versionId: connector.currentVersionId } : {}),
                });
              }
            }
          }
          return { skills, connectors: [...connectorsById.values()], credentialBindings: credentials };
        },
      } : {}),
      tenantStore,
      ...(billingService ? {
        authorizeBilling: (input: { tenantId: string; userId?: string; runId: string }) =>
          billingService!.authorizeRun(input),
      } : {}),
      ...(modelResolver ? {
        isModelAvailable: (ref: string, tenantId?: string) => modelResolver(ref, tenantId) !== null,
      } : {}),
      ...(environmentStore ? {
        isEnvironmentAvailable: async (environment: {
          providerId: string; templateVersionId?: string; instanceId?: string; recipeDigest?: string;
        }, context: { tenantId: string; userId: string; agentId?: string }) => {
          const provider = await environmentStore!.getProvider(environment.providerId);
          if (!provider || provider.status !== 'enabled') return false;
          const effectiveTemplates = await assignmentStore.listEffectiveResourceIds(
            context.tenantId, context.userId, 'environment_template', context.agentId,
          );
          const assignedTemplateIds = new Set(effectiveTemplates.map(item => item.resourceId));
          if (environment.instanceId) {
            const instance = await environmentStore!.getInstance(context.tenantId, environment.instanceId);
            return Boolean(instance
              && assignedTemplateIds.has(instance.templateId)
              && instance.providerId === environment.providerId
              && instance.status === 'ready'
              && Date.parse(instance.leaseExpiresAt) > Date.now()
              && (!environment.recipeDigest || instance.recipeDigest === environment.recipeDigest));
          }
          if (environment.templateVersionId) {
            const version = await environmentStore!.getTemplateVersion(environment.templateVersionId);
            if (!version || !assignedTemplateIds.has(version.templateId)) return false;
            const template = await environmentStore!.getTemplate(version.templateId);
            return template?.status === 'published';
          }
          return false;
        },
      } : {}),
      logger: { warn: (message) => serverLogger.warn(message) },
    });
  }

  return runPreflightService;
}
