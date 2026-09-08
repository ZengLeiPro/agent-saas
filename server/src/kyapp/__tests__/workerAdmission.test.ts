import { afterEach, expect, it, vi } from 'vitest';
import { KyAppWorker, type KyAppWorkerOptions } from '../worker.js';

afterEach(() => vi.useRealTimers());

it('候选与排空期间不执行后台任务，权威开放后恢复，stop 后不再执行', async () => {
  vi.useFakeTimers();
  let admitting = false;
  const dispatch = vi.fn().mockResolvedValue({});
  const probe = vi.fn().mockResolvedValue({});
  const reconcile = vi.fn().mockResolvedValue(undefined);
  const worker = new KyAppWorker({
    canRun: () => admitting,
    dispatcher: { tick: dispatch },
    prober: { tick: probe },
    directoryMaintenance: { reconcile },
    dispatchIntervalMs: 100,
    probeIntervalMs: 100,
    directoryIntervalMs: 100,
  } as unknown as KyAppWorkerOptions);
  worker.start();
  await vi.advanceTimersByTimeAsync(100);
  expect(dispatch).not.toHaveBeenCalled();
  expect(probe).not.toHaveBeenCalled();
  expect(reconcile).not.toHaveBeenCalled();
  admitting = true;
  await vi.advanceTimersByTimeAsync(100);
  expect(dispatch).toHaveBeenCalledOnce();
  expect(probe).toHaveBeenCalledOnce();
  expect(reconcile).toHaveBeenCalledOnce();
  admitting = false;
  await vi.advanceTimersByTimeAsync(100);
  worker.stop();
  admitting = true;
  await vi.advanceTimersByTimeAsync(100);
  expect(dispatch).toHaveBeenCalledOnce();
  expect(probe).toHaveBeenCalledOnce();
});
