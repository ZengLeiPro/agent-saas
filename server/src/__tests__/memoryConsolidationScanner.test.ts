import { afterEach, describe, expect, it, vi } from 'vitest';

import { MemoryConsolidationEngine } from '../memory/consolidation/engine.js';
import { classifyInternalMemorySession } from '../memory/consolidation/sessionEligibility.js';
import type { PgMemoryConsolidationStore } from '../memory/consolidation/store.js';
import {
  MEMORY_CONSOLIDATION_DEFAULTS,
  type MemoryConsolidationScannerStatus,
} from '../memory/consolidation/types.js';

function createScannerHarness(
  input: {
    sessionId?: string;
    onScannerStatus?: (status: MemoryConsolidationScannerStatus) => void | Promise<void>;
    scannerStatus?: MemoryConsolidationScannerStatus;
  } = {},
) {
  let cursor = 0;
  const sessionId = input.sessionId ?? 'taskboard-integration-abc';
  const event = {
    globalSequence: 899,
    sessionSequence: 1,
    tenantId: 't-enabled',
    sessionId,
    event: {
      id: 'event-899',
      type: 'run_started',
      runId: 'run-899',
      timestamp: '2026-08-26T15:00:00.000Z',
    },
  };
  const quarantineEnvelopeAndAdvanceCursor = vi.fn(
    async ({ globalSequence }: { globalSequence: number }) => {
      cursor = Math.max(cursor, globalSequence);
    },
  );
  const getScannerStatus = vi.fn(
    async () =>
      input.scannerStatus ?? {
        capturedAt: '2026-08-26T15:00:00.000Z',
        consumerName: 'memory-consolidation-v1',
        cursor,
        cursorUpdatedAt: null,
        latestBoundarySequence: cursor,
        latestBoundaryAt: null,
        sequenceLag: 0,
        oldestPendingBoundarySequence: null,
        oldestPendingBoundaryAt: null,
        oldestPendingAgeMs: null,
        skips24hByReason: {},
        latestSkipAt: null,
      },
  );
  const store = {
    getConsumerCursor: vi.fn(async () => cursor),
    advanceConsumerCursor: vi.fn(async (_name: string, to: number) => {
      cursor = Math.max(cursor, to);
    }),
    quarantineEnvelopeAndAdvanceCursor,
    getScannerStatus,
  } as unknown as PgMemoryConsolidationStore;
  const projectionGet = vi.fn(async () => null);
  const warn = vi.fn();
  const engine = new MemoryConsolidationEngine({
    store,
    eventStore: {
      listGlobalPage: vi.fn(async () => ({
        events: input.sessionId ? [event] : [],
        hasMore: false,
      })),
      listSessionRange: vi.fn(async () => []),
    },
    projectionStore: { get: projectionGet },
    userStore: { findById: vi.fn(() => undefined) },
    isTenantEnabled: () => true,
    dispatch: vi.fn() as never,
    agentCwd: '/tmp',
    getConfig: () => ({ ...MEMORY_CONSOLIDATION_DEFAULTS, enabled: true }),
    ...(input.onScannerStatus ? { onScannerStatus: input.onScannerStatus } : {}),
    logger: { info: vi.fn(), warn },
  });
  (engine as unknown as { stopped: boolean }).stopped = false;
  return {
    engine,
    getCursor: () => cursor,
    projectionGet,
    quarantineEnvelopeAndAdvanceCursor,
    getScannerStatus,
    warn,
  };
}

afterEach(() => vi.restoreAllMocks());

describe('memory consolidation scanner session classification', () => {
  it.each([
    ['taskboard-integration-abc', 'taskboard'],
    ['taskboard-review-abc', 'taskboard'],
    ['sub-abc', 'subagent'],
    ['memory-maint-abc', 'memory_maintenance'],
    ['memory-consolidate-abc', 'memory_consolidation'],
    ['agent-dws-session-abc', null],
    ['2eab3f40-6b3d-4c35-93dd-702d8de07216', null],
  ])('classifies %s as %s', (sessionId, expected) => {
    expect(classifyInternalMemorySession(sessionId)).toBe(expected);
  });

  it('skips a projection-less TaskBoard event immediately and records its class', async () => {
    const harness = createScannerHarness({ sessionId: 'taskboard-integration-abc' });

    await (harness.engine as unknown as { scanOnce(): Promise<void> }).scanOnce();

    expect(harness.projectionGet).not.toHaveBeenCalled();
    expect(harness.quarantineEnvelopeAndAdvanceCursor).toHaveBeenCalledWith(
      expect.objectContaining({
        globalSequence: 899,
        sessionId: 'taskboard-integration-abc',
        reason: 'internal_session_taskboard',
      }),
    );
    expect(harness.getCursor()).toBe(899);
    expect(harness.warn).not.toHaveBeenCalled();
  });

  it('publishes scanner status at most once per minute and isolates observer failures', async () => {
    const now = Date.parse('2026-08-26T15:00:00.000Z');
    const dateNow = vi.spyOn(Date, 'now').mockReturnValue(now);
    const onScannerStatus = vi.fn(async () => undefined);
    const harness = createScannerHarness({ onScannerStatus });

    await (harness.engine as unknown as { scanOnce(): Promise<void> }).scanOnce();
    await (harness.engine as unknown as { scanOnce(): Promise<void> }).scanOnce();
    expect(harness.getScannerStatus).toHaveBeenCalledOnce();
    expect(onScannerStatus).toHaveBeenCalledOnce();

    dateNow.mockReturnValue(now + 60_000);
    onScannerStatus.mockRejectedValueOnce(new Error('alert backend unavailable'));
    await (harness.engine as unknown as { scanOnce(): Promise<void> }).scanOnce();
    expect(harness.warn).toHaveBeenCalledWith(
      'consolidation scanner status failed: alert backend unavailable',
    );
  });
});
