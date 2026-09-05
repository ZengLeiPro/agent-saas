/** §4.6 健康端点。 */
import { describe, expect, it } from 'vitest';

import { buildHealthLive, buildHealthReady } from './index.js';
import { TEST_MANIFEST_DIGEST } from '../__tests__/helpers.js';

describe('buildHealthLive', () => {
  it('默认 ok；维护期带 etaMinutes', () => {
    expect(buildHealthLive()).toEqual({ status: 'ok' });
    expect(buildHealthLive({ maintenance: true, etaMinutes: 5 })).toEqual({
      status: 'maintenance',
      etaMinutes: 5,
    });
    expect(buildHealthLive({ maintenance: true })).toEqual({ status: 'maintenance' });
  });
});

describe('buildHealthReady', () => {
  const base = {
    appVersion: '1.2.3',
    manifestDigest: TEST_MANIFEST_DIGEST,
    installationState: 'enabled' as const,
    deps: { db: () => true, executionStore: () => true, jtiStore: () => true },
    directorySync: async () => ({ checkpoint: 42, ageSeconds: 12 }),
    jwksKids: () => ['k1', 'k2'],
  };

  it('给出 §4.6 全部字段', async () => {
    await expect(buildHealthReady(base)).resolves.toEqual({
      status: 'ok',
      contractVersion: 1,
      appVersion: '1.2.3',
      manifestDigest: TEST_MANIFEST_DIGEST,
      installationState: 'enabled',
      deps: {
        db: true,
        executionStore: true,
        jtiStore: true,
        directorySync: { checkpoint: 42, ageSeconds: 12 },
      },
      jwksKids: ['k1', 'k2'],
    });
  });

  it('依赖探测抛错时算不可用而不是整体 500', async () => {
    const ready = await buildHealthReady({
      ...base,
      deps: {
        db: () => {
          throw new Error('down');
        },
        executionStore: async () => false,
        jtiStore: () => true,
      },
      directorySync: async () => {
        throw new Error('no checkpoint');
      },
    });
    expect(ready.deps.db).toBe(false);
    expect(ready.deps.executionStore).toBe(false);
    expect(ready.deps.directorySync.ageSeconds).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('维护期 status=maintenance', async () => {
    await expect(buildHealthReady({ ...base, maintenance: true })).resolves.toMatchObject({
      status: 'maintenance',
    });
  });
});
