/**
 * Memory Index — Service
 *
 * 管理所有用户的 MemoryIndexer 实例。
 * 在主服务进程中运行（长生命周期），提供 per-user 索引管理。
 */

import { resolve } from 'node:path';

import { MemoryIndexer } from './indexer.js';
import type { SyncIfStaleOptions } from './indexer.js';
import type { MemoryIndexConfig } from './types.js';

type LogFn = (msg: string) => void;

export class MemoryIndexService {
  private readonly indexers = new Map<string, MemoryIndexer>();
  private readonly maybeChangedAt = new Map<string, number>();
  private readonly config: MemoryIndexConfig;
  private readonly log: LogFn;
  private retired = false;

  constructor(config: MemoryIndexConfig, log?: LogFn) {
    this.config = config;
    this.log = log ?? (() => {});
  }

  /**
   * 获取或创建指定 workspace 的 indexer。
   * workspaceDir 是用户的完整 workspace 路径（如 /Users/admin/workspace/admin）。
   */
  getIndexer(workspaceDir: string): MemoryIndexer {
    const key = resolve(workspaceDir);
    const existing = this.indexers.get(key);
    if (existing) return existing;

    this.log(`creating indexer for ${key}`);
    const indexer = new MemoryIndexer(key, this.config, this.log, {
      skipWatch: this.retired,
    });
    this.indexers.set(key, indexer);
    return indexer;
  }

  /** 应用层已确认记忆源文件变更时调用，立即排队同步。 */
  enqueueSync(workspaceDir: string, reason = 'explicit', opts?: { debounceMs?: number }): void {
    if (this.retired) return;
    this.getIndexer(workspaceDir).enqueueSync(reason, opts);
  }

  /** Shell 等弱信号：限频标 dirty，避免高频工具导致频繁扫描。 */
  noteMaybeChanged(
    workspaceDir: string,
    reason = 'maybe-changed',
    opts?: { debounceMs?: number; minIntervalMs?: number },
  ): void {
    if (this.retired) return;
    const key = resolve(workspaceDir);
    const now = Date.now();
    const minIntervalMs = opts?.minIntervalMs ?? 120_000;
    const last = this.maybeChangedAt.get(key) ?? 0;
    if (now - last < minIntervalMs) return;
    this.maybeChangedAt.set(key, now);
    this.getIndexer(key).enqueueSync(reason, { debounceMs: opts?.debounceMs ?? 30_000 });
  }

  async syncIfStale(workspaceDir: string, opts?: SyncIfStaleOptions): Promise<void> {
    await this.getIndexer(workspaceDir).syncIfStale(opts);
  }

  /** 关闭所有 indexer */
  async closeAll(): Promise<void> {
    const entries = Array.from(this.indexers.values());
    this.indexers.clear();
    this.maybeChangedAt.clear();
    await Promise.allSettled(entries.map((i) => i.close()));
  }

  retireAll(): void {
    this.retired = true;
    for (const indexer of this.indexers.values()) {
      indexer.retire();
    }
  }
}
