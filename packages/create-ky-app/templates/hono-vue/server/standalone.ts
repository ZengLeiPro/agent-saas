import { createHash, randomBytes } from 'node:crypto';

import { verify } from '@node-rs/argon2';
import { Hono } from 'hono';
import type { Pool } from 'pg';

import { createOrder, searchOrders, type Ctx } from './services/orders.service.js';
import { createPool, runMigrations, waitForDatabase } from './db.js';
import { serveWebDist } from './static.js';
import { webDistDir } from './paths.js';
import type { AppConfig } from './config.js';

const SESSION_SECONDS = 8 * 60 * 60;
const hash = (value: string): string => createHash('sha256').update(value).digest('hex');

async function user(pool: Pool, cookie: string | undefined): Promise<string | null> {
  const token = /(?:^|;\s*)business_session=([^;]+)/u.exec(cookie ?? '')?.[1];
  if (!token) return null;
  const result = await pool.query<{ user_id: string }>(
    `SELECT user_id FROM demo_local_session WHERE token_sha256=$1 AND expires_at>now()`,
    [hash(token)],
  );
  return result.rows[0]?.user_id ?? null;
}

const context = (userId: string): Ctx => ({
  userId,
  roles: ['admin', 'operator'],
  isTenantAdmin: true,
  tenantId: 'standalone',
  installationId: 'standalone',
  dataScope: { groupIds: [] },
});

export async function buildStandaloneApp(config: AppConfig) {
  const pool = createPool(config.databaseUrl);
  await waitForDatabase(pool);
  await runMigrations(pool);
  const app = new Hono<{ Variables: { businessUserId: string } }>();

  app.get('/health/live', (c) => c.json({ ok: true, mode: 'standalone' }));
  app.get('/ky/v2/health/live', (c) =>
    c.json({ ok: true, integration: config.integration.enabled ? 'unbound' : 'disabled' }),
  );
  app.post('/ky/v2/enrollment/challenge', async (c) => {
    if (!config.integration.enabled) return c.json({ error: '接入未开启' }, 404);
    if (!c.req.header('authorization')?.startsWith('Bearer ')) {
      return c.json({ error: '缺少平台证明' }, 401);
    }
    return c.json({ error: '部署身份提供方尚未装配' }, 503);
  });
  app.get('/ky/v2/enrollment/callback', (c) =>
    c.req.query('code') && c.req.query('state')
      ? c.json({ error: '没有待处理的授权' }, 404)
      : c.json({ error: '缺少 code/state' }, 400),
  );
  app.get('/ky/v2/attest', (c) => c.json({ error: '没有有效组织绑定' }, 404));
  app.post('/api/local/login', async (c) => {
    const body = (await c.req.json().catch(() => null)) as {
      loginId?: string;
      password?: string;
    } | null;
    if (!body?.loginId || !body.password) return c.json({ ok: false }, 400);
    const result = await pool.query<{ password_hash: string }>(
      'SELECT password_hash FROM demo_local_user WHERE user_id=$1 AND enabled=true',
      [body.loginId],
    );
    if (!result.rows[0] || !(await verify(result.rows[0].password_hash, body.password))) {
      return c.json({ ok: false }, 401);
    }
    const token = randomBytes(32).toString('base64url');
    await pool.query(
      `INSERT INTO demo_local_session(token_sha256,user_id,expires_at)
       VALUES($1,$2,now()+($3 || ' seconds')::interval)`,
      [hash(token), body.loginId, SESSION_SECONDS],
    );
    c.header(
      'set-cookie',
      `business_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_SECONDS}`,
    );
    return c.json({ ok: true });
  });

  app.use('/api/*', async (c, next) => {
    if (c.req.path === '/api/local/login') return next();
    const userId = await user(pool, c.req.header('cookie'));
    if (!userId) return c.json({ error: '请先登录业务系统' }, 401);
    c.set('businessUserId', userId);
    return next();
  });

  app.get('/api/local/me', async (c) =>
    c.json({ userId: c.get('businessUserId'), roles: ['admin', 'operator'] }),
  );
  app.get('/api/app/orders', async (c) =>
    c.json(
      await searchOrders(pool, context(c.get('businessUserId')), {
        keyword: c.req.query('keyword') ?? '',
        limit: 10,
      }),
    ),
  );
  app.post('/api/app/orders', async (c) => {
    const body = (await c.req.json()) as {
      customerId: string;
      lines: Array<{ sku: string; qty: number }>;
    };
    return c.json(await createOrder(pool, context(c.get('businessUserId')), body));
  });
  app.get('/api/admin/integration', async (c) => {
    const result = await pool.query<{ allowed: boolean }>(
      'SELECT allowed FROM demo_agent_integration WHERE id=1',
    );
    return c.json({ allowed: result.rows[0]?.allowed ?? false, runtime: 'unbound' });
  });
  app.post('/api/admin/integration', async (c) => {
    const body = (await c.req.json()) as { allowed?: unknown };
    if (typeof body.allowed !== 'boolean') return c.json({ error: 'allowed 必须是布尔值' }, 400);
    await pool.query('UPDATE demo_agent_integration SET allowed=$1,updated_at=now() WHERE id=1', [
      body.allowed,
    ]);
    return c.json({ allowed: body.allowed, runtime: 'unbound' });
  });
  app.get('*', serveWebDist(webDistDir()));
  return { app, close: async () => pool.end() };
}
