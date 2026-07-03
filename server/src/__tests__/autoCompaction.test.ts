import { beforeEach, describe, expect, it, vi } from 'vitest';

import { configureModelPricing, getModelContextWindow } from '../data/usage/pricing.js';
import { AutoCompactionService, evaluateAutoCompaction } from '../runtime/autoCompaction.js';
import type { PlatformEvent } from '../runtime/types.js';
import type { RunRecord, RunStore } from '../runtime/runStore.js';

function assistantEvent(index: number, inputTokens: number, outputTokens = 100): PlatformEvent {
  return {
    id: `event-${index}`,
    timestamp: new Date(2026, 6, 3, 0, 0, index).toISOString(),
    type: 'assistant_message',
    runId: `run-${index}`,
    sessionId: 'session-1',
    content: `回复 ${index}`,
    usage: { inputTokens, outputTokens },
  } as PlatformEvent;
}

function compactionEvent(index: number): PlatformEvent {
  return {
    id: `compaction-${index}`,
    timestamp: new Date(2026, 6, 3, 0, 0, index).toISOString(),
    type: 'compaction',
    runId: `run-compact-${index}`,
    sessionId: 'session-1',
    summary: '摘要',
    coveredEventCount: index,
  } as PlatformEvent;
}

describe('evaluateAutoCompaction（自动压缩判定）', () => {
  beforeEach(() => {
    configureModelPricing({
      groups: [{
        models: [{ value: 'glm-5.2', context_window: 100_000 }],
      }],
    });
  });

  it('租户未开启：不触发', () => {
    const result = evaluateAutoCompaction({
      events: [assistantEvent(0, 90_000)],
      model: 'glm-5.2',
      autoCompactEnabled: false,
    });
    expect(result).toMatchObject({ shouldCompact: false, reason: 'tenant_disabled' });
  });

  it('模型未配置 context_window：不触发', () => {
    const result = evaluateAutoCompaction({
      events: [assistantEvent(0, 90_000)],
      model: 'unknown-model',
      autoCompactEnabled: true,
    });
    expect(result).toMatchObject({ shouldCompact: false, reason: 'no_context_window_configured' });
    expect(getModelContextWindow('unknown-model')).toBeUndefined();
  });

  it('低于阈值（80%）：不触发；达到阈值：触发', () => {
    const below = evaluateAutoCompaction({
      events: [assistantEvent(0, 70_000, 100)],
      model: 'glm-5.2',
      autoCompactEnabled: true,
    });
    expect(below).toMatchObject({ shouldCompact: false, reason: 'below_threshold' });

    const above = evaluateAutoCompaction({
      events: [assistantEvent(0, 85_000, 100)],
      model: 'glm-5.2',
      autoCompactEnabled: true,
    });
    expect(above).toMatchObject({ shouldCompact: true, reason: 'threshold_exceeded' });
    expect(above.currentTokens).toBe(85_100);
    expect(above.contextWindow).toBe(100_000);
  });

  it('以最后一条带 usage 的 assistant 事件为准（当前上下文口径）', () => {
    const result = evaluateAutoCompaction({
      events: [assistantEvent(0, 95_000), assistantEvent(1, 10_000)],
      model: 'glm-5.2',
      autoCompactEnabled: true,
    });
    // 最后一轮 10k，不是更早的 95k
    expect(result).toMatchObject({ shouldCompact: false, reason: 'below_threshold' });
  });

  it('防死循环：最后一次压缩之后没有新的模型轮 → 不触发', () => {
    const result = evaluateAutoCompaction({
      events: [assistantEvent(0, 95_000), compactionEvent(1)],
      model: 'glm-5.2',
      autoCompactEnabled: true,
    });
    expect(result).toMatchObject({ shouldCompact: false, reason: 'just_compacted' });
  });

  it('压缩后又有新的超阈值轮：可再次触发', () => {
    const result = evaluateAutoCompaction({
      events: [assistantEvent(0, 95_000), compactionEvent(1), assistantEvent(2, 90_000)],
      model: 'glm-5.2',
      autoCompactEnabled: true,
    });
    expect(result).toMatchObject({ shouldCompact: true });
  });

  it('无任何 usage 事件：不触发', () => {
    const result = evaluateAutoCompaction({ events: [], model: 'glm-5.2', autoCompactEnabled: true });
    expect(result).toMatchObject({ shouldCompact: false, reason: 'no_usage_events' });
  });
});

describe('AutoCompactionService（调度 / 让路 / 抢占）', () => {
  beforeEach(() => {
    configureModelPricing({
      groups: [{ models: [{ value: 'glm-5.2', context_window: 100_000 }] }],
    });
  });

  function makeService(activeRuns: RunRecord[] = []) {
    const upserted: unknown[] = [];
    const runStore = {
      upsertPending: vi.fn(async (input: unknown) => {
        upserted.push(input);
        return input as RunRecord;
      }),
      listBySession: vi.fn(async () => activeRuns),
      markStatus: vi.fn(),
      get: vi.fn(),
      findByIdempotencyKey: vi.fn(),
      listRecoverable: vi.fn(async () => []),
    } as unknown as RunStore;
    const service = new AutoCompactionService({
      runStore,
      getTenantSettings: (tenantId) => tenantId === 'kaiyan' ? { autoCompactEnabled: true } : { autoCompactEnabled: false },
    });
    return { service, runStore, upserted };
  }

  const scheduleInput = {
    sessionId: 'session-1',
    finishedRunId: 'run-finished',
    model: 'glm-5.2',
    tenantId: 'kaiyan',
    userId: 'user-1',
    channel: 'web',
    events: [assistantEvent(0, 90_000)],
  };

  it('超阈值 + 无活跃 run → enqueue 一条 /compact run（metadata.autoCompaction）', async () => {
    const { service, upserted } = makeService();
    await service.maybeScheduleAfterRun(scheduleInput);
    expect(upserted).toHaveLength(1);
    const run = upserted[0] as { sessionId: string; metadata: Record<string, unknown> };
    expect(run.sessionId).toBe('session-1');
    expect(run.metadata.autoCompaction).toBe(true);
    expect((run.metadata.wakeMessage as { content: string }).content).toBe('/compact');
  });

  it('enqueue 后冷却期内不重复 enqueue', async () => {
    const { service, upserted } = makeService();
    await service.maybeScheduleAfterRun(scheduleInput);
    await service.maybeScheduleAfterRun(scheduleInput);
    expect(upserted).toHaveLength(1);
  });

  it('租户未开启 → 不 enqueue', async () => {
    const { service, upserted } = makeService();
    await service.maybeScheduleAfterRun({ ...scheduleInput, tenantId: 'other' });
    expect(upserted).toHaveLength(0);
  });

  it('session 已有其他活跃 run → 让路不 enqueue', async () => {
    const { service, upserted } = makeService([
      { runId: 'run-user', sessionId: 'session-1', status: 'pending' } as RunRecord,
    ]);
    await service.maybeScheduleAfterRun(scheduleInput);
    expect(upserted).toHaveLength(0);
  });

  it('shouldYield：存在其他活跃 run 时让路，只剩自己时不让', async () => {
    const { service } = makeService([
      { runId: 'run-self', sessionId: 'session-1', status: 'running' } as RunRecord,
      { runId: 'run-user', sessionId: 'session-1', status: 'pending' } as RunRecord,
    ]);
    expect(await service.shouldYield('session-1', 'run-self')).toBe(true);

    const { service: soloService } = makeService([
      { runId: 'run-self', sessionId: 'session-1', status: 'running' } as RunRecord,
    ]);
    expect(await soloService.shouldYield('session-1', 'run-self')).toBe(false);
  });

  it('preempt：未注册的 session 返回 false；注册后 abort 对应 run', async () => {
    const { service } = makeService();
    expect(service.preempt('session-1')).toBe(false);
    service.registerActive('session-1', 'run-compact');
    // runtimeRunController 里没有该 runId 的 controller，abort 返回 false，
    // 但 preempt 本身返回 true（表示发起过抢占尝试）
    expect(service.preempt('session-1')).toBe(true);
    service.unregisterActive('session-1', 'run-compact');
    expect(service.preempt('session-1')).toBe(false);
  });
});
