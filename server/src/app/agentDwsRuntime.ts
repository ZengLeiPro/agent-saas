import type { AgentRunDispatch } from '../agent/index.js';
import { DwsContextRuntime } from '../context/sync/index.js';
import type { ContextStore } from '../context/store/index.js';
import type { AgentDwsAccountRecord, AgentDwsAccountStore } from '../data/agentDwsAccounts/index.js';
import type { PgAssignmentStore } from '../data/assignments/index.js';
import type { AgentDwsMessageStore } from '../data/agentDwsMessages/index.js';
import { AgentDwsAuthFlowService } from '../dws/agentAuthFlow.js';
import { DwsDeviceLoginRunner, type DwsWorkspacePrincipal } from '../dws/authFlow.js';
import { PgDwsAuthSessionStore } from '../dws/authStore.js';
import { DwsPersonalEventGateway } from '../dws/personalEventGateway.js';
import {
  AgentDwsMessageRouter,
  type AgentDwsDefaultModelResolution,
} from '../dws/personalMessageRouter.js';
import { DwsPersonalMessageSender } from '../dws/personalMessageSender.js';
import type { PgEventStore } from '../runtime/pgEventStore.js';
import type { PgRunStore } from '../runtime/runStore.js';
import type { Logger } from '../utils/logger.js';

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
  onEnabledChanged(account: AgentDwsAccountRecord, enabled: boolean): Promise<void>;
  stop(): Promise<void>;
}

export async function createAgentDwsRuntime(options: {
  agentCwd: string;
  accountStore: AgentDwsAccountStore;
  assignmentStore?: PgAssignmentStore;
  contextStore?: ContextStore;
  messageStore?: AgentDwsMessageStore;
  pgEventStore?: PgEventStore;
  pgRunStore?: PgRunStore;
  tablePrefix: string;
  dispatch: AgentRunDispatch;
  resolveDefaultModel: (tenantId: string) => AgentDwsDefaultModelResolution | null;
  resolveServerRemote: ConnectorServerRemoteResolver;
  remoteAvailable: boolean;
  enableWorker: boolean;
  isExecutionEnabled?: () => boolean | Promise<boolean>;
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
        resolveServerRemote: options.resolveServerRemote,
        logger: options.logger.child('DwsContextRuntime'),
      })
    : undefined;

  const messageRouter = options.messageStore
    ? new AgentDwsMessageRouter({
        agentCwd: options.agentCwd,
        messageStore: options.messageStore,
        accountStore: options.accountStore,
        dispatch: options.dispatch,
        resolveDefaultModel: options.resolveDefaultModel,
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
      // Context sync is a best-effort wake after the durable inbox commit. Event
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
