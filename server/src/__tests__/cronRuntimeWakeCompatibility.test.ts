import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { wakeRuntimeSession } from '../runtime/rawRuntimeRunDispatch.js';
import type { RunRecord, RunStore } from '../runtime/runStore.js';
import type { RuntimeSessionRecord } from '../runtime/sessionCatalog.js';
import { MemoryEventStore, MemorySessionCatalog } from './runtimeWake.testHelpers.js';

const TENANT_ID = 'tenant-test';
const SHARED_DIR = resolve(process.cwd(), '../workspace-shared');

describe('Cron create-only 与 Runtime wake 兼容性', () => {
  it('已有 Runtime Run 的普通 wake 继续进入 dispatch，不被 create-only 静默短路', async () => {
    const now = new Date().toISOString();
    const session: RuntimeSessionRecord = {
      sessionId: 'session-wake-existing', userId: 'user-1', username: 'alice', tenantId: TENANT_ID,
      channel: 'web', cwd: process.cwd(), transcriptPath: resolve(process.cwd(), 'wake-existing.jsonl'),
      modelRef: 'gpt-5.4-mini', executionTarget: 'server-local', workspaceId: 'workspace-1',
      status: 'running', createdAt: now, updatedAt: now,
    };
    const run: RunRecord = {
      runId: 'run-wake-existing', sessionId: session.sessionId, userId: session.userId, tenantId: TENANT_ID,
      status: 'running', model: 'gpt-5.4-mini', channel: 'web', requestedAt: now, updatedAt: now,
      executionTarget: session.executionTarget, workspaceId: session.workspaceId,
      metadata: { wakeMessage: { channel: 'web', chatId: session.sessionId, content: '继续执行' } },
    };
    const upsertPending = vi.fn(async () => run);
    const createPending = vi.fn(async () => ({ created: false, record: run }));
    const runStore = { get: vi.fn(async () => run), upsertPending, createPending } as unknown as RunStore;
    const outbound: string[] = [];
    const oldApiKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = 'sk-test';
    try {
      await expect(wakeRuntimeSession({
        agentCwd: process.cwd(), sharedDir: SHARED_DIR,
        sessionCatalog: new MemorySessionCatalog(session), eventStoreFactory: () => new MemoryEventStore(), runStore,
      }, run, {
        lease: { runId: run.runId, workerId: 'worker-1', renew: async () => {}, release: async () => {} },
        onOutboundEvent: async (event) => {
          outbound.push(event.type);
          if (event.type === 'session_init') throw new Error('dispatch_reached');
        },
      })).rejects.toThrow('dispatch_reached');
    } finally {
      if (oldApiKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = oldApiKey;
    }
    expect(outbound).toContain('session_init');
    expect(upsertPending).toHaveBeenCalledTimes(1);
    expect(createPending).not.toHaveBeenCalled();
  });
});
