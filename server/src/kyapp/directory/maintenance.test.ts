/**
 * WP2b Phase A ④：30 天保留清理与目录投影挂 worker 角色（不新增任何 env）。
 * 角色判定沿用 WP2a 的 `shouldRunKyAppWorker`，与 `runtime.ts` 的
 * `enableSingletonWorkers` 同口径——多副本下只有一个角色跑清理，避免重复删。
 */
import { describe, expect, it, vi } from 'vitest';

import {
  KY_APP_DIRECTORY_INTERVAL_MS,
  KyAppWorker,
  shouldRunKyAppWorker,
  type KyAppDirectoryMaintenance,
  type KyAppWorkerOptions,
} from '../worker.js';

function buildWorker(directoryMaintenance?: KyAppDirectoryMaintenance): {
  worker: KyAppWorker;
  calls: { credentials: number; nonces: number };
} {
  const calls = { credentials: 0, nonces: 0 };
  const options = {
    dispatcher: { tick: async () => undefined },
    prober: { tick: async () => undefined },
    credentials: {
      expireStale: async () => {
        calls.credentials += 1;
      },
      listRotationDue: async () => [],
    },
    directory: { listLive: async () => [] },
    keys: { retireExpired: async () => undefined },
    nonces: {
      purgeExpired: async () => {
        calls.nonces += 1;
        return 0;
      },
    },
    suspensions: { prune: () => undefined },
    alerts: {
      onEventAbandoned: () => undefined,
      onHealthAlert: () => undefined,
      notifyCredentialExpiring: () => undefined,
      notifyCredits: () => undefined,
    },
    ...(directoryMaintenance ? { directoryMaintenance } : {}),
  } as unknown as KyAppWorkerOptions;
  return { worker: new KyAppWorker(options), calls };
}

describe('目录保留清理与投影的 worker 挂载', () => {
  it('角色判定与 WP2a 一致：只有 all / runtime-worker 跑后台节拍', () => {
    expect(shouldRunKyAppWorker('all')).toBe(true);
    expect(shouldRunKyAppWorker('runtime-worker')).toBe(true);
    expect(shouldRunKyAppWorker('ws-only')).toBe(false);
    expect(shouldRunKyAppWorker('scheduler-only')).toBe(false);
  });

  it('维护巡检顺带跑保留清理，投影单独一拍', async () => {
    const purgeExpired = vi.fn(async (_at: Date) => 3);
    const reconcile = vi.fn(async () => undefined);
    const { worker, calls } = buildWorker({ purgeExpired, reconcile });

    await worker.runMaintenance();
    expect(purgeExpired).toHaveBeenCalledTimes(1);
    expect(purgeExpired.mock.calls[0]?.[0]).toBeInstanceOf(Date);
    expect(reconcile).not.toHaveBeenCalled();
    // 既有的 WP2a 巡检项没有被挤掉。
    expect(calls).toEqual({ credentials: 1, nonces: 1 });

    await worker.runDirectory();
    expect(reconcile).toHaveBeenCalledTimes(1);
  });

  it('投影失败只告警，不影响后续节拍', async () => {
    const warn = vi.fn();
    const { worker } = buildWorker({
      purgeExpired: async () => 0,
      reconcile: async () => {
        throw new Error('source unavailable');
      },
    });
    (worker as unknown as { options: { logger?: { warn: (m: string) => void } } }).options.logger =
      {
        warn,
      };
    await expect(worker.runDirectory()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('source unavailable'));
    await expect(worker.runDirectory()).resolves.toBeUndefined();
  });

  it('未装配目录维护面时不启定时器、巡检照常', async () => {
    const { worker, calls } = buildWorker();
    await worker.runMaintenance();
    await worker.runDirectory();
    expect(calls).toEqual({ credentials: 1, nonces: 1 });

    worker.start();
    expect((worker as unknown as { directoryTimer?: unknown }).directoryTimer).toBeUndefined();
    worker.stop();
  });

  it('装配后按配置节拍起定时器，stop 后清干净', () => {
    const { worker } = buildWorker({
      purgeExpired: async () => 0,
      reconcile: async () => undefined,
    });
    worker.start();
    expect((worker as unknown as { directoryTimer?: unknown }).directoryTimer).toBeDefined();
    worker.stop();
    expect((worker as unknown as { directoryTimer?: unknown }).directoryTimer).toBeUndefined();
    expect(KY_APP_DIRECTORY_INTERVAL_MS).toBe(60_000);
  });
});
