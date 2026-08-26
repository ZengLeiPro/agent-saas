import { describe, expect, it, vi } from 'vitest';

import { MISSING_PROJECTION_GRACE_MS } from '../memory/consolidation/engine.js';
import type { MemoryConsolidationScannerStatus } from '../memory/consolidation/types.js';
import type { AlertNotifier } from '../runtime/alertNotifier.js';
import { createMemoryConsolidationScannerStatusHandler } from './runtimeMemoryConsolidationStatus.js';

function status(oldestPendingAgeMs: number): MemoryConsolidationScannerStatus {
  return {
    capturedAt: '2026-08-26T15:00:00.000Z',
    consumerName: 'memory-consolidation-v1',
    cursor: 100,
    cursorUpdatedAt: '2026-08-26T14:59:00.000Z',
    latestBoundarySequence: 150,
    latestBoundaryAt: '2026-08-26T14:59:30.000Z',
    sequenceLag: 50,
    oldestPendingBoundarySequence: 101,
    oldestPendingBoundaryAt: '2026-08-26T13:55:00.000Z',
    oldestPendingAgeMs,
    skips24hByReason: { internal_session_taskboard: 7 },
    latestSkipAt: null,
  };
}

describe('memory consolidation scanner status handler', () => {
  it('only alerts beyond grace and uses the durable dedupe key', async () => {
    const notifyExternal = vi.fn(async () => ({ considered: 1, notified: 1 }));
    const warn = vi.fn();
    const handle = createMemoryConsolidationScannerStatusHandler({
      alertNotifier: { notifyExternal } as unknown as AlertNotifier,
      logger: { warn },
    });

    await handle(status(MISSING_PROJECTION_GRACE_MS - 1));
    expect(notifyExternal).not.toHaveBeenCalled();

    await handle(status(MISSING_PROJECTION_GRACE_MS));
    expect(warn).toHaveBeenCalledOnce();
    expect(notifyExternal).toHaveBeenCalledWith('memory_consolidation', [
      expect.objectContaining({
        kind: 'memory_consolidation_scanner_lag',
        severity: 'high',
        dedupeKey: 'memory_consolidation_scanner_lag',
      }),
    ]);
  });
});
