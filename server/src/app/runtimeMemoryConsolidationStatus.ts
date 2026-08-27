import { MISSING_PROJECTION_GRACE_MS } from '../memory/consolidation/engine.js';
import type { MemoryConsolidationScannerStatus } from '../memory/consolidation/types.js';
import type { AlertNotifier } from '../runtime/alertNotifier.js';

export function createMemoryConsolidationScannerStatusHandler(options: {
  alertNotifier?: AlertNotifier;
  logger: { warn: (message: string) => void };
}): (status: MemoryConsolidationScannerStatus) => Promise<void> {
  return async (status) => {
    if (
      status.oldestPendingAgeMs === null ||
      status.oldestPendingAgeMs < MISSING_PROJECTION_GRACE_MS
    )
      return;
    options.logger.warn(
      `scanner lag exceeded grace: cursor=${status.cursor}, sequenceLag=${status.sequenceLag}, oldestPendingAgeMs=${status.oldestPendingAgeMs}`,
    );
    await options.alertNotifier?.notifyExternal('memory_consolidation', [
      {
        kind: 'memory_consolidation_scanner_lag',
        severity: 'high',
        title: `L2 记忆整合扫描延迟超过宽限期（lag ${status.sequenceLag}）`,
        occurredAt: status.oldestPendingBoundaryAt,
        actions: ['检查 memory consolidation scanner 日志与 projection 缺失分类'],
        dedupeKey: 'memory_consolidation_scanner_lag',
      },
    ]);
  };
}
