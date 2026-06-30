/**
 * Session Service Tests
 *
 * 测试 TTLCache 类和会话管理功能
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TTLCache } from '../utils/cache.js';

describe('TTLCache', () => {
  // 测试用的短 TTL 和清理间隔
  const SHORT_TTL = 100; // 100ms
  const SHORT_CLEANUP_INTERVAL = 50; // 50ms

  let cache: TTLCache;

  afterEach(() => {
    // 确保每个测试后清理 cache
    if (cache) {
      cache.destroy();
    }
  });

  describe('constructor', () => {
    it('should create a cache with default TTL', () => {
      cache = new TTLCache();
      expect(cache).toBeInstanceOf(TTLCache);
    });

    it('should create a cache with custom TTL', () => {
      cache = new TTLCache(5000);
      expect(cache).toBeInstanceOf(TTLCache);
    });

    it('should create a cache with custom TTL and cleanup interval', () => {
      cache = new TTLCache(5000, 1000);
      expect(cache).toBeInstanceOf(TTLCache);
    });
  });

  describe('set and get', () => {
    beforeEach(() => {
      cache = new TTLCache(SHORT_TTL, SHORT_CLEANUP_INTERVAL);
    });

    it('should store and retrieve a value', () => {
      cache.set('key1', 'value1');
      expect(cache.get('key1')).toBe('value1');
    });

    it('should return undefined for non-existent key', () => {
      expect(cache.get('nonexistent')).toBeUndefined();
    });

    it('should overwrite existing value', () => {
      cache.set('key1', 'value1');
      cache.set('key1', 'value2');
      expect(cache.get('key1')).toBe('value2');
    });

    it('should store multiple keys independently', () => {
      cache.set('key1', 'value1');
      cache.set('key2', 'value2');
      cache.set('key3', 'value3');

      expect(cache.get('key1')).toBe('value1');
      expect(cache.get('key2')).toBe('value2');
      expect(cache.get('key3')).toBe('value3');
    });

    it('should handle empty string key', () => {
      cache.set('', 'empty-key-value');
      expect(cache.get('')).toBe('empty-key-value');
    });

    it('should handle empty string value', () => {
      cache.set('key', '');
      expect(cache.get('key')).toBe('');
    });

    it('should handle special characters in key and value', () => {
      const specialKey = 'key:with/special\\chars!@#$%';
      const specialValue = 'value\nwith\ttabs\rand\0nulls';

      cache.set(specialKey, specialValue);
      expect(cache.get(specialKey)).toBe(specialValue);
    });

    it('should handle unicode characters', () => {
      const unicodeKey = '';
      const unicodeValue = '';

      cache.set(unicodeKey, unicodeValue);
      expect(cache.get(unicodeKey)).toBe(unicodeValue);
    });

    it('should handle very long keys and values', () => {
      const longKey = 'k'.repeat(10000);
      const longValue = 'v'.repeat(10000);

      cache.set(longKey, longValue);
      expect(cache.get(longKey)).toBe(longValue);
    });
  });

  describe('has', () => {
    beforeEach(() => {
      cache = new TTLCache(SHORT_TTL, SHORT_CLEANUP_INTERVAL);
    });

    it('should return true for existing key', () => {
      cache.set('key1', 'value1');
      expect(cache.has('key1')).toBe(true);
    });

    it('should return false for non-existent key', () => {
      expect(cache.has('nonexistent')).toBe(false);
    });

    it('should return false after key is deleted', () => {
      cache.set('key1', 'value1');
      cache.delete('key1');
      expect(cache.has('key1')).toBe(false);
    });
  });

  describe('delete', () => {
    beforeEach(() => {
      cache = new TTLCache(SHORT_TTL, SHORT_CLEANUP_INTERVAL);
    });

    it('should delete an existing key', () => {
      cache.set('key1', 'value1');
      const result = cache.delete('key1');

      expect(result).toBe(true);
      expect(cache.get('key1')).toBeUndefined();
    });

    it('should return false when deleting non-existent key', () => {
      const result = cache.delete('nonexistent');
      expect(result).toBe(false);
    });

    it('should not affect other keys when deleting', () => {
      cache.set('key1', 'value1');
      cache.set('key2', 'value2');

      cache.delete('key1');

      expect(cache.get('key1')).toBeUndefined();
      expect(cache.get('key2')).toBe('value2');
    });
  });

  describe('TTL expiration', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      cache = new TTLCache(SHORT_TTL, SHORT_CLEANUP_INTERVAL);
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('should return value before TTL expires', () => {
      cache.set('key1', 'value1');

      vi.advanceTimersByTime(SHORT_TTL - 10);

      expect(cache.get('key1')).toBe('value1');
    });

    it('should return undefined after TTL expires', () => {
      cache.set('key1', 'value1');

      vi.advanceTimersByTime(SHORT_TTL + 10);

      expect(cache.get('key1')).toBeUndefined();
    });

    it('should NOT extend TTL on get (read does not refresh)', () => {
      cache.set('key1', 'value1');

      // Advance time but not past TTL
      vi.advanceTimersByTime(SHORT_TTL - 20);

      // Access the key (should NOT extend TTL)
      expect(cache.get('key1')).toBe('value1');

      // Advance time past original TTL
      vi.advanceTimersByTime(SHORT_TTL - 20);

      // Should be expired — get does not refresh TTL
      expect(cache.get('key1')).toBeUndefined();
    });

    it('should expire all keys at their original TTL regardless of access', () => {
      cache.set('key1', 'value1');
      cache.set('key2', 'value2');

      // Advance time but not past TTL
      vi.advanceTimersByTime(SHORT_TTL - 20);

      // Access key1 only
      cache.get('key1');

      // Advance past original TTL
      vi.advanceTimersByTime(SHORT_TTL);

      // Both should be expired — get does not extend TTL
      expect(cache.get('key1')).toBeUndefined();
      expect(cache.get('key2')).toBeUndefined();
    });
  });

  describe('automatic cleanup', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('should run cleanup at specified interval', () => {
      // Mock sessionLogger to verify cleanup runs
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      cache = new TTLCache(SHORT_TTL, SHORT_CLEANUP_INTERVAL);

      cache.set('key1', 'value1');
      cache.set('key2', 'value2');

      // Advance past TTL so items are expired
      vi.advanceTimersByTime(SHORT_TTL + 10);

      // Advance to trigger cleanup
      vi.advanceTimersByTime(SHORT_CLEANUP_INTERVAL);

      // Entries should be removed
      expect(cache.has('key1')).toBe(false);
      expect(cache.has('key2')).toBe(false);

      logSpy.mockRestore();
    });

    it('should not affect unexpired entries during cleanup', () => {
      cache = new TTLCache(SHORT_TTL * 2, SHORT_CLEANUP_INTERVAL);

      cache.set('key1', 'value1');

      // Advance to trigger cleanup, but not past TTL
      vi.advanceTimersByTime(SHORT_CLEANUP_INTERVAL);

      // Entry should still be valid
      expect(cache.get('key1')).toBe('value1');
    });
  });

  describe('destroy', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('should clear the cleanup timer', () => {
      cache = new TTLCache(SHORT_TTL, SHORT_CLEANUP_INTERVAL);

      cache.set('key1', 'value1');
      cache.destroy();

      // 验证缓存被清空
      expect(cache.get('key1')).toBeUndefined();
    });

    it('should clear all entries', () => {
      cache = new TTLCache(SHORT_TTL, SHORT_CLEANUP_INTERVAL);

      cache.set('key1', 'value1');
      cache.set('key2', 'value2');
      cache.set('key3', 'value3');

      cache.destroy();

      expect(cache.get('key1')).toBeUndefined();
      expect(cache.get('key2')).toBeUndefined();
      expect(cache.get('key3')).toBeUndefined();
    });

    it('should be safe to call destroy multiple times', () => {
      cache = new TTLCache(SHORT_TTL, SHORT_CLEANUP_INTERVAL);

      cache.destroy();
      cache.destroy();
      cache.destroy();

      // Should not throw
      expect(true).toBe(true);
    });
  });

  describe('edge cases', () => {
    beforeEach(() => {
      cache = new TTLCache(SHORT_TTL, SHORT_CLEANUP_INTERVAL);
    });

    it('should handle setting the same key multiple times rapidly', () => {
      for (let i = 0; i < 100; i++) {
        cache.set('key', `value${i}`);
      }
      expect(cache.get('key')).toBe('value99');
    });

    it('should handle getting non-existent keys multiple times', () => {
      for (let i = 0; i < 100; i++) {
        expect(cache.get(`nonexistent${i}`)).toBeUndefined();
      }
    });

    it('should handle large number of keys', () => {
      for (let i = 0; i < 1000; i++) {
        cache.set(`key${i}`, `value${i}`);
      }

      for (let i = 0; i < 1000; i++) {
        expect(cache.get(`key${i}`)).toBe(`value${i}`);
      }
    });

    it('should handle has() checking for expired entries', async () => {
      vi.useFakeTimers();

      cache.set('key1', 'value1');

      vi.advanceTimersByTime(SHORT_TTL + 10);

      expect(cache.has('key1')).toBe(false);

      vi.useRealTimers();
    });
  });

  describe('concurrency simulation', () => {
    beforeEach(() => {
      cache = new TTLCache(1000, 500);
    });

    it('should handle interleaved set and get operations', () => {
      const results: string[] = [];

      cache.set('a', '1');
      results.push(cache.get('a') || 'undefined');

      cache.set('b', '2');
      results.push(cache.get('a') || 'undefined');
      results.push(cache.get('b') || 'undefined');

      cache.set('a', '3');
      results.push(cache.get('a') || 'undefined');

      cache.delete('b');
      results.push(cache.get('b') || 'undefined');

      expect(results).toEqual(['1', '1', '2', '3', 'undefined']);
    });

    it('should handle mixed operations in sequence', () => {
      cache.set('key', 'initial');
      expect(cache.has('key')).toBe(true);
      expect(cache.get('key')).toBe('initial');

      cache.set('key', 'updated');
      expect(cache.get('key')).toBe('updated');

      cache.delete('key');
      expect(cache.has('key')).toBe(false);
      expect(cache.get('key')).toBeUndefined();

      cache.set('key', 'recreated');
      expect(cache.get('key')).toBe('recreated');
    });
  });

  describe('TTL boundary conditions', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('should handle TTL of 0', () => {
      cache = new TTLCache(0, 1000);

      cache.set('key', 'value');

      // With TTL of 0, immediate access still works because
      // Date.now() - lastAccessed (0) is not > 0
      expect(cache.get('key')).toBe('value');

      // But after any time passes, it should expire
      vi.advanceTimersByTime(1);
      expect(cache.get('key')).toBeUndefined();
    });

    it('should handle very large TTL', () => {
      const largeTTL = Number.MAX_SAFE_INTEGER;
      cache = new TTLCache(largeTTL, 1000);

      cache.set('key', 'value');

      vi.advanceTimersByTime(1000000);

      expect(cache.get('key')).toBe('value');
    });

    it('should expire at exactly TTL boundary', () => {
      cache = new TTLCache(100, 1000);

      cache.set('key', 'value');

      // At exactly TTL, should still be valid
      vi.advanceTimersByTime(100);
      expect(cache.get('key')).toBe('value');

      // Just past TTL, should be expired
      cache.set('key2', 'value2');
      vi.advanceTimersByTime(101);
      expect(cache.get('key2')).toBeUndefined();
    });
  });
});
