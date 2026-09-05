# @kaiyan/ky-app-server

定制项目服务端 SDK。实现《开沿定制项目与 KY Agent 衔接契约》的 §3（身份）、§4（接口）、
§5.1（响应头）、§6.5（错误码）线协议；契约类型、JSON Schema、JCS/`aph`、路径规范化、
claims 与端点矩阵全部复用 `@kaiyan/ky-app-contract`，本包不重复实现。

```
pnpm add @kaiyan/ky-app-server        # 需要 hono ^4 才能用参考适配器（可选 peer 依赖）
```

## 导出 API

| 模块                         | 导出                                                                                                   | 契约条款   |
| ---------------------------- | ------------------------------------------------------------------------------------------------------ | ---------- |
| `config/`                    | `loadKyAppConfig` / `KyAppConfig` / `decodeInstallationKey`                                            | §2.4、§3.8 |
| `jwks/`                      | `createJwksClient`（单飞、负缓存 LRU、10 s 节流、stale-if-error 24 h、`revoke`）                       | §3.1-5     |
| `sat/`                       | `verifySat` / `VerifiedIdentity` / `MemoryJtiStore` / `PgJtiStore`                                     | §3.1       |
| `local/`                     | `deriveInstallationKeys` / `createAttestationIssuer` / `issueLocalToken` / `verifyLocalToken`          | §3.2       |
| `breakGlass/`                | `createBreakGlass` / `MemoryBreakGlassStore` / `PgBreakGlassStore`                                     | §3.5       |
| `directory/`                 | `createDirectoryClient` / `directoryStalenessGate` / `MemoryDirectoryStore` / `PgDirectoryStore`       | §3.4、§3.6 |
| `events/`                    | `createEventsHandler` / `MemoryInstallationStateStore` / `PgInstallationStateStore`                    | §3.7       |
| `capabilities/`              | `defineCapabilities` / `MemoryExecutionStore` / `PgExecutionStore` / `validateAgainstCapabilitySchema` | §4.3、§4.4 |
| `me/`                        | `buildMe` / `localModeUserRoles`                                                                       | §4.2、§9.2 |
| `health/`                    | `buildHealthLive` / `buildHealthReady`                                                                 | §4.6       |
| `pg/`                        | `ensureKyAppSchema` / `MIGRATION_FILES`                                                                | §8.3       |
| `@kaiyan/ky-app-server/hono` | `createKyAppRouter` / `requireUser` / `securityHeaders` / `requireIdentity`                            | §3.3、§5.1 |

错误统一用 `KyAppError`（携带 §6.5 的错误码与 HTTP 状态），`toErrorResponse()` 转成附录 D 结构。

## 配置项（只在 `config/` 模块读 `process.env`）

必填：`KY_ENV`、`KY_SYSTEM_ID`、`KY_TENANT_ID`、`KY_INSTALLATION_ID`、`KY_ORIGIN`、
`KY_SERVICE_CREDENTIAL`、`KY_INSTALLATION_KEY`（32 字节 base64url 或 hex）、
`KY_INSTALLATION_KEY_VERSION`。

可选：`KY_INSTALLATION_KEY_PREVIOUS` + `KY_INSTALLATION_KEY_PREVIOUS_VERSION`（轮换 24 小时窗口，
必须成对）、`KY_JWKS_URL`（**仅 `KY_ENV=local|test`**；`local` 的 `iss` 取它的 origin）、
`KY_LOCAL_LOGIN_ENABLED`。凭据只从密钥管理注入，不进仓库（§8.4）。

## 存储接口与 PG 表

每个存储都是「接口 + 内存实现 + PG 实现」。内存实现只适合单进程；多实例部署必须用 PG 实现。

| 接口                     | PG 表                                                                              |
| ------------------------ | ---------------------------------------------------------------------------------- |
| `JtiStore`               | `ky_app_jti`（主键 `jti`，`INSERT ... ON CONFLICT DO NOTHING` 保证跨进程单次消费） |
| `ExecutionStore`         | `ky_app_execution`（主键 `(installation_id, capability_id, sub, lcid)`）           |
| `InstallationStateStore` | `ky_app_installation_state`、`ky_app_event_ack`（去重 + 状态 + ack 同事务）        |
| `DirectoryStore`         | `ky_app_directory_user`、`ky_app_directory_group`、`ky_app_directory_checkpoint`   |
| `BreakGlassStore`        | `ky_app_break_glass_record` / `_session` / `_employee_code` / `_audit`             |

建表语句在 `sql/001_ky_app_server.sql`（expand-only，随包发布）。生产请纳入项目自己的迁移体系；
本地与 doctor 可以直接 `await ensureKyAppSchema(pool)`。

## Hono 挂载示例

```ts
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import {
  createBreakGlass,
  createEventsHandler,
  createJwksClient,
  createLocalKeyRing,
  createAttestationIssuer,
  defineCapabilities,
  loadKyAppConfig,
  buildMe,
  PgExecutionStore,
  PgInstallationStateStore,
  PgJtiStore,
  ensureKyAppSchema,
} from '@kaiyan/ky-app-server';
import { createKyAppRouter, requireUser, requireIdentity } from '@kaiyan/ky-app-server/hono';
import { Pool } from 'pg';

const config = loadKyAppConfig();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
await ensureKyAppSchema(pool);

const jwks = createJwksClient({ url: config.jwksUrl });
const localKeys = createLocalKeyRing(config);
const events = createEventsHandler({ config, jwks, store: new PgInstallationStateStore(pool) });
const capabilities = defineCapabilities({
  manifest,
  executionStore: new PgExecutionStore(pool),
  createContext: async (identity) => ({
    tenantId: config.tenantId,
    installationId: config.installationId,
    userId: identity.sub!,
    roles: await loadRoles(identity.sub!),
    isTenantAdmin: identity.tadm,
    dataScope: await loadDataScope(identity.sub!),
  }),
  handlers: { 'order.search': searchOrders, 'order.create': createOrder },
});

const { router, runtime } = createKyAppRouter({
  config,
  manifest,
  jwks,
  localKeys,
  jtiStore: new PgJtiStore(pool),
  capabilities,
  events,
  attestation: createAttestationIssuer({ config, keys: localKeys, manifestDigest: () => digest }),
  breakGlass: createBreakGlass({/* store / installationState / onAlert */}),
  directoryStaleness: () => directory.staleness(),
  buildMe: async (identity) => buildMe({ permissionTable /* … */ }),
  permVersion: (identity) => permVersionOf(identity.sub!),
  health: { appVersion: process.env.APP_VERSION ?? 'dev' },
});

// 业务路由：中间件必须先于路由注册。ctx 只由 requireIdentity() 构造（§9.2）。
router.use('/api/app/*', requireUser(runtime));
router.use('/api/admin/*', requireUser(runtime));
router.get('/api/app/orders', async (c) => c.json(await searchOrders(await ctxOf(c), {})));

const app = new Hono();
app.route('/', router);
serve({ fetch: app.fetch, port: 3000 });
```

`createKyAppRouter()` 已挂好 `/ky/v1/{manifest,me,attest,events,health/live,health/ready,capabilities/*}`
与 `/ky-local/{enable,login,status,employee-code,disable}`；`KY_ENV=test` 时额外挂
`/ky/v1/test/{provision,break-glass,clock}`。响应头由 `securityHeaders()` 统一设置
（CSP `frame-ancestors https://agent.kaiyan.net`、HSTS、**不设** `X-Frame-Options`）。

## 脚本

| 命令             | 说明                                                                             |
| ---------------- | -------------------------------------------------------------------------------- |
| `pnpm typecheck` | `tsc --noEmit`                                                                   |
| `pnpm test`      | vitest；`src/**/*.pg.test.ts` 读 `TEST_DATABASE_URL`，缺失则整组 skip 并打印原因 |
| `pnpm build`     | 产出 `dist/`（含 `dist/hono/`）                                                  |
