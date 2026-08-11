import { randomUUID } from 'node:crypto';
import { join } from 'path';
import type { AppConfig } from '../types/index.js';
import { serverLogger } from '../utils/logger.js';
import { PgEventStore } from '../runtime/pgEventStore.js';
import { UserStore } from '../data/users/store.js';
import { TenantStore } from '../data/tenants/store.js';
import { DEFAULT_TENANT_ID, DEFAULT_TENANT_SETTINGS } from '../data/tenants/types.js';
import { OrgAgentStore } from '../data/orgAgents/store.js';
import { SkillConfigStore } from '../data/skills/index.js';
import { PgMembershipStore } from '../data/memberships/index.js';
import { PgOAuthGrantStore } from '../data/oauthGrants/index.js';
import { PgGovernanceChangeJobStore } from '../data/changeJobs/index.js';
import { normalizeLegacyEntitlementSettings, PgEntitlementStore } from '../data/entitlements/index.js';
import { PgAssignmentStore } from '../data/assignments/index.js';
import { PgCredentialStore } from '../data/credentials/index.js';
import { PgAgentResourceStore } from '../data/agentResources/index.js';
import { PgEnvironmentStore } from '../data/environments/index.js';
import { PgSkillGovernanceStore } from '../data/skillGovernance/index.js';
import type { GovernanceAuditStore } from '../data/governance-audit/index.js';
import { GovernanceDomainShadowAuditor, GovernanceShadowComparator, PgGovernanceMigrationControlStore } from '../data/migrationControl/index.js';
import { PgRunResolutionSnapshotStore } from '../runtime/runResolutionSnapshotStore.js';
import { CredentialBroker } from '../runtime/credentialBroker.js';
import { SubjectResolver } from '../governance/subject/resolver.js';
import { AccessEvaluator } from '../governance/access/evaluator.js';
import { CredentialUseAuthorizer } from '../governance/access/credentialUseAuthorizer.js';
import {
  AssignmentPolicy,
  EntitlementPolicy,
  LongTermGrantPolicy,
  PersonaPolicy,
  PlatformInvariantPolicy,
  RuntimeApprovalPolicy,
  TenantPolicy,
} from '../governance/access/policies/index.js';
import { McpConfigStore } from '../data/mcpConfig.js';
import { ConnectorConnectionStore } from '../connectors/connectionStore.js';
import { AliyunConnectorService, revokePendingAliyunCredentials } from '../connectors/aliyun.js';
import { GITHUB_CONNECTOR_ID, resolveGithubRuntimeEnv, revokePendingGithubCredentials } from '../connectors/github.js';
import { GoogleWorkspaceOAuthService, PgGoogleWorkspaceOAuthStateStore, resolveGoogleWorkspaceRuntimeEnv } from '../connectors/googleWorkspace.js';
import { connectNotionCredential, disconnectNotion, getLiveNotionConnection, resolveNotionRuntimeEnv, type NotionConnectionView } from '../connectors/notion.js';
import { SignupConfigStore } from '../data/signupConfig.js';
import { EgressConfigStore } from '../data/egressConfig.js';
import { EgressDispatcherRegistry, createEgressFetch, createEgressWebSocketConnector } from '../runtime/egressDispatcher.js';
import type { EgressConfig } from '../runtime/egressPolicy.js';
import { resolveFeishuConnectorRunEnv } from '../runtime/connectorRunEnv.js';
import type { FeishuTokenBroker } from '../feishu/tokenBroker.js';
import { McpClientManager } from '../mcp/clientManager.js';
import { McpProxy } from '../mcp/proxy.js';
import { McpOAuthService } from '../mcp/oauthService.js';
import { resolveConnectorRuntimeEnv } from '../mcp/connectorRuntimeEnv.js';
import { CapabilityTokenService } from '../security/capabilityToken.js';
import type { SecretVault } from '../security/secretVault.js';
import { CodexResponsesWebSocketPool } from '../runtime/responses/codexResponsesWebSocketPool.js';
import { resolveUserCwd } from '../workspace/resolver.js';

export interface RuntimeGovernanceConnectorDeps {
  processCwd: string;
  agentCwd: string;
  config: AppConfig;
  secretVault: SecretVault;
  getFeishuTokenBroker?: () => FeishuTokenBroker | undefined;
  tenantRunEnvByTenant?: ReadonlyMap<string, Readonly<Record<string, string>>>;
  userStore?: UserStore;
  tenantStore?: TenantStore;
  orgAgentStore?: OrgAgentStore;
  skillConfigStore?: SkillConfigStore;
  pgEventStore?: PgEventStore;
  membershipStore?: PgMembershipStore;
  oauthGrantStore?: PgOAuthGrantStore;
  governanceChangeJobStore?: PgGovernanceChangeJobStore;
  entitlementStore?: PgEntitlementStore;
  assignmentStore?: PgAssignmentStore;
  credentialStore?: PgCredentialStore;
  agentResourceStore?: PgAgentResourceStore;
  environmentStore?: PgEnvironmentStore;
  skillGovernanceStore?: PgSkillGovernanceStore;
  governanceAuditStore?: GovernanceAuditStore;
  governanceMigrationControlStore?: PgGovernanceMigrationControlStore;
  governanceShadowComparator?: GovernanceShadowComparator;
  runResolutionSnapshotStore?: PgRunResolutionSnapshotStore;
  resolveLegacySkillResourceId: (user: { id: string; tenantId: string }, skillId: string) => string;
}

/** Initializes connector credentials, governance shadow audits, MCP, and egress in strict startup order. */
export async function initializeRuntimeGovernanceConnectors(deps: RuntimeGovernanceConnectorDeps) {
  const {
    processCwd, agentCwd, config, secretVault, getFeishuTokenBroker, tenantRunEnvByTenant,
    userStore, tenantStore, orgAgentStore, skillConfigStore,
    pgEventStore, membershipStore, oauthGrantStore, governanceChangeJobStore, entitlementStore, assignmentStore, credentialStore,
    agentResourceStore, environmentStore, skillGovernanceStore, governanceAuditStore,
    governanceMigrationControlStore, governanceShadowComparator, runResolutionSnapshotStore,
    resolveLegacySkillResourceId,
  } = deps;
  let credentialBroker: CredentialBroker | undefined;
  let googleWorkspaceOAuthService: GoogleWorkspaceOAuthService | undefined;

  // MCP client manager（lazy connect per user）。failOnError=false 让连不上的
  // server 不阻塞 dispatch；连接仍快速失败，单次 MCP 工具调用最长允许 10 分钟。
  const mcpConfigStore = new McpConfigStore(join(processCwd, 'data', 'mcp-config.json'));
  const installedMcpPresets = await mcpConfigStore.installBuiltinOAuthServers();
  if (installedMcpPresets > 0) {
    serverLogger.info(`Installed ${installedMcpPresets} built-in OAuth MCP connector preset(s)`);
  }
  const connectorConnectionStore = new ConnectorConnectionStore(
    join(processCwd, 'data', 'connector-connections.json'),
  );
  for (const legacyConnection of connectorConnectionStore.listAll().filter(connection => !connection.userId)) {
    await connectorConnectionStore.disconnect(
      legacyConnection.username,
      legacyConnection.connectorId,
      legacyConnection.tenantId,
    );
    const disconnected = connectorConnectionStore.get(
      legacyConnection.username,
      legacyConnection.connectorId,
    );
    for (const ref of disconnected?.pendingRevokeRefs ?? []) {
      try {
        await secretVault.revokeSecret(ref, {
          actor: 'connector_proxy',
          userId: legacyConnection.username,
          tenantId: legacyConnection.tenantId,
          scopes: ['secret:connector:revoke', 'secret:mcp:revoke'],
        });
        await connectorConnectionStore.markCredentialRevoked(
          legacyConnection.username,
          legacyConnection.connectorId,
          ref,
        );
      } catch (error) {
        serverLogger.warn(
          `Legacy unbound connector credential revoke pending: connector=${legacyConnection.connectorId} user=${legacyConnection.username} reason=${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }
  for (const username of mcpConfigStore.listUsernames()) {
    const legacyGithubRef = mcpConfigStore.getUserSecretRef(username, GITHUB_CONNECTOR_ID, 'token');
    if (!legacyGithubRef) continue;
    await mcpConfigStore.clearUserSecretRef(username, GITHUB_CONNECTOR_ID, 'token');
    try {
      await secretVault.revokeSecret(legacyGithubRef, {
        actor: 'connector_proxy',
        userId: username,
        scopes: ['secret:connector:revoke', 'secret:mcp:revoke'],
      });
    } catch (error) {
      serverLogger.warn(
        `Legacy GitHub MCP credential revoke failed after detaching ref: user=${username} reason=${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  await revokePendingGithubCredentials({
    connectionStore: connectorConnectionStore,
    vault: secretVault,
    onError: error => serverLogger.warn(`Pending GitHub credential revoke skipped: ${error.message}`),
  });
  await revokePendingAliyunCredentials({
    connectionStore: connectorConnectionStore,
    vault: secretVault,
    onError: error => serverLogger.warn(`Pending Aliyun credential revoke skipped: ${error.message}`),
  });
  // P2 Credential Domain：legacy connector 连接投影为 governance credential（shadow）。
  // Broker 本身已按 AccessEvaluator + Credential Assignment 权威授权；connector
  // 调用链切换到 Broker 仍由后续迁移门禁控制。
  if (credentialStore && userStore && membershipStore && entitlementStore
    && assignmentStore && tenantStore && governanceAuditStore) {
    try {
      const backfill = await credentialStore.backfillLegacyCredentials({
        users: userStore.listAll(),
        connections: connectorConnectionStore.listAll(),
        platformTenantId: DEFAULT_TENANT_ID,
        projectedBy: 'system:governance-m1',
      });
      const projectedCredentials = (await Promise.all(tenantStore.listAll().map(tenant =>
        credentialStore!.listForTenant(tenant.id))))
        .flat()
        .flatMap(credential => {
          const ownerUserId = credential.ownerUserId ?? credential.custodianUserId;
          return ownerUserId && credential.source === 'legacy_projection'
            ? [{ credentialId: credential.credentialId, tenantId: credential.tenantId, ownerUserId }]
            : [];
        });
      const credentialAssignments = await assignmentStore!.backfillLegacyCredentialAssignments({
        credentials: projectedCredentials,
        projectedBy: 'system:governance-m1',
      });
      serverLogger.info(
        `Governance Credential shadow backfill: credentials=${backfill.credentialsProjected} `
        + `assignments=${credentialAssignments.resourceSetsProjected} issues=${backfill.issuesRecorded}`,
      );
    } catch (error) {
      serverLogger.warn(
        `Governance Credential shadow backfill failed; legacy authority remains active: `
        + `${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (governanceShadowComparator && governanceMigrationControlStore && tenantStore && orgAgentStore && skillConfigStore) {
      const auditor = new GovernanceDomainShadowAuditor({
        comparator: governanceShadowComparator,
        states: governanceMigrationControlStore,
      });
      try {
        const entitlementComparisons = await Promise.all(tenantStore.listAll()
          .filter(tenant => tenant.id !== DEFAULT_TENANT_ID)
          .map(async tenant => ({
            tenantId: tenant.id,
            resourceType: 'tenant',
            resourceId: tenant.id,
            legacy: normalizeLegacyEntitlementSettings(
              tenant.settings ?? DEFAULT_TENANT_SETTINGS,
              Boolean(tenant.disabled),
            ),
            governance: await entitlementStore!.getProjectionSnapshot(tenant.id),
            blocking: true,
          })));
        await auditor.audit('entitlement_policy', entitlementComparisons);

        const assignmentComparisons: Array<{
          tenantId?: string; resourceType: string; resourceId: string;
          legacy: unknown; governance: unknown | undefined; blocking: boolean;
        }> = await Promise.all(orgAgentStore.listAll().map(async agent => {
          const set = await assignmentStore!.getAssignmentSet(agent.tenantId, 'org_agent', agent.id);
          const userIdFor = (username: string) => userStore?.findByUsername(username)?.id ?? `unresolved:${username}`;
          const legacyAssignments = agent.audience.exposure === 'all'
            ? [{ assigneeType: 'everyone', effect: 'allow' }]
            : agent.audience.exposure === 'allow_users'
              ? agent.audience.usernames.map(username => ({ assigneeType: 'user', assigneeId: userIdFor(username), effect: 'allow' }))
              : [
                  { assigneeType: 'everyone', effect: 'allow' },
                  ...agent.audience.usernames.map(username => ({ assigneeType: 'user', assigneeId: userIdFor(username), effect: 'deny' })),
                ];
          const normalize = (items: Array<{ assigneeType: string; assigneeId?: string; effect: string }>) => items
            .map(item => ({ assigneeType: item.assigneeType, assigneeId: item.assigneeId ?? null, effect: item.effect }))
            .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
          return {
            tenantId: agent.tenantId,
            resourceType: 'org_agent',
            resourceId: agent.id,
            legacy: normalize(legacyAssignments),
            governance: set ? normalize(set.assignments) : undefined,
            blocking: true,
          };
        }));
        for (const [tenantId, skillConfig] of Object.entries(skillConfigStore.getAllTenantConfigs())) {
          const rules = {
            ...Object.fromEntries((skillConfig.enabledSkills ?? []).map(skillId => [skillId, {
              enabled: true, exposure: 'all' as const, usernames: [] as string[],
            }])),
            ...(skillConfig.skills ?? {}),
            ...(skillConfig.ownSkills ?? {}),
          };
          const userIdFor = (username: string) => userStore?.findByUsername(username)?.id ?? `unresolved:${username}`;
          for (const [skillId, rule] of Object.entries(rules)) {
            const set = await assignmentStore!.getAssignmentSet(tenantId, 'skill', skillId);
            const desired = !rule.enabled ? []
              : rule.exposure === 'all'
                ? [{ assigneeType: 'everyone', assigneeId: null, effect: 'allow' }]
                : rule.exposure === 'allow_users'
                  ? rule.usernames.map(username => ({
                      assigneeType: 'user', assigneeId: userIdFor(username), effect: 'allow',
                    }))
                  : [
                      { assigneeType: 'everyone', assigneeId: null, effect: 'allow' },
                      ...rule.usernames.map(username => ({
                        assigneeType: 'user', assigneeId: userIdFor(username), effect: 'deny',
                      })),
                    ];
            const normalize = (items: Array<{ assigneeType: string; assigneeId?: string | null; effect: string }>) => items
              .map(item => ({ assigneeType: item.assigneeType, assigneeId: item.assigneeId ?? null, effect: item.effect }))
              .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
            assignmentComparisons.push({
              tenantId, resourceType: 'skill', resourceId: skillId,
              legacy: normalize(desired),
              governance: set ? normalize(set.assignments) : undefined,
              blocking: true,
            });
          }
        }
        for (const tenant of tenantStore.listAll()) {
          for (const credential of await credentialStore!.listForTenant(tenant.id)) {
            if (credential.source !== 'legacy_projection') continue;
            const ownerUserId = credential.ownerUserId ?? credential.custodianUserId;
            const set = await assignmentStore!.getAssignmentSet(tenant.id, 'credential', credential.credentialId);
            assignmentComparisons.push({
              tenantId: tenant.id,
              resourceType: 'credential',
              resourceId: credential.credentialId,
              legacy: ownerUserId ? [{ assigneeType: 'user', assigneeId: ownerUserId, effect: 'allow' }] : [],
              governance: set ? set.assignments.map(item => ({
                assigneeType: item.assigneeType, assigneeId: item.assigneeId, effect: item.effect,
              })) : undefined,
              blocking: true,
            });
          }
        }
        for (const [username, userConfig] of Object.entries(skillConfigStore.getAllUserConfigs())) {
          const user = userStore?.findByUsername(username);
          if (!user || user.tenantId === DEFAULT_TENANT_ID) continue;
          const preferences = await assignmentStore!.listUserPreferences(user.id);
          assignmentComparisons.push({
            tenantId: user.tenantId,
            resourceType: 'skill_preference',
            resourceId: user.id,
            legacy: [...new Set(userConfig.selectedSkills.map(skillId =>
              resolveLegacySkillResourceId(user, skillId)))].sort(),
            governance: preferences
              .filter(item => item.resourceType === 'skill' && item.enabled)
              .map(item => item.resourceId)
              .sort(),
            blocking: true,
          });
        }
        await auditor.audit('assignment', assignmentComparisons);

        const agentSkillComparisons = [] as Array<{
          tenantId?: string; resourceType: string; resourceId: string;
          legacy: unknown; governance: unknown | undefined; blocking: boolean;
        }>;
        for (const agent of orgAgentStore.listAll()) {
          const resource = await agentResourceStore?.getForTenant(agent.tenantId, agent.id);
          agentSkillComparisons.push({
            tenantId: agent.tenantId, resourceType: 'org_agent', resourceId: agent.id,
            legacy: { tenantId: agent.tenantId, enabled: agent.enabled },
            governance: resource ? { tenantId: resource.tenantId, enabled: resource.status === 'enabled' } : undefined,
            blocking: true,
          });
        }
        for (const user of userStore!.listAll().filter(item => item.tenantId !== DEFAULT_TENANT_ID)) {
          const resource = await agentResourceStore?.findPersonalByOwner(user.tenantId, user.id);
          agentSkillComparisons.push({
            tenantId: user.tenantId,
            resourceType: 'personal_agent',
            resourceId: user.id,
            legacy: { ownerUserId: user.id, enabled: !user.disabled },
            governance: resource ? {
              ownerUserId: resource.ownerUserId,
              enabled: resource.status === 'enabled',
            } : undefined,
            blocking: true,
          });
        }
        for (const [tenantId, skillConfig] of Object.entries(skillConfigStore.getAllTenantConfigs())) {
          const skillIds = new Set([
            ...(skillConfig.enabledSkills ?? []),
            ...Object.keys(skillConfig.skills ?? {}),
            ...Object.keys(skillConfig.ownSkills ?? {}),
          ]);
          for (const skillId of skillIds) {
            const resource = await skillGovernanceStore?.getResource(skillId);
            const resourceTenantId = Object.prototype.hasOwnProperty.call(skillConfig.ownSkills ?? {}, skillId)
              ? tenantId
              : DEFAULT_TENANT_ID;
            agentSkillComparisons.push({
              tenantId, resourceType: 'skill', resourceId: skillId,
              legacy: { assignedTenantId: tenantId, resourceTenantId, skillId },
              governance: resource ? {
                assignedTenantId: tenantId, resourceTenantId: resource.tenantId, skillId: resource.skillId,
              } : undefined,
              blocking: true,
            });
          }
        }
        for (const [username, userConfig] of Object.entries(skillConfigStore.getAllUserConfigs())) {
          const user = userStore?.findByUsername(username);
          if (!user || user.tenantId === DEFAULT_TENANT_ID) continue;
          for (const legacySkillId of new Set(userConfig.selectedSkills)) {
            const skillId = resolveLegacySkillResourceId(user, legacySkillId);
            if (skillId === legacySkillId) continue;
            const resource = await skillGovernanceStore?.getResource(skillId);
            const version = resource?.currentVersionId
              ? await skillGovernanceStore?.getVersion(resource.currentVersionId)
              : null;
            agentSkillComparisons.push({
              tenantId: user.tenantId, resourceType: 'personal_skill', resourceId: skillId,
              legacy: { ownerUserId: user.id, legacySkillId },
              governance: resource ? {
                ownerUserId: resource.ownerUserId,
                legacySkillId: version?.definition.legacySkillId,
              } : undefined,
              blocking: true,
            });
          }
        }
        await auditor.audit('agent_skill', agentSkillComparisons);

        const credentialComparisons = [] as Array<{
          tenantId?: string; resourceType: string; resourceId: string;
          legacy: unknown; governance: unknown | undefined; blocking: boolean;
        }>;
        for (const connection of connectorConnectionStore.listAll()) {
          if (connection.status !== 'connected') continue;
          for (const [slot, secretRef] of Object.entries(connection.credentialRefs ?? {})) {
            if (!secretRef) continue;
            const credential = await credentialStore!.getBySecretRef(secretRef);
            credentialComparisons.push({
              tenantId: connection.tenantId,
              resourceType: 'credential',
              resourceId: `${connection.connectorId}:${connection.username}:${slot}`,
              legacy: { connectorId: connection.connectorId, secretRef, status: 'active' },
              governance: credential ? {
                connectorId: credential.connectorId, secretRef: credential.secretRef, status: credential.status,
              } : undefined,
              blocking: true,
            });
          }
        }
        await auditor.audit('connector_credential', credentialComparisons);

        const expectedProviders = [
          { providerId: 'server-local', enabled: true },
          ...(config.serverRemote?.baseUrl ? [{ providerId: 'server-remote', enabled: true }] : []),
        ];
        const environmentComparisons = await Promise.all(expectedProviders.map(async expected => {
          const provider = await environmentStore?.getProvider(expected.providerId);
          return {
            resourceType: 'execution_provider', resourceId: expected.providerId,
            legacy: expected,
            governance: provider ? { providerId: provider.providerId, enabled: provider.status === 'enabled' } : undefined,
            blocking: true,
          };
        }));
        await auditor.audit('environment', environmentComparisons);
      } catch (error) {
        serverLogger.warn(
          `Governance domain shadow audit failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    const credentialUseAuthorizer = new CredentialUseAuthorizer({
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
      tenantStore,
    });
    credentialBroker = new CredentialBroker({
      credentialStore,
      vault: secretVault,
      authorizeUse: async (request, credential) => (
        await credentialUseAuthorizer.authorize(request, credential)
      ).allowed,
      auditUse: async ({ request, credential, result, reasonCode }) => {
        await governanceAuditStore!.append({
          correlationId: request.correlationId,
          actorType: 'service',
          actorUserId: request.delegatedUserId,
          actorPersona: 'service',
          actorTenantId: request.tenantId,
          action: 'credential.use',
          targetType: 'credential',
          targetId: request.credentialId,
          targetTenantId: credential?.tenantId ?? request.tenantId,
          purpose: request.purpose,
          reason: reasonCode,
          result,
          metadata: {
            serviceId: 'credential_broker',
            agentId: request.agentId,
            connectorId: request.connectorId,
            channel: request.channel,
            expectedGeneration: request.expectedGeneration,
            actualGeneration: credential?.generation ?? null,
            requiredScopes: (request.requiredScopes ?? []).join(','),
          },
        });
      },
    });
  }
  const aliyunConnectorService = new AliyunConnectorService({
    connectionStore: connectorConnectionStore,
    vault: secretVault,
    onError: error => serverLogger.warn(`Aliyun connector runtime env skipped: ${error.message}`),
  });
  const authorizeOAuthSubject = async (userId: string, tenantId: string): Promise<boolean> => {
    const user = userStore?.findById(userId);
    if (!user || user.disabled || user.tenantId !== tenantId || tenantStore?.findById(tenantId)?.disabled) return false;
    if (!membershipStore || !governanceChangeJobStore) return false;
    const membership = await membershipStore.getMembership(tenantId, userId);
    if (!membership || membership.status !== 'active') return false;
    return !await governanceChangeJobStore.findActiveForTarget(tenantId, 'user_offboarding', 'user', userId);
  };
  const authorizeOAuthGrant = async (grantId: string, userId: string, tenantId: string): Promise<boolean> => {
    if (!oauthGrantStore) return false;
    const grant = await oauthGrantStore.getForSubject(tenantId, userId, grantId);
    return grant?.status === 'active'
      && !grant.revocationStage
      && (!grant.expiresAt || new Date(grant.expiresAt).getTime() > Date.now());
  };
  const authorizeConnectorAssignment = async (userId: string, tenantId: string, connectorId: string): Promise<boolean> => {
    if (!assignmentStore || !entitlementStore) return false;
    try {
      const [resources, entitlement, scopes] = await Promise.all([
        assignmentStore.listEffectiveResourceIds(tenantId, userId, 'connector'),
        entitlementStore.getEntitlementSet(tenantId),
        entitlementStore.listResourceScopes(tenantId),
      ]);
      const connectorScope = scopes.find(scope => scope.resourceType === 'connector');
      const entitled = entitlement?.status === 'active' && Boolean(connectorScope)
        && (connectorScope!.mode === 'all' || connectorScope!.resourceIds.includes(connectorId));
      return entitled && resources.some(item => item.resourceId === connectorId);
    } catch {
      return false;
    }
  };
  const mcpOAuthService = new McpOAuthService({
    store: mcpConfigStore,
    vault: secretVault,
    userResolver: username => {
      const user = userStore?.findByUsername(username);
      return user ? { id: user.id, tenantId: user.tenantId, disabled: user.disabled } : undefined;
    },
    authorizeSubject: authorizeOAuthSubject,
    authorizeGrant: authorizeOAuthGrant,
    authorizeConnect: authorizeConnectorAssignment,
    onSecretRotated: async secretRef => {
      await credentialStore?.bumpGenerationBySecretRef(secretRef, 'system:mcp-oauth-rotation');
    },
  });
  const legacyNativeMcpIds = new Set([
    'github',
    'notion',
    'google_gmail',
    'google_drive',
    'google_calendar',
    'google_chat',
    'google_people',
  ]);
  for (const username of mcpConfigStore.listUsernames()) {
    for (const connection of mcpConfigStore.listUserOAuthConnections(username)) {
      if (legacyNativeMcpIds.has(connection.serverId)) {
        await mcpOAuthService.disconnect(username, connection.tenantId, connection.serverId);
      }
    }
  }
  const googleWorkspaceClientId = process.env.GOOGLE_WORKSPACE_CONNECTOR_CLIENT_ID?.trim();
  const googleWorkspaceClientSecret = process.env.GOOGLE_WORKSPACE_CONNECTOR_CLIENT_SECRET?.trim();
  let googleWorkspaceOAuthStateStore;
  if (googleWorkspaceClientId && googleWorkspaceClientSecret) {
    if (pgEventStore) {
      const pgStateStore = new PgGoogleWorkspaceOAuthStateStore(
        pgEventStore.pool,
        config.runtimeEventStore?.backend === 'pg'
          ? config.runtimeEventStore.tablePrefix ?? 'runtime'
          : 'runtime',
      );
      await pgStateStore.init();
      googleWorkspaceOAuthStateStore = pgStateStore;
    }
  } else {
    serverLogger.warn('Google Workspace connector disabled: OAuth client id/secret not configured');
  }
  // 自助注册动态配置：文件不存在时用 config.json 的 auth.selfSignup 作 seed（兼容旧配置方式）
  const signupConfigStore = new SignupConfigStore(
    join(processCwd, 'data', 'signup-config.json'),
    config.auth?.selfSignup,
  );
  // 网络出口（代理/镜像源）动态配置：文件不存在时用 config.json 的 egress 段作 seed。
  const egressConfigStore = new EgressConfigStore(
    join(processCwd, 'data', 'egress-config.json'),
    config.egress as EgressConfig | undefined,
  );
  const egressLogger = serverLogger.child('Egress');
  // 代理凭据同步缓存：dispatcher 需要同步取值，而 vault.getSecret 是异步的，
  // 因此在启动与每次配置保存后主动刷新一次，中间态按「无凭据」处理（内网代理通常无认证）。
  let egressProxyCredential: string | undefined;
  const refreshEgressProxyCredential = async (): Promise<void> => {
    const ref = egressConfigStore.getProxyCredentialRef();
    if (!ref || !secretVault) {
      egressProxyCredential = undefined;
      return;
    }
    try {
      egressProxyCredential = await secretVault.getSecret(ref, {
        actor: 'system',
        userId: '__system__',
        scopes: ['secret:egress-proxy:read'],
      });
    } catch (err) {
      egressProxyCredential = undefined;
      egressLogger.warn(
        `代理凭据解析失败，按无凭据处理: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };
  void refreshEgressProxyCredential();
  const egressDispatchers = new EgressDispatcherRegistry(
    {
      getConfig: () => egressConfigStore.getConfig(),
      getConfigVersion: () => egressConfigStore.getConfigVersion(),
      getProxyCredential: () => egressProxyCredential,
    },
    egressLogger,
  );
  const egressFetch = createEgressFetch(egressDispatchers, egressLogger);
  const getNotionConnection = connectorConnectionStore && secretVault
    ? (identity: { userId: string; username: string; tenantId: string }) => getLiveNotionConnection({
        ...identity,
        connectionStore: connectorConnectionStore,
        vault: secretVault,
        fetchImpl: egressFetch,
      })
    : undefined;
  const disconnectNotionConnection = connectorConnectionStore && secretVault
    ? (identity: { userId: string; username: string; tenantId: string }) => disconnectNotion({
        ...identity,
        connectionStore: connectorConnectionStore,
        vault: secretVault,
      })
    : undefined;
  if (googleWorkspaceClientId && googleWorkspaceClientSecret) {
    googleWorkspaceOAuthService = new GoogleWorkspaceOAuthService({
      clientId: googleWorkspaceClientId,
      clientSecret: googleWorkspaceClientSecret,
      connectionStore: connectorConnectionStore,
      vault: secretVault,
      stateStore: googleWorkspaceOAuthStateStore,
      userResolver: userId => userStore?.findById(userId),
      authorizeSubject: authorizeOAuthSubject,
      authorizeGrant: authorizeOAuthGrant,
      authorizeConnect: (userId, tenantId) => authorizeConnectorAssignment(userId, tenantId, 'google-workspace'),
      logger: serverLogger.child('GoogleWorkspaceConnector'),
      fetchImpl: egressFetch,
    });
  }
  const codexWebSocketPool = new CodexResponsesWebSocketPool(
    createEgressWebSocketConnector(egressDispatchers, egressLogger),
    { logger: egressLogger },
  );
  const mcpCapabilityTokens = new CapabilityTokenService();
  const mcpClientManager = new McpClientManager({
    agentCwd,
    failOnError: false,
    connectTimeoutMs: 5_000,
    invokeTimeoutMs: 10 * 60_000,
    logger: serverLogger.child('McpClient'),
    secretVault,
    configProvider: (username, workspaceRoot) => mcpConfigStore.buildUserMcpServers(
      username,
      workspaceRoot,
      userStore?.findByUsername(username)?.tenantId,
    ),
    workspaceResolver: (username) => {
      const u = userStore?.findByUsername(username);
      return u
        ? resolveUserCwd(agentCwd, { id: u.id, username: u.username, role: u.role, tenantId: u.tenantId })
        : join(agentCwd, username);
    },
    // PR 11：让 mcp_proxy 调 vault.getSecret 时附 tenantId，使
    // tenant/global scope secret 通过 ACL（user-scope secret 行为不变）
    tenantResolver: (username) => userStore?.findByUsername(username)?.tenantId,
    oauthProviderFactory: ({ username, tenantId, serverName }) => mcpOAuthService.runtimeProvider({
      username,
      tenantId,
      serverName,
    }),
  });
  const mcpProxy = new McpProxy({
    manager: mcpClientManager,
    capabilityTokens: mcpCapabilityTokens,
    vault: secretVault,
    warmupWithCredential: credentialBroker && credentialStore && assignmentStore
      ? async ({ username, userId, sessionId, runId }) => {
          const user = userStore?.findById(userId) ?? userStore?.findByUsername(username);
          const snapshot = await runResolutionSnapshotStore?.get(runId);
          if (!user || !snapshot
            || snapshot.sessionId !== sessionId
            || snapshot.actor.subjectId !== user.id
            || snapshot.tenantId !== user.tenantId) {
            throw new Error('RUN_SNAPSHOT_BINDING_MISMATCH');
          }
          const descriptors = [] as Awaited<ReturnType<McpClientManager['warmupBrokered']>>;
          for (const connector of snapshot.connectors) {
            const candidates = [] as Array<{
              credential: NonNullable<Awaited<ReturnType<PgCredentialStore['get']>>>;
              generation: number;
              revision: number;
              scopes: string[];
            }>;
            for (const binding of snapshot.credentialBindings) {
              const credential = await credentialStore!.get(binding.id);
              if (credential?.connectorId === connector.id
                && binding.generation !== undefined
                && binding.revision !== undefined) {
                candidates.push({
                  credential,
                  generation: binding.generation,
                  revision: binding.revision,
                  scopes: binding.scopes ?? [],
                });
              }
            }
            if (candidates.length !== 1) {
              throw new Error(candidates.length === 0 ? 'CREDENTIAL_NOT_BOUND' : 'CREDENTIAL_AMBIGUOUS');
            }
            const candidate = candidates[0];
            if (candidate.credential.version !== candidate.revision) {
              throw new Error('CREDENTIAL_REVISION_CHANGED');
            }
            if (!candidate.scopes.some(scope =>
              scope === '*' || scope === `${connector.id}:*` || scope.startsWith(`${connector.id}:`),
            )) {
              throw new Error('CREDENTIAL_SCOPE_NOT_SNAPSHOTTED');
            }
            const tools = await credentialBroker!.execute({
              credentialId: candidate.credential.credentialId,
              tenantId: user.tenantId,
              connectorId: connector.id,
              channel: 'mcp',
              delegatedUserId: user.id,
              agentId: snapshot.agent.id,
              expectedGeneration: candidate.generation,
              correlationId: `mcp:${sessionId}:${connector.id}:list-tools:${randomUUID()}`,
              purpose: `mcp list tools ${connector.id}`,
            }, resolved => mcpClientManager.warmupBrokered(
              username,
              connector.id,
              { secretRef: candidate.credential.secretRef, secret: resolved.secret },
            ));
            descriptors.push(...tools);
          }
          return descriptors;
        }
      : undefined,
    executeWithCredential: credentialBroker && credentialStore && assignmentStore
      ? async ({ username, userId, sessionId, runId, serverName, toolName, toolKey, input }) => {
          const user = userStore?.findById(userId) ?? userStore?.findByUsername(username);
          if (!user) throw new Error('CREDENTIAL_SUBJECT_NOT_FOUND');
          const snapshot = runId ? await runResolutionSnapshotStore?.get(runId) : null;
          if (!snapshot) throw new Error('RUN_SNAPSHOT_REQUIRED');
          if (snapshot.sessionId !== sessionId
            || snapshot.actor.subjectId !== user.id
            || snapshot.tenantId !== user.tenantId
            || !snapshot.connectors.some(connector => connector.id === serverName)) {
            throw new Error('RUN_SNAPSHOT_BINDING_MISMATCH');
          }
          const candidates = [] as Array<{
            credential: NonNullable<Awaited<ReturnType<PgCredentialStore['get']>>>;
            expectedGeneration: number;
            expectedRevision: number;
            scopes: string[];
          }>;
          for (const binding of snapshot.credentialBindings) {
            const credential = await credentialStore!.get(binding.id);
            if (credential?.connectorId === serverName
              && binding.generation !== undefined
              && binding.revision !== undefined) {
              candidates.push({
                credential,
                expectedGeneration: binding.generation,
                expectedRevision: binding.revision,
                scopes: binding.scopes ?? [],
              });
            }
          }
          if (candidates.length !== 1) {
            throw new Error(candidates.length === 0 ? 'CREDENTIAL_NOT_BOUND' : 'CREDENTIAL_AMBIGUOUS');
          }
          const { credential, expectedGeneration, expectedRevision, scopes } = candidates[0];
          if (credential.version !== expectedRevision) throw new Error('CREDENTIAL_REVISION_CHANGED');
          const requiredScope = `${serverName}:${toolName}`;
          if (!scopes.includes('*')
            && !scopes.includes(requiredScope)
            && !scopes.includes(`${serverName}:*`)) {
            throw new Error('CREDENTIAL_SCOPE_NOT_SNAPSHOTTED');
          }
          return credentialBroker!.execute({
            credentialId: credential.credentialId,
            tenantId: user.tenantId,
            connectorId: serverName,
            channel: 'mcp',
            delegatedUserId: user.id,
            agentId: snapshot.agent.id,
            expectedGeneration,
            requiredScopes: [requiredScope],
            correlationId: `mcp:${sessionId}:${serverName}:${toolName}:${randomUUID()}`,
            purpose: `mcp tool ${serverName}/${toolName}`,
          }, async resolved => mcpClientManager.invokeBrokered(
            username,
            toolKey,
            input,
            { secretRef: credential.secretRef, secret: resolved.secret },
          ));
        }
      : undefined,
    logger: serverLogger.child('McpProxy'),
  });
  const mcpClientShutdown = () => mcpClientManager.shutdown();
  // 能力中心连接器是用户级 CLI-first 能力：用户授权后，标准 env 只注入其
  // 自己的隔离运行环境。MCP 的服务端 broker 仍负责工具调用；这里只导出模板
  // 显式声明的 runtimeEnv，供 CLI/SDK/脚本直接使用。
  const resolveRunScopedEnv = async (context: {
    userId: string; username: string; tenantId: string;
  }): Promise<Record<string, string>> => {
    const owner = userStore?.findByUsername(context.username);
    const ownedContext = owner
      ? (!owner.disabled && owner.id === context.userId && owner.tenantId === context.tenantId ? context : undefined)
      : (!userStore ? context : undefined);
    if (!ownedContext) return {};

    const [githubEnv, notionEnv, googleWorkspaceEnv, aliyunEnv, feishuEnv, mcpConnectorEnv] = await Promise.all([
      resolveGithubRuntimeEnv({
        connectionStore: connectorConnectionStore,
        vault: secretVault,
        onError: error => serverLogger.warn(
          `Native connector runtime env skipped: connector=${GITHUB_CONNECTOR_ID} reason=${error.message}`,
        ),
      }, ownedContext),
      resolveNotionRuntimeEnv({
        connectionStore: connectorConnectionStore,
        vault: secretVault,
        onError: error => serverLogger.warn(
          `Native connector runtime env skipped: connector=notion reason=${error.message}`,
        ),
      }, ownedContext),
      resolveGoogleWorkspaceRuntimeEnv(
        googleWorkspaceOAuthService,
        ownedContext,
        error => serverLogger.warn(
          `Native connector runtime env skipped: connector=google-workspace reason=${error.message}`,
        ),
      ),
      aliyunConnectorService.resolveRuntimeEnv(ownedContext),
      resolveFeishuConnectorRunEnv(
        getFeishuTokenBroker?.(),
        ownedContext,
        error => serverLogger.warn(
          `Native connector runtime env skipped: connector=feishu reason=${error.message}`,
        ),
      ),
      resolveConnectorRuntimeEnv({
        store: mcpConfigStore,
        vault: secretVault,
        oauthService: mcpOAuthService,
        excludedServerIds: legacyNativeMcpIds,
        onError: (error, meta) => serverLogger.warn(
          `MCP connector runtime env skipped: server=${meta.serverId} source=${meta.source} reason=${error.message}`,
        ),
      }, ownedContext),
    ]);
    return {
      ...mcpConnectorEnv,
      ...aliyunEnv,
      ...feishuEnv,
      ...googleWorkspaceEnv,
      ...notionEnv,
      ...githubEnv,
      ...(tenantRunEnvByTenant?.get(context.tenantId) ?? {}),
    };
  };


  return {
    mcpConfigStore,
    connectorConnectionStore,
    aliyunConnectorService,
    mcpOAuthService,
    signupConfigStore,
    egressConfigStore,
    refreshEgressProxyCredential,
    egressDispatchers,
    egressFetch,
    getNotionConnection,
    disconnectNotionConnection,
    codexWebSocketPool,
    mcpClientManager,
    mcpProxy,
    mcpClientShutdown,
    resolveRunScopedEnv,
    googleWorkspaceOAuthService,
    credentialBroker,
  };
}
