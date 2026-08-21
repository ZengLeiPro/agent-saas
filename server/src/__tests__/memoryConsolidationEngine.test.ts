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
import { MEMORY_CONSOLIDATION_DEFAULTS, type ConsolidationState } from '../memory/consolidation/types.js';

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
  workOnce(): Promise<void>;
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
  claimedStates?: ConsolidationState[];
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
  const claimDue = vi.fn(async () => input.claimedStates ?? []);
  const markIneligible = vi.fn(async () => undefined);
  const reviveThrottled = vi.fn(async () => 0);
  const applyRunStarted = vi.fn(async () => undefined);
  const applyRunFinished = vi.fn(async () => undefined);
  const store = {
    init,
    getConsumerCursor: vi.fn(async () => cursor),
    advanceConsumerCursor,
    quarantineEnvelopeAndAdvanceCursor,
    claimDue,
    markIneligible,
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
  const dispatch = vi.fn();
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
    dispatch: dispatch as never,
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
    markIneligible,
    reviveThrottled,
    applyRunStarted,
    applyRunFinished,
    listGlobalPage,
    projectionGet,
    dispatch,
    info,
    warn,
  };
}

async function scanOnce(engine: MemoryConsolidationEngine): Promise<void> {
  const testable = engine as unknown as TestableEngine;
  testable.stopped = false;
  await testable.scanOnce();
}

async function workOnce(engine: MemoryConsolidationEngine): Promise<void> {
  const testable = engine as unknown as TestableEngine;
  testable.stopped = false;
  await testable.workOnce();
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


describe('MemoryConsolidationEngine TaskBoard exclusion', () => {
  it.each([
    { sessionSource: 'taskboard_execution', memoryAutomationEligible: true },
    { memoryAutomationEligible: false },
  ])('skips forged v2 projection with %j', async (marker) => {
    const event = boundaryEvent({ globalSequence: 900 });
    const harness = createHarness({
      events: [event],
      projection: async () => ({
        sessionId: event.sessionId, tenantId: event.tenantId, userId: 'u1', username: 'alice',
        channel: 'web', kind: 'user', workspaceId: 'ws1',
        metaJson: { memoryPolicyVersion: 'v2', ...marker },
      }),
    });
    await scanOnce(harness.engine);
    expect(harness.applyRunStarted).not.toHaveBeenCalled();
    expect(harness.applyRunFinished).not.toHaveBeenCalled();
    expect(harness.getCursor()).toBe(900);
  });

  it('discards a previously queued TaskBoard backlog when the worker claims it', async () => {
    const state: ConsolidationState = {
      tenantId: 't-enabled', userId: 'u1', workspaceId: 'ws1', sessionId: 'taskboard-review-1',
      processedSessionSequence: 0, targetSessionSequence: 42,
      firstPendingAt: '2026-08-19T00:00:00.000Z', dueAt: '2026-08-19T00:10:00.000Z',
      lastActivityAt: '2026-08-19T00:00:00.000Z', activeRunIds: [], status: 'running', attempts: 0,
      nextAttemptAt: null, leaseOwner: 'worker-1', leaseExpiresAt: null, promptVersion: null,
    };
    const harness = createHarness({
      claimedStates: [state],
      projection: async () => ({
        sessionId: state.sessionId, tenantId: state.tenantId, userId: state.userId, username: 'alice',
        channel: 'web', kind: 'user' as const, workspaceId: state.workspaceId,
        metaJson: { memoryPolicyVersion: 'v2', sessionSource: 'taskboard_execution', memoryAutomationEligible: false },
      }),
    });

    await workOnce(harness.engine);

    expect(harness.markIneligible).toHaveBeenCalledWith({ tenantId: state.tenantId, sessionId: state.sessionId });
    expect(harness.dispatch).not.toHaveBeenCalled();
  });

  it('inherits the parent runtime instead of selecting a separate model/profile', async () => {
    const state: ConsolidationState = {
      tenantId: 't-enabled', userId: 'u1', workspaceId: 'ws1', sessionId: 'source-session',
      processedSessionSequence: 10, targetSessionSequence: 42,
      firstPendingAt: '2026-08-21T00:00:00.000Z', dueAt: '2026-08-21T00:10:00.000Z',
      lastActivityAt: '2026-08-21T00:00:00.000Z', activeRunIds: [], status: 'running', attempts: 0,
      nextAttemptAt: null, leaseOwner: 'worker-1', leaseExpiresAt: null, promptVersion: null,
    };
    const release = vi.fn(async () => undefined);
    const updateRun = vi.fn(async () => undefined);
    const markApplied = vi.fn(async () => undefined);
    const markFailed = vi.fn(async () => 'retry_wait' as const);
    const dispatchOptions: unknown[] = [];
    const dispatch = vi.fn((_message, _context, options) => {
      dispatchOptions.push(options);
      return (async function* () {
        yield { type: 'session_init' as const, sessionId: 'hidden-session' };
        yield { type: 'done' as const };
      })();
    });
    const store = {
      init: vi.fn(async () => undefined),
      getConsumerCursor: vi.fn(async () => 0),
      advanceConsumerCursor: vi.fn(async () => undefined),
      quarantineEnvelopeAndAdvanceCursor: vi.fn(async () => undefined),
      claimDue: vi.fn(async () => [state]),
      reviveThrottled: vi.fn(async () => 0),
      getUserDailyUsage: vi.fn(async () => ({ runs: 0, inputTokens: 0 })),
      acquireCommitLock: vi.fn(async () => ({ release })),
      insertOrGetRun: vi.fn(async () => ({
        created: true,
        record: { id: 'ledger-1', status: 'started' },
      })),
      listActiveTombstones: vi.fn(async () => []),
      updateRun,
      markApplied,
      markFailed,
      markIneligible: vi.fn(async () => undefined),
    } as unknown as PgMemoryConsolidationStore;
    const engine = new MemoryConsolidationEngine({
      store,
      eventStore: {
        listGlobalPage: vi.fn(async () => ({ events: [], hasMore: false })),
        listSessionRange: vi.fn(async (sessionId: string) => sessionId === 'hidden-session' ? [{
          sessionSequence: 4,
          event: {
            id: 'assistant-1', type: 'assistant_message', model: 'gpt-5.4',
            usage: { inputTokens: 100, outputTokens: 8, cacheReadTokens: 80 },
          },
        }] : []),
      },
      projectionStore: { get: vi.fn(async () => ({
        sessionId: state.sessionId, tenantId: state.tenantId, userId: state.userId, username: 'alice',
        channel: 'web', kind: 'user' as const, model: 'gpt-5.4', workspaceId: state.workspaceId,
        metaJson: { memoryPolicyVersion: 'v2', profileBindingKey: 'main' },
      })) },
      userStore: { findById: vi.fn(() => ({
        id: 'u1', username: 'alice', role: 'user', tenantId: 't-enabled',
      })) },
      isTenantEnabled: () => true,
      dispatch: dispatch as never,
      agentCwd: '/tmp',
      getConfig: () => ({ ...MEMORY_CONSOLIDATION_DEFAULTS, enabled: true }),
    });

    await workOnce(engine);

    expect(store.insertOrGetRun).toHaveBeenCalledWith(expect.objectContaining({
      modelRequested: 'gpt-5.4',
    }));
    expect(dispatchOptions).toHaveLength(1);
    expect(dispatchOptions[0]).toEqual(expect.objectContaining({
      memoryConsolidationSourceSessionId: 'source-session',
      skipMemory: true,
      approvalPolicy: { autoApproveTools: true },
    }));
    expect(dispatchOptions[0]).not.toEqual(expect.objectContaining({
      toolProfile: expect.anything(),
      model: expect.anything(),
      executionTarget: expect.anything(),
      skipPersona: expect.anything(),
    }));
    expect(updateRun).toHaveBeenCalledWith(expect.objectContaining({
      status: 'applied',
      modelActual: 'gpt-5.4',
      usageJson: expect.objectContaining({ inputTokens: 100, cacheReadTokens: 80 }),
    }));
    expect(markApplied).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'source-session', toSequence: 42,
    }));
    expect(markFailed).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
  });
});
