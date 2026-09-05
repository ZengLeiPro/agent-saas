/**
 * 页面接口。`pathPrefixes.user` = `/api/app/`，`pathPrefixes.admin` = `/api/admin/`，
 * 与 manifest 声明、与路由守卫同源（§9.2）。
 *
 * 每个 handler 都只调 service，不重复实现查询；鉴权由 `requireUser()` +
 * service 内的 `requirePermission()` 两层完成（菜单不可见 ≠ 接口不可达）。
 */
import type { Hono } from 'hono';
import type { Pool } from 'pg';

import { KyAppError, type CapabilityContext } from '@kaiyan/ky-app-server';
import {
  requireIdentity,
  requireUser,
  type KyAppRuntime,
  type KyAppVariables,
  type KyRequestIdentity,
} from '@kaiyan/ky-app-server/hono';

import { ASSIGNABLE_ROLES, PERMISSIONS } from '../permissions.js';
import { createOrder, listOrdersForPage, requirePermission } from '../services/orders.service.js';
import { getUserRoles, listUserRoles, setUserRoles } from '../services/users.service.js';

export interface PageApiDeps {
  pool: Pool;
  runtime: KyAppRuntime;
  tenantId: string;
  installationId: string;
  /** 与能力 handler 共用同一个 `ctx` 构造逻辑。 */
  contextFor: (identity: KyRequestIdentity) => Promise<CapabilityContext>;
}

export function registerPageApi(app: Hono<{ Variables: KyAppVariables }>, deps: PageApiDeps): void {
  app.use('/api/app/*', requireUser(deps.runtime));
  app.use('/api/admin/*', requireUser(deps.runtime));

  app.get('/api/app/orders', async (c) => {
    const ctx = await deps.contextFor(requireIdentity(c));
    const limitRaw = c.req.query('limit');
    const limit = limitRaw === undefined ? undefined : Number.parseInt(limitRaw, 10);
    const result = await listOrdersForPage(deps.pool, ctx, {
      keyword: c.req.query('keyword') ?? '',
      ...(limit === undefined || !Number.isInteger(limit) ? {} : { limit }),
    });
    return c.json(result);
  });

  app.post('/api/app/orders', async (c) => {
    const ctx = await deps.contextFor(requireIdentity(c));
    const body = (await c.req.json().catch(() => null)) as {
      customerId?: unknown;
      lines?: unknown;
    } | null;
    if (body === null || typeof body.customerId !== 'string' || !Array.isArray(body.lines)) {
      throw new KyAppError('invalid_input', { message: '需要 customerId 与 lines[]' });
    }
    return c.json(
      await createOrder(deps.pool, ctx, {
        customerId: body.customerId,
        lines: body.lines as Array<{ sku: string; qty: number }>,
      }),
    );
  });

  app.get('/api/admin/roles', async (c) => {
    const ctx = await deps.contextFor(requireIdentity(c));
    requirePermission(ctx, PERMISSIONS.rolesManage);
    return c.json({
      assignableRoles: [...ASSIGNABLE_ROLES],
      users: await listUserRoles(deps.pool, {
        tenantId: deps.tenantId,
        installationId: deps.installationId,
      }),
    });
  });

  app.post('/api/admin/roles', async (c) => {
    const ctx = await deps.contextFor(requireIdentity(c));
    requirePermission(ctx, PERMISSIONS.rolesManage);
    const body = (await c.req.json().catch(() => null)) as {
      sub?: unknown;
      roles?: unknown;
    } | null;
    if (
      body === null ||
      typeof body.sub !== 'string' ||
      !Array.isArray(body.roles) ||
      body.roles.some((role) => typeof role !== 'string')
    ) {
      throw new KyAppError('invalid_input', { message: '需要 sub 与 roles[]' });
    }
    const allowed = (body.roles as string[]).filter((role) =>
      (ASSIGNABLE_ROLES as readonly string[]).includes(role),
    );
    const key = { tenantId: deps.tenantId, installationId: deps.installationId, sub: body.sub };
    await setUserRoles(deps.pool, key, allowed);
    return c.json({ sub: body.sub, roles: await getUserRoles(deps.pool, key) });
  });
}
