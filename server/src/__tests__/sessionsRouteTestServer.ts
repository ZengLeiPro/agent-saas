import express from 'express';
import type { Server } from 'node:http';

import { createSessionsRouter, type SessionsRouterOptions } from '../routes/sessions.js';
import { FileEventStore, getRuntimeEventLogPath } from '../runtime/fileEventStore.js';
import type { OrgAgentStore } from '../data/orgAgents/store.js';
import type { WorkspaceUser } from '../workspace/resolver.js';

type TestWorkspaceUser = WorkspaceUser & { tenantId: string };

export interface SessionsRouteTestServerOptions {
  user?: WorkspaceUser;
  resolveContextAccounting?: SessionsRouterOptions['resolveContextAccounting'];
  orgAgentStore?: OrgAgentStore;
  sessionProjectionStore?: SessionsRouterOptions['sessionProjectionStore'];
  runtimeEventStoreFor?: SessionsRouterOptions['runtimeEventStoreFor'];
  listPendingUserMessagesBySession?: SessionsRouterOptions['listPendingUserMessagesBySession'];
  findRunByClientMessageId?: SessionsRouterOptions['findRunByClientMessageId'];
}

function stopServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

export function createSessionsRouteTestServerHarness(defaultUser: TestWorkspaceUser): {
  startServer: (
    agentCwd: string,
    options?: SessionsRouteTestServerOptions,
  ) => Promise<{ server: Server; baseUrl: string }>;
  stopServer: typeof stopServer;
} {
  const startServer = async (
    agentCwd: string,
    options: SessionsRouteTestServerOptions = {},
  ): Promise<{ server: Server; baseUrl: string }> => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      const user = options.user ?? defaultUser;
      req.user = {
        sub: user.id,
        username: user.username,
        role: user.role,
        tenantId: user.tenantId ?? defaultUser.tenantId,
      };
      next();
    });
    app.use(
      '/api',
      createSessionsRouter({
        agentCwd,
        runtimeEventStoreFor:
          options.runtimeEventStoreFor ??
          ((transcriptPath) =>
            new FileEventStore(getRuntimeEventLogPath(transcriptPath), defaultUser.tenantId)),
        resolveContextAccounting: options.resolveContextAccounting,
        orgAgentStore: options.orgAgentStore,
        sessionProjectionStore: options.sessionProjectionStore,
        listPendingUserMessagesBySession: options.listPendingUserMessagesBySession,
        findRunByClientMessageId: options.findRunByClientMessageId,
      }),
    );

    return new Promise((resolve) => {
      const server = app.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        const port = typeof addr === 'object' && addr ? addr.port : 0;
        resolve({ server, baseUrl: `http://127.0.0.1:${port}` });
      });
    });
  };
  return { startServer, stopServer };
}
