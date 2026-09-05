/**
 * 订单 service —— §9.2 强制范式第 2/3 条的落点。
 *
 * **页面 API 与能力 handler 都只调这里的函数**，查询逻辑只有这一份；
 * 首参 `ctx` 由验签中间件构造，service 自己不碰 HTTP、不读 claims。
 */
import type { Pool } from 'pg';

import type { CapabilityContext } from '@kaiyan/ky-app-server';
import { KyAppError } from '@kaiyan/ky-app-server';

import { PERMISSIONS, permissionsFor } from '../permissions.js';

/** 与契约里的 `ctx` 同形（§9.2）。 */
export type Ctx = CapabilityContext;

export interface OrderSummary {
  orderId: string;
  customer: string;
  amount: number;
  status: string;
}

export interface SearchInput {
  keyword: string;
  limit?: number;
  cursor?: string;
}

export interface SearchResult {
  items: OrderSummary[];
  hasMore: boolean;
  nextCursor?: string;
}

export interface CreateInput {
  customerId: string;
  lines: Array<{ sku: string; qty: number }>;
}

export interface CancelInput {
  customerId: string;
}

/** 能力返回上限（§4.3 响应体 ≤ 6,000 字节，这里再收一道分页上限）。 */
export const MAX_PAGE_SIZE = 10;

/** §9.2：无权限一律 403，菜单不可见不代表接口不可达。 */
export function requirePermission(ctx: Ctx, permission: string): void {
  const granted = permissionsFor(ctx.roles, ctx.isTenantAdmin);
  if (!granted.has(permission)) {
    throw new KyAppError('forbidden', {
      message: `用户 ${ctx.userId} 缺少权限 ${permission}`,
    });
  }
}

function toSummary(row: {
  order_id: string;
  customer: string;
  amount: string | number;
  status: string;
}): OrderSummary {
  return {
    orderId: row.order_id,
    customer: row.customer,
    amount: Number(row.amount),
    status: row.status,
  };
}

/** 按客户名或订单号查询；`cursor` 是上一页最后一个 `orderId`。 */
export async function searchOrders(
  pool: Pool,
  ctx: Ctx,
  input: SearchInput,
): Promise<SearchResult> {
  requirePermission(ctx, PERMISSIONS.ordersRead);
  const limit = Math.min(Math.max(input.limit ?? MAX_PAGE_SIZE, 1), MAX_PAGE_SIZE);
  const cursor = input.cursor ?? '';
  const { rows } = await pool.query<{
    order_id: string;
    customer: string;
    amount: string;
    status: string;
  }>(
    `SELECT order_id, customer, amount, status
       FROM demo_orders
      WHERE (customer ILIKE $1 OR order_id ILIKE $1)
        AND ($2 = '' OR order_id > $2)
      ORDER BY order_id
      LIMIT $3`,
    [`%${input.keyword}%`, cursor, limit + 1],
  );
  const page = rows.slice(0, limit).map(toSummary);
  const hasMore = rows.length > limit;
  return {
    items: page,
    hasMore,
    ...(hasMore && page.length > 0 ? { nextCursor: page[page.length - 1].orderId } : {}),
  };
}

/** 创建订单草稿。写操作，需要 `orders.write`。 */
export async function createOrder(
  pool: Pool,
  ctx: Ctx,
  input: CreateInput,
): Promise<{ orderId: string }> {
  requirePermission(ctx, PERMISSIONS.ordersWrite);
  const amount = input.lines.reduce((total, line) => total + line.qty * 100, 0);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query<{ order_id: string }>(
      `INSERT INTO demo_orders (order_id, customer, amount, status, created_by)
       VALUES ('SO-' || to_char(clock_timestamp(), 'YYYYMMDDHH24MISSMS') || '-' ||
               lpad((floor(random() * 1000))::int::text, 3, '0'), $1, $2, 'draft', $3)
       RETURNING order_id`,
      [input.customerId, amount, ctx.userId],
    );
    const orderId = rows[0].order_id;
    for (const [index, line] of input.lines.entries()) {
      await client.query(
        'INSERT INTO demo_order_line (order_id, line_no, sku, qty) VALUES ($1, $2, $3, $4)',
        [orderId, index + 1, line.sku, line.qty],
      );
    }
    await client.query('COMMIT');
    return { orderId };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/**
 * 取消某个客户名下所有未取消的订单。
 * 一致性测试的夹具清理钩子用的就是它，因此必须幂等（重复调用返回同样的结构）。
 */
export async function cancelOrders(
  pool: Pool,
  ctx: Ctx,
  input: CancelInput,
): Promise<{ cancelled: number }> {
  requirePermission(ctx, PERMISSIONS.ordersWrite);
  const { rowCount } = await pool.query(
    `UPDATE demo_orders SET status = 'cancelled'
      WHERE customer = $1 AND status <> 'cancelled'`,
    [input.customerId],
  );
  return { cancelled: rowCount ?? 0 };
}

/** 页面接口 `GET /api/app/orders` 用的列表：与 `order.search` 同一条查询。 */
export async function listOrdersForPage(
  pool: Pool,
  ctx: Ctx,
  query: { keyword?: string; limit?: number },
): Promise<SearchResult> {
  return searchOrders(pool, ctx, {
    keyword: query.keyword ?? '',
    ...(query.limit === undefined ? {} : { limit: query.limit }),
  });
}
