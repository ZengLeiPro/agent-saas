import express from 'express';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAgentDwsAccountsRouter } from '../routes/agentDwsAccounts.js';

async function open(
  user: { sub: string; username: string; role: 'admin'; tenantId: string },
  service: Record<string, unknown>,
) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = user;
    next();
  });
  app.use('/api', createAgentDwsAccountsRouter({ receiverMigrationService: service as never }));
  return await new Promise<{ server: Server; baseUrl: string }>((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({
        server,
        baseUrl: `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`,
      });
    });
  });
}

describe('Agent DWS durable receiver migration routes', () => {
  let server: Server | undefined;
  afterEach(() => {
    server?.close();
    server = undefined;
  });

  it('allows only the platform administrator to activate a migration', async () => {
    const activate = vi.fn();
    const opened = await open(
      { sub: 'org-admin', username: 'org-admin', role: 'admin', tenantId: 'tenant-one' },
      { activate },
    );
    server = opened.server;
    const response = await fetch(
      `${opened.baseUrl}/api/agent-dws-accounts/account-one/durable-receiver-migration/activate`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tenantId: 'tenant-one', expectedRevision: 7 }),
      },
    );
    expect(response.status).toBe(403);
    expect(activate).not.toHaveBeenCalled();
  });

  it('passes an exact revision and actor through the platform-only activation endpoint', async () => {
    const migration = {
      migrationId: 'migration-one',
      tenantId: 'tenant-one',
      accountId: 'account-one',
      expectedRevision: 7,
      state: 'activated',
      evidence: {},
    };
    const activate = vi.fn(async () => migration);
    const opened = await open(
      { sub: 'platform-admin', username: 'root', role: 'admin', tenantId: 'pantheon' },
      { activate },
    );
    server = opened.server;
    const response = await fetch(
      `${opened.baseUrl}/api/agent-dws-accounts/account-one/durable-receiver-migration/activate`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tenantId: 'tenant-one', expectedRevision: 7 }),
      },
    );
    expect(response.status).toBe(200);
    expect(activate).toHaveBeenCalledWith('tenant-one', 'account-one', 7, 'root');
    expect(await response.json()).toEqual({ migration });
  });
});
