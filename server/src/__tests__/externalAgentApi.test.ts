import express from 'express';
import type { AddressInfo } from 'node:net';
import { describe, expect, it, vi } from 'vitest';

import type { ExternalClientPrincipal } from '../data/externalClients/index.js';
import { InMemoryExternalConversationStore } from '../data/externalConversations/index.js';
import { createExternalAgentApiRouter } from '../routes/externalAgentApi.js';

function principal(overrides: Partial<ExternalClientPrincipal> = {}): ExternalClientPrincipal {
  return {
    tenantId: 'tenant-a',
    serviceAccountUserId: 'svc-1',
    username: 'external-service',
    client: {
      clientId: 'apic-1',
      tenantId: 'tenant-a',
      serviceAccountUserId: 'svc-1',
      name: 'ERP',
      keyHash: 'hash',
      keyPrefix: 'ky_ext_prefix',
      scopes: ['conversations:write', 'executions:read'],
      allowedConnectionIds: ['dbc-1'],
      status: 'active',
      createdAt: '2026-09-16T00:00:00.000Z',
      createdBy: 'admin',
      updatedAt: '2026-09-16T00:00:00.000Z',
      updatedBy: 'admin',
    },
    ...overrides,
  };
}

function testApp(options: { running?: boolean } = {}) {
  const store = new InMemoryExternalConversationStore();
  const submit = vi.fn(async () => ({
    status: 'accepted' as const,
    sessionId: 'session-1',
    runId: 'run-1',
    submissionStatus: 'accepted' as const,
  }));
  const result = options.running
    ? {
        executionId: 'placeholder',
        conversationId: 'placeholder',
        status: 'running' as const,
        usage: {},
      }
    : {
        executionId: 'placeholder',
        conversationId: 'placeholder',
        status: 'completed' as const,
        output: { text: '最终答案' },
        usage: { effectiveModel: 'gpt-test', reasoningEffort: 'high' },
      };
  const outputCollector = {
    collect: vi.fn(async (execution: { executionId: string; conversationId: string }) => ({
      ...result,
      executionId: execution.executionId,
      conversationId: execution.conversationId,
    })),
    waitForTerminal: vi.fn(async (execution: { executionId: string; conversationId: string }) => ({
      ...result,
      executionId: execution.executionId,
      conversationId: execution.conversationId,
    })),
  };
  const app = express();
  app.use(express.json());
  app.use(
    '/v1',
    createExternalAgentApiRouter({
      authenticator: {
        authenticateBearer: vi.fn(async () => ({ ok: true as const, principal: principal() })),
      } as never,
      store,
      headlessClient: { submit },
      outputCollector: outputCollector as never,
    }),
  );
  return { app, store, submit, outputCollector };
}

async function apiRequest(
  app: express.Express,
  path: string,
  options: { method?: 'GET' | 'POST'; idempotencyKey?: string; body?: unknown } = {},
): Promise<{ status: number; body: Record<string, any> }> {
  const server = await new Promise<ReturnType<express.Express['listen']>>((resolve) => {
    const opened = app.listen(0, '127.0.0.1', () => resolve(opened));
  });
  try {
    const address = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${address.port}${path}`, {
      method: options.method ?? 'POST',
      headers: {
        Authorization: 'Bearer ky_ext_test',
        ...(options.idempotencyKey ? { 'Idempotency-Key': options.idempotencyKey } : {}),
        ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
    return { status: response.status, body: (await response.json()) as Record<string, any> };
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

describe('External Agent public API', () => {
  it('creates a conversation idempotently and hides unauthorized connection ids', async () => {
    const { app } = testApp();
    const first = await apiRequest(app, '/v1/conversations', {
      idempotencyKey: 'conv-request-1',
      body: {
        external_conversation_id: 'customer-analysis-001',
        database_connection_id: 'dbc-1',
        metadata: { business_id: 'SO-10086' },
      },
    });
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({
      external_conversation_id: 'customer-analysis-001',
      status: 'active',
      database_connection: { id: 'dbc-1' },
    });

    const replay = await apiRequest(app, '/v1/conversations', {
      idempotencyKey: 'conv-request-1',
      body: {
        external_conversation_id: 'customer-analysis-001',
        database_connection_id: 'dbc-1',
        metadata: { business_id: 'SO-10086' },
      },
    });
    expect(replay.status).toBe(200);
    expect(replay.body.id).toBe(first.body.id);

    const denied = await apiRequest(app, '/v1/conversations', {
      idempotencyKey: 'conv-request-2',
      body: { external_conversation_id: 'other', database_connection_id: 'dbc-cross-tenant' },
    });
    expect(denied.status).toBe(404);
    expect(denied.body.code).toBe('database_connection_not_found');
  });

  it('submits the same canonical WebChannel message once and returns final output', async () => {
    const { app, submit } = testApp();
    const created = await apiRequest(app, '/v1/conversations', {
      idempotencyKey: 'conv-1',
      body: { external_conversation_id: 'customer-analysis-001' },
    });

    const first = await apiRequest(app, `/v1/conversations/${created.body.id}/messages`, {
      idempotencyKey: 'message-1',
      body: {
        message: '分析销售额',
        model: 'inherit',
        reasoning: { enabled: true, effort: 'high' },
        response_mode: 'final',
        wait_timeout_ms: 100,
      },
    });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({
      conversation_id: created.body.id,
      status: 'completed',
      output: { text: '最终答案' },
      usage: { effective_model: 'gpt-test', reasoning_effort: 'high' },
    });
    expect(submit).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'svc-1',
        tenantId: 'tenant-a',
        message: '分析销售额',
        reasoning: { enabled: true, effort: 'high' },
        externalContext: {
          apiClientId: 'apic-1',
          conversationId: created.body.id,
          externalConversationId: 'customer-analysis-001',
          metadata: {},
        },
      }),
    );

    const replay = await apiRequest(app, `/v1/conversations/${created.body.id}/messages`, {
      idempotencyKey: 'message-1',
      body: {
        message: '分析销售额',
        model: 'inherit',
        reasoning: { enabled: true, effort: 'high' },
        response_mode: 'final',
        wait_timeout_ms: 0,
      },
    });
    expect(replay.status).toBe(200);
    expect(replay.body.execution_id).toBe(first.body.execution_id);
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it('returns 202 with a durable result URL and rejects changed idempotent requests', async () => {
    const { app } = testApp({ running: true });
    const created = await apiRequest(app, '/v1/conversations', {
      idempotencyKey: 'conv-2',
      body: { external_conversation_id: 'conversation-2' },
    });
    const running = await apiRequest(app, `/v1/conversations/${created.body.id}/messages`, {
      idempotencyKey: 'message-2',
      body: { message: '长任务', wait_timeout_ms: 0 },
    });
    expect(running.status).toBe(202);
    expect(running.body.result_url).toBe(`/v1/executions/${running.body.execution_id}`);

    const conflict = await apiRequest(app, `/v1/conversations/${created.body.id}/messages`, {
      idempotencyKey: 'message-2',
      body: { message: '不同任务', wait_timeout_ms: 0 },
    });
    expect(conflict.status).toBe(409);
    expect(conflict.body.code).toBe('idempotency_conflict');
  });
});
