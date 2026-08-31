import type pg from 'pg';
import { describe, expect, it } from 'vitest';

import {
  effectiveMaxConcurrentRuns,
  PgRuntimeSchedulerConfigStore,
} from '../runtime/runtimeSchedulerConfigStore.js';

class FakePool {
  maxConcurrentRuns: number | null = null;
  updatedAt = new Date('2026-07-27T14:00:00.000Z');
  updatedBy: string | null = null;
  executionEnabled = true;
  maintenanceReason: string | null = null;
  queries: string[] = [];
  released = 0;

  async connect(): Promise<pg.PoolClient> {
    return {
      query: async <T>(sql: string, params: unknown[] = []) => {
        this.queries.push(sql);
        if (sql.includes('INSERT INTO') && this.maxConcurrentRuns === null) {
          this.maxConcurrentRuns = Number(params[0]);
          this.updatedBy = 'bootstrap';
        }
        return { rows: [] as T[] };
      },
      release: () => {
        this.released += 1;
      },
    } as unknown as pg.PoolClient;
  }

  async query<T>(sql: string, params: unknown[] = []): Promise<{ rows: T[] }> {
    this.queries.push(sql);
    if (sql.includes('UPDATE')) {
      if (sql.includes('SET execution_enabled')) {
        this.executionEnabled = Boolean(params[0]);
        this.maintenanceReason = params[1] ? String(params[1]) : null;
        this.updatedBy = String(params[2]);
      } else {
        this.maxConcurrentRuns = Number(params[0]);
        this.updatedBy = String(params[1]);
      }
      this.updatedAt = new Date('2026-07-27T14:30:00.000Z');
    }
    if (sql.includes('SELECT') || sql.includes('RETURNING')) {
      if (this.maxConcurrentRuns === null) return { rows: [] };
      return {
        rows: [{
          max_concurrent_runs: this.maxConcurrentRuns,
          execution_enabled: this.executionEnabled,
          maintenance_reason: this.maintenanceReason,
          updated_at: this.updatedAt,
          updated_by: this.updatedBy,
        }] as T[],
      };
    }
    return { rows: [] };
  }
}

describe('PgRuntimeSchedulerConfigStore shared capacity', () => {
  it('初始化共享配置表并保留期望并发值', async () => {
    const pool = new FakePool();
    const store = new PgRuntimeSchedulerConfigStore(pool as unknown as pg.Pool, {
      tablePrefix: 'tenant_runtime',
      maxConfigurableConcurrentRuns: 64,
    });

    await store.init(16);

    expect(store.table).toBe('tenant_runtime_scheduler_config');
    expect(pool.maxConcurrentRuns).toBe(16);
    expect(pool.queries.some((sql) => sql.includes('CREATE TABLE IF NOT EXISTS tenant_runtime_scheduler_config'))).toBe(true);
    expect(pool.released).toBe(1);
    await expect(store.get()).resolves.toMatchObject({
      maxConcurrentRuns: 16,
      updatedBy: 'bootstrap',
    });
  });

  it('持久化管理员热更新并执行部署安全上限', async () => {
    const pool = new FakePool();
    const store = new PgRuntimeSchedulerConfigStore(pool as unknown as pg.Pool, {
      maxConfigurableConcurrentRuns: 32,
    });
    await store.init(16);

    await expect(store.update(24, 'admin')).resolves.toEqual({
      maxConcurrentRuns: 24,
      executionEnabled: true,
      updatedAt: '2026-07-27T14:30:00.000Z',
      updatedBy: 'admin',
    });
    await expect(store.update(33, 'admin')).rejects.toThrow('部署安全上限 32');
    await expect(store.update(0, 'admin')).rejects.toThrow('正整数');

    pool.maxConcurrentRuns = 33;
    await expect(store.get()).rejects.toThrow('PG 中的 maxConcurrentRuns 33 超过部署安全上限 32');
  });

  it('persists the shared execution maintenance switch', async () => {
    const pool = new FakePool();
    const store = new PgRuntimeSchedulerConfigStore(pool as unknown as pg.Pool);
    await store.init(16);
    expect(store.maxConfigurableConcurrentRuns).toBe(500);

    await expect(store.updateExecutionMaintenance(false, 'ACS emergency maintenance', 'admin')).resolves.toMatchObject({
      executionEnabled: false,
      maintenanceReason: 'ACS emergency maintenance',
      updatedBy: 'admin',
    });
    await expect(store.updateExecutionMaintenance(true, undefined, 'admin')).resolves.toMatchObject({
      executionEnabled: true,
      updatedBy: 'admin',
    });
    await expect(store.get()).resolves.not.toHaveProperty('maintenanceReason');
  });

  it('dual 只钳制有效值，不覆盖 PG 中的期望值', () => {
    expect(effectiveMaxConcurrentRuns(16, 'dual')).toBe(4);
    expect(effectiveMaxConcurrentRuns(2, 'dual')).toBe(2);
    expect(effectiveMaxConcurrentRuns(16, 'lease')).toBe(16);
  });
});
