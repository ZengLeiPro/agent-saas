import type { AgentRunDispatch } from '../agent/index.js';
import type { AgentDwsAccountStore } from '../data/agentDwsAccounts/index.js';
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
  stop(): Promise<void>;
}

export async function createAgentDwsRuntime(options: {
  agentCwd: string;
  accountStore: AgentDwsAccountStore;
  messageStore?: AgentDwsMessageStore;
  pgEventStore?: PgEventStore;
  pgRunStore?: PgRunStore;
  tablePrefix: string;
  dispatch: AgentRunDispatch;
  resolveDefaultModel: (tenantId: string) => AgentDwsDefaultModelResolution | null;
  resolveServerRemote: ConnectorServerRemoteResolver;
  remoteAvailable: boolean;
  enableWorker: boolean;
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
    onEvent: async (account, event) => {
      if (!messageRouter) throw new Error('Agent DWS durable inbox is unavailable');
      await messageRouter.ingest(account, event);
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
    onConnected: account => options.enableWorker ? eventGateway.startAccount(account) : Promise.resolve(),
    logger: options.logger.child('AgentDwsAuthFlow'),
  });

  if (options.enableWorker) {
    messageRouter?.start();
    await eventGateway.startAll().catch(error => {
      options.logger.warn(`Agent DWS Personal Stream startup failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  return {
    authFlowService,
    messageRouter,
    eventGateway,
    async stop() {
      await authFlowService.stop();
      await eventGateway.stop();
      await messageRouter?.stop();
    },
  };
}
