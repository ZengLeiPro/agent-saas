# KY App V2 非对称部署身份 ADR

- 状态：Accepted
- 日期：2026-09-14
- 决策范围：KY App 组织安装、工作负载认证、安装证明、动态绑定
- 关联方案：`docs/plans/ky-app-asymmetric-one-click-installation.md`
- 后续实现：WP1-WP8；本 ADR 不启用功能、不修改 Workflow、不授权部署

## 背景

KY App V1 把组织、安装实例、服务凭据和安装密钥作为启动级环境变量。领取页会把长期秘密交给浏览器和人工，SDK 在构造时捕获凭据，并用安装共享密钥同时承担安装证明和本地令牌职责。结果是首次接入、续期和轮换都要求复制秘密并重启业务系统，且难以把部署身份、平台管理员、技术联系人和真实业务用户分开审计。

V2 要解决的是部署身份与组织安装的安全绑定，不改变业务系统独立运行、独立登录和业务权限模型。V1 仍需兼容已有安装。

## 决策

### 1. 身份与信任边界

四类主体必须分别认证和授权，任何一类都不能替代另一类：

| 主体             | 身份来源                            | 可做的事                                           | 明确不能做的事                            |
| ---------------- | ----------------------------------- | -------------------------------------------------- | ----------------------------------------- |
| 平台管理员       | KY Agent 平台会话与重新认证         | 为有权管理的组织批准安装                           | 代替业务用户访问业务数据；读取部署私钥    |
| 安装技术联系人   | 安装实例登记身份与重新认证          | 批准自己负责的安装                                 | 扩大 Entitlement、Assignment 或业务权限   |
| 业务系统部署身份 | 部署侧 P-256 私钥                   | 证明部署、兑换授权码、获取 DPoP token、签署 attest | 代表自然人；自行选择 tenant、iid 或 scope |
| Agent 业务用户   | 平台用户、Assignment 与业务主体映射 | 在业务权限内调用能力                               | 继承管理员或部署身份权限                  |

平台授权只绑定部署身份与既有安装实例。它不创建组织、不赠送权益、不扩大 Assignment，也不授予业务系统数据权限。

### 2. 协议与密码学基线

- 部署身份使用 P-256/ES256；`keyId` 是 RFC 7638 SHA-256 JWK Thumbprint。
- 首次绑定使用 authorization code + PKCE S256。授权请求最长 10 分钟，授权码最长 60 秒且只能原子消费一次。
- code exchange 使用 ES256 `private_key_jwt` 和 DPoP；client assertion 最长 60 秒且 `jti` 只能消费一次。
- 后续使用 `client_credentials` 获取最长 5 分钟的 DPoP-bound workload token，不签发 refresh token，不接受 client secret。
- DPoP proof 接受窗口为 60 秒，时钟容忍 10 秒，校验 `htm`、规范化后的 `htu`、`iat`、`jti`；资源请求还校验 `ath`。
- 安装证明使用部署私钥签署 ES256 `ky-attest-v2+jwt`，平台按安装实例当前公钥验签。
- Staging/Production 只允许 HTTPS；callback 固定为已验证 origin 下的 `/ky/v2/enrollment/callback`，必须逐字节精确匹配规范化结果，出站请求不跟随跨 origin 重定向。

各 JWT 类型使用互斥验证入口，不提供“自动识别并宽松验证”的公共函数：

| `typ`                       | 签发方   | 验证方                       | 固定受众/用途             |
| --------------------------- | -------- | ---------------------------- | ------------------------- |
| `ky-enrollment-request+jwt` | 部署身份 | 平台                         | 一次 enrollment operation |
| `ky-installation-grant+jwt` | 平台     | 业务系统                     | 一次安装绑定              |
| `ky-client-auth+jwt`        | 部署身份 | 平台 token endpoint          | client authentication     |
| `ky-workload-at+jwt`        | 平台     | 平台资源接口                 | `ky-app-platform-api`     |
| `dpop+jwt`                  | 部署身份 | 平台 token/resource endpoint | 单次 HTTP 请求 proof      |
| `ky-attest-v2+jwt`          | 部署身份 | 平台探测器                   | 一次安装状态证明          |

所有验证器固定 `alg`、`typ`、issuer、audience、必填 claims、最大 TTL 和 key source；拒绝 `none`、HS/ES 混淆、未知 `crit`、重复 claim、私钥 JWK 成员以及 V1/V2 类型替换。

### 3. 密钥所有权与存储

业务系统首次启用 V2 时在受控的 `DeploymentKeyStore` 中生成不可导出的部署私钥。Production 使用 KMS/HSM/加密 Secret Store；平台、浏览器、URL、业务数据库、日志和审计 metadata 永远不接收私钥。

平台只保存经过 public-only 校验的公钥 JWK、thumbprint、deploymentId、generation 和状态。业务系统绑定库只保存 `keyRef` 与非敏感的组织绑定 metadata，不保存 access token 或明文私钥。测试向量中的密钥仅为公开测试材料，禁止作为环境密钥。

平台签名密钥与部署身份密钥必须不同；验证 `ky-installation-grant+jwt`/`ky-workload-at+jwt` 时只查平台 key set，验证 enrollment/client-auth/DPoP/attest 时只查与该 installation/deployment/generation 绑定的部署公钥。

### 4. 动态绑定与运行时

业务 HTTP 服务先于 Agent adapter 启动。没有绑定、平台不可达或 KMS 暂时不可用时，核心业务仍可登录和读写，集成状态为 `unbound` 或 `degraded`。

V2 路由常驻。授权完成后，SDK 按 `installationId` 执行 `stage -> validate -> start -> atomic swap -> drain old`，generation 只增不减。失败保留最后有效 generation，不要求重启进程。首个生产范围为 `single_tenant` 部署，但新表、缓存键和 API 从第一天按 `installationId` 分区。

### 5. 防重放、未知结果与降级

- authorization code 仅保存 SHA-256，消费、绑定和 grant 结果在同一数据库事务中提交。
- client assertion 与 DPoP 的 `(keyId, jti)` 通过 PostgreSQL 唯一约束原子占用，并按过期时间清理。
- 每个 mutation 使用调用方生成且重试时保持不变的 `operationId`；超时或 5xx 后只查询原 operation。
- 只有明确记录 `not_committed`、`expired` 或 `rolled_back` 才能创建新授权。
- `auth_mode=v2_asymmetric` 一经激活，不接受 V1 credential、HS256 attest 或 Bearer workload token。恢复或回退必须走新的受审计操作。

### 6. 授权与产品默认值

本 ADR 接受方案中的默认决策：

- 平台管理员或安装技术联系人可以授权，approve 前必须重新认证。
- 部署时开启 enrollment 表示业务系统侧预授权；高敏系统可增加本地管理员二次确认。
- 第一版支持平台和浏览器可达的已验证 HTTPS origin；私网 device flow 后续另立 ADR。
- 正在执行的 run 不改变工具面；下一 run 或新会话重建快照。
- V1 手动领取仅在迁移期服务 `v1_symmetric` 安装。

## 备选方案与拒绝理由

| 方案                                | 结论 | 原因                                                                       |
| ----------------------------------- | ---- | -------------------------------------------------------------------------- |
| 继续复制长期 client secret          | 拒绝 | 秘密暴露面大，续期和轮换仍要求人工及重启                                   |
| 浏览器生成或保存部署私钥            | 拒绝 | 浏览器存储、扩展、日志和 XSS 会进入长期身份信任边界                        |
| Bearer access token + refresh token | 拒绝 | token 被窃取后可独立使用，refresh token 形成新的长期秘密                   |
| mTLS 作为第一版                     | 暂缓 | 安全属性可行，但证书签发、代理透传和多副本运维成本高于当前 P-256/DPoP 路径 |
| 动态 OAuth client registration      | 暂缓 | 扩大协议面和注册治理，当前 installation 已提供更窄的信任锚                 |
| V2 故障时自动回退 V1                | 拒绝 | 形成降级攻击并重新引入已撤销的共享秘密                                     |
| 新协议继续使用单例表                | 拒绝 | 阻断未来多安装，并使缓存、重放和轮换产生跨安装碰撞                         |

## 结果与约束

正面结果是浏览器和人工不再接触长期秘密、部署身份可独立撤销与轮换、短期 token 被窃取后不能脱离 DPoP key 使用，并可在不重启业务系统的情况下绑定组织。

代价是平台必须维护授权状态机、原子防重放、DPoP 验证、密钥 generation 和实时安装状态检查；SDK 必须引入受控密钥存储、动态运行时和多副本轮换协议。token exchange 成功不等于可用，只有 digest、attest、ready、`/me` 和 Agent 新会话真实只读调用全部通过才可宣称接入完成。

## 实施与回滚门禁

WP1-WP8 必须按方案依赖顺序独立 PR 实施。expand migration 不随应用回滚删除；feature flag 默认关闭。任何 Workflow 修改、部署、真实组织授权、真实凭据签发/撤销或 Production 操作都需要另行明确授权。
