import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  inspectMemoryConsolidationDraft,
  invokeMemoryConsolidationDraftTool,
} from '../memory/consolidation/draft.js';
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
  stopped: boolean; scanOnce(): Promise<void>; workOnce(): Promise<void>;
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
  const reviveLegacyBlocked = vi.fn(async () => 0);
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
    reviveLegacyBlocked,
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
    reviveLegacyBlocked,
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

function createRecoveryHarness(input: {
  agentCwd?: string;
  commitJournal: unknown;
  journalBoundarySequence?: number;
  stateBoundarySequence?: number;
  tombstoneIds?: string[];
  currentTombstoneIds?: string[];
  recoverPrepared?: boolean;
  timeoutSeconds?: number;
  fenceResult?: { boundaryChanged: boolean; fence: {
    listActiveTombstoneIds: ReturnType<typeof vi.fn>;
    finalizeApplied: ReturnType<typeof vi.fn>;
    retireJournalAndRequeue: ReturnType<typeof vi.fn>;
    release: ReturnType<typeof vi.fn>;
  } | null };
  dispatch?: ReturnType<typeof vi.fn>;
}) {
  const state: ConsolidationState = {
    tenantId: 't-enabled', userId: 'u1', workspaceId: 'ws1', sessionId: 'source-recovery',
    processedSessionSequence: 10, targetSessionSequence: 42,
    lastBoundaryGlobalSequence: input.stateBoundarySequence ?? 100,
    firstPendingAt: '2026-08-21T00:00:00.000Z', dueAt: '2026-08-21T00:10:00.000Z',
    lastActivityAt: '2026-08-21T00:00:00.000Z', activeRunIds: [], status: 'running', attempts: 1,
    nextAttemptAt: null, leaseOwner: 'worker-1', leaseExpiresAt: '2026-08-21T02:00:00.000Z', promptVersion: 2,
  };
  const releaseCommitLock = vi.fn(async () => undefined);
  const releaseFence = vi.fn(async () => undefined);
  const listActiveTombstoneIds = vi.fn(async () => input.currentTombstoneIds ?? []);
  const finalizeApplied = vi.fn(async () => undefined);
  const retireJournalAndRequeue = vi.fn(async () => undefined);
  const fenceResult = input.fenceResult ?? {
    boundaryChanged: false,
    fence: { listActiveTombstoneIds, finalizeApplied, retireJournalAndRequeue, release: releaseFence },
  };
  const dispatch = input.dispatch ?? vi.fn(() => (async function* () {})());
  const updateRun = vi.fn(async (_runInput?: unknown) => undefined);
  const updateRunFenced = vi.fn(async (runInput) => {
    await updateRun(runInput);
    return true;
  });
  const markFailed = vi.fn(async () => 'retry_wait' as const);
  const failRunAndState = vi.fn(async () => 'retry_wait' as const);
  const acquireCommitFence = vi.fn(async () => fenceResult);
  const store = {
    claimDue: vi.fn(async () => [state]),
    acquireCommitLock: vi.fn(async () => ({
      acquireFence: acquireCommitFence,
      release: releaseCommitLock,
    })),
    findPreparedCommitRun: vi.fn(async () => input.recoverPrepared === false ? null : ({
      id: 'ledger-recovery', idempotencyKey: 'recovery-key',
      tenantId: state.tenantId, userId: state.userId, workspaceId: state.workspaceId,
      sessionId: state.sessionId, fromSessionSequence: 10, toSessionSequence: 42,
      status: 'prepared' as const, modelRequested: 'gpt-5.4', modelActual: 'gpt-5.4',
      promptVersion: 2, retryCount: 0, errorCode: null, errorMessage: null,
      usageJson: {
        inputTokens: 100,
        hiddenSessionId: 'old-hidden',
        commitJournal: input.commitJournal,
        commitBoundarySequence: input.journalBoundarySequence ?? 100,
        tombstoneIds: input.tombstoneIds ?? [],
      },
    })),
    insertOrGetRun: vi.fn(async () => ({
      created: true,
      record: { id: 'ledger-current', status: 'started' as const },
    })),
    renewLease: vi.fn(async () => true),
    updateRun,
    updateRunFenced,
    markApplied: vi.fn(async () => undefined),
    markFailed,
    failRunAndState,
    markIneligible: vi.fn(async () => undefined),
    listActiveTombstones: vi.fn(async () => []),
  } as unknown as PgMemoryConsolidationStore;
  const engine = new MemoryConsolidationEngine({
    store,
    eventStore: {
      listGlobalPage: vi.fn(async () => ({ events: [], hasMore: false })),
      listSessionRange: vi.fn(async () => []),
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
    agentCwd: input.agentCwd ?? '/tmp',
    getConfig: () => ({
      ...MEMORY_CONSOLIDATION_DEFAULTS,
      enabled: true,
      ...(input.timeoutSeconds !== undefined ? { timeoutSeconds: input.timeoutSeconds } : {}),
    }),
  });
  return {
    engine, state, store, dispatch, updateRun, updateRunFenced, markFailed, failRunAndState,
    listActiveTombstoneIds: fenceResult.fence?.listActiveTombstoneIds ?? listActiveTombstoneIds,
    finalizeApplied: fenceResult.fence?.finalizeApplied ?? finalizeApplied,
    retireJournalAndRequeue: fenceResult.fence?.retireJournalAndRequeue ?? retireJournalAndRequeue,
    releaseFence: fenceResult.fence?.release ?? releaseFence,
    releaseCommitLock,
    acquireCommitFence,
  };
}

const tempDirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('MemoryConsolidationEngine scanner', () => {
  it('默认静默期为 30 分钟，隐藏审查有一小时和 1000 轮预算', () => {
    expect(MEMORY_CONSOLIDATION_DEFAULTS.debounceMinutes).toBe(30);
    expect(MEMORY_CONSOLIDATION_DEFAULTS.timeoutSeconds).toBe(3_600);
    expect(MEMORY_CONSOLIDATION_DEFAULTS.maxTurns).toBe(1_000);
    expect(MEMORY_CONSOLIDATION_DEFAULTS.leaseSeconds)
      .toBeGreaterThan(MEMORY_CONSOLIDATION_DEFAULTS.timeoutSeconds);
  });

  it('全局关闭：只初始化表，不启动 scanner/worker，也不响应 wake', async () => {
    const harness = createHarness({ configEnabled: false });

    await harness.engine.start();
    harness.engine.wake();
    await Promise.resolve();

    expect(harness.init).toHaveBeenCalledOnce();
    expect(harness.listGlobalPage).not.toHaveBeenCalled();
    expect(harness.claimDue).not.toHaveBeenCalled();
    expect(harness.reviveThrottled).not.toHaveBeenCalled();
    expect(harness.reviveLegacyBlocked).not.toHaveBeenCalled();
    expect(harness.info).toHaveBeenCalledWith('MemoryConsolidationEngine disabled by global config');
  });

  it('全局启用：启动时一次性恢复旧版本遗留的 throttled 状态', async () => {
    const harness = createHarness();

    await harness.engine.start();
    harness.engine.stop();

    expect(harness.reviveThrottled).toHaveBeenCalledOnce();
    expect(harness.reviveLegacyBlocked).toHaveBeenCalledOnce();
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
      processedSessionSequence: 0, targetSessionSequence: 42, lastBoundaryGlobalSequence: 100,
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

    expect(harness.markIneligible).toHaveBeenCalledWith({
      tenantId: state.tenantId,
      sessionId: state.sessionId,
      leaseOwner: 'worker-1',
    });
    expect(harness.dispatch).not.toHaveBeenCalled();
  });

  it('timeout 时 iterator.return 同步抛错也会继续收敛失败状态', async () => {
    const dispatch = vi.fn(() => ({
      [Symbol.asyncIterator]: () => ({
        next: () => new Promise<never>(() => undefined),
        return: () => { throw new Error('iterator return failed'); },
      }),
    }));
    const harness = createRecoveryHarness({
      commitJournal: { version: 1, entries: [] },
      recoverPrepared: false,
      timeoutSeconds: 0,
      dispatch,
    });

    await workOnce(harness.engine);

    expect(harness.failRunAndState).toHaveBeenCalledWith(expect.objectContaining({
      errorCode: 'timeout',
    }));
  });

  it('续租查询抛错时仍清理隐藏草稿和固定 root fd', async () => {
    const root = await mkdtemp(join(tmpdir(), 'memory-renew-error-'));
    tempDirs.push(root);
    const userRoot = join(root, 't-enabled', 'u1');
    await mkdir(userRoot, { recursive: true });
    await invokeMemoryConsolidationDraftTool({
      toolId: 'Write', input: { content: '# stale draft\n' },
      authorization: { source: 'policy_auto' },
    } as never, {
      sessionId: 'hidden-renew-error',
      workspace: { root: userRoot, executionTarget: 'server-local' },
    } as never, 'MEMORY.md');
    const dispatch = vi.fn(() => (async function* () {
      yield { type: 'session_init' as const, sessionId: 'hidden-renew-error' };
      yield { type: 'done' as const };
    })());
    const harness = createRecoveryHarness({
      agentCwd: root,
      commitJournal: { version: 1, entries: [] },
      recoverPrepared: false,
      dispatch,
    });
    harness.store.renewLease = vi.fn(async () => { throw new Error('lease database unavailable'); });

    await workOnce(harness.engine);

    expect((await inspectMemoryConsolidationDraft('hidden-renew-error')).changedFiles).toEqual([]);
    expect(harness.markFailed).toHaveBeenCalled();
  });

  it('模型运行期间 tombstone 集合变化时退休 prepared journal 且不提交 stale draft', async () => {
    const dispatch = vi.fn(() => (async function* () {
      yield { type: 'session_init' as const, sessionId: 'hidden-tombstone-change' };
      yield { type: 'done' as const };
    })());
    const harness = createRecoveryHarness({
      commitJournal: { version: 1, entries: [] },
      recoverPrepared: false,
      currentTombstoneIds: ['forgotten-during-run'],
      dispatch,
    });

    await workOnce(harness.engine);

    expect(harness.updateRunFenced).toHaveBeenCalledWith(expect.objectContaining({
      status: 'prepared',
      usageJson: expect.objectContaining({ tombstoneIds: [] }),
    }));
    expect(harness.retireJournalAndRequeue).toHaveBeenCalledWith(expect.objectContaining({
      errorCode: 'commit_tombstone_superseded',
    }));
    expect(harness.finalizeApplied).not.toHaveBeenCalled();
  });

  it('prepared journal 恢复完成后原子收敛且不再次运行模型', async () => {
    const root = await mkdtemp(join(tmpdir(), 'memory-recovery-applied-'));
    tempDirs.push(root);
    const userRoot = join(root, 't-enabled', 'u1');
    await mkdir(userRoot, { recursive: true });
    await writeFile(join(userRoot, 'MEMORY.md'), '# staged\n', 'utf8');
    const harness = createRecoveryHarness({
      agentCwd: root,
      commitJournal: {
        version: 1,
        entries: [{ relativePath: 'MEMORY.md', baseline: '# baseline\n', staged: '# staged\n' }],
      },
    });

    await workOnce(harness.engine);

    expect(harness.finalizeApplied).toHaveBeenCalledWith(expect.objectContaining({
      toSequence: 42,
      usageJson: expect.not.objectContaining({ commitJournal: expect.anything() }),
    }));
    expect(harness.dispatch).not.toHaveBeenCalled();
    expect(harness.store.markApplied).not.toHaveBeenCalled();
    expect(harness.markFailed).not.toHaveBeenCalled();
    expect(harness.releaseCommitLock).toHaveBeenCalledOnce();
    expect(await readFile(join(userRoot, 'MEMORY.md'), 'utf8')).toBe('# staged\n');
  });

  it('prepared 恢复发现 tombstone 集合变化时回滚旧文件并重排', async () => {
    const root = await mkdtemp(join(tmpdir(), 'memory-recovery-tombstone-'));
    tempDirs.push(root);
    const userRoot = join(root, 't-enabled', 'u1');
    await mkdir(userRoot, { recursive: true });
    await writeFile(join(userRoot, 'MEMORY.md'), '# stale staged\n', 'utf8');
    const harness = createRecoveryHarness({
      agentCwd: root,
      tombstoneIds: [],
      currentTombstoneIds: ['forgotten-now'],
      commitJournal: {
        version: 1,
        entries: [{ relativePath: 'MEMORY.md', baseline: '# baseline\n', staged: '# stale staged\n' }],
      },
    });

    await workOnce(harness.engine);

    expect(harness.finalizeApplied).not.toHaveBeenCalled();
    expect(harness.retireJournalAndRequeue).toHaveBeenCalledWith(expect.objectContaining({
      errorCode: 'recovery_tombstone_superseded',
    }));
    expect(await readFile(join(userRoot, 'MEMORY.md'), 'utf8')).toBe('# baseline\n');
  });

  it('prepared journal 冲突会原子退休旧记录并立即重排 state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'memory-recovery-conflict-'));
    tempDirs.push(root);
    const userRoot = join(root, 't-enabled', 'u1');
    await mkdir(userRoot, { recursive: true });
    await writeFile(join(userRoot, 'MEMORY.md'), '# current\n', 'utf8');
    const dispatch = vi.fn();
    const harness = createRecoveryHarness({
      agentCwd: root,
      commitJournal: {
        version: 1,
        entries: [{ relativePath: 'MEMORY.md', baseline: '# baseline\n', staged: '# staged\n' }],
      },
      dispatch,
    });

    await workOnce(harness.engine);

    expect(harness.retireJournalAndRequeue).toHaveBeenCalledWith(expect.objectContaining({
      idempotencyKey: 'recovery-key',
      errorCode: 'recovery_conflict_superseded',
      usageJson: expect.not.objectContaining({ commitJournal: expect.anything() }),
    }));
    expect(dispatch).not.toHaveBeenCalled();
    expect(await readFile(join(userRoot, 'MEMORY.md'), 'utf8')).toBe('# current\n');
  });

  it('prepared recovery 观察到新 run boundary 时不再由旧 worker 改 ledger 或文件', async () => {
    const root = await mkdtemp(join(tmpdir(), 'memory-recovery-boundary-'));
    tempDirs.push(root);
    const userRoot = join(root, 't-enabled', 'u1');
    await mkdir(userRoot, { recursive: true });
    await writeFile(join(userRoot, 'MEMORY.md'), '# baseline\n', 'utf8');
    const harness = createRecoveryHarness({
      agentCwd: root,
      commitJournal: {
        version: 1,
        entries: [{ relativePath: 'MEMORY.md', baseline: '# baseline\n', staged: '# stale staged\n' }],
      },
      fenceResult: { boundaryChanged: true, fence: null },
    });

    await workOnce(harness.engine);

    expect(harness.updateRunFenced).not.toHaveBeenCalled();
    expect(harness.dispatch).not.toHaveBeenCalled();
    expect(harness.releaseCommitLock).toHaveBeenCalledOnce();
    expect(await readFile(join(userRoot, 'MEMORY.md'), 'utf8')).toBe('# baseline\n');
  });

  it('boundary superseded 后回滚已提交文件、退休 journal 并重排 state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'memory-recovery-superseded-'));
    tempDirs.push(root);
    const userRoot = join(root, 't-enabled', 'u1');
    await mkdir(join(userRoot, 'memory'), { recursive: true });
    await writeFile(join(userRoot, 'MEMORY.md'), '# staged root\n', 'utf8');
    await writeFile(join(userRoot, 'memory', 'facts.md'), '# baseline facts\n', 'utf8');
    const harness = createRecoveryHarness({
      agentCwd: root,
      commitJournal: {
        version: 1,
        entries: [
          { relativePath: 'MEMORY.md', baseline: '# baseline root\n', staged: '# staged root\n' },
          { relativePath: 'memory/facts.md', baseline: '# baseline facts\n', staged: '# staged facts\n' },
        ],
      },
      journalBoundarySequence: 100,
      stateBoundarySequence: 101,
    });

    await workOnce(harness.engine);

    expect(harness.retireJournalAndRequeue).toHaveBeenCalledWith(expect.objectContaining({
      errorCode: 'recovery_boundary_superseded',
      usageJson: expect.not.objectContaining({ commitJournal: expect.anything() }),
    }));
    expect(harness.dispatch).not.toHaveBeenCalled();
    expect(await readFile(join(userRoot, 'MEMORY.md'), 'utf8')).toBe('# baseline root\n');
    expect(await readFile(join(userRoot, 'memory', 'facts.md'), 'utf8')).toBe('# baseline facts\n');
  });

  it('inherits the parent runtime instead of selecting a separate model/profile', async () => {
    const state: ConsolidationState = {
      tenantId: 't-enabled', userId: 'u1', workspaceId: 'ws1', sessionId: 'source-session',
      processedSessionSequence: 10, targetSessionSequence: 42, lastBoundaryGlobalSequence: 100,
      firstPendingAt: '2026-08-21T00:00:00.000Z', dueAt: '2026-08-21T00:10:00.000Z',
      lastActivityAt: '2026-08-21T00:00:00.000Z', activeRunIds: [], status: 'running', attempts: 0,
      nextAttemptAt: null, leaseOwner: 'worker-1', leaseExpiresAt: null, promptVersion: null,
    };
    const release = vi.fn(async () => undefined);
    const releaseFence = vi.fn(async () => undefined);
    const listActiveTombstoneIds = vi.fn(async () => [] as string[]);
    const finalizeApplied = vi.fn(async () => undefined);
    const retireJournalAndRequeue = vi.fn(async () => undefined);
    const updateRun = vi.fn(async (_runInput?: unknown) => undefined);
    const updateRunFenced = vi.fn(async (runInput) => {
      await updateRun(runInput);
      return true;
    });
    const markApplied = vi.fn(async () => undefined);
    const markFailed = vi.fn(async () => 'retry_wait' as const);
    const failRunAndState = vi.fn(async () => 'retry_wait' as const);
    const acquireCommitFence = vi.fn(async () => ({
      boundaryChanged: false,
      fence: { listActiveTombstoneIds, finalizeApplied, retireJournalAndRequeue, release: releaseFence },
    }));
    const acquireCommitLock = vi.fn(async () => ({
      acquireFence: acquireCommitFence,
      release,
    }));
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
      acquireCommitLock,
      renewLease: vi.fn(async () => true),
      findPreparedCommitRun: vi.fn(async () => null),
      insertOrGetRun: vi.fn(async () => ({
        created: true,
        record: { id: 'ledger-1', status: 'started' },
      })),
      listActiveTombstones: vi.fn(async () => []),
      updateRun,
      updateRunFenced,
      markApplied,
      markFailed,
      failRunAndState,
      markIneligible: vi.fn(async () => undefined),
    } as unknown as PgMemoryConsolidationStore;
    const engine = new MemoryConsolidationEngine({
      store,
      eventStore: {
        listGlobalPage: vi.fn(async () => ({ events: [], hasMore: false })),
        listSessionRange: vi.fn(async (_tenantId: string, sessionId: string) => sessionId === 'hidden-session' ? [{
          sessionSequence: 4,
          event: {
            id: 'assistant-1', type: 'assistant_message', model: 'gpt-5.4',
            usage: { inputTokens: 100, outputTokens: 8, cacheReadInputTokens: 80 },
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
      maxTurns: 1_000,
    }));
    expect(dispatchOptions[0]).not.toEqual(expect.objectContaining({
      toolProfile: expect.anything(),
      model: expect.anything(),
      executionTarget: expect.anything(),
      skipPersona: expect.anything(),
    }));
    expect(updateRun).toHaveBeenCalledWith(expect.objectContaining({ status: 'prepared' }));
    expect(finalizeApplied).toHaveBeenCalledWith(expect.objectContaining({
      idempotencyKey: expect.any(String),
      toSequence: 42,
      modelActual: 'gpt-5.4',
      usageJson: expect.objectContaining({ inputTokens: 100, cacheReadTokens: 80 }),
    }));
    expect(markApplied).not.toHaveBeenCalled();
    expect(markFailed).not.toHaveBeenCalled();
    expect(acquireCommitLock).toHaveBeenCalledOnce();
    expect(dispatch.mock.invocationCallOrder[0]).toBeLessThan(acquireCommitLock.mock.invocationCallOrder[0]!);
    expect(releaseFence).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
  });
});
