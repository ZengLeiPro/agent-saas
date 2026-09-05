# **SYSTEM_NAME**（`__SYSTEM_ID__`）

开沿定制项目，按《开沿定制项目与 KY Agent 衔接契约》v1 实现。
后端 Hono + `@kaiyan/ky-app-server`，前端 Vue 3 + Vite + `@kaiyan/ky-app-browser`，
前端生产产物由后端托管（响应头必须由后端发，见契约 §5.1）。

## 1. 安装

```bash
pnpm install
cp .env.example .env
```

`.env` 里的值**只从密钥管理拿**，不要提交（`.gitignore` 已经挡住，pre-commit 还会再扫一遍）。

必填项（契约 §2.4）：

| 变量                                                  | 说明                                                       |
| ----------------------------------------------------- | ---------------------------------------------------------- |
| `KY_ENV`                                              | `prod` / `staging` / `local` / `test`                      |
| `KY_SYSTEM_ID`                                        | 与 `ky-app.manifest.json` 的 `systemId` 一致               |
| `KY_TENANT_ID` / `KY_INSTALLATION_ID`                 | 平台安装时下发                                             |
| `KY_ORIGIN`                                           | 本系统对外的 origin，例如 `https://demo.apps.kaiyancn.com` |
| `KY_SERVICE_CREDENTIAL`                               | 组织目录接口的服务凭据                                     |
| `KY_INSTALLATION_KEY` / `KY_INSTALLATION_KEY_VERSION` | 32 字节安装密钥与版本                                      |
| `DATABASE_URL`                                        | PostgreSQL 连接串                                          |
| `PORT`                                                | 监听端口，默认 8787（也可用 `--port`）                     |

`local` / `test` 下还要给 `KY_JWKS_URL`；本地跑 mock 壳时再加 `KY_SHELL_ORIGIN`
与 `KY_DIRECTORY_URL`（`ky-app mock-shell` 会把整组配置打印出来）。

## 2. 本地开发

```bash
pnpm build          # 编译后端 + 构建前端产物（前端产物由后端托管）
pnpm dev            # 起服务，默认 8787
```

另开一个终端起本地 mock 壳，就能在浏览器里看到 iframe 里的本系统：

```bash
pnpm mock-shell     # = ky-app mock-shell，按提示把打印出来的 KY_* 填进 .env 后重启服务
```

它会打印一个壳地址（形如 `http://127.0.0.1:xxxxx/shell`），浏览器打开即可。
壳负责握手、发令牌、路由同步；子端行为与线上完全一致。

> 本地开发不走 vite dev server：契约要求 `script-src 'self'`，dev server 注入的内联脚本
> 会被 CSP 拦掉。改完前端跑一次 `pnpm build:web` 刷新即可。

## 3. 自测

```bash
pnpm typecheck
pnpm test           # service 层单测
pnpm secret-scan    # 密钥扫描（pre-commit 也会跑）
pnpm doctor         # = ky-app doctor --pg docker --browser auto，契约 §9.3 十六章
```

`pnpm doctor` 会自己起一个临时 PostgreSQL 容器与 mock 壳，把本项目**真实启动两次**
（验证 `jti` 的跨进程单次消费），跑完 16 章后打印逐项结果。**16 章全绿才算达标**，
跳过（SKIP）不算通过。CI（`.github/workflows/ci.yml`）用 GitHub 的 postgres service 跑同一套。

## 4. 目录结构

```
ky-app.manifest.json      能力与前缀声明（契约附录 A），平台按它注册工具
ky-app.conformance.json   一致性测试夹具（契约附录 J）
server/
  app.ts                  装配：契约端点 + 业务路由 + 静态托管
  permissions.ts          声明式权限表（同时驱动 /me 与路由守卫）
  capabilities.ts         能力 handler（只调 service）
  routes/pageApi.ts       页面接口（只调 service）
  services/               唯一的业务逻辑所在地
  testHooks.ts            /ky/v1/test/*，只在 KY_ENV=test 注册
  migrations/             业务表（expand-only，禁 DROP）
web/                      Vue 3 前端，产物 web/dist 由后端托管
skills/                   技能，只经 app__ 工具取数，不带凭据
scripts/secret-scan.mjs   密钥扫描
```

## 5. 启动约定

`ky-app doctor` 需要能自己拉起本项目。约定如下（`package.json` 的 `ky.start` 已写好）：

```json
{ "ky": { "start": ["node", "server/dist/index.js", "--port", "{{port}}"] } }
```

不写 `ky.start` 时，doctor 退回默认约定 `pnpm start --port <port>`，
并同时注入环境变量 `PORT`。两条路都要求先跑过 `pnpm build`。

## 6. 加一个页面要改哪些地方

1. `server/permissions.ts`：加权限点 + 菜单节点（`/me` 与路由守卫都读它）；
2. `server/services/`：写业务函数，首参 `ctx`；
3. `server/routes/pageApi.ts`：加页面接口，只调 service；
4. 需要 Agent 也能用时，在 `ky-app.manifest.json` 里加一个能力，
   `server/capabilities.ts` 里挂 handler（同一个 service 函数）；
5. `web/src/router.ts` + `web/src/pages/`：加前端路由与页面；
6. `ky-app.conformance.json`：补夹具（`validInputs` / `invalidInputs` / `cleanup` /
   `pageApiEquivalence` / `menuApis` / `endpoints`）；
7. `pnpm doctor` 跑绿。

细则见 `CLAUDE.md`（由 `@kaiyan/ky-app-contract` 生成，不要手改）。
