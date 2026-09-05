/** service 层最小业务测试：权限判定、分页与查询参数拼装。 */
import { describe, expect, it } from 'vitest';

import type { Pool } from 'pg';

import { PERMISSIONS } from '../permissions.js';
import {
  MAX_PAGE_SIZE,
  cancelOrders,
  requirePermission,
  searchOrders,
  type Ctx,
} from './orders.service.js';

/** 只记录 SQL 与参数、按脚本返回结果的假连接池。 */
function fakePool(rows: Array<Record<string, unknown>>): {
  pool: Pool;
  calls: Array<{ text: string; values: unknown[] }>;
} {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  const pool = {
    query: async (text: string, values: unknown[] = []) => {
      calls.push({ text, values });
      return { rows, rowCount: rows.length };
    },
  } as unknown as Pool;
  return { pool, calls };
}

function ctx(roles: string[], isTenantAdmin = false): Ctx {
  return {
    tenantId: 't_demo',
    installationId: 'tsi_demo',
    userId: 'u_1',
    roles,
    isTenantAdmin,
    dataScope: { groupIds: ['g1'] },
  };
}

describe('requirePermission', () => {
  it('有角色对应的权限点即放行', () => {
    expect(() => requirePermission(ctx(['sales']), PERMISSIONS.ordersRead)).not.toThrow();
  });

  it('无业务角色的用户一律 403（§9.3-8）', () => {
    expect(() => requirePermission(ctx([]), PERMISSIONS.ordersRead)).toThrow('缺少权限');
  });

  it('viewer 只读，不能写', () => {
    expect(() => requirePermission(ctx(['viewer']), PERMISSIONS.ordersRead)).not.toThrow();
    expect(() => requirePermission(ctx(['viewer']), PERMISSIONS.ordersWrite)).toThrow();
  });

  it('组织管理员即使没有业务角色也拿到 adminRole 的权限', () => {
    expect(() => requirePermission(ctx([], true), PERMISSIONS.rolesManage)).not.toThrow();
  });
});

describe('searchOrders', () => {
  it('把行映射成契约 outputSchema 的形状', async () => {
    const { pool } = fakePool([
      { order_id: 'SO-1', customer: 'C-DEMO', amount: '12.50', status: 'draft' },
    ]);
    const result = await searchOrders(pool, ctx(['sales']), { keyword: 'C-DEMO' });
    expect(result).toEqual({
      items: [{ orderId: 'SO-1', customer: 'C-DEMO', amount: 12.5, status: 'draft' }],
      hasMore: false,
    });
  });

  it('多取一条判断 hasMore，并给出 nextCursor', async () => {
    const rows = Array.from({ length: 3 }, (_unused, index) => ({
      order_id: `SO-${String(index + 1)}`,
      customer: 'C-DEMO',
      amount: '1',
      status: 'draft',
    }));
    const { pool, calls } = fakePool(rows);
    const result = await searchOrders(pool, ctx(['sales']), { keyword: 'C-DEMO', limit: 2 });
    expect(calls[0].values).toEqual(['%C-DEMO%', '', 3]);
    expect(result.items).toHaveLength(2);
    expect(result.hasMore).toBe(true);
    expect(result.nextCursor).toBe('SO-2');
  });

  it('limit 被夹在 1 与页上限之间', async () => {
    const { pool, calls } = fakePool([]);
    await searchOrders(pool, ctx(['sales']), { keyword: 'x', limit: 999 });
    await searchOrders(pool, ctx(['sales']), { keyword: 'x', limit: 0 });
    expect(calls[0].values[2]).toBe(MAX_PAGE_SIZE + 1);
    expect(calls[1].values[2]).toBe(2);
  });

  it('cursor 参与查询（keyset 分页）', async () => {
    const { pool, calls } = fakePool([]);
    await searchOrders(pool, ctx(['sales']), { keyword: 'x', cursor: 'SO-9' });
    expect(calls[0].values[1]).toBe('SO-9');
  });
});

describe('cancelOrders', () => {
  it('返回本次取消条数，重复调用同样可用（夹具清理要幂等）', async () => {
    const { pool, calls } = fakePool([]);
    expect(await cancelOrders(pool, ctx(['sales']), { customerId: 'C-DOCTOR' })).toEqual({
      cancelled: 0,
    });
    expect(calls[0].values).toEqual(['C-DOCTOR']);
  });

  it('无写权限时 403', async () => {
    const { pool } = fakePool([]);
    await expect(cancelOrders(pool, ctx(['viewer']), { customerId: 'C' })).rejects.toThrow(
      '缺少权限',
    );
  });
});
