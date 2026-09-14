# KY App 非对称一键授权接入改造方案

> 状态：待执行
>
> 编制日期：2026-09-14
>
> 目标：业务系统完成一次支持 V2 的版本升级后，后续组织接入、凭据续期和密钥轮换均不再复制 `.env`、不向浏览器展示长期秘密、无需重启业务系统。
>
> 授权边界：本文是实施方案，不授权修改或启用 GitHub Workflow，不授权推送、创建 PR、部署、操作真实组织、签发或撤销真实凭据。

## 1. 决策摘要

采用“授权码 + PKCE + 非对称部署身份 + DPoP 短期访问令牌”的 KY App V2 协议：

1. 业务系统首次启动时在受控密钥存储中生成 P-256 私钥，平台只保存公钥和 RFC 7638 JWK Thumbprint。
2. 平台的安装实例页面提供“授权并自动接入”，不再默认展示或下载服务凭据。
3. 业务系统生成 PKCE verifier；平台只接收 S256 challenge。授权完成后，浏览器只携带一次性授权码和 `state` 返回业务系统。
4. 业务系统后端使用授权码、PKCE verifier、私钥客户端断言和 DPoP proof 完成兑换；响应不包含长期共享秘密。
5. 后续业务系统使用私钥获取 5 分钟 DPoP-bound workload access token，不签发 refresh token，不再使用长期 Bearer `KY_SERVICE_CREDENTIAL`。
6. 安装证明从共享密钥 HS256 改为部署私钥 ES256；平台按安装实例绑定的公钥验签。
7. SDK 通过 `InstallationBindingProvider` 动态加载和原子切换组织绑定，路由常驻，接入成功后无需重启。
8. V1 继续服务现有安装；V2 安装一经激活禁止静默降级回 V1。

这不是现有领取页的 UI 小改，而是契约、平台、SDK、脚手架、业务系统存储和验收链路的版本化升级。

## 2. 目标与完成标准

### 2.1 用户目标

平台管理员或安装实例技术联系人在平台完成一次明确授权后，页面自动推进并最终显示“已接入”。操作者不接触服务凭据、安装密钥、私钥或 access token，也不登录部署服务器。

### 2.2 技术完成标准

- 未绑定任何组织时，业务系统仍能启动、登录并完成核心业务读写；Agent 集成显示 `unbound`。
- 完成授权后，业务系统在原进程内进入 `connected`，不重启、不重新部署。
- 平台数据库、浏览器、URL、前端状态、日志和审计 metadata 中均不存在业务系统私钥或长期共享秘密。
- 平台只保存业务系统公钥；业务系统只长期保存自己的私钥和非敏感安装绑定元数据。
- workload access token 最长 5 分钟，并通过 DPoP 绑定发送方密钥；窃取 token 本身不能独立使用。
- 授权码一次性、60 秒有效，并绑定安装实例、部署身份、精确 callback、PKCE challenge 和发起人。
- V2 安装停用或撤销后不再签发新 token；已有 token 最多在 5 分钟内自然失效，资源接口仍实时检查安装状态并立即拒绝。
- 平台只有在安装激活、当前 Manifest digest 一致、业务系统 ready、`/ky/v1/me` 能力可见后才把系统投影给 Agent。
- 至少完成一个真实 Staging 组织的浏览器授权、数据库回读、平台探测、Agent 新会话工具快照和真实只读能力调用。

### 2.3 非目标

- 不把 KY Agent 变成业务系统启动、独立登录或核心业务的前置条件。
- 不允许浏览器生成、读取或持久化部署私钥。
- 不在第一版引入 refresh token、动态 OAuth client registration、任意 redirect URI 或隐式授权。
- 不自动创建新组织、赠送权益、扩大 Assignment 或授予业务数据权限。
- 不把平台授权等同于业务系统内的用户权限；Agent 请求仍须映射到真实业务主体并经过业务权限校验。
- 不在本方案中修改 GitHub Workflow、云资源、DNS 或生产配置。

## 3. 当前约束与改造原因

当前链路有四个启动级约束：

1. `KyAppCredentialClaimPage` 把 `KY_SERVICE_CREDENTIAL`、`KY_INSTALLATION_KEY` 和版本展示在浏览器中。
2. `loadKyAppConfig()` 把组织、安装实例和两类秘密都定义为必填环境变量。
3. `createDirectoryClient()` 在构造时捕获服务凭据，不能在运行中替换。
4. `createLocalKeyRing()` 在构造时派生共享密钥，attest 和 Local Token 都依赖同一安装密钥。

此外，SDK 当前部分表是单安装实例模型：安装状态和目录 checkpoint 使用固定单行主键，目录用户/组也未按 `installation_id` 分区。V2 的内部接口和新表必须从第一天按安装实例索引；首个生产试点可以限制为单组织部署，但不能继续把全局单例写进新协议。

## 4. 安全协议基线

协议实现遵循以下标准的适用部分：

- [RFC 9700 OAuth 2.0 Security Best Current Practice](https://www.rfc-editor.org/rfc/rfc9700.html)：授权码模式、PKCE、防降级和 redirect 精确匹配。
- [RFC 7636 PKCE](https://www.rfc-editor.org/rfc/rfc7636.html)：只允许 `S256`。
- [RFC 7523 JWT Client Authentication](https://www.rfc-editor.org/rfc/rfc7523.html)：业务系统以私钥签名客户端断言。
- [RFC 9449 DPoP](https://www.rfc-editor.org/rfc/rfc9449.html)：短期 access token 绑定发送方公钥，并校验 `htm`、`htu`、`iat`、`jti`、`ath` 和可选 nonce。
- [RFC 7638 JWK Thumbprint](https://www.rfc-editor.org/rfc/rfc7638.html)：用 SHA-256 thumbprint 标识业务系统公钥。
- [RFC 8725 JWT Best Current Practices](https://www.rfc-editor.org/rfc/rfc8725.html)：显式 `typ`、算法白名单、issuer/audience 校验和不同 JWT 类型的互斥验证规则。

第一版密码学配置固定如下，变更必须升级契约测试向量：

| 项目                    | V2 决策                                                                 |
| ----------------------- | ----------------------------------------------------------------------- |
| 部署身份密钥            | P-256，JWS `ES256`                                                      |
| `keyId`                 | RFC 7638 SHA-256 JWK Thumbprint 的 base64url 值                         |
| PKCE                    | `S256`，拒绝 `plain` 和缺失 challenge                                   |
| 授权请求有效期          | 10 分钟                                                                 |
| 授权码有效期            | 60 秒、单次消费                                                         |
| client assertion 有效期 | 60 秒，`jti` 单次消费                                                   |
| DPoP proof 接受窗口     | 60 秒，`jti` 单次消费；时钟容忍 10 秒                                   |
| workload access token   | 5 分钟，不签发 refresh token                                            |
| token 类型              | `DPoP`，不接受同 token 以 `Bearer` 使用                                 |
| callback                | 必须等于安装实例已验证 origin 下的固定路径 `/ky/v2/enrollment/callback` |
| TLS                     | Staging/Production 只允许 HTTPS；不跟随跨 origin 重定向                 |

不得复用同一个 JWT 校验函数宽松接受所有 token。至少使用以下互斥 `typ`：

- `ky-enrollment-request+jwt`
- `ky-installation-grant+jwt`
- `ky-client-auth+jwt`
- `ky-workload-at+jwt`
- `ky-attest-v2+jwt`
- 标准 `dpop+jwt`

每种类型分别固定 `alg`、必填 claims、issuer、audience、key source 和最大 TTL，拒绝 `none`、HS/ES 算法混淆、未知 critical header 和包含私钥成员的 JWK。

## 5. 目标架构

```text
平台安装实例页
  -> 平台 Enrollment Service
      -> 精确访问已验证 business origin 的 challenge 端点
      -> 平台登录用户确认组织、系统、部署和 scopes
      -> 浏览器携带一次性 code + state 回到业务系统

业务系统 Enrollment Router（未绑定时也常驻）
  -> DeploymentKeyStore（私钥只在 KMS/HSM/加密 Secret Store）
  -> BindingStore（tenant/iid/digest/state 等非敏感元数据）
  -> TokenClient（private_key_jwt + DPoP，只缓存短期 token）
  -> InstallationRuntimeManager（按 iid 原子创建/替换/停止运行时）

平台 Resource Server
  -> 校验 workload token + DPoP + 安装实时状态
  -> 目录快照/变更、激活、轮换等最小 scope API
```

### 5.1 业务系统静态配置

V2 仅保留部署级、非组织秘密配置：

```dotenv
AGENT_INTEGRATION_ENABLED=false
KY_ENV=prod
KY_SYSTEM_ID=example-system
KY_ORIGIN=https://example-system.example.com
KY_DEPLOYMENT_MODE=single_tenant
KY_KEY_STORE_PROVIDER=aliyun_kms
```

- `AGENT_INTEGRATION_ENABLED` 默认关闭。开启只表示允许进入 `unbound` 和发起授权，不表示已经接入组织。
- `KY_DEPLOYMENT_MODE` 第一阶段允许 `single_tenant`；内部存储和 API 均按 iid 设计。`multi_tenant` 必须在跨组织测试全部通过后单独开放。
- KMS/HSM/Secret Store 的访问身份属于业务系统自身部署身份，不是组织安装凭据。开发环境可以使用临时文件适配器，Production 禁止明文私钥文件和数据库明文 JWK。
- V2 不要求 `KY_TENANT_ID`、`KY_INSTALLATION_ID`、`KY_SERVICE_CREDENTIAL`、`KY_INSTALLATION_KEY` 或 `KY_INSTALLATION_KEY_VERSION`。

### 5.2 业务系统动态绑定

`InstallationBinding` 最少包含：

```ts
interface InstallationBinding {
  installationId: string;
  tenantId: string;
  systemId: string;
  deploymentId: string;
  origin: string;
  platformIssuer: string;
  platformApiBaseUrl: string;
  keyId: string;
  grantedScopes: string[];
  registeredDigest: string | null;
  generation: number;
  state: 'activating' | 'connected' | 'degraded' | 'revoked';
  updatedAt: string;
}
```

绑定记录不保存 access token。私钥通过 `keyRef` 指向受控密钥存储；业务数据库不得保存可导出的明文私钥。

### 5.3 平台 workload access token

平台签发的 JWT 至少包含：

```json
{
  "iss": "<platform issuer>",
  "aud": "ky-app-platform-api",
  "sub": "<installationId>",
  "tid": "<tenantId>",
  "iid": "<installationId>",
  "sid": "<systemId>",
  "client_id": "<deploymentId>",
  "scope": "directory.snapshot directory.changes",
  "cnf": { "jkt": "<RFC7638 thumbprint>" },
  "iat": 0,
  "nbf": 0,
  "exp": 0,
  "jti": "<random>"
}
```

资源接口必须同时验证：平台签名、`typ`、`aud`、TTL、scope、`cnf.jkt`、DPoP proof、`ath`、HTTP method/URI、proof `jti`、安装实例当前状态、tenant/system/deployment/key 绑定。只验证 JWT 签名不算完成。

## 6. 一键授权完整流程

### 6.1 前置条件

- 系统定义及当前 Manifest 已发布。
- 安装实例已创建，origin 域名已按现有机制验证。
- 业务系统部署了支持 V2 的版本，`AGENT_INTEGRATION_ENABLED=true`。
- `/ky/v2/enrollment/challenge` 可达，但除 enrollment 和业务 live 外，未绑定状态不开放 Agent 能力。
- 当前用户是平台管理员或该安装实例登记的技术联系人；正式授权前要求重新认证。

### 6.2 顺序

1. 用户在安装实例页点击“授权并自动接入”。前端只提交 `installationId` 和一个稳定 `operationId`。
2. 平台读取安装实例、发布 Manifest、Entitlement、技术联系人、已验证 origin 和当前状态；任何缺失都 fail closed。
3. 平台生成随机 nonce，以 `act=platform` 的短期 SAT 调用业务系统 `POST /ky/v2/enrollment/challenge`。
4. 业务系统确认平台 issuer、audience、nonce 和自身 `systemId/origin`，生成或读取部署私钥、PKCE verifier、`state`，返回公钥 JWK、thumbprint、S256 challenge、固定 callback 和签名 enrollment request。
5. 平台验证签名、JWK、thumbprint、nonce、origin/callback 精确匹配和请求有效期，把请求保存为 `awaiting_consent`。
6. 页面展示组织、系统名、业务域名、deploymentId、keyId 指纹短码、能力 scopes 和风险说明；用户确认后创建一次性 authorization code。
7. 浏览器 302 到固定 callback，只携带 `code` 和 `state`。URL、Referer 和页面均不出现 token、私钥或安装秘密。
8. 业务系统 callback 校验 `state`，由后端向平台 token endpoint 发送 code、PKCE verifier、`private_key_jwt` client assertion 和 DPoP proof。
9. 平台原子消费 code，校验 PKCE、客户端断言和 DPoP，把公钥绑定到安装实例，返回平台签名的 installation grant 和仅含激活 scope 的 5 分钟 DPoP token。
10. 业务系统验证 grant 后先写入 `activating` 绑定，再由 `InstallationRuntimeManager` 创建隔离运行时；失败不能影响独立业务 HTTP 服务。
11. 业务系统用激活 token 调用 `POST /api/app-contract/v2/installations/:iid/activate`，提交当前 app version、Manifest digest、keyId 和运行时 generation。
12. 平台探测 V2 attest、`health/ready`、Manifest 和 `/me`；全部一致后 CAS 登记 digest，并把安装实例迁移为 `enabled`。
13. 平台失效该安装实例相关的 Agent 会话工具快照；当前正在执行的 run 不改变工具面，下一 run 或新会话按现有快照规则重建。
14. 页面轮询 operation 状态并显示“已接入”；失败显示脱敏 reason code、diagnosticId 和可安全重试动作。

### 6.3 超时和未知结果

- 所有 mutation 使用用户生成后保持不变的 `operationId`，服务端按操作者、安装实例和请求摘要幂等。
- 浏览器超时或收到 5xx 后只查询原 operation，不自动创建新授权请求。
- code exchange 发生响应丢失时，相同 code、client assertion `jti` 和 operationId 只能读回已提交结果，不能重复绑定或签发第二份 grant。
- 只有平台明确记录 `not_committed`、`expired` 或 `rolled_back` 后，UI 才允许新建授权。

## 7. 状态机

### 7.1 平台 Enrollment 状态

```text
created
  -> challenge_verified
  -> awaiting_consent
  -> code_issued
  -> exchanged
  -> activating
  -> ready

任一非终态 -> expired | cancelled
exchanged/activating -> failed_retryable | needs_human
```

- `ready`、`cancelled`、`expired` 为终态。
- `failed_retryable` 只允许以同一 operationId 恢复，不重新授权。
- 身份、origin、keyId 或 scope 发生变化时不得 resume，必须取消并创建新请求。

### 7.2 业务系统 Binding 状态

```text
unbound -> activating -> connected -> degraded
                         |             |
                         +-------------+
connected/degraded -> revoked
```

- `unbound` 下独立业务全部可用，Agent 能力全部关闭。
- `activating` 只允许 enrollment、token、health 和激活所需调用。
- `degraded` 不回退为匿名或独立管理员，不删除上次有效目录快照；读写门禁按目录陈旧度执行。
- `revoked` 停止同步和 Agent 路由授权，但保留业务数据、独立账号和审计记录。

## 8. API 契约草案

### 8.1 平台 API

| Method | Path                                                              | Auth                             | 用途                                                      |
| ------ | ----------------------------------------------------------------- | -------------------------------- | --------------------------------------------------------- |
| `POST` | `/api/app-contract/v2/installations/:iid/enrollment-operations`   | 平台会话                         | 创建/读取幂等授权 operation，并向精确 origin 取 challenge |
| `GET`  | `/api/app-contract/v2/enrollment-operations/:operationId`         | 原操作者                         | 查询脱敏状态                                              |
| `POST` | `/api/app-contract/v2/enrollment-operations/:operationId/approve` | 重新认证的平台管理员或技术联系人 | 固化 consent 并签发 code                                  |
| `POST` | `/api/app-contract/v2/oauth/token`                                | client assertion + DPoP          | code exchange 或已绑定部署获取短期 token                  |
| `POST` | `/api/app-contract/v2/installations/:iid/activate`                | DPoP token                       | 提交运行时 identity/digest 并触发平台探测                 |
| `POST` | `/api/app-contract/v2/installations/:iid/keys/prepare`            | DPoP token                       | 登记 next 公钥，双 key 重叠                               |
| `POST` | `/api/app-contract/v2/installations/:iid/keys/commit`             | current + next 双证明            | 切换当前 key                                              |
| `POST` | `/api/app-contract/v2/installations/:iid/revoke-deployment`       | 平台会话                         | 撤销部署身份并停止签发 token                              |

token endpoint 支持两种严格区分的 grant：

- `authorization_code`：只用于首次绑定，必须有 PKCE、client assertion 和 DPoP。
- `client_credentials`：只用于已绑定部署获取短期 workload token，必须有 client assertion 和 DPoP，不接受 client secret。

### 8.2 业务系统 API

| Method | Path                          | Auth                          | 用途                                         |
| ------ | ----------------------------- | ----------------------------- | -------------------------------------------- |
| `GET`  | `/ky/v2/health/live`          | public                        | 仅表示 Agent 适配进程/模块可达，不表示已绑定 |
| `POST` | `/ky/v2/enrollment/challenge` | platform SAT                  | 创建短期 PKCE/state 并证明部署私钥持有权     |
| `GET`  | `/ky/v2/enrollment/callback`  | code + state                  | 浏览器落点；立即转后端兑换，随后清理 URL     |
| `GET`  | `/ky/v2/attest`               | nonce + iid                   | ES256 安装证明；平台按绑定公钥验签           |
| `GET`  | `/ky/v2/integration/status`   | 本地业务管理员或 platform SAT | 返回脱敏绑定/运行状态                        |

现有 `/ky/v1/manifest`、`/ky/v1/health/ready`、`/ky/v1/me`、events 和 capabilities 在迁移期保留。V2 SAT 或路由按经过验签的 `iid` 选择 `InstallationBinding`；不得直接相信 query/header 中的 tenantId。

## 9. 数据模型与迁移

### 9.1 平台新增表

新增下一可用 governance expand migration，禁止改写已发布 migration：

- `*_ky_app_enrollment_operations`
  - `operation_id`、`installation_id`、`actor_user_id`、`request_digest`
  - `deployment_id`、`key_id`、`public_jwk_json`
  - `origin`、`callback_url`、`pkce_challenge`
  - `status`、`version`、`code_sha256`、`code_expires_at`、`code_consumed_at`
  - `grant_jti`、`last_error_code`、`diagnostic_id`、时间戳
- `*_ky_app_deployment_keys`
  - `(installation_id, key_id)` 主键
  - `deployment_id`、`public_jwk_json`、`alg='ES256'`
  - `status=current|next|previous|revoked`
  - `not_before`、`accept_until`、`revoked_at`、`generation`
- `*_ky_app_dpop_replays`
  - `(key_id, jti)` 主键、`expires_at`
  - 仅保存 proof 标识和过期时间，不保存 access token 或请求正文

安装实例表新增：

- `auth_mode`：`v1_symmetric | v2_asymmetric`，已有行默认 V1。
- `deployment_id`、`current_key_id`、`identity_generation`。
- 数据约束保证 V2 enabled 行必须存在 current key，V1 行不读取 V2 key。

迁移必须 expand-only、可重复执行，并登记 `config/release-migration-reviews.json`。contract 阶段删除旧列或旧表不在本项目第一轮范围内。

### 9.2 SDK/业务系统新增表

新增 `packages/ky-app-server/sql/002_asymmetric_installations.sql`：

- `ky_app_deployment_key_refs`：只存 `deployment_id/key_id/key_ref/status/generation`。
- `ky_app_installation_bindings`：按 `installation_id` 保存非敏感绑定和状态。
- `ky_app_enrollment_attempts`：保存 state/verifier 的加密 ref、operationId、过期和消费状态。
- 新的 V2 installation state、event ack、directory user/group/checkpoint 表全部包含 `installation_id`。

旧 V1 表保持不动。首次载入 V1 配置时使用兼容适配器；V2 不把数据写入 V1 单例表。未来 contract migration 只有在所有生产安装都迁移并完成回滚窗口后才能删除 V1 表。

## 10. 代码工作包

每个工作包独立分支、独立 PR、独立本地 commit。依赖顺序不得打乱；每个 PR 合并前重新同步当前 `main` 并运行受影响门禁。任何 Workflow 改动都必须先单独取得用户确认。

### WP0：ADR、威胁模型和契约测试向量

依赖：无。

改动：

- 新增 `docs/architecture/ky-app-v2-asymmetric-identity.md`。
- 新增 `docs/security/ky-app-v2-threat-model.md`。
- 冻结 enrollment request、installation grant、client assertion、workload token、DPoP 和 attest 的正反向 JSON/JWS 测试向量。
- 明确平台管理员、技术联系人、业务系统部署身份、Agent 用户身份四类主体不可互相替代。

退出标准：

- 覆盖 code 注入、PKCE 降级、redirect 替换、JWK 私钥泄露、alg 混淆、JWT 类型替换、DPoP 重放、跨组织 key 复用、DNS rebinding、SSRF、未知提交结果和多副本 split-brain。
- 对每个威胁写出自动化测试落点和监控信号。

### WP1：`@kaiyan/ky-app-contract` V2 契约

依赖：WP0。

主要文件：

- `packages/ky-app-contract/src/types/constants.ts`
- `packages/ky-app-contract/src/types/claims.ts`
- 新增 `packages/ky-app-contract/src/types/enrollment.ts`
- 新增 `packages/ky-app-contract/src/types/workload.ts`
- 新增对应 Schema、validators、vectors 和测试

实现：

- 保留 `CONTRACT_VERSION=1` 的既有导出，新增 V2 常量和显式版本协商，避免直接改值破坏旧客户端。
- 定义全部 `typ`、claims、scope、错误码、TTL、endpoint 和状态枚举。
- 提供 JWK public-only 校验、RFC 7638 thumbprint、PKCE S256 和 DPoP claims 的纯函数。
- 测试拒绝错误 aud/iss/iid/tid/origin/keyId、过长 TTL、重复 jti、Bearer 降级和未知字段。

验证：

```bash
pnpm --filter @kaiyan/ky-app-contract typecheck
pnpm --filter @kaiyan/ky-app-contract test
pnpm --filter @kaiyan/ky-app-contract build
```

### WP2：平台 V2 存储、密钥绑定和 token 服务

依赖：WP1。

主要文件：

- 新增 `server/src/kyapp/enrollment/`
- 新增 `server/src/kyapp/workload/`
- `server/src/kyapp/assembly.ts`
- `server/src/kyapp/installations/service.ts`
- `server/src/data/governance-schema/` 下一可用 expand migration
- `config/release-migration-reviews.json`

实现：

- Enrollment operation 的 lock/reload/validate/mutate/atomic publish 流程。
- authorization code 只保存 SHA-256，原子单次消费。
- client assertion 和 DPoP `jti` 的 PostgreSQL 原子防重放及 TTL 清理。
- 平台签发 5 分钟 `ky-workload-at+jwt`，token 不落库、不写日志。
- 每次资源请求实时检查安装、组织、系统、deployment/key generation 和 scope。
- `auth_mode=v2_asymmetric` 后 V1 credential 路由对该安装返回明确冲突，不允许降级。

验证：

- 内存测试覆盖全部错误码。
- 真实 PostgreSQL 测试覆盖并发消费 code、并发 DPoP jti、CAS、过期清理和跨进程竞争。
- secret scan 证明数据库、日志、审计不包含 code 明文、token 或私钥。

### WP3：平台授权路由和管理页面

依赖：WP2。

主要文件：

- 新增 `server/src/kyapp/routes/enrollment.ts`
- `server/src/kyapp/routes/installations.ts`
- `server/src/auth/publicRoutes.ts`
- `web/src/components/KyAppCredentialClaim/`
- `web/src/components/SystemDelivery/`
- `web/src/lib/kyAppManagementTypes.ts`
- `e2e/ky-app-management/`

实现：

- 原领取页面主操作改为“授权并自动接入”，展示组织、origin、scope、key 指纹和状态进度。
- “手动配置旧版 V1”折叠为兼容入口，并明确只适用于旧 SDK。
- approve 前重新认证；浏览器只看到 operationId、code、state 和脱敏状态。
- callback 必须精确匹配已验证 origin；出站复用 KY App 现有 SSRF/DNS/重定向安全策略。
- 页面超时后查询原 operation，不重复创建或兑换。

验证：

- 组件测试覆盖取消、过期、重复点击、刷新恢复、无权限、origin/key 变化和 unknown outcome。
- Playwright 断言 URL、localStorage、sessionStorage、下载、剪贴板和控制台均无秘密。

### WP4：SDK 动态绑定、非对称 attest 和 DPoP client

依赖：WP1、WP2 的 token 契约。

主要文件：

- `packages/ky-app-server/src/config/`
- 新增 `packages/ky-app-server/src/enrollment/`
- 新增 `packages/ky-app-server/src/identity/`
- 新增 `packages/ky-app-server/src/workload/`
- `packages/ky-app-server/src/hono/router.ts`
- `packages/ky-app-server/src/hono/runtime.ts`
- `packages/ky-app-server/src/directory/client.ts`
- `packages/ky-app-server/src/local/attest.ts`
- `packages/ky-app-server/sql/002_asymmetric_installations.sql`

新增接口：

```ts
interface DeploymentKeyStore {
  current(): Promise<{ deploymentId: string; keyId: string; keyRef: string }>;
  sign(keyRef: string, payload: Uint8Array): Promise<Uint8Array>;
  prepareRotation(): Promise<{ keyId: string; publicJwk: JsonWebKey }>;
  commitRotation(keyId: string): Promise<void>;
}

interface InstallationBindingProvider {
  get(installationId: string): Promise<InstallationBinding | null>;
  list(): Promise<InstallationBinding[]>;
  stage(binding: InstallationBinding): Promise<void>;
  activate(installationId: string, expectedGeneration: number): Promise<void>;
  revoke(installationId: string, expectedGeneration: number): Promise<void>;
  subscribe(listener: (change: BindingChange) => void): () => void;
}
```

实现：

- 主业务先启动；Agent adapter 可以保持 `unbound`，不能因平台不可达退出进程。
- enrollment router 常驻但严格限速；业务能力路由按有效 binding 和已验证 SAT 选择上下文。
- directory client 每次取短期 token；token cache key 至少包含 iid、keyId、scope 和 generation，提前 60 秒刷新。
- 401/invalid_dpop_proof 只进行一次有界重新取 token；unknown mutation 不自动重放。
- attest 使用 ES256 部署私钥，平台 keyId 选择公钥；不再使用安装共享密钥。
- Local Login/Break Glass 改用业务系统自己的独立 `LocalAuthKeyProvider`，不复用部署身份私钥。
- runtime 切换遵循 stage -> validate -> start -> atomic swap -> drain old；失败保留最后有效 generation。

验证：

- 零绑定启动、动态接入不重启、撤销、平台断连、KMS 暂时不可用、token 续期、key rotation、旧 generation drain。
- 两个进程共享 PostgreSQL/KMS 模拟多副本，证明不会一个实例新 key、另一个实例旧 key 后提前 commit。

### WP5：脚手架与参考业务系统升级

依赖：WP4。

主要文件：

- `packages/create-ky-app/templates/hono-vue/server/config.ts`
- `packages/create-ky-app/templates/hono-vue/server/index.ts`
- `packages/create-ky-app/templates/hono-vue/server/app.ts`
- 模板 `.env.example`、README、迁移和测试
- `packages/create-ky-app/src/generate.test.ts`
- `packages/ky-app-cli/` doctor 与本地 mock 平台

实现：

- 新项目默认独立运行，`AGENT_INTEGRATION_ENABLED=false`。
- 不再在进程入口无条件调用完整 KY 配置加载。
- 提供业务管理员可见的脱敏集成状态页和“允许接入”开关。
- CLI doctor 增加 V2 enrollment、DPoP、attest、动态接入和撤销测试；保留 V1 doctor。
- 模板继续配置 husky + lint-staged；不自动启用或修改 Workflow。

验证：

```bash
pnpm --filter @kaiyan/create-ky-app typecheck
pnpm --filter @kaiyan/create-ky-app test
pnpm --filter @kaiyan/create-ky-app build
pnpm --filter @kaiyan/ky-app-cli typecheck
pnpm --filter @kaiyan/ky-app-cli test
pnpm --filter @kaiyan/ky-app-cli build
```

然后在临时目录生成全新项目，验证无 KY 绑定生产构建可启动、真实独立登录/读写可用，再执行一次本地 V2 自动授权且进程 PID 不变化。

### WP6：平台激活、Gateway 和会话快照闭环

依赖：WP3、WP4、WP5。

主要文件：

- `server/src/kyapp/delivery/onboard.ts`
- `server/src/kyapp/delivery/existingOnboard.ts`
- `server/src/kyapp/delivery/diagnostics.ts`
- `server/src/kyapp/installations/readiness.ts`
- `server/src/kyapp/health/prober.ts`
- `server/src/kyapp/gateway/snapshot.ts`
- `server/src/kyapp/assembly.ts`

实现：

- onboarding 的等待点从 `credential_claim_required` 增加 V2 `authorization_required/activation_pending`。
- 激活严格按 current published digest 探测；平台 readiness、业务系统 ready 和 `/me` 不一致时不切 enabled。
- 授权完成触发 installation 状态事件与跨进程快照失效。
- 保持当前 run 工具面稳定；下一 run 重建或 UI 明确提示“能力已更新，将在下一次运行生效”。
- 真实能力成功前，管理页不得只根据 token exchange 显示“可用”。

验证：

- V1/V2 安装并存。
- 授权成功但 `/me` 失败、digest 旧、无 Assignment、跨组织用户、安装被禁用时均不投影工具。
- 当前 run 不抖动，下一 run/new session 能看到对应 `app__<systemId>__<capabilityId>`。

### WP7：V2 密钥轮换与撤销

依赖：WP4、WP6。

轮换流程：

1. 业务系统生成 next 私钥，私钥不离开 KMS。
2. 使用 current key 和 next key 分别提交 proof，平台登记 `next`。
3. 所有业务实例加载 next key，并按 instance heartbeat 报告 generation/keyId。
4. 平台确认期望实例全部就绪后将 next CAS 为 current，旧 key 进入 previous 窗口。
5. 业务系统切换签名，平台观察真实 token/attest 成功后撤销 previous。

不得沿用当前“新凭据 ack 后立即撤销所有旧凭据”的收口方式处理多副本 V2。未知结果保留 operationId，先查询状态。

撤销流程必须同时做到：停止 token 签发、资源接口实时拒绝、发送 installation event、业务系统停止同步、快照失效、保留审计和独立业务数据。

### WP8：Staging 真实验收与渐进发布

依赖：WP0-WP7。

执行顺序：

1. 冻结同一 RC/SHA、SDK 套件 digest、Manifest digest 和测试系统 SHA。
2. 在独立测试系统部署 V2，但保持自动接入关闭；先验收独立业务。
3. 启用 enrollment，不注入任何组织安装秘密。
4. 在 Staging 页面完成真实浏览器一键授权，记录业务系统 PID 前后未变化。
5. 回读平台 enrollment/key/installation/runtime 表和业务系统 binding/keyRef 状态；禁止输出秘密。
6. 验证 platform -> business attest/ready/manifest/me。
7. 用授权成员的新会话调用一个真实只读能力；用无授权用户和其他组织用户验证拒绝。
8. 执行密钥轮换、多副本、平台断连、callback 响应丢失、重复 code、DPoP 重放和撤销演练。
9. 完成同一 RC 的浏览器、HTTP、PostgreSQL、日志和业务结果证据后，才允许讨论 Production。

运行任何部署或验收 Workflow 前必须先取得用户明确确认。

## 11. 测试矩阵

| 层级       | 必测内容                                    | 通过口径                                      |
| ---------- | ------------------------------------------- | --------------------------------------------- |
| 契约       | 全部 JWT/PKCE/DPoP vectors 与错误向量       | Node 端平台和 SDK 交叉签发/验签一致           |
| 单元       | 状态机、scope、TTL、aud/iss、key generation | 每个拒绝都有稳定错误码                        |
| PostgreSQL | code/jti 原子消费、CAS、并发、多进程        | 并发只有一个提交者成功，其他读回同一结果      |
| 进程       | 无绑定启动、热接入、撤销、重连              | PID 不变化，独立业务始终可用                  |
| 浏览器     | 授权、取消、刷新、超时恢复                  | URL/storage/console/下载中无秘密              |
| 网络故障   | token/activate/callback 响应丢失            | 不重复绑定，不误报成功，可按 operationId 恢复 |
| 多副本     | 新旧 key generation、leader/worker 重启     | 未全体就绪不 commit，旧 generation 有界 drain |
| 租户隔离   | iid/tid/key/origin/用户交叉组合             | 全部 fail closed，无数据或工具泄露            |
| 业务验收   | 页面、目录、`/me`、Agent 能力               | 新会话存在真实 `app__*` 并成功读业务数据      |
| 回滚       | 禁用 V2、保留 V1、撤销 V2                   | 不删除业务数据，不要求普通发版重领身份        |

仓库级本地门禁按受影响范围执行：

```bash
pnpm --filter @kaiyan/ky-app-contract typecheck
pnpm --filter @kaiyan/ky-app-contract test
pnpm --filter @kaiyan/ky-app-server typecheck
pnpm --filter @kaiyan/ky-app-server test
pnpm --filter @kaiyan/ky-app-cli typecheck
pnpm --filter @kaiyan/ky-app-cli test
pnpm --filter server typecheck
pnpm --filter server test
pnpm --filter web typecheck
pnpm --filter web test
pnpm check:ratchets
pnpm build
```

实际脚本名以各工作包开始时的 `package.json` 为准；不存在的命令不得假装通过。

## 12. 兼容迁移与发布开关

### 12.1 平台开关

开关必须进入现有 `config.json` 的 `kyApp` 配置域，不新增散落环境变量：

- `kyApp.enrollmentV2.enabled=false`
- `kyApp.enrollmentV2.allowedSystemIds=[]`
- `kyApp.enrollmentV2.issueWorkloadTokens=false`
- `kyApp.enrollmentV2.requireDpop=true`，生产不可关闭

顺序：代码和 expand migration -> V1/V2 双读 -> 仅测试系统 allowlist -> Staging 全链路 -> 小范围 Production allowlist -> V2 默认 -> 停止新建 V1。旧 V1 的删除属于后续 contract 项目。

### 12.2 降级规则

- V1 安装继续使用现有 credential/HS256 流程。
- `auth_mode=v2_asymmetric` 的安装不接受 V1 credential、HS256 attest 或 Bearer workload token。
- 如果 V2 adapter 故障，平台可禁用该安装；不得自动改回 V1。
- 需要人工回退时必须创建新的受审计 operation、重新授权并明确数据迁移，不复用已经撤销的 V1/V2身份。

## 13. 回滚方案

### 13.1 合并前

每个 WP 独立 revert，不回滚已应用的 expand migration；未启用 feature flag 时不得影响 V1。

### 13.2 Staging/Production 运行中

1. 关闭目标 systemId 的 V2 allowlist，阻止新授权。
2. 保持 token 验证和撤销路径在线，不能先关闭验证器导致已发 token 绕过状态检查。
3. 对故障安装切 `disabled`，停止新 token 和能力投影。
4. 保留 enrollment operation、部署公钥、binding metadata 和审计，不删除业务数据。
5. 如发生私钥泄露，撤销对应 key generation；业务系统生成新 key 并走显式恢复授权，不能仅关闭 UI。
6. 回滚应用版本后，数据库保留新表；旧代码不得读取或误解释 V2 数据。

## 14. 可观测性与告警

日志和指标只记录 ID、摘要和状态：

- `enrollment_operation_total{status,reason}`
- `enrollment_duration_seconds`
- `workload_token_issue_total{grant_type,result}`
- `dpop_replay_rejected_total`
- `deployment_key_generation{installation_id}`
- `binding_runtime_state{state}`
- `binding_reload_total{result}`
- `installation_activation_total{result,reason}`
- `agent_tool_snapshot_invalidation_total{reason}`

禁止记录 authorization code、PKCE verifier、client assertion、DPoP proof、access token、私钥 JWK、完整公钥或请求 Authorization header。错误响应只返回稳定 reason code 和 diagnosticId。

首版目标 SLO：

- 正常授权从用户确认到平台 ready 的 P95 小于 30 秒。
- 动态绑定切换期间独立业务错误率无可测上升。
- 平台短暂不可达时，业务系统独立接口不等待平台网络请求。
- 停用/撤销在平台资源接口立即生效；Agent 工具投影按事件/下一 run 刷新，不超过现有状态传播上限。

## 15. 开发前必须确认的产品决策

以下默认值已经给出，若产品负责人不同意，应在 WP0 改 ADR，而不是开发中途隐式变化：

| 决策                           | 本方案默认                                                                       |
| ------------------------------ | -------------------------------------------------------------------------------- |
| 谁能授权                       | 平台管理员或安装实例技术联系人，approve 前重新认证                               |
| 是否需要业务系统管理员二次确认 | 默认由业务系统部署时开启 enrollment 表示预授权；高敏系统可配置本地管理员二次确认 |
| 首个生产范围                   | `single_tenant` 部署；存储/API 从第一天按 iid 设计                               |
| 是否支持私网系统               | 第一版要求平台和浏览器可达已验证 HTTPS origin；私网 device flow 后续单列         |
| access token                   | 5 分钟 DPoP token，无 refresh token                                              |
| 密钥算法                       | P-256/ES256，保留算法敏捷接口但第一版拒绝其他算法                                |
| V1 手动领取                    | 迁移期保留，只服务 `auth_mode=v1_symmetric`                                      |
| 授权后当前会话                 | 不改变正在执行的 run；下一 run 或新会话重建工具快照                              |

## 16. Definition of Done

只有以下项目全部满足，才能宣布“组织可一键授权且无需重启接入”：

- [ ] WP0-WP8 代码、测试、迁移评审、安全评审和真实 Staging 验收全部完成。
- [ ] 业务系统无组织凭据也能生产模式启动并完成真实独立业务。
- [ ] 浏览器授权全程无长期秘密，重复/过期/取消/响应丢失均可恢复。
- [ ] 业务系统 PID 在授权前后不变，binding generation 单调增加。
- [ ] 平台只保存公钥，业务系统私钥不可导出且不进入数据库明文、日志、Git 或前端。
- [ ] 短期 token 必须 DPoP-bound，Bearer 降级、proof/token 重放和跨安装替换全部拒绝。
- [ ] V1 与 V2 并存回归通过，V2 不能静默降级 V1。
- [ ] 同一 RC/SHA/digest 的 Staging 页面、HTTP、PostgreSQL、日志和密钥状态证据通过。
- [ ] 授权用户的新会话出现正确 `app__*` 工具并完成真实只读业务调用。
- [ ] 无授权用户和其他组织用户无法看到页面、目录、工具或业务数据。
- [ ] 密钥轮换、多副本、撤销、平台断连和回滚演练通过。
- [ ] Production 发布、Workflow、组织授权和真实密钥操作均另行取得用户明确授权。
