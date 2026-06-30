/**
 * Session Cache Utilities
 *
 * 通用会话缓存工具：
 * - TTLCache: 带过期时间的内存缓存
 * - JsonFileSessionCache: 文件持久化的 KV 缓存
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname } from "path";
import { sessionLogger } from './logger.js';

interface CacheEntry<T> {
  value: T;
  createdAt: number;
}

// ============================================
// TTL Session Cache
// ============================================

export class TTLCache<T = string> {
  private cache = new Map<string, CacheEntry<T>>();
  private readonly ttlMs: number;
  private cleanupTimer: ReturnType<typeof setInterval>;

  constructor(ttlMs: number = 24 * 60 * 60 * 1000, cleanupIntervalMs: number = 60 * 60 * 1000) {
    this.ttlMs = ttlMs;
    // Start periodic cleanup
    this.cleanupTimer = setInterval(() => this.cleanup(), cleanupIntervalMs);
    // Ensure timer doesn't prevent process exit
    this.cleanupTimer.unref();
  }

  get(key: string): T | undefined {
    const entry = this.cache.get(key);
    if (!entry) {
      return undefined;
    }
    if (Date.now() - entry.createdAt > this.ttlMs) {
      this.cache.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: T): void {
    this.cache.set(key, {
      value,
      createdAt: Date.now()
    });
  }

  has(key: string): boolean {
    const entry = this.cache.get(key);
    if (!entry) {
      return false;
    }
    if (Date.now() - entry.createdAt > this.ttlMs) {
      this.cache.delete(key);
      return false;
    }
    return true;
  }

  delete(key: string): boolean {
    return this.cache.delete(key);
  }

  clear(): void {
    this.cache.clear();
  }

  private cleanup(): void {
    const now = Date.now();
    let cleanedCount = 0;
    for (const [key, entry] of this.cache) {
      if (now - entry.createdAt > this.ttlMs) {
        this.cache.delete(key);
        cleanedCount++;
      }
    }
    if (cleanedCount > 0) {
      sessionLogger.info(`Cache cleanup: removed ${cleanedCount} expired sessions`);
    }
  }

  destroy(): void {
    clearInterval(this.cleanupTimer);
    this.cache.clear();
  }
}

// ============================================
// File-backed Session Cache (Web)
// ============================================

/**
 * 用 JSON 文件持久化的简单 Session Cache。
 * - 主要用于 Web 端 clientSessionId -> claudeSessionId 映射
 * - 仅在 set 时写文件（降低 IO）
 */
export class JsonFileSessionCache {
  private cache = new Map<string, string>();
  private readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
    this.loadFromFile();
  }

  get(key: string): string | undefined {
    return this.cache.get(key);
  }

  set(key: string, value: string): void {
    this.cache.set(key, value);
    this.persist();
  }

  private loadFromFile(): void {
    if (!existsSync(this.filePath)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, "utf-8")) as unknown;
      if (!parsed || typeof parsed !== "object") return;
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof k === "string" && typeof v === "string") {
          this.cache.set(k, v);
        }
      }
    } catch {
      // ignore
    }
  }

  private persist(): void {
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      const data = Object.fromEntries(this.cache.entries());
      writeFileSync(this.filePath, JSON.stringify(data, null, 2));
    } catch (err) {
      sessionLogger.warn(`Failed to persist sessions: ${String(err)}`);
    }
  }
}
