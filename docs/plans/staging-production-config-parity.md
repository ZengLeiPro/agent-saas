# Staging 与 Production 显式配置统一方案

> 状态：Proposal（已按即时生效与 Codex 独立授权决策修订）
> 日期：2026-08-31
> 目标：让 Staging 与 Production 使用同一套显式、可审计、可比较的配置模型，在保持环境隔离的前提下实现功能能力一致。
> 已确认决策：管理后台保存后立即修改当前环境；Staging 与 Production 的 Codex 分别授权，使用不同账号和独立凭据。
> 生产保护边界：本方案的代码实施、Staging 配置和验收不得改写、迁移、补全或重置 Production 现有配置与凭据；任何 Production 配置变更都必须由用户另行明确授权。

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

- Staging 新增独立 Codex OAuth 授权；Production 继续使用当前已存在的独立授权。
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
- 在不修改 Production 现有配置值、存储形式和凭据的前提下，完成代码兼容、Staging 改造和差异报告。

### 3.2 非目标

- 不建设配置 Draft、审批、revision 晋级或跨环境自动同步。
- 不要求 Production 自动采用 Staging 中保存的配置。
- 不要求两个环境使用相同数据库、NAS 路径、OSS Bucket、域名、ACS namespace 或通知目标。
- 不复制 Production 用户数据、业务数据、租户凭据、个人连接器授权或 Codex 授权到 Staging。
- 不把任何 Token、AccessKey、数据库密码或完整连接串提交到 Git。
- 本方案不直接修改 Workflow、GitHub 设置或线上资源。
- 不自动迁移 Production 明文凭据，不因启动、部署、GET、健康检查或差异检查重写 Production 文件。
- 不自动修复环境差异，也不提供从 Staging 向 Production 写入或同步配置的能力。

### 3.3 Production 零配置改动硬边界

本方案分为“代码能力与 Staging 落地”和“Production 配置采用”两部分。当前获准执行的范围只包括前者；
后者不在本方案的自动执行范围内。

1. Production 只允许只读盘点、脱敏导出、摘要计算和身份读回，不允许写文件、写 Vault、调用管理 PUT/POST/DELETE
   或触发 OAuth 重新授权。
2. 新代码必须兼容 Production 当前配置结构。旧内联字段和旧 store 在未迁移时仍可读取；不得在启动时静默转换、
   写回默认值或删除未知字段。
3. 新增 Schema 字段必须先保持可选或提供与当前行为等价的内存默认值。不得因为 Production 尚未补齐新字段而启动失败、
   Readiness 失败或改变既有功能开关。
4. 管理后台的目标环境只能由服务端可信运行时身份确定，客户端不得提交文件路径、Vault namespace 或
   `environment=production` 来选择写入目标。
5. 配置比较器永远只读，只输出报告；即使发现 `mustEqual` 违规，也不得自动复制、覆盖或“修复”Production。
6. 代码部署包不得包含或覆盖 `/etc/agent-saas/config.json`、`/etc/agent-saas/server.env`、Production SecretVault、
   `/mnt/agent-saas/server-data` 中的管理 store。部署前后必须计算这些受保护对象的摘要或版本，发生非预期变化立即失败。
7. Production 配置迁移、SecretRef 切换、Codex 重新授权以及任何现有值调整必须拆成单独操作，先给出精确 diff、备份、
   回滚和读回步骤，并等待用户逐项明确授权。

“发布了包含本方案代码的新版本”不等于“授权修改 Production 配置”。只部署代码时，Production 的有效配置、授权账号、
SecretRef、业务 store 和功能行为必须保持不变。

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

Production 当前文件和 store 是只读基线，不由 Staging renderer、配置脚本或部署制品生成。Staging 可以参考 Production
脱敏导出的非敏感值进行人工配置，但只能写入 Staging 自己的路径、数据库和 Vault namespace。

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

### 6.4 前端页面改动清单

本方案只新增 **1 个平台管理页面**，其余能力复用并改造现有页面，避免产生第二套配置入口。

#### 新增页面

| 页面     | 建议路由                            | 内容                                                                                                            | 写入边界                                                                         |
| -------- | ----------------------------------- | --------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| 配置状态 | `platform.governance.config-status` | 当前环境身份、Schema/配置/能力指纹、API 与 Runtime Worker 收敛状态、Secret 就绪摘要、脱敏环境差异、配置变更审计 | 页面默认只读；只提供刷新和导出，不提供同步、修复、复制到 Production 或跨环境保存 |

“配置状态”内部使用标签页或分区承载“当前环境”“Secret 就绪”“进程收敛”“环境差异”“变更记录”，不再为每项
单独建立页面。环境差异只展示只读比较结果，不让浏览器持有另一环境的管理凭据。

#### 修改现有页面

| 现有页面             | 主要修改                                                                                                                       | 不做的事情                                                                   |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| 平台管理公共页面框架 | 在所有平台配置页持续显示服务端返回的当前环境；Production 使用醒目样式，保存时统一二次确认并展示脱敏 diff                       | 不增加 Staging/Production 切换器，不允许客户端选择配置路径或 Vault namespace |
| 模型                 | 模型 API Key 改为提交后写 SecretVault；展示 `present/ref/missing` 和连通性；Codex 卡片展示当前环境、独立账号绑定摘要和授权状态 | 不迁移或重授权 Production 现有 Codex；不读回 API Key 明文                    |
| 工具开关             | 保留 WebTools、ImageGen、STT 现有卡片，补充 SecretRef 状态、生效读回和错误恢复；新增 TTS 配置卡片                              | 不新增独立“语音配置”页面，不把基础设施凭据放入工具页面                       |
| 系统提示语           | 接入统一原子保存、并发冲突提示、当前环境标识和保存后指纹读回                                                                   | 不自动把 Staging 提示词同步到 Production                                     |
| 记忆轮询             | 扩展为完整 Memory 策略区，补齐启用、注入、维护、轮询和 consolidation 的环境内配置与读回                                        | 不复制两环境的 Memory 数据、索引或用户记忆                                   |
| 系统配置             | 保留 Runtime Scheduler 和告警状态，补齐告警规则/测试 sink 的非敏感配置、保存审计和进程收敛状态                                 | 不在 Production 首次启用新的 Ready 硬门禁，不编辑 JWT、数据库或 Vault 主密钥 |
| 网络出口             | 展示当前环境出口、代理凭据就绪状态和连通性；保存走统一安全契约                                                                 | 不允许 Staging 使用或复制 Production 出口凭据                                |
| 注册管理             | 短信配置改为 SecretRef 状态与轮换入口，明确当前环境和测试目标                                                                  | 不复制 Production 短信凭据或真实接收目标到 Staging                           |
| 组织管理             | 保留模型、技能、MCP、连接器和组织策略入口，统一环境标识、并发控制、审计和即时生效读回                                          | 不复制 Production 租户、成员、技能授权或组织数据到 Staging                   |
| 连接与授权           | 对个人/组织连接器展示当前环境、授权状态和 SecretRef 健康；继续按用户和租户隔离                                                 | 不提供跨环境授权复制，不暴露 Token 或 Vault ref 明细                         |

#### 明确不新增的页面和操作

- 不新增“配置发布”“Draft”“审批”“版本晋级”页面。
- 不新增独立 SecretVault 浏览器；Secret 只在对应业务配置页授权或轮换。
- 不新增“同步到 Production”“用 Staging 覆盖 Production”或“自动修复差异”按钮。
- 不新增前端环境选择器；前端只能管理当前部署实例由服务端确认的环境。
- 不把数据库、JWT、Vault 主密钥、GitHub Secret、Kubernetes 凭据或云资源密钥变成前端可编辑项。

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

统一保存服务只在管理员对当前环境发起明确写请求时运行。应用启动、配置加载、GET、健康检查、Readiness、导出和差异比较
不得调用保存服务。服务端必须从受信任的运行身份解析唯一配置路径和 Vault namespace，并拒绝请求体中的环境或路径覆盖。

Secret 更新采用“先写新 Secret、再原子切换 SecretRef”的方式。配置切换失败时撤销新 Secret；旧 Secret 在新配置
完成读回后再撤销，避免即时保存过程中出现无可用凭据的窗口。

Production 页面必须持续显示醒目的环境标识；敏感操作和大范围功能关闭需要二次确认，但不引入审批和发布队列。

## 8. Codex 独立授权专项设计

### 8.1 配置与存储

- Staging：`codexSubscription.enabled=true`，绑定 Staging 专用 Codex 账号及独立 Vault namespace。
- Production：继续使用现有 Production Codex 账号和凭据；本方案不重新授权、不迁移、不轮换。
- token bundle 只能存在于对应环境的 SecretVault，不写入 `config.json`、日志、审计 diff 或运行元数据。
- `config.json` 只保存功能开关、非敏感策略和当前环境 credential reference。

### 8.2 权限和故障隔离

- Staging 完成独立的 device authorization、refresh、revoke 和 account validation；Production 只做现有状态的只读核验。
- Staging 管理员只能管理 Staging 授权；Production 授权操作不属于本方案执行范围。
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

Staging 的 API 与 Runtime Worker 必须读回同一个当前环境配置指纹，否则 Staging 不得报告 Ready。Production 首次部署
该能力时只记录指标和告警，不改变既有 Ready 结果；确认读回稳定且取得单独授权后，才能考虑启用 Production 硬门禁。
指纹只代表当前有效配置，不引入配置 revision 或跨环境晋级语义。

## 11. 实施阶段

### 阶段 A：只读事实导出

- 实现有效配置脱敏导出。
- 分别在 Staging 和 Production 现场运行。
- 生成共有、不同、缺失和漂移字段的第一份权威报告。
- 建立配置项到前端、SecretVault、systemd、GitHub Environment、ACS 和云资源的归属清单。
- Production 导出使用只读身份；脚本不提供 `--write`、`--fix`、`--sync` 或目标覆盖参数，并在运行前校验
  `environment=production` 与只读模式。

验收：能够准确回答两个环境还有多少配置差异，以及每项差异的事实源和责任边界。

### 阶段 B：即时保存可靠性与前端补齐

- 抽取统一原子保存、锁、并发检查、恢复和审计服务。
- 将模型、工具、系统提示词、Memory、STT/TTS、ImageGen 等后台接口迁移到统一保存服务。
- 补齐缺失的日常全局配置页面。
- 增加环境标识、Production 二次确认和保存后生效读回。
- 验证 API 与 Runtime Worker 的跨进程热更新。
- 新实现必须保留对 Production 当前配置的兼容读取，禁止启动时自动迁移或写回。
- 在隔离 fixture 和 Staging 完成保存测试；Production 只部署兼容代码，不执行管理保存测试。

验收：并发保存不会丢失更新，失败不会破坏原配置，成功响应可以证明当前环境各进程已生效。

### 阶段 C：SecretRef 与 Codex 独立授权

- 为模型 API Key 以及仍以内联方式保存的业务凭据增加 SecretRef 写入和兼容读取能力。
- 在 Staging 将对应凭据迁移到 SecretRef；Production 现有内联值保持原样，后续迁移必须另行授权。
- 为 JWT、数据库连接、Artifact 签名密钥等基础设施密钥增加环境变量或专用 Secret 引用能力，先在 Staging 使用。
- 确保 Staging 使用持久化且与 Production 隔离的 SecretVault backend/namespace；只读核验 Production 当前 backend，
  不修改其配置。
- 为 Staging 完成独立 Codex 授权、真实请求、刷新和撤销测试；对 Production 只读比较账号绑定摘要，不执行授权变更。
- 不建设共享 Codex Broker。

验收：Staging 普通配置文件中不存在明文密钥；Production 当前配置摘要不变；两环境 Codex 账号和 credential ID 不同；
Staging 刷新或撤销不影响 Production。

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
- 漂移检查禁止自动 remediation；Production 的新增检查先以 observe-only 运行，不改变 Ready、部署结果或配置文件。

将检查加入 `.github/workflows/**` 前，必须再次取得明确的“确认修改 Workflow”。

## 12. 验收标准

### 12.1 Codex

- Staging 的 `codexSubscription.enabled=true`；Production 只读核验当前值，如果不是 `true` 则报告差异，不在本方案内修改。
- 两环境使用不同 Codex 账号、credential ID、Vault namespace 和 token bundle。
- Staging 配置的 Codex 模型均可发起真实请求，请求数和 Token 大于零；Production 不为本方案额外触发可能刷新凭据的请求。
- Staging 的文本回复、工具调用和凭据自动刷新分别通过；Production 只读取既有健康和历史指标。
- Staging 刷新、重新授权或撤销不会改变 Production 的账号绑定摘要和可用性。
- 两环境的请求量、Token、429/401、延迟和费用可以单独统计。

### 12.2 即时保存

- 保存前通过 Schema、SecretRef 和运行时依赖校验。
- 并发修改可检测冲突，不会静默覆盖。
- 文件写入原子完成；模拟中断后原配置仍可解析和运行。
- 保存失败自动保留或恢复旧配置，新 Secret 不发生泄漏。
- 保存成功后 API 与 Runtime Worker 读回相同配置指纹。
- 审计记录不含明文 Secret，并能回答谁在何时修改了哪个环境。

### 12.3 配置一致性

- `mustEqual` 差异数通过只调整 Staging 降为 0；不得为达成该指标自动修改 Production。
- `mustDiffer` 字段全部不同且通过资源身份读回。
- 所有允许差异都有原因、负责人和到期策略。
- 未分类差异全部报告，不被默认忽略。
- 仓库、Staging 普通配置文件、部署产物和日志均不包含明文凭据；Production 历史内联项作为已知只读例外报告，
  未经单独授权不迁移。

### 12.4 业务能力

- Agent → Runtime Worker → ACS → Sandbox → result writeback 真实通过。
- WebTools、ImageGen、STT/TTS、Memory、Cron 和通知测试 sink 各有真实读回证据。
- Staging 无法访问 Production DB、Workspace、通知目标、普通业务凭据和 Codex 凭据。
- 健康检查、配置一致性和业务验收分别报告，不互相替代。

### 12.5 Production 配置不变证明

- 实施前记录 Production `config.json`、共享 `server.env`、独立管理 store 和 SecretVault 非敏感清单的摘要或版本。
- Staging 改造、代码部署和验收结束后，由独立只读身份重新采集相同对象。
- 除正常 release identity 等明确不属于业务配置的发布字段外，受保护对象摘要必须逐项相同。
- Production Codex account binding hash、credential ID 和授权状态必须保持不变。
- Production API、Runtime Worker 的有效能力摘要和关键业务开关必须与实施前一致。
- 任一项无法读回或发生未授权变化，均不能宣称“未影响 Production”；停止后续动作并按既有备份恢复。

## 13. 恢复方案

即时保存不使用 revision，但每次修改仍保留受限数量的本地恢复点：

- 保存前文件摘要和备份路径；
- 配置 Schema 版本和脱敏指纹；
- SecretRef 清单摘要；
- 操作者、环境、时间和脱敏 diff；
- 运行时应用及读回结果。

配置采用候选文件校验后原子切换。持久化、热更新或读回失败时恢复上一份配置，并重新验证 API 与
Runtime Worker。恢复只作用于当前环境，不跨环境复制配置或凭据。

上述恢复机制适用于管理员明确发起的当前环境保存。对于本方案的代码实施和 Staging 落地，Production 不应产生配置写入，
因此不得以“可以回滚”为由先改 Production；如果检测到意外写入，应立即停止并按实施前只读基线进行事件处置。

Codex 故障只处理对应环境：重新授权该环境账号，或临时切换到该环境已配置的 API Key fallback 模型；
不得复制另一环境的 token bundle 作为恢复手段。

## 14. 建议提交拆分

1. `feat(config): add effective config inventory and parity contract`
2. `feat(config): harden immediate admin config updates`
3. `feat(config): add secret references without production auto migration`
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
- Staging 完成独立 Codex 授权，Production 保持现有授权不变；账号与凭据相互隔离且无跨环境影响。
- Staging 和所有后续新写入的业务凭据只保存 SecretRef；Production 历史配置保持兼容读取，迁移不包含在本次执行范围。
- Staging 在独立资源和测试目标上完成完整业务验收。
- 环境差异可持续检测，未分类漂移能够被报告和处置。
- Production 受保护配置、store、Vault 清单及 Codex 绑定的实施前后只读证据一致。
