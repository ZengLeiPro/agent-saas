import { describe, expect, it, vi } from 'vitest';
import { claimRuntimeRun } from '../runtime/runtimeRunClaim.js';
import type { RunStore } from '../runtime/runStore.js';

const input = {
  runId: 'runtime-run-1', sessionId: 'session-1', tenantId: 'tenant-1', userId: 'user-1',
  channel: 'cron', metadata: {},
};

describe('Runtime create-only claim', () => {
  it('普通 wake 即使支持 createPending 也必须续用 upsertPending', async () => {
    const upsertPending = vi.fn(async () => ({ ...input, status: 'running' }));
    const createPending = vi.fn();
    await expect(claimRuntimeRun({ upsertPending, createPending } as unknown as RunStore, input, false)).resolves.toBe(true);
    expect(upsertPending).toHaveBeenCalledWith(input);
    expect(createPending).not.toHaveBeenCalled();
  });

  it('预分配 runId 时拒绝退化到可复活旧状态的 upsertPending', async () => {
    const upsertPending = vi.fn();
    await expect(claimRuntimeRun({ upsertPending } as unknown as RunStore, input, true))
      .rejects.toThrow('requires create-only persistence');
    expect(upsertPending).not.toHaveBeenCalled();
  });

  it('create-only 冲突时复用相同 session 且不取得执行权', async () => {
    const createPending = vi.fn(async () => ({ created: false, record: { ...input, status: 'running' } }));
    await expect(claimRuntimeRun({ createPending } as unknown as RunStore, input, true)).resolves.toBe(false);
  });
});
