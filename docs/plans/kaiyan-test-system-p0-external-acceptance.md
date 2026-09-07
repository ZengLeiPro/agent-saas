# 开沿测试系统与 P0 外部验收环境实施方案

> 2026-09-07 产品调整：平台管理员登记后直接发布，取消独立版本复核步骤，历史 pending 版本可直接发布。版本变化提示、工具注册校验、管理员权限、乐观锁和审计保留。平台仅保留“业务系统”入口，系统详情包含“版本管理”和“组织接入”；原系统交付链接跳转到对应系统。本文下方历史双人复核描述以此调整为准。

> 状态：待执行
>
> 编制日期：2026-09-07
>
> 关联 PR：`ZengLeiPro/agent-saas#548`
>
> 当前待验收主体：`df2820a263708d686a101394a38ab2956a33ceae`
>
> 目标：建设一套非生产的 KY Agent 验收环境和一个真实运行的“开沿测试系统”，完成业务系统接入管理 P0 的外部业务验收。
>
> 审核约定：不安排独立审核人；以冻结 SHA、自动化门禁、Agent 自检、真实业务证据和用户最终签收作为正式审核依据。

## 1. 执行结果

完成后必须得到以下交付物：

1. 独立仓库 `kaiyan-test-system`，系统 ID 为 `kaiyan-test-system`，显示名为“开沿测试系统”。
2. 独立部署的测试系统服务、域名、HTTPS、数据库、数据库账号和密钥空间。
3. 两个隔离测试组织、七个测试身份和一个专用测试 Agent。
4. v1、v2 两份不可变 Manifest 及其 digest。
5. v1 只读能力、v2 受控写能力、iframe 页面、组织目录同步和角色权限页面。
6. PR #548 对应功能的真实浏览器、真实 HTTP、真实 PostgreSQL、成员权限、Agent 工具和业务结果证据。
7. 一份绑定 RC、Git SHA、Manifest digest 的最终验收报告。
8. 可重复执行的部署、重置和回滚脚本。

## 2. 范围边界

### 2.1 本次包含

- 复用现有 `agent-saas` Staging，不创建第二套 KY Agent 平台。
- 新建一个逻辑和数据均独立的外部测试系统。
- 创建测试组织、测试成员、组织权益和 Assignment。
- 验证系统登记、版本变化确认、发布、交付、凭据领取、DNS、握手、能力调用、升级、回滚、轮换和离场。
- 对 PR #548 做无独立审核人的正式自审，并保留机器可复核证据。

### 2.2 本次不包含

- 不接生产业务数据、生产账号、生产凭据或真实客户组织。
- 不发布到 Production。
- 不修改或新建 `agent-saas` Workflow。
- 不在 `fc.kaiyan.net` 增加任何声明式域名配置。
- 不为了验收绕过租户权限、Assignment、工具批准或凭据一次领取门禁。
- 不把 CI、健康检查或 HTTP 200 当作业务验收通过。

### 2.3 授权边界

以下动作执行前必须由用户在当次会话明确授权：

- 创建 GitHub 远程仓库或执行 `git push`。
- 运行 `deploy-staging.yml`、`staging-acceptance.yml` 或其他 Workflow。
- 合并 PR #548。
- 创建或修改云资源、DNS、证书、RDS database/role、ECS systemd/Nginx 配置。
- 执行最终离场、吊销凭据或删除测试资源。

未获得授权时只允许本地开发、测试和只读盘点。

## 3. 固定命名和目标拓扑

### 3.1 固定命名

| 对象               | 固定值                                         |
| ------------------ | ---------------------------------------------- |
| 本地仓库           | `/Users/kaiyan001/code/kaiyan-test-system`     |
| GitHub 仓库建议名  | `ZengLeiPro/kaiyan-test-system`                |
| 系统 ID            | `kaiyan-test-system`                           |
| 系统名称           | `开沿测试系统`                                 |
| 安装实例 ID        | `kaiyan-test-system-tenant-a`                  |
| 外部域名           | `kaiyan-test-system.apps.kaiyancn.com`         |
| Origin/Base URL    | `https://kaiyan-test-system.apps.kaiyancn.com` |
| 数据库             | `kaiyan_test_system_staging`                   |
| 数据库角色         | `kaiyan_test_system_staging`                   |
| systemd 服务建议名 | `kaiyan-test-system-staging.service`           |
| 测试组织 A         | `tenant-a`，实际 ID 在资源清单中回填           |
| 越权组织 B         | `tenant-b`，实际 ID 在资源清单中回填           |
| 测试 Agent         | `agent-kaiyan-test-system`                     |

如果固定名称已经被占用，不得自动追加随机后缀继续执行；先只读查明现有资源是否属于本次验收，再决定复用或换名。

### 3.2 目标拓扑

```text
真实浏览器
  -> https://staging-agent.kaiyan.net
  -> agent-saas Staging API / Worker / ACS
  -> https://kaiyan-test-system.apps.kaiyancn.com
       -> 独立进程或容器
       -> 独立数据库 kaiyan_test_system_staging
       -> 独立 KY_* 凭据和安装密钥
```

“外部测试系统”必须满足：代码仓库、进程、域名、数据库、运行账号和密钥均与 `agent-saas` 分离。可以暂时与 Staging 共用 ECS，但必须使用独立 Unix 用户、目录、端口、systemd unit、数据库和 Nginx server block。若只读盘点发现端口、容量、权限或隔离不满足要求，停止执行并提交独立 ECS/FC 资源方案，不得临时占用现有服务端口。

### 3.3 前置门禁：先对齐 Staging KY App 契约

截至 2026-09-07 的只读复核结果显示，当前代码契约和实际 Staging 基础设施并不一致：

| 项目                 | SDK/服务端当前内置值                                                | 当前实际基础设施                                                    | 复核结果                                     |
| -------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------- | -------------------------------------------- |
| Staging Shell/Issuer | `https://staging.agent.kaiyan.net`                                  | `https://staging-agent.kaiyan.net`                                  | 点号域名无 DNS；连字符域名可访问             |
| Staging API/JWKS     | `https://api.staging.agent.kaiyan.net/.well-known/ky-app-jwks.json` | `https://staging-agent-api.kaiyan.net/.well-known/ky-app-jwks.json` | 点号域名无 DNS；实际域名的 JWKS 路由返回 404 |
| iframe CSP           | SDK 仅允许 `https://agent.kaiyan.net`                               | 验收 Shell 为 `https://staging-agent.kaiyan.net`                    | 当前不能完成真实 Staging iframe 嵌入         |
| doctor 第 9 章       | 只接受 Production Shell                                             | 需要校验 Staging Shell                                              | 按当前规则无法做到 Staging 合规且 16 章全绿  |

因此，不得直接进入测试系统部署。推荐统一沿用现有基础设施的连字符域名，并先完成一个独立前置修复 PR；若负责人决定改用点号域名，则必须同步完成 DNS、TLS、路由和全部代码契约，不允许两套命名混用。

前置修复至少包含：

1. 将 `packages/ky-app-contract/src/types/constants.ts` 和 `server/src/kyapp/config.ts` 的 Staging issuer/JWKS 统一为最终选定且真实可访问的域名。
2. 将 `packages/ky-app-server/src/hono/securityHeaders.ts` 的 `frame-ancestors` 改为按受信环境选择精确 Shell origin：Production 只允许 `https://agent.kaiyan.net`，Staging 只允许最终确认的 Staging Shell；禁止通配符。
3. 将 `packages/ky-app-cli/src/doctor/ch09Headers.ts` 改为按目标环境校验预期 Shell origin，并继续拒绝通配符和未批准的额外公网 origin。
4. 同步更新模板、契约测试、Server 测试、CLI doctor 测试和环境配置测试。
5. 确认 Staging 实际启用了 `kyApp` 配置，并使最终 JWKS 地址返回 HTTP 200、`application/json` 和非空 `keys`。
6. 增加真实 Staging CORS、CSP、issuer、JWKS 和 iframe 握手回归。

执行并保存以下无 secret 的回读证据：

```bash
dig +short staging-agent.kaiyan.net
dig +short staging-agent-api.kaiyan.net
curl -fsS -D /tmp/ky-staging-jwks.headers \
  https://staging-agent-api.kaiyan.net/.well-known/ky-app-jwks.json \
  -o /tmp/ky-staging-jwks.json
jq -e '.keys | type == "array" and length > 0' /tmp/ky-staging-jwks.json

cd /Users/kaiyan001/code/agent-saas
pnpm --filter @kaiyan/ky-app-contract test
pnpm --filter @kaiyan/ky-app-server test
pnpm --filter @kaiyan/ky-app-cli test
```

若完成修复需要修改 GitHub Workflow，必须暂停并单独取得用户授权；不得自行改造或启用 Workflow。不得用 Nginx 重写安全头、在已部署 Staging 设置 `KY_ENV=test`，或放宽为 `frame-ancestors *` 来绕过该门禁。

本门禁通过标准：Shell、issuer、API、JWKS 使用同一套已确认命名；Web/API/JWKS 在线可回读；`KY_ENV=staging` 自动指向真实地址；iframe 仅允许真实 Staging Shell；doctor 可在不降低安全规则的前提下通过。

## 4. Gate 0：执行前只读盘点

执行 Agent 先完成以下只读检查，并把结果写入临时资源清单；任何结论不得从旧文档推断：

```bash
cd /Users/kaiyan001/code/agent-saas
git status --short --branch
git fetch origin main --quiet
gh pr view 548 --json state,isDraft,headRefOid,mergeable,mergeStateStatus,statusCheckRollup
gh api 'repos/ZengLeiPro/agent-saas/rules/branches/main'
```

云端只读盘点至少包括：

- Staging 当前 RC、Web/API/Worker/ACS source SHA 和健康状态。
- Staging ECS CPU、内存、磁盘、已监听端口、systemd unit 和 Nginx server block。
- RDS 实例、目标 database/role 是否存在，确认不是 Production database/role。
- `apps.kaiyancn.com` DNS 管理位置、现有同名记录和证书覆盖范围。
- GitHub 仓库名是否已存在。
- Staging 当前是否有人在演示或执行其他验收。

形成以下冻结清单，不提交 secret：

```yaml
agentSaasPr: 548
agentSaasHeadSha: df2820a263708d686a101394a38ab2956a33ceae
agentSaasMergeSha: null
stagingReleaseId: null
stagingReleaseSha: null
testSystemRepository: ZengLeiPro/kaiyan-test-system
testSystemCommitSha: null
testSystemOrigin: https://kaiyan-test-system.apps.kaiyancn.com
testSystemManifestV1Digest: null
testSystemManifestV2Digest: null
tenantAId: null
tenantBId: null
installationId: kaiyan-test-system-tenant-a
acceptanceStartedAt: null
acceptanceCompletedAt: null
```

Gate 0 通过标准：目标唯一、账号明确、无生产误指向、无端口冲突、无并行验收冲突。

## 5. Gate 1：创建“开沿测试系统”代码仓库

### 5.1 使用标准脚手架

先在 `agent-saas` 构建脚手架，再生成独立项目：

```bash
cd /Users/kaiyan001/code/agent-saas
pnpm -F create-ky-app build
node packages/create-ky-app/dist/bin.js \
  /Users/kaiyan001/code/kaiyan-test-system \
  --system-id kaiyan-test-system \
  --name '开沿测试系统' \
  --link /Users/kaiyan001/code/agent-saas
```

生成后：

```bash
cd /Users/kaiyan001/code/kaiyan-test-system
git init
pnpm install
cp .env.example .env
```

`--link` 只用于本地开发。提交和部署前必须把 `link:/Users/...` 替换为可复现的不可变 tarball 或已发布精确版本；禁止把开发机绝对路径当作交付依赖。

### 5.2 JS/TS 工程基础门禁

新仓库必须配置：

- Node.js `22.23.1`。
- pnpm 版本与 `agent-saas` 当前 `packageManager` 一致。
- `husky` + `lint-staged`。
- `pre-commit` 至少运行格式化、lint、类型检查和密钥扫描的受影响范围。
- `.env`、凭据、安装密钥、测试截图明文和 Playwright trace 全部忽略。

建议脚本：

```json
{
  "scripts": {
    "prepare": "husky",
    "lint": "eslint .",
    "format:check": "prettier --check .",
    "secret-scan": "node scripts/secret-scan.mjs"
  },
  "lint-staged": {
    "*.{js,mjs,ts,vue,json,md,yml,yaml}": ["prettier --write"],
    "*.{js,mjs,ts,vue}": ["eslint --fix"]
  }
}
```

如果脚手架生成内容与本节冲突，以“hooks 实际可运行、不会修改未暂存文件、不会泄露 secret”为验收标准。

### 5.3 最小产品页面

只实现三个页面，不保留无关订单演示页面：

| 路由              | 页面     | 权限                    | 必须展示                                                                                     |
| ----------------- | -------- | ----------------------- | -------------------------------------------------------------------------------------------- |
| `/users`          | 用户列表 | `users.read`            | 姓名、用户 ID、工号、状态、管理员标记、所属部门/群组、本地状态、更新时间                     |
| `/settings/roles` | 角色权限 | `settings.roles.manage` | 用户、当前角色、`viewer`/`operator` 分配；仅组织管理员可见和修改                             |
| `/system-status`  | 系统状态 | `system.status.read`    | 环境、systemId、installationId、目录 checkpoint/陈旧度、Manifest digest；不得展示任何 secret |

共同要求：

- loading、empty、error、retry、403 状态完整。
- 所有数据来自真实页面 API，不允许前端 mock。
- 菜单、页面接口和前端路由都由声明式权限表驱动。
- 普通成员手工访问 `/settings/roles` 仍由服务端返回 403。
- 前端不读写 SAT、服务凭据或安装密钥；令牌只由 `@kaiyan/ky-app-browser` 在内存管理。

### 5.4 页面 API

最低接口：

```text
GET  /api/app/users?q=&status=&limit=&cursor=
GET  /api/app/system-status
GET  /api/admin/roles
POST /api/admin/roles
```

要求：

- `/api/app/users` 读取 `PgDirectoryStore.listUsers()` 的本地目录投影，并执行稳定分页。
- 用户结果只包含测试组织目录字段；不返回手机号、登录凭据或平台 token。
- `/api/admin/roles` 只管理测试系统内部角色，不修改 KY Agent 平台成员身份。
- 写接口要求 `X-KY-Idempotency-Key`，相同 key 重放返回同一结果。

### 5.5 Manifest v1

v1 只提供一个能力：

```json
{
  "id": "user.search",
  "name": "查询测试系统用户",
  "description": "按姓名、工号或用户 ID 查询开沿测试系统的测试用户",
  "riskLevel": "read_only",
  "approval": "none",
  "safeToRetry": true,
  "timeoutMs": 12000
}
```

具体 Schema 必须满足：

- 输入：`keyword` 必填，`limit` 为 1～10，可选 `cursor`。
- 输出：`items`、`hasMore`、可选 `nextCursor`。
- 每个用户只返回 `userId`、`displayName`、`employeeNo`、`status`、`isTenantAdmin`。
- 页面 API 和 `user.search` 必须调用同一个 service，不能复制两套查询逻辑。
- `ky-app.conformance.json` 覆盖合法输入、非法输入、分页、页面/能力等价性和 U1/U2 权限。

### 5.6 Manifest v2

v2 在 v1 基础上只增加一个外部写能力：

```json
{
  "id": "user.note.create",
  "name": "创建用户测试备注",
  "description": "为测试用户创建仅用于验收的备注，不修改平台用户或真实业务数据",
  "riskLevel": "external_write",
  "approval": "required",
  "safeToRetry": false,
  "timeoutMs": 12000
}
```

写入独立表 `test_user_note`：

```sql
CREATE TABLE IF NOT EXISTS test_user_note (
  note_id TEXT PRIMARY KEY,
  installation_id TEXT NOT NULL,
  target_user_id TEXT NOT NULL,
  note TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (installation_id, idempotency_key)
);
```

禁止添加修改/删除平台用户的能力。验收结束时只删除 `test_user_note` 测试行。

### 5.7 需要修改的文件

执行 Agent 至少核对并修改：

```text
package.json
pnpm-workspace.yaml
.husky/pre-commit
.gitignore
.env.example
ky-app.manifest.json
ky-app.conformance.json
server/app.ts
server/permissions.ts
server/capabilities.ts
server/routes/pageApi.ts
server/services/users.service.ts
server/services/users.service.test.ts
server/migrations/002_test_system.sql
web/src/App.vue
web/src/router.ts
web/src/pages/Users.vue
web/src/pages/Roles.vue
web/src/pages/SystemStatus.vue
README.md
```

删除订单模板时，同时删除订单路由、能力、迁移、页面、测试、技能和 conformance 引用，不能留下不可达菜单或空 handler。

### 5.8 本地验证

使用共享本地 PostgreSQL，但创建独立 database：

```bash
docker start local-postgres
createdb -h 127.0.0.1 -p 5432 -U postgres kaiyan_test_system_dev
```

如 database 已存在，只读确认归属后复用，不得先删除。

填写本地 `.env` 后执行：

```bash
pnpm typecheck
pnpm lint
pnpm format:check
pnpm test
pnpm build
pnpm secret-scan
pnpm doctor
```

Gate 1 通过标准：全部命令成功；`ky-app doctor` 16 章全绿且无 SKIP；真实浏览器 mock shell 可打开三个页面；普通成员访问管理员接口为 403；工作区无 secret 和意外文件。

完成后按功能范围提交本地 commit；未获授权不得创建远程仓库或 push。

## 6. Gate 2：部署外部测试系统

### 6.1 依赖冻结

部署前将以下包构建成不可变 tarball，并记录 SHA-256：

- `@kaiyan/ky-app-contract`
- `@kaiyan/ky-app-server`
- `@kaiyan/ky-app-browser`
- `@kaiyan/ky-app-cli`

测试系统不得依赖开发机绝对路径。使用 vendored tarball 时，`package.json` 和 `pnpm-workspace.yaml` 必须引用仓库相对路径，并提交 `pnpm-lock.yaml`。

### 6.2 数据库

经授权后创建：

- database：`kaiyan_test_system_staging`
- role：`kaiyan_test_system_staging`
- role 只拥有该 database/schema 权限。
- `DATABASE_URL` 只进入 Staging secret，不写仓库、日志或截图。

迁移只允许 expand 操作。部署前后分别保存 schema 只读摘要；不得连接 `agent_saas` Production database。

### 6.3 服务和 HTTPS

在确认的目标计算资源上创建独立服务：

- 独立运行用户，不允许读取 `agent-saas` 配置目录。
- 独立目录 `/opt/kaiyan-test-system/releases/<sha>` 和 `current` 软链。
- 监听仅绑定 `127.0.0.1:<已确认空闲端口>`。
- Nginx 只把 `kaiyan-test-system.apps.kaiyancn.com` 转发到该端口。
- HTTPS 证书覆盖精确域名；HTTP 强制跳转 HTTPS。
- CSP `frame-ancestors` 必须由修复后的 SDK 按 `KY_ENV=staging` 精确允许最终确认的 Staging Shell，当前推荐值为 `https://staging-agent.kaiyan.net`；不得由 Nginx 覆盖，也不得使用 `*`。
- 日志禁止记录 Authorization、cookie、领取票据、服务凭据和安装密钥。

### 6.4 首次启动配置

首次启动前只能先填写非 secret 配置；领取凭据后再由受控密钥文件或 secret manager 注入：

```dotenv
KY_ENV=staging
KY_SYSTEM_ID=kaiyan-test-system
KY_TENANT_ID=<tenant-a-real-id>
KY_INSTALLATION_ID=kaiyan-test-system-tenant-a
KY_ORIGIN=https://kaiyan-test-system.apps.kaiyancn.com
KY_SERVICE_CREDENTIAL=<secret-manager>
KY_INSTALLATION_KEY=<secret-manager>
KY_INSTALLATION_KEY_VERSION=<secret-manager>
DATABASE_URL=<secret-manager>
PORT=<confirmed-port>
```

部署形态不得设置 `KY_LOCAL_LOGIN_ENABLED`，也不得通过临时 `KY_SHELL_ORIGIN` 或自定义 `KY_JWKS_URL` 掩盖 SDK 契约错误；这些地址必须由已验证的 `KY_ENV=staging` 配置确定。

### 6.5 DNS

需要两类记录：

1. 业务系统访问域名的 A/CNAME：`kaiyan-test-system.apps.kaiyancn.com`。
2. 平台创建安装实例后给出的 TXT：`_ky-app-verify.kaiyan-test-system.apps.kaiyancn.com`。

TXT 值只从安装详情复制，不写入仓库。DNS 变更后从两个公共解析器回读，再在平台执行“验证域名”。

Gate 2 通过标准：HTTPS、证书、CSP、`/ky/v1/health/live`、`/ky/v1/health/ready`、Manifest digest、数据库身份、进程身份和日志脱敏全部通过；此时仍不代表 P0 验收通过。

## 7. Gate 3：准备 KY Agent Staging 测试数据

### 7.1 测试身份

通过正常管理页面或正式 API 创建/确认以下真实登录身份，不直接写数据库伪造：

| 代号 | 角色                                                                           | 组织     |
| ---- | ------------------------------------------------------------------------------ | -------- |
| PA   | 平台管理员 A，登记、发布和交付                                                 | 平台     |
| OA   | 组织管理员                                                                     | tenant-a |
| TC   | 技术联系人                                                                     | tenant-a |
| U1   | 被授权普通成员                                                                 | tenant-a |
| U2   | 未授权普通成员                                                                 | tenant-a |
| OB   | 越权验证组织管理员                                                             | tenant-b |

系统版本由 PA 登记并直接发布，不再准备 PB 复核账号。能力执行批准和技术联系人领取凭据仍走各自正式流程。

### 7.2 组织和权益

- `tenant-a`：Entitlement 状态有效，`integrated_system` 选择 `kaiyan-test-system`。
- `tenant-b`：Entitlement 有效，但 `integrated_system` 不包含 `kaiyan-test-system`。
- TC、U1、U2 均为 `tenant-a` active membership。
- OB 只属于 `tenant-b`。
- 创建测试 Agent `agent-kaiyan-test-system`，只服务于本轮验收。

### 7.3 固定业务断言

目录同步后必须能在测试系统查到：

- U1：状态 active，后续应该能打开系统并调用能力。
- U2：状态 active，但没有安装实例 Assignment，不能打开或取得工具。
- OA：管理员标记为 true，可访问角色权限页。

所有真实 ID 写入脱敏资源清单；手机号、密码、token 不进入报告。

Gate 3 通过标准：两个组织无串租户、七个账号均能通过真实登录流程到达预期权限、权益范围可回读。

## 8. Gate 4：PR 正式自审与合并

本项目不安排独立代码审核人，正式审核按以下方式完成：

1. Agent 在全新上下文中只读检查 PR #548 的完整 diff。
2. 检查跨租户、成员撤权、握手缓存、凭据明文、版本 CAS、离场和失败恢复。
3. 运行全量 CI 等价门禁，并确认 GitHub required checks 对精确 HEAD 成功。
4. 将发现按 P0/P1/P2 分类；P0/P1 未关闭不得解除 Draft。
5. 用户阅读自审结论并明确同意进入合并。
6. 合并前再次确认 `CLEAN`、`MERGEABLE`、review thread 为 0、HEAD 未变化。

仓库当前不要求 approving review 数量，因此不伪造自我 `APPROVED`。正式审核事实记录为：自审报告、CI、冻结 HEAD、用户确认和合并回读。

解除 Draft 可执行：

```bash
gh pr ready 548
```

合并属于独立授权动作；未收到用户明确“合并 PR #548”不得执行。合并后必须拉取并回读 `origin/main`，记录 merge SHA。

## 9. Gate 5：部署 KY Agent Staging

现有 Staging 发布链只接受已合入 `main` 的 SHA。用户明确授权运行 Workflow 后：

```bash
cd /Users/kaiyan001/code/agent-saas
git fetch origin main --quiet
git rev-parse origin/main

gh workflow run deploy-staging.yml \
  --ref main \
  -f reason='业务系统接入管理 P0 外部验收'
```

等待完成后读取 RC ID、Workflow run ID、Manifest 和在线 identity，确认 `releaseSha` 包含 PR #548 merge SHA。若 dispatch 前 `main` 已前进，验收主体必须写实际 RC SHA，不能继续声称只验收了 PR #548 HEAD。

通用 Staging 验收需另行授权后执行：

```bash
gh workflow run staging-acceptance.yml \
  --ref main \
  -f release_id='<rc-id>' \
  -f reason='业务系统接入管理 P0 发布回归'
```

通用 Workflow 不覆盖下面的业务系统专项场景，不能替代 Gate 6。

## 10. Gate 6：P0 完整外部业务验收

严格按顺序执行。每一步先保存非敏感证据并回读，再进入下一步；禁止把多个写操作打包后补证据。

### 10.1 v1 登记和交付

- [ ] PA 上传 v1 Manifest，记录 digest、warnings 和校验结果。
- [ ] PA 直接发布首版；无需第二位管理员，变化提示可查看。
- [ ] PA 使用 `expectedVersion` 发布 v1。
- [ ] tenant-a 可安装列表出现“开沿测试系统”。
- [ ] tenant-b 可安装列表不出现该系统，直接安装返回 403。
- [ ] PA 为 tenant-a 创建交付；重复提交相同请求不重复创建组织、成员、积分、安装或凭据。
- [ ] 交付进入 `waiting_external`，重新打开页面能从原 request 恢复。

### 10.2 凭据和 DNS

- [ ] 只有 TC 能打开领取页；OA、U1、OB 均为 403。
- [ ] TC 真实登录后确认风险并领取；页面刷新或返回后不能再次显示明文。
- [ ] 平台管理页面和凭据元数据接口不包含服务凭据或安装密钥明文。
- [ ] TC 将凭据写入测试系统 secret manager并重启服务。
- [ ] 测试系统实际调用 `credential-ack`；重复 ack 不产生第二份凭据。
- [ ] 配置真实 TXT，公共 DNS 回读后平台验证成功。
- [ ] 测试系统上报 live/ready 和 v1 digest。
- [ ] 继续同一交付请求直至 `completed`。

### 10.3 Assignment、iframe 和成员权限

- [ ] 首次启用后的 Assignment 为空，不自动授权全员。
- [ ] OA 预览并提交 U1 allow 和测试 Agent allow，保存人数预览截图。
- [ ] U1 左侧出现“开沿测试系统”，iframe 从真实域名加载并完成握手。
- [ ] U1 能访问 `/users`，能看到目录同步的真实测试成员。
- [ ] U2 左侧无入口；手工 URL、nonce、握手均被拒绝。
- [ ] U2 新 Agent 会话的工具快照不包含 `user.search`。
- [ ] OB 读取或操作 tenant-a 安装详情返回 403。
- [ ] 停用实例后 U1 只看到“暂不可用”，不能挂载 iframe或取得工具。
- [ ] 再启用后原 Assignment 保留，U1 恢复，U2 仍无权限。
- [ ] 撤销 U1 后，旧页面续期失败，新会话工具快照不再包含该能力。

### 10.4 真实只读业务能力

- [ ] 重新授权 U1。
- [ ] U1 新建 Agent 会话，确认工具快照包含 `user.search`。
- [ ] Agent 调用 `user.search` 查询 U1 的固定姓名/工号。
- [ ] HTTP 结果、测试系统数据库/目录回读和 Agent 最终回答一致。
- [ ] Agent 回答包含可核对用户 ID；不能只以 HTTP 200 判成功。
- [ ] U2 发起相同请求时没有该工具，不能通过伪造 userId/tenantId 调用。

### 10.5 v2、工具批准、升级和回滚

- [ ] PA 上传 v2，diff 明确出现 `user.note.create` 和 `external_write`。
- [ ] PA 可直接发布 v2，工具注册校验仍生效。
- [ ] 外部测试系统部署 v2并上报 v2 digest；上报前平台不能切换。
- [ ] 平台切换 `registeredDigest` 使用正确 `expectedRegisteredDigest`；过期值返回 409。
- [ ] U1 新会话出现 `user.note.create`，未经运行时批准不得执行。
- [ ] 批准后只向 `test_user_note` 写入一条记录；相同幂等 key 不重复写。
- [ ] 外部系统重新部署 v1并上报 v1 digest后，平台成功回滚。
- [ ] 回滚后的新会话不再出现 `user.note.create`，`user.search` 仍正常。

### 10.6 轮换、诊断、用量、审计和离场

- [ ] PA 签发新凭据，旧凭据在新凭据 ack 前仍有效。
- [ ] TC 领取并装配新凭据，测试系统用新凭据完成 ack。
- [ ] 新凭据变 active，旧凭据 revoked；旧凭据调用失败。
- [ ] 一键诊断逐项显示 DNS、live、ready digest、attest、admin me 和只读能力结果。
- [ ] 运行信号、用量和审计均能回读到本轮调用。
- [ ] PA 保存离场计划，未输入精确 installation ID 时不能执行。
- [ ] 离场前完成测试数据导出清单并勾选外部责任项。
- [ ] 最后执行平台离场：实例 disabled、凭据 revoked、审计保留。
- [ ] 外部测试系统数据仍存在，页面不得宣称已删除外部数据。

Gate 6 通过标准：以上每一项都有绑定同一 RC/系统版本的证据；任何关键项失败则 P0 不通过。

## 11. 证据目录和脱敏规则

最终在 `agent-saas` 新增：

```text
docs/evidence/business-systems-p0/<yyyy-mm-dd>/
  00-resource-identity.md
  01-platform-release.md
  02-delivery-and-credential.md
  03-assignment-and-members.md
  04-agent-readonly-business-result.md
  05-upgrade-rollback.md
  06-rotation-offboarding.md
  http/
  db/
  screenshots/
  manifest-v1.json
  manifest-v2.json
  acceptance-summary.json
```

`acceptance-summary.json` 最低字段：

```json
{
  "status": "passed",
  "agentSaasMergeSha": "<sha>",
  "stagingReleaseId": "<rc-id>",
  "stagingReleaseSha": "<sha>",
  "testSystemCommitSha": "<sha>",
  "manifestV1Digest": "<digest>",
  "manifestV2Digest": "<digest>",
  "tenantAId": "<id>",
  "tenantBId": "<id>",
  "installationId": "kaiyan-test-system-tenant-a",
  "passedChecks": 0,
  "failedChecks": 0,
  "startedAt": "<iso8601>",
  "completedAt": "<iso8601>"
}
```

禁止保存：

- 密码、短信码、session JWT、Authorization header。
- credential claim ticket。
- `KY_SERVICE_CREDENTIAL`、`KY_INSTALLATION_KEY` 及 previous key。
- 未清除明文的领取页截图、trace、HAR、video或浏览器 storage。
- 完整手机号和不必要的个人信息。

HTTP 证据只保留 method、脱敏 URL、状态码、`requestId`、响应字段摘要和结果 digest。数据库证据只读导出必要列，凭据仅保留 ID、状态、时间和 hash 摘要。

## 12. 失败处理与重测规则

- 代码或配置失败：停止后续写操作，保留失败证据，修复后生成新 commit/RC。
- secret 疑似泄露：立即停止验收，吊销对应凭据，清理 artifact，再从凭据签发步骤重做。
- 跨租户或 U2 越权：P0 阻断，不允许降级为已知问题。
- Manifest 或测试系统代码变化：重新计算 digest，并从版本登记开始重测。
- `agent-saas` SHA 变化：重新跑 CI、部署新 RC，并重跑所有安全和业务关键路径。
- 仅文案或证据索引变化：运行受影响检查和 `git diff --check`，不重复破坏性离场。
- Staging 被其他发布覆盖：停止，重新冻结在线 RC 后重测，不能拼接两次 RC 的证据。

## 13. 回滚和清理

### 13.1 测试系统代码回滚

- 使用上一成功 commit 构建新 release 目录。
- 原子切换 `current` 软链并重启独立服务。
- 回读进程 SHA、Manifest digest、live/ready。
- 数据库 migration 只 expand，不在回滚时 DROP。

### 13.2 平台侧回滚

- 系统版本回滚必须先部署旧版本并取得 ready + 相同 digest，再切换 `registeredDigest`。
- 不直接修改数据库登记 digest。
- 不移动或覆盖已有 RC tag/Manifest。

### 13.3 验收后清理

最终离场已经停用安装并吊销凭据。资源删除需另行授权，并按顺序执行：

1. 冻结证据并确认不含 secret。
2. 删除 `test_user_note` 测试行。
3. 停止测试系统服务。
4. 删除 DNS TXT；访问域名是否保留由用户决定。
5. 吊销并删除 secret manager 中的测试凭据。
6. database/role、服务目录和远程仓库是否删除必须分别确认，禁止一键递归删除。

## 14. 最终完成定义

只有同时满足以下条件，才能把“P0 管理功能已实现”更新为“P0 已完整交付验收”：

- [ ] PR #548 已完成正式自审、CI、用户确认和合并回读。
- [ ] Staging Shell/issuer/API/JWKS 契约已对齐，JWKS 在线回读为 200 且包含非空 keys。
- [ ] Staging 在线 identity 与冻结 RC 一致。
- [ ] 开沿测试系统独立运行，`ky-app doctor` 16 章全绿且无 SKIP。
- [ ] v1/v2 digest、部署版本和平台登记一致。
- [ ] U1 成功、U2/OB 拒绝、撤权立即失效。
- [ ] Agent 返回真实用户数据，结果经过测试系统回读核对。
- [ ] v2 管理员直接发布、工具批准、升级和回滚通过。
- [ ] 凭据轮换、诊断、用量、审计和离场通过。
- [ ] 证据完整、脱敏、绑定 SHA/RC/digest。
- [ ] 用户在最终验收报告中明确签收。

最终状态报告必须分开写：

```text
代码检查：通过/失败
PR 正式自审：通过/失败
PR 合并：已完成/未执行
Staging 部署：通过/失败/未执行
开沿测试系统：在线/离线，commit 与 digest
外部业务验收：通过/失败
Production：未部署
残余限制：逐项列出
```
