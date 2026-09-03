import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRawRuntimeRunDispatch } from '../runtime/rawRuntimeRunDispatch.js';
import type { RunStore } from '../runtime/runStore.js';
import type { OutboundEvent } from '../types/index.js';
import { MemorySessionCatalog } from './runtimeStage2.testHelpers.js';

const SHARED_DIR = resolve(process.cwd(), '../workspace-shared');
const TENANT_ID = 'tenant-test';

describe('Cron Runtime identity', () => {
  const cleanupDirs = new Set<string>();
  afterEach(async () => {
    vi.restoreAllMocks();
    for (const dir of cleanupDirs) await rm(dir, { recursive: true, force: true });
    cleanupDirs.clear();
  });

  it('预分配 Runtime 身份命中已有 run 时 create-only 退让且不进入模型', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'runtime-create-only-'));
    cleanupDirs.add(cwd);
    const sessionCatalog = new MemorySessionCatalog();
    const upsertPending = vi.fn();
    const createPending = vi.fn(async (input: any) => ({
      created: false,
      record: { ...input, status: 'running' as const, requestedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(), metadata: input.metadata ?? {} },
    }));
    const dispatch = createRawRuntimeRunDispatch({
      agentCwd: cwd, sharedDir: SHARED_DIR, sessionCatalog,
      runStore: { createPending, upsertPending } as unknown as RunStore, memory: { enabled: false },
    });
    const events: OutboundEvent[] = [];
    for await (const event of dispatch(
      { channel: 'cron', chatId: 'cron-job-1', content: '只运行一次' },
      { channel: 'cron', sessionOwner: { id: 'user-1', username: 'owner', role: 'user', tenantId: TENANT_ID } },
      { runtimeRunId: 'runtime-run-1', runtimeSessionId: 'runtime-session-1', runtimeRunCreateOnly: true,
        modelConnection: { apiKey: 'sk-test' }, skipSystemPrompt: true },
    )) events.push(event);
    expect(events).toEqual([]);
    expect(createPending).toHaveBeenCalledWith(expect.objectContaining({
      runId: 'runtime-run-1', sessionId: 'runtime-session-1', channel: 'cron',
    }));
    expect(upsertPending).not.toHaveBeenCalled();
  });
});
