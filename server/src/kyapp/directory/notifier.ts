import { randomUUID } from 'node:crypto';

import type { KyAppInstallationDirectory } from '../installations/queries.js';
import type { KyAppOutbound } from '../outbound.js';
import type { KyAppSatIssuer } from '../sat/issuer.js';
import { KY_APP_EVENTS_PATH } from '../events/dispatcher.js';
import type { DirectoryReconcileResult } from './projection.js';

export const DIRECTORY_CHANGED_FEATURE = 'directory.changed.v1';

export interface DirectoryChangeNotifierLogger {
  warn(message: string): void;
}

export interface DirectoryChangeNotifierOptions {
  directory: KyAppInstallationDirectory;
  issuer: KyAppSatIssuer;
  outbound: KyAppOutbound;
  supportsFeature: (installationId: string, feature: string) => boolean;
  now?: () => number;
  logger?: DirectoryChangeNotifierLogger;
}

export interface DirectoryNotificationResult {
  attempted: number;
  delivered: number;
  failed: number;
}

function hasChanges(result: DirectoryReconcileResult): boolean {
  return result.userUpserts + result.userRemovals + result.groupUpserts + result.groupRemovals > 0;
}

/**
 * 目录投影后的低延迟提示。通知不携带用户数据，也不承担可靠消费职责；
 * 接收方按 checkpoint 拉 changes，漏通知由 SDK 的五分钟兜底同步修复。
 */
export class DirectoryChangeNotifier {
  private readonly now: () => number;

  constructor(private readonly options: DirectoryChangeNotifierOptions) {
    this.now = options.now ?? Date.now;
  }

  async notify(reconciled: DirectoryReconcileResult[]): Promise<DirectoryNotificationResult> {
    const summary: DirectoryNotificationResult = { attempted: 0, delivered: 0, failed: 0 };
    const changed = new Map(
      reconciled.filter(hasChanges).map((result) => [result.tenantId, result.snapshotSeq]),
    );
    if (changed.size === 0) return summary;

    const installations = await this.options.directory.listEnabled();
    for (const installation of installations) {
      const targetSeq = changed.get(installation.tenantId);
      if (targetSeq === undefined) continue;
      if (!this.options.supportsFeature(installation.installationId, DIRECTORY_CHANGED_FEATURE)) {
        continue;
      }
      summary.attempted += 1;
      const requestId = randomUUID();
      const eventId = randomUUID();
      try {
        const sat = await this.options.issuer.issue({
          act: 'platform',
          tenantId: installation.tenantId,
          installationId: installation.installationId,
          systemId: installation.systemId,
          rid: requestId,
        });
        const response = await this.options.outbound.request({
          baseUrl: installation.baseUrl,
          path: KY_APP_EVENTS_PATH,
          method: 'POST',
          requestId,
          headers: { authorization: `Bearer ${sat.token}` },
          jsonBody: {
            eventId,
            iid: installation.installationId,
            stateVersion: installation.stateVersion,
            type: 'directory.changed',
            occurredAt: new Date(this.now()).toISOString(),
            payload: { targetSeq },
          },
        });
        const ack = response.json as { eventId?: unknown; ack?: unknown } | null;
        if (response.status !== 200 || ack?.ack !== true || ack.eventId !== eventId) {
          throw new Error(`对端返回 HTTP ${response.status} 或 ack 不匹配`);
        }
        summary.delivered += 1;
      } catch (error) {
        summary.failed += 1;
        this.options.logger?.warn(
          `KY App 目录变更通知失败：实例 ${installation.installationId}：${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    return summary;
  }
}
