import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { manifestDigest, type InstallationBinding, type Manifest } from '@kaiyan/ky-app-contract';
import {
  InstallationRuntimeManager,
  JwksPlatformKeyResolver,
  PgEncryptedDeploymentKeyStore,
  PgEncryptedEphemeralSecretStore,
  PgEnrollmentAttemptStore,
  PgInstallationBindingProvider,
  PgJtiStore,
  SatPlatformChallengeVerifier,
  V2EnrollmentService,
  KyAppWorkloadClient,
  createJwksClient,
  type KyAppConfig,
} from '@kaiyan/ky-app-server';
import { createKyAppV2Router } from '@kaiyan/ky-app-server/hono';
import { verify } from '@node-rs/argon2';
import { Hono } from 'hono';
import type { Pool } from 'pg';

import { createOrder, searchOrders, type Ctx } from './services/orders.service.js';
import { createPool, runMigrations, waitForDatabase } from './db.js';
import { serveWebDist } from './static.js';
import { webDistDir } from './paths.js';
import type { AppConfig } from './config.js';
import { buildApp, type BuiltApp } from './app.js';
import { projectRoot } from './paths.js';

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

  let activeAdapter: BuiltApp | null = null;
  let v2Bindings: PgInstallationBindingProvider | null = null;
  if (config.integration.enabled) {
    if (!config.deploymentEncryptionKey) throw new Error('部署密钥加密配置缺失');
    const integration = config.integration;
    if (
      !integration.env ||
      !integration.systemId ||
      !integration.origin ||
      !integration.platformIssuer ||
      !integration.platformApiBaseUrl
    ) {
      throw new Error('自动接入配置不完整');
    }
    const {
      env: integrationEnv,
      systemId,
      origin,
      platformIssuer,
      platformApiBaseUrl,
    } = integration;
    const manifest = JSON.parse(
      await readFile(join(projectRoot(), 'ky-app.manifest.json'), 'utf8'),
    ) as Manifest;
    const digest = manifestDigest(manifest);
    const jwksUrl = `${platformApiBaseUrl}/.well-known/ky-app-jwks.json`;
    const jwks = createJwksClient({ url: jwksUrl });
    const platformKeys = new JwksPlatformKeyResolver(jwks);
    const jtiStore = new PgJtiStore(pool);
    const keys = new PgEncryptedDeploymentKeyStore(pool, config.deploymentEncryptionKey);
    const bindings = new PgInstallationBindingProvider(pool);
    v2Bindings = bindings;
    const workload = new KyAppWorkloadClient({ keys, platformKeys });
    const runtimeManager = new InstallationRuntimeManager(bindings, async (binding) => {
      const ky: KyAppConfig = {
        env: integrationEnv,
        systemId: binding.systemId,
        tenantId: binding.tenantId,
        installationId: binding.installationId,
        origin: binding.origin,
        serviceCredential: 'v2-not-used',
        issuer: binding.platformIssuer,
        jwksUrl,
        installationKey: new Uint8Array(32),
        installationKeyVersion: 'v2-not-used',
        localLoginEnabled: false,
      };
      const built = await buildApp(
        { ...config, ky, directoryUrl: binding.platformApiBaseUrl },
        { binding, workload },
      );
      await built.directory.sync();
      return {
        validate: async () => {
          const response = await built.app.request('/ky/v2/health/live');
          if (!response.ok) throw new Error('adapter_health_validation_failed');
        },
        start: async () => {
          activeAdapter = built;
        },
        drain: async () => {
          if (activeAdapter === built) activeAdapter = null;
          await built.close();
        },
      };
    });
    const enrollment = new V2EnrollmentService({
      enabled: async () => {
        const result = await pool.query<{ allowed: boolean }>(
          'SELECT allowed FROM demo_agent_integration WHERE id=1',
        );
        return result.rows[0]?.allowed === true;
      },
      systemId,
      origin,
      platformIssuer,
      platformApiBaseUrl,
      keys,
      attempts: new PgEnrollmentAttemptStore(pool),
      secrets: new PgEncryptedEphemeralSecretStore(pool, config.deploymentEncryptionKey),
      verifier: new SatPlatformChallengeVerifier({ jwks, jtiStore }),
      platformKeys,
      runtimes: runtimeManager,
      activation: { appVersion: '0.1.0', manifestDigest: digest },
    });
    app.route(
      '/',
      createKyAppV2Router({
        enabled: true,
        enrollment,
        bindings,
        keys,
        manifestDigest: digest,
        authorizeStatus: async () => false,
      }),
    );
    // 进程重启时从共享绑定恢复运行时；新增绑定则由 callback 在当前进程热装配。
    for (const binding of await bindings.list()) {
      if (binding.state === 'connected' || binding.state === 'activating') {
        await runtimeManager.install(binding);
      }
    }
  }

  app.get('/health/live', (c) => c.json({ ok: true, mode: 'standalone' }));
  if (!config.integration.enabled) {
    app.get('/ky/v2/health/live', (c) => c.json({ ok: true, integration: 'disabled' }));
  }
  app.all('/ky/v1/*', (c) =>
    activeAdapter
      ? activeAdapter.app.fetch(c.req.raw)
      : c.json({ ok: false, error: { code: 'installation_inactive' } }, 503),
  );
  app.all('/ky/v2/*', (c) =>
    activeAdapter
      ? activeAdapter.app.fetch(c.req.raw)
      : c.json({ ok: false, error: { code: 'installation_inactive' } }, 503),
  );
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
    const bindings = await v2Bindings?.list();
    return c.json({
      allowed: result.rows[0]?.allowed ?? false,
      runtime: activeAdapter ? 'connected' : 'unbound',
      organizations:
        bindings?.map((binding: InstallationBinding) => ({
          organizationId: binding.tenantId,
          installationId: binding.installationId,
          state: binding.state,
        })) ?? [],
    });
  });
  app.post('/api/admin/integration', async (c) => {
    const body = (await c.req.json()) as { allowed?: unknown };
    if (typeof body.allowed !== 'boolean') return c.json({ error: 'allowed 必须是布尔值' }, 400);
    await pool.query('UPDATE demo_agent_integration SET allowed=$1,updated_at=now() WHERE id=1', [
      body.allowed,
    ]);
    return c.json({ allowed: body.allowed, runtime: activeAdapter ? 'connected' : 'unbound' });
  });
  app.get('*', serveWebDist(webDistDir()));
  return {
    app,
    close: async () => {
      await activeAdapter?.close();
      await pool.end();
    },
  };
}
