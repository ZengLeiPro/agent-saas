import express from 'express';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';

import { InMemoryExternalConversationStore } from '../data/externalConversations/index.js';
import { createExternalAgentOperationsAdminRouter } from '../routes/externalAgentOperations.js';

let server: Server | undefined;
afterEach(async () => {
  if (!server) return;
  await new Promise<void>((resolve, reject) =>
    server!.close((error) => (error ? reject(error) : resolve())),
  );
  server = undefined;
});

describe('external Agent operations API', () => {
  it('returns tenant-scoped conversations, executions and hash-only query audit', async () => {
    const conversations = new InMemoryExternalConversationStore();
    const created = await conversations.createConversation({
      clientId: 'client-a',
      tenantId: 'tenant-a',
      serviceAccountUserId: 'svc-a',
      externalConversationId: 'erp-1',
      databaseConnectionId: 'dbc-1',
      agentId: 'oa-1',
      metadata: { order: 'SO-1' },
      idempotencyKey: 'conv-1',
      requestHash: 'hash-1',
    });
    const reserved = await conversations.reserveExecution({
      conversation: created.record,
      idempotencyKey: 'exec-1',
      requestHash: 'hash-2',
    });
    await conversations.bindAcceptedExecution({
      executionId: reserved.record.executionId,
      conversationId: created.record.conversationId,
      runId: 'run-1',
      sessionId: 'session-1',
    });
    const app = express();
    app.use((req, _res, next) => {
      req.user = { sub: 'admin', username: 'admin', role: 'admin', tenantId: 'tenant-a' };
      next();
    });
    app.use(
      '/api/admin/external-agent-operations',
      createExternalAgentOperationsAdminRouter({
        conversations,
        databaseConnections: {
          listQueryAudit: async () => [
            {
              auditId: '1',
              connectionId: 'dbc-1',
              tenantId: 'tenant-a',
              apiClientId: 'client-a',
              conversationId: created.record.conversationId,
              sessionId: 'session-1',
              runId: 'run-1',
              sqlHash: 'a'.repeat(64),
              status: 'completed',
              durationMs: 2,
              rowCount: 1,
              resultBytes: 12,
              truncated: false,
              createdAt: new Date().toISOString(),
            },
          ],
        } as never,
        billingService: {
          ensureProjected: async () => undefined,
          getSummaryForTenant: async () => ({
            tenantId: 'tenant-a',
            balanceCredits: 88,
            lowBalance: false,
            billingEnabled: true,
            billingMode: 'prepaid',
            pricingVersion: 'v1',
            policyVersion: 'p1',
            creditValueYuan: 0.01,
            currentMonthCreditsUsed: 12,
            currentMonthRevenueYuan: 0.12,
          }),
          store: {
            listUsageEvents: async () => [
              {
                actualModel: 'gpt-test',
                modelValue: 'gpt-test',
                inputTokens: 10,
                outputTokens: 4,
                cachedInputTokens: 2,
                reasoningTokens: 1,
                apiRequestCount: 1,
                actualCostYuanMicro: 30_000,
              },
            ],
            listLedger: async () => ({
              entries: [
                {
                  type: 'debit',
                  creditsDeltaMicro: -12_000_000,
                  revenueYuanMicro: 120_000,
                },
              ],
            }),
            getMemberBudgetOverview: async () => ({ items: [] }),
          },
        } as never,
      }),
    );
    server = await new Promise<Server>((resolve) => {
      const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('not listening');
    const response = await fetch(
      `http://127.0.0.1:${address.port}/api/admin/external-agent-operations`,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, any>;
    expect(body.conversations[0]).toMatchObject({ clientId: 'client-a', agentId: 'oa-1' });
    expect(body.executions).toHaveLength(1);
    expect(body.queryAudit[0]).toMatchObject({ sqlHash: 'a'.repeat(64) });
    expect(body.usageSummary.client[0]).toMatchObject({
      key: 'client-a',
      inputTokens: 10,
      outputTokens: 4,
      chargedCredits: 12,
    });
    expect(body.usageSummary.connection[0]).toMatchObject({ key: 'dbc-1' });
    expect(body.billingSummary).toMatchObject({ balanceCredits: 88 });
    expect(JSON.stringify(body)).not.toContain('SELECT');
  });
});
