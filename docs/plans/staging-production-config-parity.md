# Staging 与 Production 显式配置统一方案

> 状态：Proposal（已按即时生效与 Codex 独立授权决策修订）
> 日期：2026-08-31
> 目标：让 Staging 与 Production 使用同一套显式、可审计、可比较的配置模型，在保持环境隔离的前提下实现功能能力一致。
> 已确认决策：管理后台保存后立即修改当前环境；Staging 与 Production 的 Codex 分别授权，使用不同账号和独立凭据。

## 1. 背景与问题

当前 Staging 不是按一套完整、显式的环境配置运行，而是从源配置复制后，由
`scripts/staging/render-config.mjs` 对多个配置段进行硬编码覆盖或删除。

这一模式存在以下问题：

1. 模型清单与功能开关可能不一致。例如 Staging 中仍能选择 Codex 模型，但
   `codexSubscription.enabled=false`，运行时会在请求上游之前直接失败。
2. Staging 为了隔离外部副作用，直接关闭 Cron、通知、WebTools、ImageGen、STT/TTS、
   Memory 等功能，无法验证即将进入 Production 的完整能力。
3. Production 的一部分配置通过管理后台或 ECS 文件手工维护，缺少统一清单和环境差异报告。
4. 配置分散在 `config.json`、systemd EnvironmentFile、SecretVault、独立 JSON store、
   GitHub Environment、ACS 环境变量和云资源中，无法回答两个环境究竟还有多少差异。
5. 当前多个管理接口直接改写配置文件，但原子写入、并发控制、跨进程热加载、失败恢复和生效读回
   尚未形成统一契约。
6. 当前健康接口能证明代码制品身份，但不能证明当前环境实际启用了哪些能力、Secret 是否就绪，
   以及 API 与 Runtime Worker 是否读取了同一份有效配置。

## 2. 已确认的配置管理方式

### 2.1 保存后立即修改当前环境

本方案不建设 Draft、审批、配置 revision 晋级或“先 Staging 后 Production”的配置发布平台。

- 管理员在 Staging 后台保存，只修改 Staging。
- 管理员在 Production 后台保存，只修改 Production。
- 保存成功必须代表配置已持久化、当前进程已应用，并完成必要的跨进程生效读回。
- 两个环境的配置由管理员分别维护，通过只读 parity 检查发现遗漏和意外漂移。
- Production 修改增加环境标识、二次确认、审计和快速恢复，但不引入审批流。

### 2.2 Codex 分环境独立授权

- Staging 和 Production 分别完成 Codex OAuth 授权。
- 两个环境使用不同 Codex 账号，不共享 refresh token、access token 或 credential ID。
- 两个环境使用独立 SecretVault namespace 和独立 token bundle。
- 任一环境重新授权、刷新、失效或撤销，不得影响另一环境。
- 不建设共享 Codex Credential Broker，也不需要跨环境 refresh lock 或 generation CAS。
- Codex 模型清单、transport、endpoint 规则和能力配置仍应保持一致；账号、Token、额度和用量必须不同。

## 3. 目标与非目标

### 3.1 目标

- 两个环境使用同一份配置 Schema 和同一套能力定义。
- Staging 不通过关闭功能实现安全隔离，而是通过独立资源、测试目标和权限边界实现隔离。
- 所有环境差异必须声明、分类并给出原因；未声明差异进入漂移告警。
- 所有敏感值只进入 SecretVault、GitHub Environment Secret、systemd 凭据或专用凭据服务，
  普通配置文件只保存引用。
- 管理后台保存后立即修改当前环境，并具备校验、原子写入、并发控制、审计、恢复和生效读回。
- 能够从 Staging 和 Production 导出脱敏的有效配置，生成权威环境差异报告。
- 部署后可以读回配置 Schema 版本、配置指纹、能力摘要和 Secret 就绪状态。

### 3.2 非目标

- 不建设配置 Draft、审批、revision 晋级或跨环境自动同步。
- 不要求 Production 自动采用 Staging 中保存的配置。
- 不要求两个环境使用相同数据库、NAS 路径、OSS Bucket、域名、ACS namespace 或通知目标。
- 不复制 Production 用户数据、业务数据、租户凭据、个人连接器授权或 Codex 授权到 Staging。
- 不把任何 Token、AccessKey、数据库密码或完整连接串提交到 Git。
- 本方案不直接修改 Workflow、GitHub 设置或线上资源。

## 4. 配置一致性的定义

“同一套配置”指配置结构、产品能力和行为语义一致，不代表所有值逐字相同，也不代表两个环境自动同步。

### 4.1 必须一致：`mustEqual`

- 模型组、模型清单、模型协议、Responses transport、能力声明和定价。
- Codex、WebTools、ImageGen、STT/TTS、Memory、Tool Controls 等功能开关。
- 系统提示词、标题模型、Guardrail、模型 fallback 策略。
- Runtime Scheduler、事件保留、重试、超时和审批语义。
- App 与 ACS 的协议、Orchestrator/Sandbox 兼容性配置。
- 配置 Schema 版本和能力契约版本。

### 4.2 必须不同：`mustDiffer`

- Web/API 域名、端口和回调地址。
- 数据库名称、数据库角色和连接凭据。
- Workspace、NAS、Artifact、运行目录和锁目录。
- JWT、VAPID、短信、钉钉、模型 API Key 等环境凭据。
- SecretVault 访问身份和普通 credential namespace。
- Codex OAuth 账号、credential ID、Token、额度和授权生命周期。
- ACS namespace、PVC、ServiceAccount、Kubeconfig 和资源配额。
- 通知目标、测试账号、测试组织和外部副作用接收方。

### 4.3 明确允许不同：`allowedDifference`

允许不同的字段必须记录：

- JSON Path；
- Staging/Production 期望语义；
- 差异原因；
- 风险负责人；
- 是否永久；
- 临时差异的到期时间和关闭条件。

任何不属于 `mustEqual`、`mustDiffer` 或 `allowedDifference` 的差异都进入错误报告；是否阻断部署由后续
Workflow 门禁决定，本阶段只实现只读检查和清晰告警。

## 5. 配置事实源与治理文件

保留当前“每个环境独立保存”的事实源，不新增会与后台即时保存冲突的 Git 内业务配置副本。

```text
config/governance/
├── schema.json
├── parity-policy.json
├── secrets-manifest.schema.json
└── capability-contract.json

scripts/config/
├── export-effective-config.mjs
├── compare-environments.mjs
└── validate-effective-config.mjs
```

每个运行环境继续独立维护：

- `config.json`：当前环境的全局业务配置与 SecretRef。
- `data/egress-config.json`：当前环境的动态出口配置。
- `data/signup-config.json`：当前环境的注册和短信配置。
- `tenants.json`、`skills-config.json`、`mcp-config.json`：当前环境的组织和连接能力配置。
- SecretVault：当前环境的模型、Codex、连接器及远程 Hand 凭据。
- systemd EnvironmentFile：当前环境身份、运行资源、连接串引用和 release identity。
- ACS、GitHub Environment 和云资源：环境基础设施身份。

治理文件只描述 Schema、分类规则和验收要求，不保存两边需要人工同步的业务值。

## 6. 三层前端配置边界

### 6.1 日常全局业务配置

继续由当前环境的前端管理后台维护，保存后立即生效：

- 模型清单、能力、协议与定价；
- 工具开关、WebTools、ImageGen、STT/TTS；
- 系统提示词、Memory、Runtime 策略和告警规则；
- Codex 功能配置和当前环境授权入口。

需要补齐缺失页面，并将分散入口统一到平台设置导航中。

### 6.2 租户级配置

继续由当前环境的组织管理维护：

- 可用模型、模型展示覆盖；
- 技能、组织 Agent、MCP、连接器；
- 组织功能开关、配额、品牌、安全和个性化策略。

租户配置属于环境本地业务数据，不要求从 Production 复制到 Staging。Staging 使用固定测试组织和 fixture。

### 6.3 敏感凭据

前端只提供授权、更新、轮换、撤销和连通性测试入口：

- Secret 明文只允许在提交时出现，服务端立即写入当前环境的 SecretVault。
- 普通配置与业务 store 只保存 opaque SecretRef。
- 前端只能读回 `present/ref/missing`、更新时间、账号绑定摘要和测试状态，不返回明文。
- 模型 API Key、STT/TTS、ImageGen、WebTools、短信、钉钉和连接器 Token 统一遵循此规则。
- Codex 在两个环境分别授权并分别写入各自 SecretVault。

数据库连接、JWT、Vault 主密钥、GitHub Secret、Kubernetes 凭据等基础设施密钥不作为普通前端可编辑项；
前端最多展示脱敏就绪状态，实际值由 GitHub Environment、systemd 凭据或云端 Secret 管理。

## 7. 即时保存的统一安全契约

所有管理接口不得继续各自实现一套“读文件—改字段—直接覆盖”的保存逻辑，应复用统一保存服务：

1. 校验操作者权限和目标环境。
2. 校验请求 Schema、字段约束、SecretRef 可解析性和运行时依赖。
3. 读取当前文件摘要或 `updatedAt`，执行乐观并发检查，避免覆盖他人刚保存的修改。
4. 获取跨进程写锁，在同一文件的修改之间串行化。
5. 生成候选配置，在临时文件中完成完整解析和业务校验。
6. 创建受限数量的本地恢复副本，再以原子 rename 替换当前配置。
7. 调用当前进程的运行时更新器，并等待其他 API/Runtime Worker 读到新文件摘要。
8. 读回非敏感生效结果；只有持久化和运行时应用都成功时才向前端返回成功。
9. 写入审计记录：环境、操作者、时间、修改字段、脱敏 diff、结果和恢复点。

Secret 更新采用“先写新 Secret、再原子切换 SecretRef”的方式。配置切换失败时撤销新 Secret；旧 Secret 在新配置
完成读回后再撤销，避免即时保存过程中出现无可用凭据的窗口。

Production 页面必须持续显示醒目的环境标识；敏感操作和大范围功能关闭需要二次确认，但不引入审批和发布队列。

## 8. Codex 独立授权专项设计

### 8.1 配置与存储

- Staging：`codexSubscription.enabled=true`，绑定 Staging 专用 Codex 账号及独立 Vault namespace。
- Production：绑定 Production 专用 Codex 账号及独立 Vault namespace。
- token bundle 只能存在于对应环境的 SecretVault，不写入 `config.json`、日志、审计 diff 或运行元数据。
- `config.json` 只保存功能开关、非敏感策略和当前环境 credential reference。

### 8.2 权限和故障隔离

- 两个环境各自完成 device authorization、refresh、revoke 和 account validation。
- Staging 管理员只能管理 Staging 授权；Production 授权需要 Production 平台管理员操作。
- Staging 账号设置独立并发上限、每日预算和告警阈值，避免测试流量影响 Production。
- 指标按环境和账号拆分：请求数、Token、刷新次数、429、401、延迟和费用。
- 任一账号失效时仅该环境 fail closed，并提示重新授权；不得回退到另一环境的凭据。
- 可为两个环境分别配置 API Key 模型 fallback，但凭据仍必须独立。

### 8.3 前端授权体验

- 授权卡片明确显示当前环境，避免管理员在错误环境重新授权。
- 只展示账号绑定摘要、授权状态、过期状态和最近刷新时间，不显示 Token。
- 撤销前明确提示影响范围仅为当前环境。
- 保存或重新授权后发起当前环境的最小真实请求，验证请求数和 Token 大于零。

## 9. 其他能力的 Staging 适配方式

| 能力             | Staging 策略                       | Production 策略                    | 一致性要求                   |
| ---------------- | ---------------------------------- | ---------------------------------- | ---------------------------- |
| Models           | 同一模型、协议、能力、定价         | 同左                               | 必须一致                     |
| Codex            | 启用，Staging 独立账号、凭据与限额 | 启用，Production 独立账号与凭据    | 功能一致，授权必须不同       |
| WebTools         | 启用，走 Staging 出口代理          | 启用，Production 出口策略          | 功能一致，出口不同           |
| ImageGen         | 启用，独立凭据/预算                | 启用，Production 凭据              | 功能一致，凭据不同           |
| STT/TTS          | 启用，测试 Bucket/凭据             | 启用，Production 资源              | 功能一致，资源不同           |
| Memory           | 启用，写 Staging Workspace/索引    | 启用，写 Production Workspace/索引 | 行为一致，数据不同           |
| Cron             | 启用，只加载 Staging 作业          | 启用，加载 Production 作业         | 调度语义一致，任务不同       |
| DingTalk/SMS     | 启用测试链路，发测试群或 sink      | 发真实目标                         | 链路一致，目标不同           |
| Web Push         | Staging VAPID 与测试订阅           | Production VAPID                   | 功能一致，凭据不同           |
| OAuth/Connectors | Staging Client/Callback            | Production Client/Callback         | 协议一致，Client 不同        |
| Integration V3   | 独立测试组织和 fixture             | 真实组织                           | 功能一致，数据不同           |
| ACS              | 同一兼容制品与协议                 | 同左                               | 制品一致，namespace/PVC 不同 |
| Event Retention  | 在 Staging DB 真实执行             | 在 Production DB 执行              | 策略一致，数据不同           |
| Alerting         | 发 Staging 告警 sink               | 发 Production 告警目标             | 规则一致，目标不同           |

## 10. 环境导出、比较与运行时读回

### 10.1 脱敏有效配置导出

`export-effective-config.mjs` 在目标环境现场读取：

- `config.json` 及独立 JSON store；
- SecretRef 的 `present/ref/missing` 状态；
- systemd key 名和非敏感环境身份；
- API、Runtime Worker、ACS 和云资源身份。

导出结果不得包含 Secret 明文、完整连接串、用户数据或个人授权。不得用本地 `config.json` 代替线上现场配置。

### 10.2 环境差异报告

`compare-environments.mjs` 根据 parity policy 输出：

- `mustEqual` 违规；
- `mustDiffer` 违规；
- 已批准差异；
- 未分类差异；
- 缺失 SecretRef 和能力未就绪项。

报告用于运维核对和告警，不自动把任一环境的值覆盖到另一环境。

### 10.3 运行时读回

Readiness 和管理接口增加非敏感字段：

```json
{
  "configSchemaVersion": 1,
  "effectiveConfigFingerprint": "sha256:...",
  "capabilityFingerprint": "sha256:...",
  "secretReadiness": "ready",
  "environment": "staging",
  "appliedAt": "2026-08-31T12:00:00.000Z"
}
```

API 与 Runtime Worker 必须读回同一个当前环境配置指纹，否则环境不得报告 Ready。指纹只代表当前有效配置，
不引入配置 revision 或跨环境晋级语义。

## 11. 实施阶段

### 阶段 A：只读事实导出

- 实现有效配置脱敏导出。
- 分别在 Staging 和 Production 现场运行。
- 生成共有、不同、缺失和漂移字段的第一份权威报告。
- 建立配置项到前端、SecretVault、systemd、GitHub Environment、ACS 和云资源的归属清单。

验收：能够准确回答两个环境还有多少配置差异，以及每项差异的事实源和责任边界。

### 阶段 B：即时保存可靠性与前端补齐

- 抽取统一原子保存、锁、并发检查、恢复和审计服务。
- 将模型、工具、系统提示词、Memory、STT/TTS、ImageGen 等后台接口迁移到统一保存服务。
- 补齐缺失的日常全局配置页面。
- 增加环境标识、Production 二次确认和保存后生效读回。
- 验证 API 与 Runtime Worker 的跨进程热更新。

验收：并发保存不会丢失更新，失败不会破坏原配置，成功响应可以证明当前环境各进程已生效。

### 阶段 C：SecretRef 与 Codex 独立授权

- 将模型 API Key 以及仍以内联方式保存的业务凭据迁移到 SecretRef。
- 为 JWT、数据库连接、Artifact 签名密钥等基础设施密钥使用环境变量或专用 Secret 引用。
- 确保 Staging/Production 使用持久化且隔离的 SecretVault backend/namespace。
- 为两个环境分别完成 Codex 授权、真实请求、刷新和撤销隔离测试。
- 不建设共享 Codex Broker。

验收：普通配置文件中不存在明文密钥；两环境 Codex 账号和 credential ID 不同；任一环境刷新或撤销不影响另一环境。

### 阶段 D：恢复完整 Staging 能力

建议顺序：

1. Codex。
2. WebTools、ImageGen、STT/TTS。
3. Memory、System Monitor、Event Retention。
4. OAuth、Connectors、Integration V3。
5. Cron 和测试通知 sink。

每项能力独立提交、独立验收、独立回滚，不做一次性大爆炸切换。

### 阶段 E：环境漂移检测

- 运行 Schema、SecretRef 和 parity diff。
- 部署后读回当前环境配置指纹和能力摘要。
- 定时只读检测 ECS 文件、管理 store、Secret 就绪状态和运行时之间的漂移。
- 先以报告和告警运行，确认规则稳定后再决定是否加入 CI/CD 门禁。

将检查加入 `.github/workflows/**` 前，必须再次取得明确的“确认修改 Workflow”。

## 12. 验收标准

### 12.1 Codex

- Staging 和 Production 的 `codexSubscription.enabled=true`。
- 两环境使用不同 Codex 账号、credential ID、Vault namespace 和 token bundle。
- 两边配置的 Codex 模型均可发起真实请求，请求数和 Token 大于零。
- 文本回复、工具调用和凭据自动刷新分别通过。
- Staging 刷新、重新授权或撤销不会改变 Production 的账号绑定摘要和可用性，反向亦然。
- 两环境的请求量、Token、429/401、延迟和费用可以单独统计。

### 12.2 即时保存

- 保存前通过 Schema、SecretRef 和运行时依赖校验。
- 并发修改可检测冲突，不会静默覆盖。
- 文件写入原子完成；模拟中断后原配置仍可解析和运行。
- 保存失败自动保留或恢复旧配置，新 Secret 不发生泄漏。
- 保存成功后 API 与 Runtime Worker 读回相同配置指纹。
- 审计记录不含明文 Secret，并能回答谁在何时修改了哪个环境。

### 12.3 配置一致性

- `mustEqual` 差异数为 0。
- `mustDiffer` 字段全部不同且通过资源身份读回。
- 所有允许差异都有原因、负责人和到期策略。
- 未分类差异全部报告，不被默认忽略。
- 仓库、普通配置文件、部署产物和日志均不包含明文凭据。

### 12.4 业务能力

- Agent → Runtime Worker → ACS → Sandbox → result writeback 真实通过。
- WebTools、ImageGen、STT/TTS、Memory、Cron 和通知测试 sink 各有真实读回证据。
- Staging 无法访问 Production DB、Workspace、通知目标、普通业务凭据和 Codex 凭据。
- 健康检查、配置一致性和业务验收分别报告，不互相替代。

## 13. 恢复方案

即时保存不使用 revision，但每次修改仍保留受限数量的本地恢复点：

- 保存前文件摘要和备份路径；
- 配置 Schema 版本和脱敏指纹；
- SecretRef 清单摘要；
- 操作者、环境、时间和脱敏 diff；
- 运行时应用及读回结果。

配置采用候选文件校验后原子切换。持久化、热更新或读回失败时恢复上一份配置，并重新验证 API 与
Runtime Worker。恢复只作用于当前环境，不跨环境复制配置或凭据。

Codex 故障只处理对应环境：重新授权该环境账号，或临时切换到该环境已配置的 API Key fallback 模型；
不得复制另一环境的 token bundle 作为恢复手段。

## 14. 建议提交拆分

1. `feat(config): add effective config inventory and parity contract`
2. `feat(config): harden immediate admin config updates`
3. `feat(config): migrate runtime secrets to references`
4. `feat(codex): isolate staging and production authorizations`
5. `feat(staging): enable production-parity capabilities with isolated targets`
6. `ci(config): report config parity and runtime drift`

前五项可以按独立代码阶段实施；第六项修改 Workflow 前必须单独确认。

## 15. 完成定义

只有同时满足以下条件，本方案才算完成：

- 不再由 Staging renderer 硬编码关闭业务能力。
- 两个环境都通过同一 Schema 和 parity policy 检查。
- Production 的历史手工配置和 Staging 当前配置都能被现场、脱敏、完整导出。
- 后台保存立即作用于当前环境，且具备原子写入、并发控制、审计、恢复和跨进程生效读回。
- Staging 与 Production 分别完成 Codex 授权，账号与凭据相互隔离且无跨环境影响。
- 所有普通配置只保存 SecretRef，基础设施密钥由专用凭据面管理。
- Staging 在独立资源和测试目标上完成完整业务验收。
- 环境差异可持续检测，未分类漂移能够被报告和处置。
