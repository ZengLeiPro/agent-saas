import express from 'express';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { WebChannel } from '../channels/web/channel.js';
import { createHeadlessWebClient } from '../externalAgent/headlessWebClient.js';
import { FileEventStore, getRuntimeEventLogPath } from '../runtime/fileEventStore.js';
import { FileSessionCatalog } from '../runtime/sessionCatalog.js';
import type { UpsertRunInput } from '../runtime/runStore.js';
import { MemoryRunStore } from './webChannelTestHelpers.js';

describe('headless WebChannel client', () => {
  const itLinux = process.platform === 'linux' ? it : it.skip;

  itLinux(
    'uses canonical durable enqueue and preserves server-only reasoning metadata',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'external-headless-'));
      const enqueued: UpsertRunInput[] = [];
      const runStore = new MemoryRunStore();
      const sessionCatalog = new FileSessionCatalog({ agentCwd: root });
      const user = {
        id: 'svc-1',
        username: 'external-service',
        role: 'user' as const,
        tenantId: 'tenant-a',
        passwordHash: 'unused',
        createdAt: '2026-09-16T00:00:00.000Z',
        createdBy: 'admin',
        disabled: false,
      };
      const channel = new WebChannel(
        {
          agentCwd: root,
          userStore: {
            findById: (id: string) => (id === user.id ? user : undefined),
            listAll: () => [user],
          } as never,
          runtimeEventStoreFor: (transcriptPath, tenantId) =>
            new FileEventStore(getRuntimeEventLogPath(transcriptPath), tenantId),
          enqueueRuntime: {
            scheduler: {
              enqueue: async (input: UpsertRunInput) => {
                enqueued.push(input);
                return runStore.upsertPending(input);
              },
            } as never,
            runStore,
            sessionCatalog,
            enabled: true,
          },
        },
        async function* () {
          yield { type: 'done' as const };
        },
      );
      try {
        await channel.start(express());
        const result = await createHeadlessWebClient(channel).submit({
          userId: user.id,
          tenantId: user.tenantId,
          message: '分析销售额',
          clientMessageId: 'external:apic-1:message-1',
          reasoning: { enabled: true, effort: 'high' },
          externalContext: {
            apiClientId: 'apic-1',
            conversationId: 'conv-1',
            externalConversationId: 'customer-analysis-001',
            metadata: { business_id: 'SO-10086' },
          },
        });
        expect(result).toMatchObject({
          status: 'accepted',
          runId: expect.any(String),
          sessionId: expect.any(String),
        });
        expect(enqueued).toHaveLength(1);
        expect(enqueued[0]).toMatchObject({
          userId: user.id,
          tenantId: user.tenantId,
          idempotencyKey: 'external:apic-1:message-1',
          metadata: {
            externalApiReasoning: { enabled: true, effort: 'high' },
            externalApi: {
              apiClientId: 'apic-1',
              conversationId: 'conv-1',
              externalConversationId: 'customer-analysis-001',
              metadata: { business_id: 'SO-10086' },
            },
            wakeMessage: { content: '分析销售额' },
            chatSubmission: { target: { agentTarget: { kind: 'personal', tenantId: 'tenant-a' } } },
          },
        });
        expect(await sessionCatalog.get(enqueued[0]!.sessionId)).toMatchObject({
          sessionSource: 'external_api',
          externalApi: {
            apiClientId: 'apic-1',
            conversationId: 'conv-1',
            externalConversationId: 'customer-analysis-001',
          },
        });
      } finally {
        await channel.stop();
        await rm(root, { recursive: true, force: true });
      }
    },
  );
});
