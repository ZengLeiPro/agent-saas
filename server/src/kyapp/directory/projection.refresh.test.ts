import { describe, expect, it, vi } from 'vitest';

import { RefreshingDirectoryReconciler } from './refreshingReconciler.js';

describe('目录投影事实源刷新', () => {
  it('刷新成功后才执行全组织投影', async () => {
    const calls: string[] = [];
    const reconciler = new RefreshingDirectoryReconciler({
      refresh: () => {
        calls.push('refresh');
      },
      reconciler: {
        reconcileAll: async () => {
          calls.push('reconcile');
          return [];
        },
      },
    });

    await expect(reconciler.reconcileAll()).resolves.toEqual([]);
    expect(calls).toEqual(['refresh', 'reconcile']);
  });

  it('刷新失败时不执行投影，避免把失效事实源解释成空目录', async () => {
    const reconcileAll = vi.fn();
    const reconciler = new RefreshingDirectoryReconciler({
      refresh: () => {
        throw new Error('invalid users snapshot');
      },
      reconciler: { reconcileAll },
    });

    await expect(reconciler.reconcileAll()).rejects.toThrow('invalid users snapshot');
    expect(reconcileAll).not.toHaveBeenCalled();
  });
});
