import type { AgentRunDispatch } from '../agent/index.js';
import { DwsContextRuntime } from '../context/sync/index.js';
import type { ContextStore } from '../context/store/index.js';
import type { AgentDwsAccountRecord, AgentDwsAccountStore } from '../data/agentDwsAccounts/index.js';
import type { GovernanceAuditStore } from '../data/governance-audit/types.js';
import type { PgAssignmentStore } from '../data/assignments/index.js';
import type { AgentDwsMessageStore } from '../data/agentDwsMessages/index.js';
import type { OrgGroupAgentStore } from '../data/orgGroupAgents/index.js';
import { AgentDwsAuthFlowService } from '../dws/agentAuthFlow.js';
import { DwsDeviceLoginRunner, type DwsWorkspacePrincipal } from '../dws/authFlow.js';
import { PgDwsAuthSessionStore } from '../dws/authStore.js';
import { DwsPersonalEventGateway } from '../dws/personalEventGateway.js';
import {
  AgentDwsMessageRouter,
  type AgentDwsDefaultModelResolution,
} from '../dws/personalMessageRouter.js';
import { DwsPersonalMessageSender } from '../dws/personalMessageSender.js';
import { DwsRequesterIdentityResolver } from '../dws/requesterIdentityResolver.js';
import type { UserStore } from '../data/users/store.js';
import type { PgMembershipStore } from '../data/memberships/store.js';
import type { PgEventStore } from '../runtime/pgEventStore.js';
import { isAssignedToOrgAgent, type OrgAgentStore } from '../data/orgAgents/store.js';
import type { RunPreflightService } from '../runtime/runPreflight.js';
import type { PgRunStore } from '../runtime/runStore.js';
import type { UserIdentity } from '../types/index.js';
import type { Logger } from '../utils/logger.js';
import { governancePersonaForUser } from '../governance/subject/platformIdentity.js';

export type ConnectorServerRemoteResolver = (principal: DwsWorkspacePrincipal) => Promise<{
  baseUrl: string;
  authToken: string;
  invokeTimeoutMs?: number;
}>;

export interface AgentDwsRuntimeBundle {
  authFlowService: AgentDwsAuthFlowService;
  messageRouter?: AgentDwsMessageRouter;
  eventGateway: DwsPersonalEventGateway;
  onContextPolicyUpdated(account: AgentDwsAccountRecord): Promise<void>;
  onGroupBindingUpdated(account: AgentDwsAccountRecord, conversationId: string): Promise<void>;
  onEnabledChanged(account: AgentDwsAccountRecord, enabled: boolean): Promise<void>;
  stop(): Promise<void>;
}

export async function authorizeAgentDwsRequesterAccess(input: {
  account: AgentDwsAccountRecord;
  requester: UserIdentity;
  sessionId: string;
  runId: string;
  orgAgentStore: Pick<OrgAgentStore, 'get'>;
  runPreflightService: Pick<RunPreflightService, 'preflight'>;
  auditStore: GovernanceAuditStore;
}): Promise<{ allowed: boolean; reason?: string }> {
  const recordDecision = async (decision: { allowed: boolean; reason?: string }) => {
    await input.auditStore.append({
      correlationId: `dws-requester-access-${input.runId}`,
      actorType: 'user',
      actorUserId: input.requester.id,
      actorPersona: governancePersonaForUser(input.requester),
      actorTenantId: input.requester.tenantId ?? input.account.tenantId,
      action: 'dws.requester.access_decision',
      targetType: 'org_agent',
      targetId: input.account.agentId,
      targetTenantId: input.account.tenantId,
      purpose: 'record DWS requester audience and assignment decision',
      reason: decision.reason ?? 'ACCESS_ALLOWED',
      result: decision.allowed ? 'succeeded' : 'failed',
      metadata: { allowed: decision.allowed },
    });
    return decision;
  };
  const agent = input.orgAgentStore.get(input.account.agentId);
  if (!agent || !agent.enabled || agent.tenantId !== input.account.tenantId) {
    return await recordDecision({ allowed: false, reason: 'ORG_AGENT_UNAVAILABLE' });
  }
  if (!isAssignedToOrgAgent(agent, input.requester.username)) {
    return await recordDecision({ allowed: false, reason: 'ORG_AGENT_AUDIENCE_DENIED' });
  }
  const preflight = await input.runPreflightService.preflight({
    phase: 'enqueue',
    runId: input.runId,
    sessionId: input.sessionId,
    userId: input.requester.id,
    tenantId: input.account.tenantId,
    orgAgentId: input.account.agentId,
    skipBilling: true,
  });
  return await recordDecision(preflight.accessDecision.verdict === 'allow'
    ? { allowed: true }
    : { allowed: false, reason: preflight.accessDecision.reasonCode });
}

export async function createAgentDwsRuntime(options: {
  agentCwd: string;
  accountStore: AgentDwsAccountStore;
  assignmentStore?: PgAssignmentStore;
  contextStore?: ContextStore;
  messageStore?: AgentDwsMessageStore;
  orgGroupAgentStore?: OrgGroupAgentStore;
  pgEventStore?: PgEventStore;
  pgRunStore?: PgRunStore;
  tablePrefix: string;
  dispatch: AgentRunDispatch;
  resolveDefaultModel: (tenantId: string) => AgentDwsDefaultModelResolution | null;
  userStore: UserStore;
  membershipStore?: Pick<PgMembershipStore, 'getMembership'>;
  orgAgentStore: Pick<OrgAgentStore, 'get'>;
  runPreflightService: Pick<RunPreflightService, 'preflight'>;
  governanceAuditStore: GovernanceAuditStore;
  resolveServerRemote: ConnectorServerRemoteResolver;
  remoteAvailable: boolean;
  enableWorker: boolean;
  isExecutionEnabled?: () => boolean | Promise<boolean>;
  isOrgAgentRuntimeV2Ready?: () => boolean;
  logger: Logger;
}): Promise<AgentDwsRuntimeBundle | undefined> {
  if (!options.pgEventStore || !options.remoteAvailable) {
    options.logger.warn('Agent DWS runtime unavailable: PG event store or connector execution remote is not configured');
    return undefined;
  }

  let authSessionStore: PgDwsAuthSessionStore;
  try {
    authSessionStore = new PgDwsAuthSessionStore({
      pool: options.pgEventStore.pool,
      tablePrefix: options.tablePrefix,
      connectorId: 'agent_dws',
    });
    await authSessionStore.init();
  } catch (error) {
    options.logger.warn(`Agent DWS auth session store init failed: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }

  const contextRuntime = options.contextStore
    ? new DwsContextRuntime({
        agentCwd: options.agentCwd,
        accountStore: options.accountStore,
        contextStore: options.contextStore,
        ...(options.assignmentStore ? { assignmentStore: options.assignmentStore } : {}),
        ...(options.orgGroupAgentStore ? { orgGroupAgentStore: options.orgGroupAgentStore } : {}),
        resolveServerRemote: options.resolveServerRemote,
        logger: options.logger.child('DwsContextRuntime'),
      })
    : undefined;

  const requesterIdentityResolver = new DwsRequesterIdentityResolver({
    agentCwd: options.agentCwd,
    userStore: options.userStore,
    auditStore: options.governanceAuditStore,
    resolveServerRemote: options.resolveServerRemote,
  });
  const messageRouter = options.messageStore
    ? new AgentDwsMessageRouter({
        agentCwd: options.agentCwd,
        messageStore: options.messageStore,
        ...(options.orgGroupAgentStore ? { orgGroupAgentStore: options.orgGroupAgentStore } : {}),
        orgAgentStore: options.orgAgentStore,
        accountStore: options.accountStore,
        dispatch: options.dispatch,
        resolveDefaultModel: options.resolveDefaultModel,
        resolveRequester: (account, senderOpenDingtalkId, senderName) => requesterIdentityResolver.resolve(
          account,
          senderOpenDingtalkId,
          senderName,
        ),
        resolveRequesterOutcome: (account, senderOpenDingtalkId, senderName) => requesterIdentityResolver.resolveOutcome(
          account,
          senderOpenDingtalkId,
          senderName,
        ),
        resolveRequesterGovernanceRole: async (tenantId, userId) => {
          const membership = await options.membershipStore?.getMembership(tenantId, userId);
          return membership?.status === 'active' ? membership.persona : undefined;
        },
        ...(options.isOrgAgentRuntimeV2Ready
          ? { isOrgAgentRuntimeV2Ready: options.isOrgAgentRuntimeV2Ready }
          : {}),
        authorizeCompletionRequester: async (tenantId, agentId, userId) => {
          const [membership, user] = await Promise.all([
            options.membershipStore?.getMembership(tenantId, userId),
            Promise.resolve(options.userStore.findById(userId)),
          ]);
          const agent = options.orgAgentStore.get(agentId);
          return membership?.status === 'active'
            && Boolean(user && !user.disabled && user.tenantId === tenantId)
            && Boolean(agent && agent.enabled && agent.tenantId === tenantId
              && user && isAssignedToOrgAgent(agent, user.username));
        },
        authorizeRequester: input => authorizeAgentDwsRequesterAccess({
          ...input,
          orgAgentStore: options.orgAgentStore,
          runPreflightService: options.runPreflightService,
          auditStore: options.governanceAuditStore,
        }),
        auditRequesterRejection: async ({ account, eventId, requester, reason }) => {
          await options.governanceAuditStore.append({
            correlationId: `agent-dws-rejection:${account.accountId}:${eventId}`,
            actorType: requester ? 'user' : 'service',
            actorUserId: requester?.id ?? `agent-dws:${account.accountId}`,
            actorPersona: requester ? governancePersonaForUser(requester) : 'service',
            actorTenantId: requester?.tenantId ?? account.tenantId,
            action: 'dws.requester.rejected',
            targetType: 'org_agent',
            targetId: account.agentId,
            targetTenantId: account.tenantId,
            purpose: 'persist terminal DWS requester rejection',
            reason,
            result: 'failed',
            metadata: { requesterMapped: Boolean(requester) },
          });
        },
        auditToolPolicyRejection: async ({ account, requester, runId, toolName }) => {
          await options.governanceAuditStore.append({
            correlationId: `agent-dws-tool-policy:${runId}`,
            actorType: 'user',
            actorUserId: requester.id,
            actorPersona: governancePersonaForUser(requester),
            actorTenantId: requester.tenantId ?? account.tenantId,
            action: 'dws.tool_policy.rejected',
            targetType: 'org_agent',
            targetId: account.agentId,
            targetTenantId: account.tenantId,
            purpose: 'persist DWS channel tool policy rejection before provider invocation',
            reason: 'DWS_INTERACTIVE_APPROVAL_UNAVAILABLE',
            result: 'failed',
            metadata: { ...(toolName ? { toolName } : {}), channel: 'dingtalk' },
          });
        },
        sender: new DwsPersonalMessageSender({
          agentCwd: options.agentCwd,
          resolveServerRemote: options.resolveServerRemote,
          logger: options.logger.child('DwsPersonalMessageSender'),
        }),
        ...(options.pgRunStore ? { runStore: options.pgRunStore } : {}),
        eventStore: options.pgEventStore,
        logger: options.logger.child('AgentDwsMessageRouter'),
      })
    : undefined;
  const eventGateway = new DwsPersonalEventGateway({
    agentCwd: options.agentCwd,
    accountStore: options.accountStore,
    resolveServerRemote: options.resolveServerRemote,
    isExecutionEnabled: options.isExecutionEnabled,
    onEvent: async (account, event) => {
      if (!messageRouter) throw new Error('Agent DWS durable inbox is unavailable');
      await messageRouter.ingest(account, event);
      // Context sync remains a best-effort wake after the durable inbox commit. Event
      // content is ignored; the worker re-reads canonical messages from DWS.
      void contextRuntime?.wake(account, event).catch(error => {
        options.logger.warn(
          `DWS context event wake failed account=${account.accountId}: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    },
    logger: options.logger.child('DwsPersonalEventGateway'),
  });
  const authFlowService = new AgentDwsAuthFlowService({
    agentCwd: options.agentCwd,
    authSessionStore,
    accountStore: options.accountStore,
    runner: new DwsDeviceLoginRunner({
      agentCwd: options.agentCwd,
      resolveServerRemote: options.resolveServerRemote,
    }),
    onBeforeAccountIdentityChange: async account => {
      await contextRuntime?.invalidateAccountIdentity(account);
    },
    onConnected: async account => {
      if (!options.enableWorker) return;
      await eventGateway.startAccount(account);
      void contextRuntime?.resumeAccount(account).catch(error => {
        options.logger.warn(
          `DWS context initial backfill failed account=${account.accountId}: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    },
    logger: options.logger.child('AgentDwsAuthFlow'),
  });

  if (options.enableWorker) {
    messageRouter?.start();
    contextRuntime?.start();
    await eventGateway.startAll().catch(error => {
      options.logger.warn(`Agent DWS Personal Stream startup failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  return {
    authFlowService,
    messageRouter,
    eventGateway,
    async onContextPolicyUpdated(account) {
      await contextRuntime?.onContextPolicyUpdated(account);
    },
    async onGroupBindingUpdated(account, conversationId) {
      await contextRuntime?.onGroupBindingUpdated(account, conversationId);
    },
    async onEnabledChanged(account, enabled) {
      await contextRuntime?.onAccountEnabledChanged(account, enabled);
    },
    async stop() {
      await authFlowService.stop();
      await eventGateway.stop();
      await contextRuntime?.stop();
      await messageRouter?.stop();
    },
  };
}
