import { describe, expect, it, vi } from 'vitest';

import type { RawRuntimeRunDispatchConfig } from '../runtime/rawRuntimeRunDispatch.js';
import type { RunRecord } from '../runtime/runStore.js';
import { acquireSubagentRunLease } from '../runtime/subagent/subagentRunner.js';

describe('acquireSubagentRunLease 满载接棒', () => {
  const parentRun = {
    runId: 'run-parent',
    sessionId: 'session-parent',
    status: 'running',
    channel: 'web',
    requestedAt: '2026-08-30T16:00:00.000Z',
    updatedAt: '2026-08-30T16:00:00.000Z',
    metadata: {},
  } as RunRecord;

  it('全局满载时首个子结束后，已等待兄弟可接棒父槽并完成', async () => {
    let inheritedChild: string | undefined;
    const acquiredOrder: string[] = [];
    const acquireLease = vi.fn(async (childRunId: string) => {
      if (inheritedChild) return null;
      inheritedChild = childRunId;
      acquiredOrder.push(childRunId);
      return { ...parentRun, runId: childRunId, sessionId: `session-${childRunId}` };
    });
    const config = {
      agentCwd: '/tmp',
      sharedDir: '/tmp',
      runStore: { acquireLease },
      resolveRuntimeRunCapacity: () => ({ maxConcurrentRuns: 500, foregroundReservedRuns: 100 }),
    } as unknown as RawRuntimeRunDispatchConfig;
    let releaseFirst!: () => void;
    const firstMayFinish = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const runChild = async (childRunId: string) => {
      const controller = new AbortController();
      await acquireSubagentRunLease({
        config, parentRun, parentRunId: parentRun.runId, childRunId,
        leaseMs: 60_000, signal: controller.signal,
      });
      if (childRunId === 'child-1') {
        await firstMayFinish;
        inheritedChild = undefined;
      }
    };

    const first = runChild('child-1');
    await vi.waitFor(() => expect(acquiredOrder).toEqual(['child-1']));
    const second = runChild('child-2');
    await vi.waitFor(() => expect(acquireLease.mock.calls.length).toBeGreaterThan(1));
    releaseFirst();
    await Promise.all([first, second]);
    expect(acquiredOrder).toEqual(['child-1', 'child-2']);
    expect(acquireLease.mock.calls.every((call) => (
      (call as unknown[])[5] as { inheritFromRunId?: string }
    )?.inheritFromRunId === parentRun.runId)).toBe(true);
  });

  it('等待中的兄弟会响应父取消，不会拖到硬超时', async () => {
    const controller = new AbortController();
    const config = {
      agentCwd: '/tmp',
      sharedDir: '/tmp',
      runStore: { acquireLease: vi.fn().mockResolvedValue(null) },
      resolveRuntimeRunCapacity: () => ({ maxConcurrentRuns: 500, foregroundReservedRuns: 100 }),
    } as unknown as RawRuntimeRunDispatchConfig;
    const waiting = acquireSubagentRunLease({
      config, parentRun, parentRunId: parentRun.runId, childRunId: 'child-waiting',
      leaseMs: 60_000, signal: controller.signal,
    });
    controller.abort(new Error('parent cancelled'));
    await expect(waiting).rejects.toThrow('parent cancelled');
  });
});
