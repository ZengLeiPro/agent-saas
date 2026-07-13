import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  configureModelPricing,
  getModelAutoCompactThreshold,
  getModelContextWindow,
} from '../data/usage/pricing.js';
import { AutoCompactionService, evaluateAutoCompaction } from '../runtime/autoCompaction.js';
import { RuntimeContextUsageTracker } from '../runtime/contextUsage.js';
import type { PlatformEvent } from '../runtime/types.js';
import type { RunRecord, RunStore } from '../runtime/runStore.js';

function assistantEvent(
  index: number,
  inputTokens: number,
  outputTokens = 100,
  options: { cacheReadInputTokens?: number; responseChained?: boolean; model?: string } = {},
): PlatformEvent {
  return {
    id: `event-${index}`,
    timestamp: new Date(2026, 6, 3, 0, 0, index).toISOString(),
    type: 'assistant_message',
    runId: `run-${index}`,
    sessionId: 'session-1',
    content: `回复 ${index}`,
    model: options.model ?? 'glm-5.2',
    usage: { inputTokens, outputTokens, cacheReadInputTokens: options.cacheReadInputTokens ?? 0 },
    ...(options.responseChained !== undefined ? { responseChained: options.responseChained } : {}),
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
        models: [{ value: 'glm-5.2', context_window: 100_000, auto_compact_threshold: 0.7 }],
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

  it('按模型配置的 70% 阈值触发，并返回实际 token 线', () => {
    const below = evaluateAutoCompaction({
      events: [assistantEvent(0, 69_899, 100)],
      model: 'glm-5.2',
      autoCompactEnabled: true,
    });
    expect(below).toMatchObject({
      shouldCompact: false,
      reason: 'below_threshold',
      currentTokens: 69_999,
      thresholdRatio: 0.7,
      thresholdTokens: 70_000,
    });

    const above = evaluateAutoCompaction({
      events: [assistantEvent(0, 69_900, 100)],
      model: 'glm-5.2',
      autoCompactEnabled: true,
    });
    expect(above).toMatchObject({ shouldCompact: true, reason: 'threshold_exceeded' });
    expect(above.currentTokens).toBe(70_000);
    expect(above.contextWindow).toBe(100_000);
    expect(getModelAutoCompactThreshold('glm-5.2')).toBe(0.7);
  });

  it('模型未配置触发比例时兼容默认 80%', () => {
    configureModelPricing({
      groups: [{ models: [{ value: 'glm-5.2', context_window: 100_000 }] }],
    });
    const result = evaluateAutoCompaction({
      events: [assistantEvent(0, 79_900, 100)],
      model: 'glm-5.2',
      autoCompactEnabled: true,
    });
    expect(result).toMatchObject({
      shouldCompact: true,
      thresholdRatio: 0.8,
      thresholdTokens: 80_000,
    });
  });

  it('上下文用量数据暴露模型级阈值，供前端显示实际触发线', () => {
    const tracker = new RuntimeContextUsageTracker('glm-5.2', []);
    const usage = tracker.record('glm-5.2', { inputTokens: 10_000, outputTokens: 100 });
    expect(usage).toMatchObject({
      totalTokens: 10_100,
      maxTokens: 100_000,
      autoCompactThreshold: 0.7,
    });
  });

  it('全量请求以最后一条 usage 重锚，不累计更早轮次', () => {
    const result = evaluateAutoCompaction({
      events: [
        assistantEvent(0, 95_000, 100, { responseChained: false }),
        assistantEvent(1, 10_000, 100, { cacheReadInputTokens: 9_000, responseChained: false }),
      ],
      model: 'glm-5.2',
      autoCompactEnabled: true,
    });
    // 最后一轮 10k，不是更早的 95k
    expect(result).toMatchObject({ shouldCompact: false, reason: 'below_threshold' });
  });

  it('Responses 接力按跨 leg 净新增累计，最后 leg 未达阈值也能正确触发', () => {
    const result = evaluateAutoCompaction({
      events: [
        assistantEvent(0, 60_000, 1_000, { responseChained: false }),
        assistantEvent(1, 50_000, 7_000, { cacheReadInputTokens: 45_000, responseChained: true }),
        assistantEvent(2, 50_000, 8_000, { cacheReadInputTokens: 45_000, responseChained: true }),
      ],
      model: 'glm-5.2',
      autoCompactEnabled: true,
    });

    // 61k + (50k-45k+7k) + (50k-45k+8k) = 86k；最后 leg 仅 58k。
    expect(result).toMatchObject({
      shouldCompact: true,
      reason: 'threshold_exceeded',
      currentTokens: 86_000,
    });
  });

  it('Responses 接力降级为全量请求后显式重锚', () => {
    const result = evaluateAutoCompaction({
      events: [
        assistantEvent(0, 70_000, 5_000, { responseChained: false }),
        assistantEvent(1, 30_000, 3_000, { cacheReadInputTokens: 25_000, responseChained: true }),
        assistantEvent(2, 20_000, 1_000, { cacheReadInputTokens: 18_000, responseChained: false }),
      ],
      model: 'glm-5.2',
      autoCompactEnabled: true,
    });

    expect(result).toMatchObject({ shouldCompact: false, currentTokens: 21_000 });
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
    modelRef: 'ark-agents/glm-5.2',
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
    const run = upserted[0] as { sessionId: string; model: string; metadata: Record<string, unknown> };
    expect(run.sessionId).toBe('session-1');
    expect(run.model).toBe('ark-agents/glm-5.2');
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
