import type { DirectoryReconcileResult } from './projection.js';

export interface DirectoryReconcileAll {
  reconcileAll(): Promise<DirectoryReconcileResult[]>;
}

export interface RefreshingDirectoryReconcilerOptions {
  refresh(): Promise<void> | void;
  reconciler: DirectoryReconcileAll;
}

/**
 * 将易变事实源的刷新放在目录投影器之外。
 * projection.ts 同时承载历史迁移 SQL，必须保持不可变，避免运行时编排改动被误判为迁移。
 */
export class RefreshingDirectoryReconciler implements DirectoryReconcileAll {
  constructor(private readonly options: RefreshingDirectoryReconcilerOptions) {}

  async reconcileAll(): Promise<DirectoryReconcileResult[]> {
    await this.options.refresh();
    return this.options.reconciler.reconcileAll();
  }
}
