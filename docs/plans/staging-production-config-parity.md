# Staging 与 Production 显式配置统一方案

> 状态：Proposal  
> 日期：2026-08-31  
> 目标：让 Staging 与 Production 使用同一套显式、可审计、可比较的配置模型，在保持环境隔离的前提下实现功能能力一致。  
> 已确认决策：Staging 不得禁用 Codex；Staging 与 Production 使用同一个 Codex 订阅授权账号。

## 1. 背景与问题

当前 Staging 不是从一套声明式环境配置生成，而是从源配置复制后，由
`scripts/staging/render-config.mjs` 对多个配置段进行硬编码覆盖或删除。

这一模式存在以下问题：

1. 模型清单与功能开关可能不一致。例如 Staging 中仍能选择 Codex 模型，但
   `codexSubscription.enabled=false`，运行时会在请求上游之前直接失败。
2. Staging 为了隔离外部副作用，直接关闭了 Cron、通知、WebTools、ImageGen、STT/TTS、
   Memory 等功能，无法验证即将进入 Production 的完整能力。
3. Production 的一部分配置通过管理后台或 ECS 文件手工维护，未进入版本化配置事实源。
4. 配置分散在 `config.json`、systemd EnvironmentFile、SecretVault、独立 JSON store、
   GitHub Environment、ACS 环境变量和云资源中，无法生成完整环境差异。
5. 当前健康接口能证明代码制品身份，但没有公开非敏感的配置版本与配置摘要，健康成功不能证明
   Staging 和 Production 配置一致。

## 2. 目标与非目标

### 2.1 目标

- 两个环境使用同一份基础功能配置和同一份 Schema。
- Staging 不通过关闭功能实现安全隔离，而是通过独立资源、测试目标和权限边界实现隔离。
- 所有环境差异必须声明、分类并给出原因；未声明差异自动失败。
- 所有敏感值只进入 SecretVault、GitHub Environment Secret 或专用凭据服务，仓库只保存引用。
- 管理后台产生的全局配置变更可版本化、审计、导出、回滚，并能先应用到 Staging。
- 部署后可以读回 `configSchemaVersion`、`configRevision`、`configFingerprint` 和能力摘要。
- RC 同时绑定不可变制品和已验收的配置 revision，Production 不重新生成另一套业务配置。

### 2.2 非目标

- 不要求两个环境使用相同的数据库、NAS 路径、OSS Bucket、域名、ACS namespace 或通知目标。
- 不复制 Production 用户数据、业务数据、租户凭据或个人连接器授权到 Staging。
- 不把任何 Token、AccessKey、数据库密码或完整连接串提交到 Git。
- 不在本方案阶段直接修改 Workflow、GitHub 设置或线上资源。

## 3. 配置一致性的定义

“同一套配置”指配置结构和功能能力一致，不代表所有值逐字相同。

### 3.1 必须一致：`mustEqual`

- 模型组、模型清单、模型协议、Responses transport、能力声明和定价。
- Codex、WebTools、ImageGen、STT/TTS、Memory、Tool Controls 等功能开关。
- 系统提示词、标题模型、Guardrail、模型 fallback 策略。
- Runtime Scheduler、事件保留、重试、超时和审批语义。
- App 与 ACS 的协议、Orchestrator/Sandbox 兼容性配置。
- 配置 Schema 版本和基础配置 revision。

### 3.2 必须不同：`mustDiffer`

- Web/API 域名、端口和回调地址。
- 数据库名称、数据库角色和连接凭据。
- Workspace、NAS、Artifact、运行目录和锁目录。
- JWT、VAPID、短信、钉钉、模型 API Key 等环境凭据。
- SecretVault 访问身份和普通 credential namespace。
- ACS namespace、PVC、ServiceAccount、Kubeconfig 和资源配额。
- 通知目标、测试账号、测试组织和外部副作用接收方。

### 3.3 明确允许不同：`allowedDifference`

允许不同的字段必须记录：

- JSON Path；
- Staging/Production 期望语义；
- 差异原因；
- 风险负责人；
- 是否永久；
- 临时差异的到期时间和关闭条件。

任何未进入 `mustEqual`、`mustDiffer` 或 `allowedDifference` 的差异都必须使配置校验失败。

## 4. 目标文件结构

```text
config/runtime/
├── schema.json
├── base.jsonc
├── staging.jsonc
├── production.jsonc
├── parity-policy.json
├── secrets-manifest.json
└── capability-contract.json
```

### 4.1 `base.jsonc`

保存两个环境共用的功能行为：模型、工具、提示词、Runtime 策略、功能开关和默认限额。

### 4.2 环境 Overlay

`staging.jsonc` 和 `production.jsonc` 只保存环境绑定：域名、资源路径、数据库身份、ACS 身份、
通知 sink、SecretRef 和环境容量。

Overlay 不允许随意关闭 `base.jsonc` 中已启用的能力。确需关闭时必须进入
`allowedDifference`，并提供到期时间。

### 4.3 `secrets-manifest.json`

只保存非敏感元数据，例如：

```json
{
  "id": "SHARED_CODEX/primary",
  "kind": "codex_subscription_oauth",
  "scope": "shared-staging-production",
  "required": true,
  "value": "never-stored-here"
}
```

### 4.4 `capability-contract.json`

记录每项能力是否必须在 Staging 真实验收，例如 Codex 文本回复、Codex 工具调用、WebSearch、
ImageGen、STT/TTS、通知测试 sink、Cron 测试任务和 ACS Sandbox。

## 5. Codex 共用同一授权的专项设计

### 5.1 已确认约束

- Staging 和 Production 使用同一个 Codex 订阅账号授权。
- Staging 中 `codexSubscription.enabled` 必须为 `true`。
- 两个环境使用相同的 Codex 模型清单、transport、endpoint 和能力配置。
- 调用记录必须带 `environment=staging|production`，以便分别统计成本、失败率和限流。

### 5.2 禁止直接复制两份 Refresh Token

不得把同一个 OAuth token bundle 分别复制到两个独立的 encrypted-file Vault。

Codex 刷新流程会更新 refresh token 和 generation。若两个环境各自保存一份副本，它们可能同时刷新，
其中一份获得新 token 后使另一份失效，最终表现为随机授权失败。现有 PG advisory lock 也不能直接解决该
问题，因为 Staging 和 Production 使用不同数据库，锁不在同一权威存储域中。

### 5.3 推荐实现：共享 Codex Credential Broker

为 Codex 单独建立一个共享的凭据权威面：

- 只保存一个 canonical Codex token bundle。
- Staging 和 Production 使用不同的 Broker 客户端身份访问同一个 opaque credential ID。
- Token 刷新、generation CAS、refresh lock 和远端撤销只在 Broker 内执行。
- App 进程只请求当前有效 access token，不直接持久化 refresh token。
- Staging 身份允许 `read/use`，不允许重新授权、删除或远端撤销共享账号。
- 重新授权和撤销仅允许受控的 Production/平台超级管理员操作，并明确提示会同时影响两个环境。

普通凭据仍保持 Staging/Production namespace 隔离；只对
`kind=codex_subscription_oauth`、`scope=shared-staging-production` 建立窄范围例外。

### 5.4 共享授权的风险控制

- Staging 设置独立的并发上限、每日请求预算和告警阈值，避免测试流量挤占 Production。
- Staging E2E 使用固定测试账号和测试会话，不读取 Production 用户数据。
- 指标按环境拆分：请求数、Token、刷新次数、429、401、延迟和费用。
- Broker 不可用时两个环境都 fail closed，不回退到明文或历史 token。
- 配置读回只展示 credential ID、generation、过期时间和 account binding hash，不展示 Token。
- 将“共享 Codex 授权导致共同故障域”登记为已接受风险，并提供 API Key 模型回退预案。

## 6. 其他能力的 Staging 适配方式

| 能力             | Staging 策略                    | Production 策略                    | 一致性要求                   |
| ---------------- | ------------------------------- | ---------------------------------- | ---------------------------- |
| Models           | 同一模型、协议、能力、定价      | 同左                               | 必须一致                     |
| Codex            | 启用，共享授权，独立限额与指标  | 启用，共享授权                     | 必须一致                     |
| WebTools         | 启用，走 Staging 出口代理       | 启用，Production 出口策略          | 功能一致，出口不同           |
| ImageGen         | 启用，独立凭据/预算             | 启用，Production 凭据              | 功能一致，凭据不同           |
| STT/TTS          | 启用，测试 Bucket/凭据          | 启用，Production 资源              | 功能一致，资源不同           |
| Memory           | 启用，写 Staging Workspace/索引 | 启用，写 Production Workspace/索引 | 行为一致，数据不同           |
| Cron             | 启用，只加载 Staging 作业       | 启用，加载 Production 作业         | 调度语义一致，任务不同       |
| DingTalk/SMS     | 启用测试链路，发测试群或 sink   | 发真实目标                         | 链路一致，目标不同           |
| Web Push         | Staging VAPID 与测试订阅        | Production VAPID                   | 功能一致，凭据不同           |
| OAuth/Connectors | Staging Client/Callback         | Production Client/Callback         | 协议一致，Client 不同        |
| Integration V3   | 独立测试组织和 fixture          | 真实组织                           | 功能一致，数据不同           |
| ACS              | 同一兼容制品与协议              | 同左                               | 制品一致，namespace/PVC 不同 |
| Event Retention  | 在 Staging DB 真实执行          | 在 Production DB 执行              | 策略一致，数据不同           |
| Alerting         | 发 Staging 告警 sink            | 发 Production 告警目标             | 规则一致，目标不同           |

## 7. 手工配置治理

### 7.1 当前需纳入的配置面

- `config.json`：模型、Codex、工具、提示词、STT、ImageGen、Memory、Remote Hands 等。
- `data/egress-config.json`：动态网络出口配置。
- `data/signup-config.json`：自助注册和短信配置。
- `tenants.json`、`skills-config.json`、`mcp-config.json`：组织级和连接能力配置。
- SecretVault：模型、连接器、Codex 和远程 Hand 凭据。
- systemd EnvironmentFile：环境身份、release identity 和运行资源。
- ACS Orchestrator env、Kubernetes namespace/PVC/ServiceAccount。
- GitHub Environment Secrets/Variables。
- DNS、证书、OSS、ECS、RDS、NAS 和 ACK 资源身份。

### 7.2 管理后台改造

管理后台不再直接覆盖部署生成的 `config.json`，改为写入版本化配置 revision：

1. 管理员编辑 Draft。
2. 服务端校验 Schema、SecretRef 和 parity policy。
3. 生成 canonical diff 和审计记录。
4. 先应用到 Staging。
5. Staging 验收通过后，将同一 revision 晋级 Production。

紧急 override 必须包含操作者、理由、TTL 和回滚 revision；到期后自动恢复或阻断继续运行。

## 8. 配置生成与运行时读回

统一生成器：

```text
base + environment overlay + secret references + approved revision
  -> schema validation
  -> parity validation
  -> secret readiness validation
  -> effective config
  -> canonical fingerprint
```

Readiness 和管理接口增加以下非敏感字段：

```json
{
  "configSchemaVersion": 1,
  "configRevision": "cfg-20260831-001",
  "configFingerprint": "sha256:...",
  "capabilityFingerprint": "sha256:...",
  "secretReadiness": "ready",
  "codexCredentialGeneration": 12
}
```

API 与 Runtime Worker 必须读回相同的 config revision 和 fingerprint，否则环境不允许进入 Ready。

## 9. 实施阶段

### 阶段 A：只读事实导出

新增 `scripts/config/export-effective-config.mjs`：

- 输出配置结构、非敏感值、SecretRef 状态、systemd key、独立 store revision 和云资源身份。
- 对敏感字段只输出 `present/ref/missing`。
- 在 Staging 和 Production 分别运行，生成第一份权威差异报告。
- 不用本地 `config.json` 代替 Production 现场配置。

验收：能够准确回答环境间共有、不同、缺失和漂移的字段数量。

### 阶段 B：声明式配置基础

- 新增 `config/runtime/` 文件和 Schema。
- 实现统一 renderer，替换 Staging 硬编码删改。
- 加入 `mustEqual`、`mustDiffer`、`allowedDifference` 校验。
- 加入未知字段、隐式默认值和明文凭据检查。

验收：同一基础配置可确定性生成两个环境配置，重复生成摘要完全一致。

### 阶段 C：SecretRef 与 Codex Broker

- 为 JWT、数据库连接、Artifact 签名密钥等当前只支持内联值的字段补充 SecretRef。
- 迁移模型、STT/TTS、ImageGen、通知和 OAuth 凭据。
- 建设共享 Codex Credential Broker，并将两个环境绑定到同一 Codex credential ID。
- 保持其他凭据 namespace 严格隔离。

验收：配置文件中不存在生产明文密钥；Codex 刷新并发测试只有一次真实 refresh。

### 阶段 D：恢复完整 Staging 能力

建议顺序：

1. Codex。
2. WebTools、ImageGen、STT/TTS。
3. Memory、System Monitor、Event Retention。
4. OAuth、Connectors、Integration V3。
5. Cron 和测试通知 sink。

每项能力独立提交、独立验收、独立回滚，不做一次性大爆炸切换。

### 阶段 E：配置发布与漂移门禁

- PR 阶段执行 Schema、SecretRef 和 parity diff。
- Staging 部署后读回配置 revision/fingerprint。
- Staging 真实验收通过后，Production 晋级同一基础 revision。
- 定时只读检测 ECS 文件、管理 store 和声明式配置之间的漂移。

本阶段涉及 `.github/workflows/**`，实施前必须取得明确的“确认修改 Workflow”。

## 10. 验收标准

### 10.1 Codex

- Staging `codexSubscription.enabled=true`。
- Staging 配置的全部 Codex 模型均可发起真实请求。
- 模型请求数和 Token 大于 0。
- 文本回复、工具调用、凭据自动刷新均通过。
- Staging/Production 读取同一个 account binding hash 和连续 generation。
- 两环境并发触发过期刷新时只发生一次权威 token rotate。
- Staging 的请求量、Token、429/401 和费用可以单独统计。

### 10.2 配置一致性

- `mustEqual` 差异数为 0。
- `mustDiffer` 字段全部不同且通过资源身份读回。
- 所有允许差异都有原因、负责人和到期策略。
- API/Worker config fingerprint 一致。
- 仓库、部署产物和运行时均不包含明文凭据。

### 10.3 业务能力

- Agent → Runtime Worker → ACS → Sandbox → result writeback 真实通过。
- WebTools、ImageGen、STT/TTS、Memory、Cron 和通知测试 sink 各有真实读回证据。
- Staging 无法访问 Production DB、Workspace、通知目标和普通业务凭据。
- 健康检查、配置一致性和业务验收分别报告，不互相替代。

## 11. 回滚方案

每次配置发布保存：

- `configRevision`；
- `configSchemaVersion`；
- canonical 配置摘要；
- SecretRef 清单摘要；
- 旧 revision；
- 部署人与时间；
- 迁移结果和验收证据。

配置采用候选文件校验后原子切换。启动或读回失败时恢复上一 revision，并重新验证 API、Worker 和 ACS。

Codex Broker 回滚只回滚 Broker 客户端和引用配置，不回滚到两份本地 refresh token。若共享授权本身失效，
两个环境统一切换到已声明的 API Key fallback 模型，重新授权后再恢复 Codex。

## 12. 建议提交拆分

1. `feat(config): add effective config inventory and parity contract`
2. `feat(config): add declarative runtime profiles`
3. `feat(config): migrate runtime secrets to references`
4. `feat(codex): add shared credential broker for staging and production`
5. `feat(staging): enable production-parity capabilities with isolated targets`
6. `ci(config): enforce config parity and runtime drift readback`

前五项可以按独立代码阶段实施；第六项修改 Workflow 前必须单独确认。

## 13. 完成定义

只有同时满足以下条件，本方案才算完成：

- 不再由 Staging renderer 硬编码关闭业务能力。
- 两个环境都由声明式配置生成并通过 parity policy。
- Production 的历史手工配置已完成权威导出和版本化迁移。
- Staging 启用 Codex，并与 Production 共用同一权威授权且无 refresh 竞争。
- 所有其他凭据、数据和外部副作用仍保持环境隔离。
- 配置 revision/fingerprint 已进入运行时身份和发布证据。
- Staging 完整业务验收通过后，Production 使用相同制品和已批准配置 revision 晋级。
