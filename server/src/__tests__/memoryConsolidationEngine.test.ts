/**
 * L2 scanner 回归测试：覆盖全局关闭态、空游标 poison event、projection 宽限期、
 * 隔离台账先写后推进，以及未启用租户短路。生产曾因首个缺 projection 的历史
 * run 边界事件永久卡在空 consumer cursor，本文件专门锁住该故障形态。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  MemoryConsolidationEngine,
  MISSING_PROJECTION_GRACE_MS,
  type MemoryConsolidationEngineOptions,
} from '../memory/consolidation/engine.js';
import type { PgMemoryConsolidationStore } from '../memory/consolidation/store.js';
import { MEMORY_CONSOLIDATION_DEFAULTS } from '../memory/consolidation/types.js';

type BoundaryEvent = {
  globalSequence: number;
  sessionSequence: number;
  tenantId: string;
  sessionId: string;
  event: Record<string, unknown> & { type: string; id: string };
};

type TestableEngine = {
  stopped: boolean;
  scanOnce(): Promise<void>;
};

function boundaryEvent(input: {
  globalSequence: number;
  tenantId?: string;
  sessionId?: string;
  timestamp?: string;
}): BoundaryEvent {
  return {
    globalSequence: input.globalSequence,
    sessionSequence: 1,
    tenantId: input.tenantId ?? 't-enabled',
    sessionId: input.sessionId ?? `s-${input.globalSequence}`,
    event: {
      id: `e-${input.globalSequence}`,
      type: 'run_started',
      runId: `r-${input.globalSequence}`,
      ...(input.timestamp ? { timestamp: input.timestamp } : {}),
    },
  };
}

function createHarness(input: {
  events?: BoundaryEvent[];
  configEnabled?: boolean;
  tenantEnabled?: (tenantId: string) => boolean;
  projection?: MemoryConsolidationEngineOptions['projectionStore']['get'];
  quarantineEnvelopeAndAdvanceCursor?: ReturnType<typeof vi.fn>;
} = {}) {
  let cursor = 0;
  const init = vi.fn(async () => undefined);
  const advanceConsumerCursor = vi.fn(async (_consumerName: string, to: number) => {
    cursor = Math.max(cursor, to);
  });
  const quarantineEnvelopeAndAdvanceCursor = input.quarantineEnvelopeAndAdvanceCursor ?? vi.fn(
    async (quarantineInput: { globalSequence: number }) => {
      cursor = Math.max(cursor, quarantineInput.globalSequence);
    },
  );
  const claimDue = vi.fn(async () => []);
  const reviveThrottled = vi.fn(async () => 0);
  const applyRunStarted = vi.fn(async () => undefined);
  const applyRunFinished = vi.fn(async () => undefined);
  const store = {
    init,
    getConsumerCursor: vi.fn(async () => cursor),
    advanceConsumerCursor,
    quarantineEnvelopeAndAdvanceCursor,
    claimDue,
    reviveThrottled,
    applyRunStarted,
    applyRunFinished,
  } as unknown as PgMemoryConsolidationStore;

  const listGlobalPage = vi.fn(async () => ({
    events: input.events ?? [],
    hasMore: false,
  }));
  const projectionGet = vi.fn(input.projection ?? (async () => null));
  const info = vi.fn();
  const warn = vi.fn();
  const config = {
    ...MEMORY_CONSOLIDATION_DEFAULTS,
    enabled: input.configEnabled ?? true,
  };
  const engine = new MemoryConsolidationEngine({
    store,
    eventStore: {
      listGlobalPage,
      listSessionRange: vi.fn(async () => []),
    },
    projectionStore: { get: projectionGet },
    userStore: { findById: vi.fn((id: string) => ({ id, username: 'u1', role: 'user' })) },
    isTenantEnabled: input.tenantEnabled ?? (() => true),
    dispatch: vi.fn() as never,
    agentCwd: '/tmp',
    getConfig: () => config,
    logger: { info, warn },
  });

  return {
    engine,
    setCursor: (value: number) => { cursor = value; },
    getCursor: () => cursor,
    init,
    advanceConsumerCursor,
    quarantineEnvelopeAndAdvanceCursor,
    claimDue,
    reviveThrottled,
    applyRunStarted,
    applyRunFinished,
    listGlobalPage,
    projectionGet,
    info,
    warn,
  };
}

async function scanOnce(engine: MemoryConsolidationEngine): Promise<void> {
  const testable = engine as unknown as TestableEngine;
  testable.stopped = false;
  await testable.scanOnce();
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('MemoryConsolidationEngine scanner', () => {
  it('全局关闭：只初始化表，不启动 scanner/worker，也不响应 wake', async () => {
    const harness = createHarness({ configEnabled: false });

    await harness.engine.start();
    harness.engine.wake();
    await Promise.resolve();

    expect(harness.init).toHaveBeenCalledOnce();
    expect(harness.listGlobalPage).not.toHaveBeenCalled();
    expect(harness.claimDue).not.toHaveBeenCalled();
    expect(harness.reviveThrottled).not.toHaveBeenCalled();
    expect(harness.info).toHaveBeenCalledWith('MemoryConsolidationEngine disabled by global config');
  });

  it('空游标遇到超期缺 projection 事件：先写隔离台账，再推进到该 global sequence', async () => {
    const oldTimestamp = new Date(Date.now() - MISSING_PROJECTION_GRACE_MS - 1).toISOString();
    const event = boundaryEvent({ globalSequence: 161_971, timestamp: oldTimestamp });
    const harness = createHarness({ events: [event] });

    await scanOnce(harness.engine);

    expect(harness.quarantineEnvelopeAndAdvanceCursor).toHaveBeenCalledWith(expect.objectContaining({
      consumerName: 'memory-consolidation-v1',
      globalSequence: 161_971,
      sessionId: event.sessionId,
      reason: 'projection_missing_after_grace',
    }));
    expect(harness.getCursor()).toBe(161_971);
    expect(harness.advanceConsumerCursor).toHaveBeenCalledWith('memory-consolidation-v1', 161_971);
  });

  it('宽限期内缺 projection：保持 cursor，且同一事件五分钟内只告警一次', async () => {
    const now = Date.parse('2026-08-07T07:30:00.000Z');
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const event = boundaryEvent({ globalSequence: 200, timestamp: new Date(now).toISOString() });
    const harness = createHarness({ events: [event] });

    await scanOnce(harness.engine);
    await scanOnce(harness.engine);

    expect(harness.getCursor()).toBe(0);
    expect(harness.quarantineEnvelopeAndAdvanceCursor).not.toHaveBeenCalled();
    expect(harness.advanceConsumerCursor).not.toHaveBeenCalled();
    expect(harness.warn).toHaveBeenCalledTimes(1);
    expect(harness.warn).toHaveBeenCalledWith(expect.stringContaining('holding cursor within grace window'));
  });

  it('远未来事件时间戳不进入无限宽限：立即隔离并推进', async () => {
    const now = Date.parse('2026-08-07T07:30:00.000Z');
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const event = boundaryEvent({
      globalSequence: 250,
      timestamp: new Date(now + 24 * 60 * 60_000).toISOString(),
    });
    const harness = createHarness({ events: [event] });

    await scanOnce(harness.engine);

    expect(harness.quarantineEnvelopeAndAdvanceCursor).toHaveBeenCalledWith(expect.objectContaining({
      globalSequence: 250,
      reason: 'projection_missing_future_timestamp',
    }));
    expect(harness.getCursor()).toBe(250);
  });

  it('隔离事务写入失败：台账与 cursor 都不落半套状态', async () => {
    const oldTimestamp = new Date(Date.now() - MISSING_PROJECTION_GRACE_MS - 1).toISOString();
    const quarantineEnvelopeAndAdvanceCursor = vi.fn(async () => { throw new Error('audit unavailable'); });
    const harness = createHarness({
      events: [boundaryEvent({ globalSequence: 300, timestamp: oldTimestamp })],
      quarantineEnvelopeAndAdvanceCursor,
    });

    await scanOnce(harness.engine);

    expect(quarantineEnvelopeAndAdvanceCursor).toHaveBeenCalledOnce();
    expect(harness.getCursor()).toBe(0);
    expect(harness.advanceConsumerCursor).not.toHaveBeenCalled();
    expect(harness.warn).toHaveBeenCalledWith('consolidation scan failed: audit unavailable');
  });

  it('未启用租户的孤儿事件：不查 projection，直接推进；随后启用租户的新鲜孤儿仍阻塞', async () => {
    const now = Date.parse('2026-08-07T07:30:00.000Z');
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const harness = createHarness({
      events: [
        boundaryEvent({ globalSequence: 400, tenantId: 't-disabled', timestamp: new Date(now).toISOString() }),
        boundaryEvent({ globalSequence: 401, tenantId: 't-enabled', timestamp: new Date(now).toISOString() }),
      ],
      tenantEnabled: (tenantId) => tenantId === 't-enabled',
    });

    await scanOnce(harness.engine);

    expect(harness.projectionGet).toHaveBeenCalledTimes(1);
    expect(harness.projectionGet).toHaveBeenCalledWith('s-401', { includeDeleted: true });
    expect(harness.getCursor()).toBe(400);
    expect(harness.advanceConsumerCursor).toHaveBeenCalledWith('memory-consolidation-v1', 400);
    expect(harness.quarantineEnvelopeAndAdvanceCursor).not.toHaveBeenCalled();
  });

  it('stop 发生在 projection 查询途中：当前事件返回后立即停，不再处理后续事件或推进 cursor', async () => {
    let releaseProjection!: () => void;
    let signalProjectionEntered!: () => void;
    const projectionGate = new Promise<void>((resolve) => { releaseProjection = resolve; });
    const projectionEntered = new Promise<void>((resolve) => { signalProjectionEntered = resolve; });
    let calls = 0;
    const harness = createHarness({
      events: [
        boundaryEvent({ globalSequence: 500, timestamp: '2026-08-07T07:00:00.000Z' }),
        boundaryEvent({ globalSequence: 501, timestamp: '2026-08-07T07:01:00.000Z' }),
      ],
      projection: async (sessionId) => {
        calls += 1;
        if (calls === 1) {
          signalProjectionEntered();
          await projectionGate;
        }
        return {
          sessionId,
          tenantId: 't-enabled',
          userId: 'u1',
          username: 'u1',
          channel: 'web',
          kind: 'user',
          workspaceId: 'u1',
          metaJson: { memoryPolicyVersion: 'v2' },
        };
      },
    });
    const testable = harness.engine as unknown as TestableEngine;
    testable.stopped = false;

    const running = testable.scanOnce();
    await projectionEntered;
    harness.engine.stop();
    releaseProjection();
    await running;

    expect(harness.applyRunStarted).toHaveBeenCalledWith(expect.objectContaining({ globalSequence: 500 }));
    expect(harness.projectionGet).toHaveBeenCalledOnce();
    expect(harness.getCursor()).toBe(0);
    expect(harness.advanceConsumerCursor).not.toHaveBeenCalled();
  });
});
