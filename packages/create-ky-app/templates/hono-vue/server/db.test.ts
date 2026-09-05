/** 数据库首连重试：只重试连接类错误，次数有限，运行期错误不吞。 */
import { describe, expect, it } from 'vitest';
import type { Pool } from 'pg';

import { DB_CONNECT_RETRIES, isConnectionError, waitForDatabase } from './db.js';

/** 一个按脚本依次抛错 / 成功的假连接池。 */
function fakePool(outcomes: (Error | null)[]): { pool: Pool; calls: () => number } {
  let index = 0;
  const pool = {
    query: async (): Promise<unknown> => {
      const outcome = outcomes[Math.min(index, outcomes.length - 1)];
      index += 1;
      if (outcome !== null) throw outcome;
      return { rows: [] };
    },
  } as unknown as Pool;
  return { pool, calls: () => index };
}

function pgError(message: string, code?: string): Error {
  const error = new Error(message);
  if (code !== undefined) Object.assign(error, { code });
  return error;
}

describe('isConnectionError', () => {
  it('认得容器刚起时的几种错误', () => {
    expect(isConnectionError(pgError('read ECONNRESET', 'ECONNRESET'))).toBe(true);
    expect(isConnectionError(pgError('connect ECONNREFUSED 127.0.0.1:5433', 'ECONNREFUSED'))).toBe(
      true,
    );
    expect(isConnectionError(pgError('Connection terminated unexpectedly'))).toBe(true);
    expect(isConnectionError(pgError('the database system is starting up', '57P03'))).toBe(true);
  });

  it('运行期的正常错误不算连接错误', () => {
    expect(isConnectionError(pgError('relation "orders" does not exist', '42P01'))).toBe(false);
    expect(
      isConnectionError(pgError('duplicate key value violates unique constraint', '23505')),
    ).toBe(false);
    expect(isConnectionError('boom')).toBe(false);
  });
});

describe('waitForDatabase', () => {
  it('连接类错误重试后成功，并打印中文重试日志', async () => {
    const lines: string[] = [];
    const { pool, calls } = fakePool([
      pgError('read ECONNRESET', 'ECONNRESET'),
      pgError('the database system is starting up', '57P03'),
      null,
    ]);
    await waitForDatabase(pool, { intervalMs: 1, log: (line) => lines.push(line) });
    expect(calls()).toBe(3);
    expect(lines[0]).toContain('数据库暂时连不上');
    expect(lines.at(-1)).toContain('数据库连接成功（第 3 次尝试）');
  });

  it('非连接类错误立刻抛出，不重试', async () => {
    const { pool, calls } = fakePool([pgError('permission denied for schema public', '42501')]);
    await expect(waitForDatabase(pool, { intervalMs: 1, log: () => undefined })).rejects.toThrow(
      'permission denied',
    );
    expect(calls()).toBe(1);
  });

  it('一直连不上时按上限次数放弃并抛原始错误', async () => {
    const { pool, calls } = fakePool([pgError('read ECONNRESET', 'ECONNRESET')]);
    await expect(waitForDatabase(pool, { intervalMs: 1, log: () => undefined })).rejects.toThrow(
      'ECONNRESET',
    );
    expect(calls()).toBe(DB_CONNECT_RETRIES + 1);
  });
});
