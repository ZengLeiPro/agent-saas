import { describe, expect, it, vi } from 'vitest';

import type { KyAppInstallationDirectory } from '../installations/queries.js';
import type { KyAppOutbound } from '../outbound.js';
import type { KyAppSatIssuer } from '../sat/issuer.js';
import { DIRECTORY_CHANGED_FEATURE, DirectoryChangeNotifier } from './notifier.js';
import type { DirectoryReconcileResult } from './projection.js';

const CHANGED: DirectoryReconcileResult = {
  tenantId: 'tenant-a',
  userUpserts: 1,
  userRemovals: 0,
  groupUpserts: 0,
  groupRemovals: 0,
  snapshotSeq: 42,
};

function installationDirectory(): KyAppInstallationDirectory {
  return {
    listEnabled: async () => [
      {
        installationId: 'tsi-a',
        tenantId: 'tenant-a',
        systemId: 'demo-system',
        baseUrl: 'https://demo.invalid',
        origin: 'https://demo.invalid',
        status: 'enabled',
        stateVersion: 3,
        registeredDigest: null,
      },
    ],
  } as KyAppInstallationDirectory;
}

describe('目录变更通知', () => {
  it('只通知 ready 明确声明能力的实例，载荷只有目标水位', async () => {
    const requests: Array<Record<string, unknown>> = [];
    const outbound = {
      request: vi.fn(async (input: { jsonBody: Record<string, unknown> }) => {
        requests.push(input.jsonBody);
        return {
          status: 200,
          json: { eventId: input.jsonBody.eventId, ack: true, stateVersion: 3 },
        };
      }),
    } as unknown as KyAppOutbound;
    const notifier = new DirectoryChangeNotifier({
      directory: installationDirectory(),
      issuer: { issue: async () => ({ token: 'sat' }) } as unknown as KyAppSatIssuer,
      outbound,
      supportsFeature: (_installationId, feature) => feature === DIRECTORY_CHANGED_FEATURE,
      now: () => Date.parse('2026-09-10T00:00:00.000Z'),
    });

    await expect(notifier.notify([CHANGED])).resolves.toEqual({
      attempted: 1,
      delivered: 1,
      failed: 0,
    });
    expect(requests[0]).toMatchObject({
      iid: 'tsi-a',
      stateVersion: 3,
      type: 'directory.changed',
      payload: { targetSeq: 42 },
    });
    expect(JSON.stringify(requests[0])).not.toContain('displayName');
  });

  it('旧实例未声明能力时完全跳过', async () => {
    const request = vi.fn();
    const notifier = new DirectoryChangeNotifier({
      directory: installationDirectory(),
      issuer: {} as KyAppSatIssuer,
      outbound: { request } as unknown as KyAppOutbound,
      supportsFeature: () => false,
    });

    await expect(notifier.notify([CHANGED])).resolves.toEqual({
      attempted: 0,
      delivered: 0,
      failed: 0,
    });
    expect(request).not.toHaveBeenCalled();
  });
});
