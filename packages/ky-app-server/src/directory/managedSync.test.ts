import { describe, expect, it, vi } from 'vitest';

import { createManagedDirectorySync, type DirectorySyncCoordinator } from './managedSync.js';

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('托管目录同步', () => {
  it('启动立即同步，成功后安排带抖动的兜底周期', async () => {
    const sync = vi.fn(async () => ({ status: 'up-to-date' as const, applied: 0, checkpoint: 7 }));
    const scheduled: Array<{ run: () => void; delay: number }> = [];
    const managed = createManagedDirectorySync({
      client: { sync },
      intervalMs: 1_000,
      jitterRatio: 0,
      schedule: (run, delay) => {
        scheduled.push({ run, delay });
        return { unref: vi.fn() } as unknown as ReturnType<typeof setTimeout>;
      },
      clearSchedule: vi.fn(),
    });

    managed.start();
    await settle();
    expect(sync).toHaveBeenCalledOnce();
    expect(scheduled.at(-1)?.delay).toBe(1_000);
    expect(managed.status()).toMatchObject({ started: true, consecutiveFailures: 0 });
    await managed.stop();
  });

  it('并发通知合并为当前轮后的单次补跑', async () => {
    let finish: (() => void) | undefined;
    const sync = vi.fn(() => {
      if (sync.mock.calls.length > 1)
        return Promise.resolve({ status: 'up-to-date' as const, applied: 0, checkpoint: 1 });
      return new Promise<{ status: 'up-to-date'; applied: number; checkpoint: number }>(
        (resolve) => {
          finish = () => resolve({ status: 'up-to-date', applied: 0, checkpoint: 1 });
        },
      );
    });
    const managed = createManagedDirectorySync({ client: { sync }, intervalMs: 1_000 });

    managed.start();
    managed.trigger();
    managed.trigger();
    expect(sync).toHaveBeenCalledOnce();
    finish?.();
    await settle();
    expect(sync).toHaveBeenCalledTimes(2);
    await managed.stop();
  });

  it('失败后指数退避且不产生未处理 rejection', async () => {
    const sync = vi.fn(async () => {
      throw new Error('platform offline');
    });
    const scheduled: number[] = [];
    const managed = createManagedDirectorySync({
      client: { sync },
      intervalMs: 60_000,
      retryBaseMs: 100,
      retryMaxMs: 500,
      schedule: (_run, delay) => {
        scheduled.push(delay);
        return { unref: vi.fn() } as unknown as ReturnType<typeof setTimeout>;
      },
      clearSchedule: vi.fn(),
    });

    managed.start();
    await settle();
    expect(scheduled).toEqual([100]);
    expect(managed.status()).toMatchObject({
      consecutiveFailures: 1,
      lastError: 'platform offline',
    });
    await managed.stop();
  });

  it('多实例租约未取得时跳过网络同步', async () => {
    const coordinator: DirectorySyncCoordinator = { runExclusive: async () => false };
    const sync = vi.fn();
    const managed = createManagedDirectorySync({
      client: { sync },
      coordinator,
      intervalMs: 1_000,
      jitterRatio: 0,
    });

    managed.start();
    await settle();
    expect(sync).not.toHaveBeenCalled();
    await managed.stop();
  });
});
