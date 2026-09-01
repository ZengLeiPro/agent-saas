# Release-bound Config Identity（配置身份）

> 对应任务：TASK-318。本文定义「Release 期望的配置身份」与「Runtime 实际观察到的
> 配置身份」的版本化契约、唯一 digest 语义、四态判定与产品内呈现规则。
> 与 `production-component-identity.md`（组件制品身份）互补：那份回答「跑的是哪份代码」，
> 这份回答「生效的是哪份配置语义」。

## 1. 解决什么问题

在此契约之前：

- ACS 的 `configFingerprint` 是 `acs-orchestrator.env` 原始字节的 SHA-256；
  Web / 汇总 identity 的 `configFingerprint` 却是 Release Manifest digest——两者
  **语义不同、不可比**，都不能回答「当前生效配置是否等于发布时的配置」。
- 配置热更新（`SharedConfigRefresher`）在进程内局部原地替换配置对象，发布侧
  无法感知运行中进程的配置已经偏离发布时点。
- SecretVault 凭据轮换（rotate）复用同一 ref id 原地更新，配置文件不变，
  任何基于文件字节的指纹都察觉不到轮换。
- Production 缺少「已有 SecretVault ref 方案的 inline secret」的 fail-closed
  门禁（environmentSafety 的 production 分支此前直接放行）。

## 2. 契约（schemaVersion = 1）

### 2.1 canonical projection

对 **parse 之后的 AppConfig**（Zod 校验 + 默认值填充后）做投影：

| 输入形态                                                                            | 投影结果                                                                                                                                                                 |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 普通有效配置字段                                                                    | 原值（键按 `canonicalJson` 排序）                                                                                                                                        |
| JSONC 注释 / 原始文本排版                                                           | 不存在（parse 时天然消除）                                                                                                                                               |
| 受管 inline/ref 双形态字段的 inline 值（含 memory embedding / model group API key） | `{form:'inline'}`（明文不进投影）                                                                                                                                        |
| 受管字段的 ref id                                                                   | `{form:'ref', ref: sha256(refId)}`（不可逆、不含 ref id 本身）                                                                                                           |
| 无 ref 替代方案的 secret 值字段（jwtSecret/appSecret/tts 等）                       | `{__redacted:'secret'}`                                                                                                                                                  |
| URL（webhook/代理/signed URL 等）                                                   | 保留无凭据 endpoint；userinfo/query/hash 剥除                                                                                                                            |
| DB 连接串                                                                           | 只保留 host/database                                                                                                                                                     |
| 绝对机器存储路径（agent.cwd、vault file、artifact root 等）                         | 不进投影（同语义配置在不同主机目录得到相同 digest）                                                                                                                      |
| 相对机器存储路径                                                                    | 先按运行期 `path.normalize` 规则 canonicalize，再投影为 `{__opaqueDigest__: sha256(...)}`；`./x`、`x`、`x/../x` 等解析后等价路径 identity 相同，目标变化可见且原值不可见 |
| 语义路径/任意 payload（sandbox 路径、extraBody、setupCommands、repo URL）           | `{__opaqueDigest__: sha256(...)}`，变化可见但原值不可见                                                                                                                  |
| env 值（dispatch.env/proxy 的 value）                                               | `{__opaqueDigest__: sha256(...)}`（键与变化信号保留，原值不可见）                                                                                                        |

已发布投影语义的任何变化都必须递增 `CONFIG_IDENTITY_SCHEMA_VERSION` 并显式迁移，
**不允许静默改变 digest 语义**。

### 2.2 digest

- `digest = sha256("agent-saas-config-identity-v1\0" + canonicalJson(projection))`
  —— 独立 domain separator，与 Manifest digest / 组件 artifact digest 不可混用。
- `credentialVersionDigest = sha256("agent-saas-config-credential-versions-v1\0"
  - canonicalJson({[refDigest]: version}))`
    —— 只覆盖受管 SecretVault ref 的 **opaque version**（put=1，rotate/revoke 递增；
    不含任何明文）。配置语义 digest 不含 vault 版本，保证 expected（部署期可能
    无 vault 访问）与 observed 可比；轮换只改变 credentialVersionDigest。

### 2.3 四态判定

| status          | 含义                                                                                              |
| --------------- | ------------------------------------------------------------------------------------------------- |
| `consistent`    | expected 与 observed digest 一致，且（若双方都携带）credentialVersionDigest 一致                  |
| `drifted`       | digest 不一致，或轮换后 credentialVersionDigest 不一致                                            |
| `unverifiable`  | 已采集但不足以判定（expected 未绑定 / ref 版本不可解析 / schema 版本不支持），附机器可读 `reason` |
| `not_collected` | Runtime 尚未采集 observed identity                                                                |

wire 契约（`shared/src/schemas/configIdentity.ts`）被 server / web 共用，Release
State / Evidence 的独立进程校验器保持同构；除字段形态外还校验四态关系（例如
`consistent` 必须是受支持 schema、相同 digest 且 versionResolution=resolved）。
overview snapshot 在 wire 层再校验一次，不合法载荷降级为 `null` + 待关注项，
**绝不渲染成正常值**。

## 3. 字段所有权（谁在哪算）

| 角色                          | 位置                                                                                | 职责                                                                                     |
| ----------------------------- | ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| canonical projection / digest | `server/src/release/configIdentity.ts`                                              | 唯一实现；运行期与部署 CLI 共用                                                          |
| wire 契约                     | `shared/src/schemas/configIdentity.ts`                                              | 四态词汇、摘要 schema、`parseConfigIdentitySummary`                                      |
| observed runtime              | `server/src/runtime/configIdentityRuntime.ts`                                       | 启动计算、热更新重算、5s 节流摘要                                                        |
| expected 绑定                 | deploy 脚本 → release env → `readExpectedConfigIdentity`                            | `AGENT_SAAS_CONFIG_IDENTITY_DIGEST`（+ 可选 SCHEMA_VERSION / CREDENTIAL_VERSION_DIGEST） |
| 部署期 CLI                    | `server/src/release/configIdentityCli.ts`（构建产物 `dist/config-identity-cli.js`） | 在部署主机上对实际 config.json 计算 expected identity                                    |
| 前端                          | `web/src/components/PlatformAdmin/pages/ConfigIdentityCard.tsx`                     | 平台概览只读区块（四态 + 摘要）                                                          |

### 受管凭据注册表

`configIdentity.ts` 中的注册表是**显式清单**：只登记已有 SecretVault ref 安全
方案的 inline/ref 双形态字段（serverRemote / tenantRemoteHands / clientDaemon /
stt / webTools / imageGenTools / memory embedding / models.groups 共 12 组 +
codexSubscription credentialRef(s) ref-only），不做字段名后缀猜测。tts / alerting
等当前没有 ref 方案的旧字段只做投影脱敏，不伪装成可追踪轮换的受管凭据。
Production 门禁（`assertProductionManagedCredentialSafety`）基于同一注册表判定，
避免误杀普通字符串配置。

## 4. 安全语义

1. **脱敏硬约束**：投影、digest 输入、API 载荷、日志、页面文本中不允许出现
   secret 明文、可逆密文、连接串、token、本机绝对路径。ref 只保留
   domain-separated sha256。signedUrl 仅保留 protocol/host/port origin，完全丢弃
   userinfo/path/query；数据库连接只保留规范 protocol/host/port/database 与严格
   allowlist 的枚举/数值行为参数。
2. **Production fail closed**：
   - 部署期：`config-identity-cli --environment production` 调用
     `assertProductionManagedCredentialSafety`——已有 ref 方案的字段出现 inline
     值直接报错，部署中止。
   - 运行期：`createConfigIdentityRuntime.initialize()` 在 production 下若存在
     受管 ref 且版本解析非 resolved（vault 元数据不可得 / ref 缺失）则抛错拒启。
   - staging：`readRuntimeIdentity` 要求 expected config identity 必须绑定
     且 schemaVersion=1，否则启动失败（Staging 是发布链路的验证环境）。
3. **凭据轮换/撤销可见**：rotate 与 revoke 都递增 opaque version；revoked ref
   无论 version 是否可读都按 unverifiable 处理，绝不进入 consistent。EncryptedFile/InMemory 直接
   `inspectRef`，HttpSecretVault 缓存未命中时调用 metadata-only
   `POST /secrets/inspect`（只返回 `SecretRef` 元数据，不拉明文）。metadata cache
   默认 5 秒到期重检，`invalidate` 也会立即失效，因此外部 KMS rotate/revoke 不会永久
   复用旧 version。端点缺失、ref 缺失或版本非法都按不可验证处理，Production
   有受管 ref 时拒启/拒绝发布。resolved 版本变化会改变 observed
   credentialVersionDigest → 四态转 `drifted`。

## 5. 热更新与 drift 语义

`SharedConfigRefresher` 在 config 文件重载成功后调用 `onConfigReloaded` →
`configIdentityRuntime.notifyConfigChanged('config_file_hot_reload')` 异步重算：

- 重算成功：发布新 observed identity；digest 或 credentialVersionDigest 变化
  时更新 `lastChangedAt` 并记录日志。显式热更新与周期重算共享单调 generation，
  较慢的旧计算即使晚完成也只会被丢弃，不能覆盖更新快照。
- Production 在应用新配置前先跑 inline-secret 安全门禁，并异步解析候选配置中
  所有受管 ref 的 version；任一校验失败则整次重载保留旧内存配置。校验期间热路径
  继续使用旧配置。webTools 与 STT 都使用 prepare/commit 两阶段：SecretVault 明文解析只
  产生无副作用 commit，候选文件仍为最新版且前置回调全部成功后，执行侧配置与 AppConfig
  才在同一发布点更新；旧 observed identity 同步失效为 `not_collected`，随后异步重算。
  身份重算若失败则维持保守态并告警，不恢复旧 `consistent` 或发布半成品摘要。
- overview snapshot 15s 轮询读取摘要；前端用单调 generation 丢弃晚到的旧响应。
  `getSummary` 有 5s 节流，避免每次轮询都解密 vault 文件。

## 6. 发布链路

1. `deploy-production-release.sh` / `deploy-staging-release.sh` 在部署时调用
   `dist/config-identity-cli.js` 对部署主机上的实际 config.json 计算
   `{schemaVersion, digest, credentialVersionDigest}`（production 额外执行
   inline-secret fail-closed；CLI 通过 `--process-cwd`、`--runtime-data-dir` 与
   `--env-file` 读取和运行期相同的 encrypted-file / HTTP vault 元数据）。显式
   vault 覆盖只接受 `--vault-key-env <ENV_NAME>`，禁止密钥值进入 argv / `/proc`。
2. digest 写入 release env（`AGENT_SAAS_CONFIG_IDENTITY_DIGEST` 等），随蓝绿
   单元注入进程环境。
3. `readRuntimeIdentity` 读取 expected；`write-production-identity.mjs` 把
   expected 固化进 trusted runtime identity。Web-only / ACS-only partial promotion
   在 API keep 时从 active release env 与上一份 trusted identity 双源交叉校验后继承。
   release env 的 `AGENT_SAAS_SERVER_DIGEST` 必须同时绑定 content-addressed target basename、
   active target 内不可变 Manifest 的 API artifact digest 与上一份 trusted API digest；
   `AGENT_SAAS_RELEASE_ID` 必须绑定同一 Manifest 的 releaseId。任一来源缺失或冲突都 fail
   closed（`configIdentity` 字段；legacy `configFingerprint` 语义不变）。
   Runtime 将严格摘要原子写入每色 `/run/agent-saas-server-<color>.config-identity.json`
   私有快照（0600）；匿名 `/api/healthz/ready` 只用一致性做 readiness 门禁，不返回摘要。
   `read-live-production-components.mjs` / `read-production-state.mjs` 从活动色私有快照读取并
   二次严格校验后写入 Production State 与 Release Evidence；legacy API 可以完全没有
   `configIdentity`，但一旦提供该对象，非空 `releaseId` 必须存在并等于
   `api.release.releaseId`，Evidence schema 同样强制此绑定。
4. `read-runtime-identity.mjs` 的校验器对 `configIdentity` 做结构校验
   （存在时必须合法），旧 identity 文件（无该字段）保持兼容。

## 7. 产品内呈现（平台概览 → 概览）

`OverviewPage` 新增「配置身份」只读卡片：四态徽章、Release ID、schema 版本、
expected/observed digest 截断摘要、最近观察/变化时间。`null`/`unknown` 一律
显式渲染为占位符或状态；首次、手动或定时刷新失败都会撤销旧 `consistent` 绿态。
**没有**修改配置、接受漂移、查看
raw config 的任何入口。drifted / unverifiable 同时进入待关注队列（high）。

## 8. 版本迁移

- v1（本版）：如上。迁移到 v2 时必须：递增 `CONFIG_IDENTITY_SCHEMA_VERSION`、
  更新 shared wire schema 的 `z.literal`、旧 observed 摘要按
  `schema_version_unsupported` 判定不可验证（不误报一致/漂移）、部署脚本写入
  新 SCHEMA_VERSION env。
- 合并本变更后，**存量环境需要一次重新发布**才能绑定 expected identity；
  在此之前 runtime 只会报告 `unverifiable: expected_not_bound`（production
  不阻断启动，仅 overview 提示）。Staging 在下一次部署后立即强制生效。

## 9. 相关文件

- `shared/src/schemas/configIdentity.ts` — wire 契约
- `server/src/release/configIdentity.ts` — projection / digest / 注册表 / 门禁
- `server/src/release/configIdentityCli.ts` — 部署期 CLI
- `server/src/runtime/configIdentityRuntime.ts` — observed 运行时
- `server/src/release/runtimeIdentity.ts` — expected env 绑定 + staging 断言
- `server/src/app/sharedConfigRefresher.ts` — 配置候选两阶段提交 + `onConfigReloaded` 回调
- `server/src/app/sttRuntimeUpdate.ts` — STT SecretVault 无副作用 prepare / 同步 commit
- `server/src/routes/platformObservability.ts` — snapshot `configIdentity` + attention
- `server/src/routes/health.ts` — ready 载荷 `configIdentity`
- `scripts/release/deploy-production-release.sh` / `deploy-staging-release.sh` — 部署期绑定
- `scripts/release/write-production-identity.mjs` / `read-production-state.mjs` /
  `read-live-production-components.mjs` / `read-runtime-identity.mjs` /
  `release-evidence-schema.mjs` — 发布链路透传与校验
- `web/src/components/PlatformAdmin/pages/ConfigIdentityCard.tsx` — 前端区块
