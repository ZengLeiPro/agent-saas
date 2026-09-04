import express from 'express';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { InMemoryGovernanceAuditStore } from '../data/governance-audit/index.js';
import { createAgentDwsAccountsRouter } from '../routes/agentDwsAccounts.js';

describe('Agent DWS 群审批路由', () => {
  let server: Server | undefined;
  afterEach(async () => {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  });

  it('工作台返回待审批操作，并由管理员审计后恢复原任务', async () => {
    const listPending = vi.fn(async () => [
      {
        approvalId: 'approval/a',
        inboxId: 'inbox-a',
        sessionId: 'session-a',
        runId: 'run-a',
        bindingId: 'binding-a',
        conversationId: 'cid-a',
        workConversationId: 'work-conversation-a',
        toolName: 'DwsBusiness',
        input: { token: '[REDACTED]' },
        createdAt: '2026-09-04T00:00:00.000Z',
      },
    ]);
    const decide = vi.fn(async () => ({
      approvalId: 'approval/a',
      runId: 'run-a',
      status: 'queued' as const,
    }));
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as unknown as { user: unknown }).user = {
        sub: 'admin-a',
        username: 'alice',
        role: 'admin',
        tenantId: 'tenant-a',
      };
      next();
    });
    app.use(
      '/api',
      createAgentDwsAccountsRouter({
        accountStore: {
          getForTenant: vi.fn(async () => ({ accountId: 'adws-1' })),
        } as never,
        orgGroupAgentStore: {
          listBindings: vi.fn(async () => []),
          listDeliveries: vi.fn(async () => []),
          loadGroupWorkspace: vi.fn(async () => ({
            conversations: [],
            workOrders: [],
            attempts: [],
            memories: [],
          })),
        } as never,
        orgAgentStore: { get: vi.fn() } as never,
        approvalService: { listPending, decide } as never,
        auditStore: new InMemoryGovernanceAuditStore(),
      }),
    );
    const opened = await new Promise<{ server: Server; baseUrl: string }>((resolve) => {
      const listener = app.listen(0, '127.0.0.1', () => {
        const address = listener.address();
        resolve({
          server: listener,
          baseUrl: `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`,
        });
      });
    });
    server = opened.server;

    const view = await fetch(`${opened.baseUrl}/api/agent-dws-accounts/adws-1/group-workspace`);
    expect(view.status).toBe(200);
    expect(await view.json()).toMatchObject({ approvals: [{ approvalId: 'approval/a' }] });
    const response = await fetch(
      `${opened.baseUrl}/api/agent-dws-accounts/adws-1/group-workspace/approvals/approval%2Fa/decision`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ decision: 'approved' }),
      },
    );
    expect(response.status).toBe(202);
    expect(decide).toHaveBeenCalledWith({
      tenantId: 'tenant-a',
      accountId: 'adws-1',
      approvalId: 'approval/a',
      decision: 'approved',
      actorUserId: 'admin-a',
    });
  });
});
