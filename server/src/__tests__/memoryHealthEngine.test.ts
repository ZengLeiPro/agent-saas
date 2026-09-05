import { describe, expect, it, vi } from 'vitest';
import {
  MemoryConsolidationEngine,
  type MemoryConsolidationEngineOptions,
} from '../memory/consolidation/engine.js';
import {
  MEMORY_CONSOLIDATION_DEFAULTS,
  type ConsolidationState,
} from '../memory/consolidation/types.js';

const config = { ...MEMORY_CONSOLIDATION_DEFAULTS, enabled: true };
const state: ConsolidationState = {
  tenantId: 't',
  userId: 'u',
  workspaceId: 'w',
  sessionId: 'session',
  processedSessionSequence: 0,
  targetSessionSequence: 10,
  lastBoundaryGlobalSequence: 20,
  firstPendingAt: '2026-09-01T00:00:00Z',
  lastActivityAt: '2026-09-01T00:00:00Z',
  dueAt: null,
  activeRunIds: [],
  status: 'running',
  attempts: 2,
  nextAttemptAt: null,
  leaseOwner: 'worker',
  leaseExpiresAt: null,
  promptVersion: 1,
};
const processState = (engine: MemoryConsolidationEngine, input: ConsolidationState) =>
  (
    engine as unknown as { processState(s: ConsolidationState, c: typeof config): Promise<void> }
  ).processState(input, config);

function harness(get: MemoryConsolidationEngineOptions['projectionStore']['get']) {
  const markIneligible = vi.fn();
  const markFailed = vi.fn();
  const dispatch = vi.fn();
  const engine = new MemoryConsolidationEngine({
    store: { markIneligible, markFailed } as never,
    eventStore: {} as never,
    projectionStore: { get },
    userStore: { findById: () => undefined },
    isTenantEnabled: () => true,
    dispatch: dispatch as never,
    agentCwd: '/tmp',
    getConfig: () => config,
  });
  return { engine, markIneligible, markFailed, dispatch };
}

describe('不可用会话退役', () => {
  it('超出一小时仍缺失 projection 的历史待办不再无限重试', async () => {
    const h = harness(async () => null);
    await processState(h.engine, state);
    expect(h.markIneligible).toHaveBeenCalledWith({
      tenantId: 't',
      sessionId: 'session',
      leaseOwner: 'worker',
    });
    expect(h.markFailed).not.toHaveBeenCalled();
    expect(h.dispatch).not.toHaveBeenCalled();
  });
  it('新会话仍在 projection 宽限期内时保留重试', async () => {
    const h = harness(async () => null);
    await processState(h.engine, { ...state, firstPendingAt: new Date().toISOString() });
    expect(h.markIneligible).not.toHaveBeenCalled();
    expect(h.markFailed).toHaveBeenCalledOnce();
  });
  it('已软删除会话立即退役，不再读历史或运行模型', async () => {
    const h = harness(async (_id, options) =>
      options?.includeDeleted
        ? {
            sessionId: 'session',
            tenantId: 't',
            userId: 'u',
            kind: 'user',
            metaJson: { memoryPolicyVersion: 'v2' },
          }
        : null,
    );
    await processState(h.engine, { ...state, firstPendingAt: new Date().toISOString() });
    expect(h.markIneligible).toHaveBeenCalledOnce();
    expect(h.dispatch).not.toHaveBeenCalled();
  });
});
