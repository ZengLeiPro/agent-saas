/**
 * §3.3 端点 × act 矩阵的 Hono 参考适配器。
 *
 * 挂载 `/ky/v1/*` 与 `/ky-local/*` 的全部端点；业务路由由应用侧自行挂载并使用
 * `requireUser()`。错误统一按附录 D 输出，响应头按 §5.1。
 */
import { Hono, type Context } from 'hono';

import { HTTP_HEADERS } from '@kaiyan/ky-app-contract';

import { KyAppError } from '../errors.js';
import { buildHealthLive, buildHealthReady } from '../health/index.js';
import { errorResponder, requestContext } from './middleware.js';
import { createKyAppRuntime, type KyAppRuntime } from './runtime.js';
import { securityHeaders } from './securityHeaders.js';
import { registerTestRoutes } from './testRoutes.js';
import type { KyAppRouterConfig, KyAppVariables, KyRequestIdentity } from './types.js';

export type KyAppRouter = Hono<{ Variables: KyAppVariables }>;

/** `GET /ky/v1/attest`：每 nonce ≤ 5 次、每 IP ≤ 60 次/分钟（§3.3）。 */
const ATTEST_NONCE_MAX = 5;
const ATTEST_IP_LIMIT = { max: 60, windowMs: 60_000 } as const;

class Counter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
  ) {}

  take(key: string, nowMs: number): boolean {
    const recent = (this.hits.get(key) ?? []).filter((at) => nowMs - at < this.windowMs);
    if (recent.length >= this.max) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(nowMs);
    this.hits.set(key, recent);
    return true;
  }
}

function requireSat(identity: KyRequestIdentity): NonNullable<KyRequestIdentity['sat']> {
  if (identity.sat === undefined) {
    throw new KyAppError('forbidden', { message: '该端点只接受 SAT' });
  }
  return identity.sat;
}

/** 创建挂在 `/ky/v1/*` 与 `/ky-local/*` 上的路由。 */
export function createKyAppRouter(options: KyAppRouterConfig): {
  router: KyAppRouter;
  runtime: KyAppRuntime;
} {
  const runtime = createKyAppRuntime(options);
  const app = new Hono<{ Variables: KyAppVariables }>();
  const nonceCounter = new Counter(ATTEST_NONCE_MAX, 10 * 60_000);
  const attestIpCounter = new Counter(ATTEST_IP_LIMIT.max, ATTEST_IP_LIMIT.windowMs);

  app.use('*', securityHeaders());
  app.use('*', requestContext(runtime));
  app.onError((error, c) => errorResponder(c, error));
  app.notFound((c) => errorResponder(c, new KyAppError('not_found', { message: '端点不存在' })));

  /** 统一的验签入口：先查安装实例状态，再按矩阵验签。 */
  async function authenticate(
    c: Context<{ Variables: KyAppVariables }>,
    consumeJti = true,
  ): Promise<KyRequestIdentity> {
    const url = new URL(c.req.url);
    await runtime.assertInstallationUsable(url.pathname);
    const identity = await runtime.authenticate({
      method: c.req.method,
      pathname: url.pathname,
      authorization: c.req.header('authorization') ?? null,
      requestId: c.get('kyRequestId'),
      consumeJti,
    });
    c.set('kyIdentity', identity);
    return identity;
  }

  // ---- 公开行（§3.3）----

  app.get('/ky/v1/health/live', (c) => {
    const custom = options.health.live?.();
    if (custom !== undefined) return c.json(custom);
    return c.json(
      buildHealthLive({
        maintenance: options.health.maintenance?.() === true,
        ...(options.health.etaMinutes === undefined
          ? {}
          : { etaMinutes: options.health.etaMinutes() }),
      }),
    );
  });

  app.get('/ky/v1/attest', async (c) => {
    if (options.attestation === undefined) {
      throw new KyAppError('not_found', { message: '本部署未启用安装证明' });
    }
    const nonce = c.req.query('nonce');
    if (nonce === undefined || nonce === '') {
      throw new KyAppError('invalid_input', { message: '缺少 nonce' });
    }
    const nowMs = runtime.now();
    const ip = runtime.clientIp(c.req.raw.headers) ?? 'unknown';
    if (!attestIpCounter.take(ip, nowMs) || !nonceCounter.take(nonce, nowMs)) {
      throw new KyAppError('rate_limited', { message: '安装证明请求过于频繁' });
    }
    return c.json({ attestation: await options.attestation.issue(nonce) });
  });

  // ---- platform 行 ----

  app.get('/ky/v1/manifest', async (c) => {
    await authenticate(c);
    return c.json(options.manifest);
  });

  app.get('/ky/v1/health/ready', async (c) => {
    await authenticate(c);
    const ready = await buildHealthReady({
      appVersion: options.health.appVersion,
      manifestDigest: runtime.manifestDigest,
      installationState: await runtime.installationState(),
      maintenance: options.health.maintenance?.() === true,
      deps: {
        db: options.health.db ?? (() => true),
        executionStore: async () => {
          await options.capabilities.expireOverdue();
          return true;
        },
        jtiStore: async () => {
          // 用一个必然重复的探针 jti 验证存储可达：返回 true / false 都说明存储在线。
          await options.jtiStore.consume('__probe__', new Date(runtime.now() + 1000));
          return true;
        },
      },
      directorySync:
        options.directorySync ??
        (async () => ({ checkpoint: 0, ageSeconds: Number.MAX_SAFE_INTEGER })),
      jwksKids: () => runtime.jwks.kids(),
    });
    return c.json(ready);
  });

  app.post('/ky/v1/events', async (c) => {
    await authenticate(c);
    const ack = await options.events.handle(await c.req.json().catch(() => null));
    return c.json(ack);
  });

  // ---- user / local_* 行 ----

  app.get('/ky/v1/me', async (c) => {
    const identity = await authenticate(c);
    const me = await options.buildMe(identity);
    c.header(HTTP_HEADERS.permVersion, me.permVersion);
    return c.json(me);
  });

  // ---- agent 行 ----

  app.post('/ky/v1/capabilities/:capabilityId', async (c) => {
    // §3.1-6：`jti` 占用在鉴权与输入校验之后、执行之前，所以这里先不消费。
    const identity = await authenticate(c, false);
    const sat = requireSat(identity);
    const body = await c.req.json().catch(() => null);
    const response = await options.capabilities.invoke({
      capabilityId: c.req.param('capabilityId'),
      identity: sat,
      idempotencyKey: c.req.header(HTTP_HEADERS.idempotencyKey) ?? null,
      body,
    });
    return c.json(response);
  });

  app.get('/ky/v1/capabilities/:capabilityId/executions/:lcid', async (c) => {
    const identity = await authenticate(c);
    const sat = requireSat(identity);
    const result = await options.capabilities.queryExecution({
      capabilityId: c.req.param('capabilityId'),
      identity: sat,
      lcid: c.req.param('lcid'),
    });
    return c.json(result);
  });

  registerLocalRoutes(app, runtime);
  registerTestRoutes(app, runtime);

  return { router: app, runtime };
}

/** §3.3 / §3.5 `/ky-local/*`：`enable` 始终公开，其余兜底关闭时 404。 */
function registerLocalRoutes(app: KyAppRouter, runtime: KyAppRuntime): void {
  const options = runtime.options;

  function requireBreakGlass(): NonNullable<KyAppRouterConfig['breakGlass']> {
    if (options.breakGlass === undefined) {
      throw new KyAppError('not_found', { message: '本部署未启用兜底登录' });
    }
    return options.breakGlass;
  }

  // 兜底模式关闭时，除 `enable` 外的 /ky-local/* 一律 404（§3.3）。
  // 显式排除 enable，而不是靠路由注册顺序绕开，避免以后调整顺序就悄悄失效。
  app.use('/ky-local/*', async (c, next) => {
    const pathname = new URL(c.req.url).pathname;
    if (pathname !== '/ky-local/enable' && !(await runtime.localModeActive())) {
      throw new KyAppError('not_found', { message: '兜底模式未开启' });
    }
    await next();
  });

  app.post('/ky-local/enable', async (c) => {
    const breakGlass = requireBreakGlass();
    const body = (await c.req.json().catch(() => null)) as {
      sub?: unknown;
      password?: unknown;
      code?: unknown;
    } | null;
    if (
      body === null ||
      typeof body.sub !== 'string' ||
      typeof body.password !== 'string' ||
      typeof body.code !== 'string'
    ) {
      throw new KyAppError('invalid_input', { message: '需要 sub / password / code' });
    }
    const ip = runtime.clientIp(c.req.raw.headers);
    const result = await breakGlass.enable({
      sub: body.sub,
      password: body.password,
      code: body.code,
      ...(ip === undefined ? {} : { ip }),
    });
    return c.json(result);
  });

  app.post('/ky-local/login', async (c) => {
    const breakGlass = requireBreakGlass();
    const body = (await c.req.json().catch(() => null)) as {
      loginId?: unknown;
      code?: unknown;
    } | null;
    if (body === null || typeof body.loginId !== 'string' || typeof body.code !== 'string') {
      throw new KyAppError('invalid_input', { message: '需要 loginId / code' });
    }
    const ip = runtime.clientIp(c.req.raw.headers);
    return c.json(
      await breakGlass.login({
        loginId: body.loginId,
        code: body.code,
        ...(ip === undefined ? {} : { ip }),
      }),
    );
  });

  app.get('/ky-local/status', async (c) => {
    const session = await requireBreakGlass().session();
    return c.json({ active: session !== null, session });
  });

  app.post('/ky-local/employee-code', async (c) => {
    const breakGlass = requireBreakGlass();
    const identity = await runtime.authenticate({
      method: c.req.method,
      pathname: new URL(c.req.url).pathname,
      authorization: c.req.header('authorization') ?? null,
      requestId: c.get('kyRequestId'),
    });
    if (identity.act !== 'local_admin') {
      throw new KyAppError('forbidden', { message: '只有 local_admin 能签发员工恢复码' });
    }
    c.set('kyIdentity', identity);
    const body = (await c.req.json().catch(() => null)) as {
      loginId?: unknown;
      sub?: unknown;
    } | null;
    if (body === null || typeof body.loginId !== 'string' || typeof body.sub !== 'string') {
      throw new KyAppError('invalid_input', { message: '需要 loginId / sub' });
    }
    return c.json(await breakGlass.issueEmployeeCode({ loginId: body.loginId, sub: body.sub }));
  });

  app.post('/ky-local/disable', async (c) => {
    const breakGlass = requireBreakGlass();
    const identity = await runtime.authenticate({
      method: c.req.method,
      pathname: new URL(c.req.url).pathname,
      authorization: c.req.header('authorization') ?? null,
      requestId: c.get('kyRequestId'),
    });
    if (identity.act !== 'local_admin') {
      throw new KyAppError('forbidden', { message: '只有 local_admin 能关闭兜底模式' });
    }
    await breakGlass.disable();
    return c.json({ ok: true });
  });
}
