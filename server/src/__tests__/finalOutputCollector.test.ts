import { describe, expect, it, vi } from 'vitest';

import type { ExternalExecutionRecord } from '../data/externalConversations/index.js';
import { FinalOutputCollector } from '../externalAgent/finalOutputCollector.js';
import type { RunRecord } from '../runtime/runStore.js';

function execution(): ExternalExecutionRecord {
  return {
    executionId: 'exec-1',
    conversationId: 'conv-1',
    clientId: 'apic-1',
    tenantId: 'tenant-a',
    serviceAccountUserId: 'svc-1',
    runId: 'run-1',
    sessionId: 'session-1',
    clientMessageId: 'message-1',
    idempotencyKey: 'idem-1',
    requestHash: 'hash-1',
    submissionStatus: 'accepted',
    requestedReasoningEffort: 'high',
    createdAt: '2026-09-16T00:00:00.000Z',
    updatedAt: '2026-09-16T00:00:00.000Z',
  };
}

function run(status: RunRecord['status']): RunRecord {
  return {
    runId: 'run-1',
    sessionId: 'session-1',
    userId: 'svc-1',
    tenantId: 'tenant-a',
    status,
    model: 'configured/model-ref',
    actualModelSeen: 'provider-model',
    requestedAt: '2026-09-16T00:00:00.000Z',
    updatedAt: '2026-09-16T00:00:01.000Z',
    metadata: {},
  };
}

describe('FinalOutputCollector', () => {
  it('returns only the final assistant message for the bound run', async () => {
    const collector = new FinalOutputCollector({
      runStore: { get: vi.fn(async () => run('completed')) },
      sessionCatalog: {
        get: vi.fn(async () => ({
          sessionId: 'session-1',
          tenantId: 'tenant-a',
          userId: 'svc-1',
          username: 'external-service',
          channel: 'web',
          kind: 'user',
          cwd: '/workspace',
          transcriptPath: '/workspace/session.jsonl',
          workspaceId: 'workspace-1',
          status: 'idle',
          createdAt: '2026-09-16T00:00:00.000Z',
          updatedAt: '2026-09-16T00:00:01.000Z',
        })),
      } as never,
      eventStoreFor: () =>
        ({
          list: vi.fn(async () => [
            {
              id: 'event-old',
              sequence: '1',
              timestamp: '2026-09-16T00:00:00.000Z',
              type: 'assistant_message',
              tenantId: 'tenant-a',
              sessionId: 'session-1',
              runId: 'run-old',
              content: '上一轮答案',
            },
            {
              id: 'event-final',
              sequence: '2',
              timestamp: '2026-09-16T00:00:01.000Z',
              type: 'assistant_message',
              tenantId: 'tenant-a',
              sessionId: 'session-1',
              runId: 'run-1',
              content: '本轮最终答案',
            },
          ]),
        }) as never,
    });

    await expect(collector.collect(execution())).resolves.toEqual({
      executionId: 'exec-1',
      conversationId: 'conv-1',
      status: 'completed',
      output: { text: '本轮最终答案' },
      usage: { effectiveModel: 'provider-model', reasoningEffort: 'high' },
    });
  });

  it('does not expose internal events or another tenant run', async () => {
    const wrongTenant = run('completed');
    wrongTenant.tenantId = 'tenant-b';
    const collector = new FinalOutputCollector({
      runStore: { get: vi.fn(async () => wrongTenant) },
      sessionCatalog: { get: vi.fn() },
      eventStoreFor: vi.fn() as never,
    });
    await expect(collector.collect(execution())).resolves.toMatchObject({
      status: 'failed',
      error: { code: 'execution_unavailable' },
      usage: {},
    });
  });
});
