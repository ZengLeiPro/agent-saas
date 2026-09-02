# 平台能力引导式配置与安全启用方案

## 1. 背景

平台“配置状态”页已经能够展示当前实例的有效配置、能力指纹和 Secret 就绪摘要，并把管理员引导到对应业务页面。但当前能力启用仍以业务页面中的独立开关为主，部分能力可能出现以下半配置状态：

- 开关已经写为 `enabled=true`，但必填配置或 Secret 尚未齐备；
- 配置格式合法，但出口网络、上游服务或运行资源不可用；
- API 进程已经热更新，Runtime Worker 尚未读取相同配置；
- 前端阻止了错误提交，但调用者绕过前端后仍可直接写入不完整配置；
- 状态页只有“已启用/未启用”，无法区分未配置、待验证、运行异常和基础设施阻塞。

本方案在现有业务配置页面内增加能力专属引导式表单和后端启用门禁，确保能力只有在必填配置、Secret、外部连通性和运行依赖全部满足后才能启用。

## 2. 目标与边界

### 2.1 目标

- 为配置状态页当前展示的 14 项能力分别提供独立引导式表单。
- 每项能力使用自己的字段、校验规则、探测步骤和启用条件。
- 启用过程保持原子性：探测失败不得改变当前有效配置。
- Secret 明文只在提交时出现，服务端立即写入当前环境 SecretVault；普通配置只保存 SecretRef。
- 保存并启用后，读回 API 与 Runtime Worker 的配置指纹和能力状态。
- Staging 允许具备权限的管理员直接配置；Production 继续受只读、二次确认或发布审批策略约束。

### 2.2 不做的事情

- 不在配置状态页堆叠所有配置字段。
- 不实现 JSON Schema 动态表单、字段数组驱动的通用表单或 `GenericCapabilityForm`。
- 不新增跨环境复制、从 Production 同步到 Staging 或反向覆盖能力。
- 不在浏览器中展示 Secret 明文、完整 Vault Ref、数据库连接或基础设施主密钥。
- 不把所有能力合并成一个巨型保存接口。
- 不把配置格式校验等同于真实运行就绪。

## 3. 总体交互

配置状态页根据能力状态展示不同操作：

| 状态         | 展示                 | 主操作     |
| ------------ | -------------------- | ---------- |
| `disabled`   | 已完整配置但关闭     | 启用       |
| `incomplete` | 缺少配置或 Secret    | 配置并启用 |
| `validating` | 正在执行能力探测     | 查看进度   |
| `ready`      | 验证通过但尚未启用   | 启用       |
| `enabled`    | 已启用且运行正常     | 查看配置   |
| `degraded`   | 已启用但运行探测异常 | 检查并修复 |
| `blocked`    | 受基础设施或审批阻塞 | 查看阻塞项 |

点击操作后跳转到对应业务页面，并通过路由参数自动打开目标能力的专属向导。例如：

```text
配置状态
  -> WebTools“配置并启用”
  -> 工具开关页面
  -> WebToolsEnableWizard
  -> 填写专属配置
  -> 校验 Secret 与出口
  -> 执行真实探测
  -> 原子保存并启用
  -> 读回 API/Worker 指纹
```

配置状态页保持只读汇总，不承担业务配置保存职责。

## 4. 独立表单约束

每项能力必须有单独组件、类型、默认值、前端校验、API client 和后端验证器。

建议组件：

```text
ModelEnableWizard.tsx
CodexEnableWizard.tsx
WebToolsEnableWizard.tsx
ImageGenEnableWizard.tsx
AudioTranscribeEnableWizard.tsx
TtsEnableWizard.tsx
MemoryEnableWizard.tsx
MemoryPollingEnableWizard.tsx
MemoryConsolidationEnableWizard.tsx
CronEnableWizard.tsx
SystemMonitorEnableWizard.tsx
EventRetentionEnableWizard.tsx
ToolControlsEnableWizard.tsx
AcsEnableWizard.tsx
```

允许共享的仅是无业务语义的交互基础设施：

- `EnableWizardShell`：步骤、取消、返回和加载状态；
- `SecretInput`：不回显、替换、撤销和 Secret 就绪状态；
- `ValidationChecklist`：格式校验和缺失项展示；
- `ProbeResult`：连通性和运行探测结果；
- `EnvironmentBanner`：当前环境和 Production 风险提示；
- `ConfigDiffConfirm`：脱敏 diff 和最终确认。

不得共享字段定义、能力校验规则或能力启用 payload。代码评审应拒绝以下实现：

```text
GenericCapabilityForm
CapabilityForm({ schema, fields })
JSON Schema form renderer
通过一个字段数组渲染全部能力
```

## 5. 14 项能力的专属向导

### 5.1 模型

表单内容：

- Provider/协议模板；
- 模型组 ID、名称、Base URL；
- API Key 新值或已有 Secret 状态；
- Chat Completions/Responses 协议参数；
- 模型 ID、显示名称和上游 model value；
- 输入模态、上下文窗口和自动压缩阈值；
- Token 计费、缓存计费和 usage accounting；
- 默认模型、跨组切换、图片理解模型和 fallback。

启用门禁：

- 至少存在一个模型组和一个模型；
- 默认模型必须解析到已配置模型；
- 需要凭证的模型组必须具备 Secret；
- Base URL、协议和 transport 组合合法；
- 使用最小请求完成一次真实模型探测；
- 声明图片输入时应额外执行图片输入探测，不按模型名称猜能力。

“模型”不存在单独总开关。未配置时主操作文案为“添加首个模型”。

### 5.2 Codex

表单内容：

- 当前环境和固定 Endpoint；
- Originator；
- OAuth 设备授权；
- 已授权账号列表、账号摘要、到期时间和优先级；
- WebSocket 会话接力开关；
- 使用 `codex_subscription` transport 的 Responses 模型映射。

启用门禁：

- 至少一个账号处于已连接状态；
- OAuth Token 未过期，或刷新测试成功；
- 至少存在一个协议为 Responses 且 transport 为 Codex Subscription 的模型；
- 完成最小 Responses 请求；
- WebSocket 开启时额外验证握手和回退链路。

Codex 不提供 API Key 表单，必须走当前环境独立 OAuth 授权。

### 5.3 WebTools

向导首先让管理员选择启用 `WebSearch`、`WebFetch` 或二者同时启用。

WebSearch 表单：

- Provider：Brave、Volcengine、Tencent WSA、智谱或 Tavily；
- Provider 对应 API Key；
- 自定义 Endpoint；
- Timeout、Max results；
- 智谱 Search Engine、Tavily Search Depth 等 Provider 专属字段；
- 可选全球搜索源及其独立 Provider、Secret 和策略。

WebFetch 表单：

- Timeout、最大响应字节、最大字符数和最大跳转数；
- 允许的 Content-Type；
- User-Agent；
- Allowed hosts、Blocked hosts；
- 是否允许访问私网/localhost，默认关闭。

启用门禁：

- WebSearch 启用时必须存在对应 Provider Secret；
- 使用当前环境实际出口执行固定搜索查询并验证结构化结果；
- WebFetch 使用当前环境出口抓取测试地址并验证 DNS、TLS、跳转、大小和 Content-Type；
- 出口代理不可用时不得仅凭格式校验启用；
- 对私网访问必须显示高风险确认和最终有效策略。

### 5.4 ImageGen

GPT Image 2 和 Seedream 使用两张独立引擎卡，不共用一套字段：

- 引擎开关；
- Base URL；
- 模型 ID；
- API Key；
- Timeout；
- 每张图积分和实际成本。

启用门禁：

- 平台总开关开启时至少启用一个引擎；
- 每个启用引擎必须具备自己的 Secret、Base URL 和模型 ID；
- 执行一次最小尺寸生图 canary；
- 测试前明确提示可能产生真实费用；
- 返回结果必须能下载并解码为受支持图片格式。

### 5.5 语音转写

表单内容：

- 转写模型；
- DashScope API Key；
- OSS AccessKey ID 和 Secret；
- OSS Bucket、Endpoint；
- 每次积分和实际成本。

启用门禁：

- 三项 Secret 全部存在；
- Bucket 与 Endpoint 合法；
- 使用 canary 对象完成 OSS 写入、读取和删除；
- 使用仓库内固定短音频完成一次真实转写；
- 验证转写结果非空，并清理测试对象。

### 5.6 语音合成

新增 TTS 专属卡片和后端管理接口，表单内容：

- 豆包 App ID；
- 豆包 API Key；
- Cluster；
- 默认音色；
- 默认语速。

同时扩展配置兼容层：

- 新增 `tts.enabled`；
- 新增 `tts.doubaoApiKeyRef`；
- 继续兼容读取历史 `doubaoApiKey`；
- 旧配置存在且缺少 `enabled` 时保持原运行语义，不在启动时自动写回。

启用门禁：

- App ID 和 Secret 完整；
- 默认音色有效、语速为正数；
- 合成固定测试文本；
- 返回音频能够解码且时长大于零。

### 5.7 Memory

表单按业务语义分为三个区块。

核心与注入：

- Memory 总开关；
- 是否向会话注入记忆；
- 最大注入行数。

可选向量索引：

- Embedding Base URL、模型、维度和 API Key；
- Chunk tokens 和 overlap；
- 向量/文本权重、最大结果和最低分；
- 时间衰减和半衰期；
- 同步 debounce。

存储状态：

- 展示当前 Memory/索引存储位置和可写状态；
- 不允许管理员在浏览器中任意输入宿主机或 NAS 路径。

启用门禁：

- Memory 存储可创建、写入和读回 fixture；
- 开启索引时必须具备 Embedding Secret；
- Embedding 请求返回维度必须与配置一致；
- Chunk overlap 小于 chunk tokens；
- 检索权重组合有效，并完成一组 fixture 写入与召回。

### 5.8 记忆轮询

表单内容：

- 起始小时、调度跨度和 IANA 时区；
- 活动回看范围；
- 最大 Agent 轮数；
- 执行超时；
- 执行模型或跟随组织默认模型；
- 未来三次触发时间预览。

启用门禁：

- Memory 总能力已启用；
- 调度窗口不跨越次日；
- 指定模型存在且可调用；
- Runtime Worker 和调度器健康；
- 在 Staging fixture 上执行一次 dry-run；
- 平台启用不自动打开组织级 Memory Polling 权限。

### 5.9 记忆整合

表单内容：

- 静默期；
- 扫描周期和批次大小；
- Worker 并发；
- Lease 时长；
- 单次超时、重试次数和最大轮数；
- 是否包含中断会话。

启用门禁：

- Memory 总能力已启用；
- Runtime Event Store 为 PostgreSQL 且可用；
- Runtime Worker 健康；
- 完成 lease 获取、续租和释放测试；
- 使用隔离 fixture 完成一次候选扫描和 dry-run；
- 并发、lease 与 timeout 组合不得造成任务必然过期。

### 5.10 定时任务

表单内容：

- 平台 Cron 总开关；
- 当前持久化后端、位置和可写状态，只读展示；
- Scheduler/Runtime Worker 状态；
- 当前时区；
- 当前任务数量和下一次触发摘要。

不允许管理员从浏览器任意填写 `cron.store` 路径。路径属于环境部署配置。

启用门禁：

- 持久化后端可写并能读回；
- Scheduler 和 Runtime Worker 就绪；
- 创建一个临时 no-op 任务、观察一次 claim 后删除；
- 清理测试数据成功后才允许正式启用。

### 5.11 系统监控

表单内容：

- Fast interval；
- Workspace scan interval；
- `du` 并发；
- TLS 检查域名列表；
- 当前告警 sink 状态和跳转入口。

启用门禁：

- 完成一次 CPU/内存/磁盘采样；
- 完成一次 Workspace/NAS 扫描并记录耗时；
- 所有 TLS 检查地址格式合法，并至少完成一次探测；
- 扫描周期和并发不得超过安全边界；
- 告警 sink 缺失可以启用监控，但必须明确显示“只能采集、不能通知”。

### 5.12 事件保留

这是高风险数据删除能力，必须使用两阶段向导。

第一阶段：Dry-run。

- 扫描周期；
- 批次和每类最大批次数；
- Terminal Delta 宽限期；
- 成功摘要、失败摘要、模型诊断、请求完成和 Hand 事件保留时间；
- Billing catch-up 参数；
- 展示预计删除条数、最早/最晚序列和受影响类别。

第二阶段：Execute。

- 法务允许删除到的全局序列水位；
- 授权编号/审批引用；
- 最近一次 Dry-run 摘要和时间；
- 输入环境名称和确认语句。

启用门禁：

- 首次只能启用 `dry-run`；
- Execute 必须提供非空授权引用和正数法务水位；
- `modelRequestFinishedRetentionDays` 不得短于诊断保留期；
- 最近一次 Dry-run 必须基于当前配置指纹；
- Production 必须经过额外人工审批，不允许普通保存按钮直接切换 Execute。

### 5.13 工具控制

表单内容：

- 全局“向模型暴露平台工具”开关；
- 按工作区、记忆、技能、协作、会话、Web、多媒体和定时任务分组；
- 单工具开关；
- description append/replace；
- 依赖能力和受影响系统 Profile 摘要。

启用门禁：

- `WebSearch`、`WebFetch` 必须依赖已就绪 WebTools 子能力；
- `GenerateImage` 必须依赖至少一个已就绪生图引擎；
- `AudioTranscribe` 必须依赖已就绪 STT；
- 依赖执行环境的工具必须存在健康执行提供方；
- 危险工具显示审批/HITL 要求；
- description `replace` 必须展示原文与新文并二次确认；
- 启用后只影响后续 dispatch，已有运行继续使用创建时快照。

### 5.14 ACS 执行环境

表单内容：

- 环境池 ID 和描述；
- Base URL；
- Auth Token 新值或 SecretVault Ref；
- Invoke timeout；
- Rollout：disabled、drain、用户白名单、组织、全部用户；
- 用户/组织范围；
- 网络策略：isolated、public-egress、private-egress；
- Allow CIDR、Allow Domain、Deny CIDR；
- Workspace Recipe、资源限制和初始化命令；
- ACS 最大运行数、告警阈值和排空超时。

启用门禁：

- Runtime Event Store 为 PostgreSQL；
- Base URL 和 Token 鉴权通过；
- Orchestrator 健康并返回可信运行身份；
- PVC/NAS 和 Sandbox namespace 正确；
- 创建、运行、排空并删除一个 canary Sandbox；
- 网络策略在 canary 中实际生效；
- 全部探测通过前 Rollout 只能保持 `disabled`；
- 切到“全部用户”必须单独高风险确认。

## 6. 后端契约

### 6.1 状态汇总

保留现有 `capabilities: Record<string, boolean>` 作为兼容字段，新增 `capabilityStates`：

```ts
type CapabilityState =
  'disabled' | 'incomplete' | 'validating' | 'ready' | 'enabled' | 'degraded' | 'blocked';

interface CapabilityReadiness {
  state: CapabilityState;
  missing: string[];
  blockers: Array<{
    code: string;
    message: string;
    targetRouteId?: string;
  }>;
  lastValidation?: {
    status: 'passed' | 'failed';
    validatedAt: string;
    configFingerprint: string;
  };
  targetRouteId: string | null;
}
```

返回示例：

```json
{
  "state": "incomplete",
  "missing": ["webTools.search.apiKeyRef", "egress.server.proxyUrl"],
  "blockers": [],
  "lastValidation": null,
  "targetRouteId": "platform.resource-center.tools"
}
```

`missing` 只包含字段路径，不返回 Secret 明文或完整 Vault Ref。

### 6.2 能力级验证器

后端必须建立独立验证器，不使用一套通用必填规则：

```text
ModelEnableValidator
CodexEnableValidator
WebToolsEnableValidator
ImageGenEnableValidator
SttEnableValidator
TtsEnableValidator
MemoryEnableValidator
MemoryPollingEnableValidator
MemoryConsolidationEnableValidator
CronEnableValidator
SystemMonitorEnableValidator
EventRetentionEnableValidator
ToolControlsEnableValidator
AcsEnableValidator
```

可以共享网络请求、Secret 暂存、配置锁、指纹读回等基础设施，但验证步骤和成功条件由各能力自己实现。

### 6.3 原子启用事务

所有能力遵循相同事务顺序，但不共享业务 payload：

1. 读取当前有效配置和 expected fingerprint；
2. 校验能力专属候选配置；
3. 将新 Secret 写入临时或可撤销 Vault 记录；
4. 使用候选配置与 Secret 执行能力专属真实探测；
5. 探测通过后通过 `adminConfigMutationService` 原子写入配置和 `enabled=true`；
6. 热更新 API 与 Runtime Worker；
7. 读回有效配置指纹、能力状态和 Secret 就绪摘要；
8. 指纹不收敛时报告失败并触发安全恢复；
9. 探测或保存失败时保持原配置不变，并撤销本次暂存 Secret。

绕过前端直接调用保存接口时，后端仍必须拒绝不完整启用，建议错误码：

```text
CAPABILITY_CONFIG_INCOMPLETE
CAPABILITY_SECRET_MISSING
CAPABILITY_PROBE_FAILED
CAPABILITY_RUNTIME_NOT_READY
CAPABILITY_CONFIG_CONFLICT
CAPABILITY_APPROVAL_REQUIRED
```

## 7. 安全与环境规则

- Secret 明文不得写入配置状态、审计 diff、日志、错误信息或浏览器缓存。
- 普通配置只保存当前环境的 opaque SecretRef。
- Staging 和 Production 分别授权，不跨环境复制授权凭证。
- Production 保存前展示环境、脱敏 diff、影响面和审批状态。
- 数据删除、全用户 Rollout、私网访问、危险工具和 description replace 使用额外确认。
- 连通性测试必须使用服务端当前有效出口，不从浏览器直接调用上游。
- 测试产生的 OSS 对象、Cron fixture、Sandbox 和其他资源必须清理并读回确认。
- 已开始的运行继续使用创建时工具/配置快照；新配置只影响后续 dispatch。

## 8. 实施拆分

### PR 1：状态契约和启用基础设施

- 扩展 `effectiveConfigStatus` 和前端类型；
- 增加 `capabilityStates`；
- 增加状态页操作文案和精确 deep link；
- 实现 Secret 暂存/撤销、expected fingerprint 和原子启用基础设施；
- 不在该 PR 引入业务表单。

### PR 2：外部服务能力

- 模型；
- Codex；
- WebTools；
- ImageGen；
- STT；
- TTS；
- 对每项增加独立验证器和真实探测。

### PR 3：Memory 与后台任务

- Memory；
- 记忆轮询；
- 记忆整合；
- Cron；
- 系统监控；
- 事件保留。

### PR 4：工具与执行环境

- ToolControls 依赖门禁；
- ACS 独立向导；
- API/Worker 收敛读回；
- Staging 真实 E2E；
- Production 只读与审批保护。

## 9. 测试与验收

### 9.1 单元和契约测试

- 14 个向导分别测试默认值、必填、边界值、Secret 保留和错误展示；
- 14 个后端验证器分别测试成功、缺失、探测失败和运行依赖阻塞；
- 直接绕过前端提交 `enabled=true` 时，后端必须拒绝不完整候选配置；
- 探测失败前后有效配置指纹保持不变；
- Secret 写入成功但配置提交失败时，新增 Secret 被撤销或标记为不可引用；
- 并发管理员使用过期 fingerprint 保存时返回冲突，不覆盖新配置。

### 9.2 Staging 真实验收

- 使用浏览器逐项完成“配置并启用”；
- 对外部能力执行真实上游调用，而不是仅验证 `/health`；
- 对 Cron、Memory、Retention 和 ACS 使用隔离 fixture；
- 保存后分别读取 API 和 Runtime Worker 的配置指纹；
- 配置状态页展示 `enabled`，且最后验证指纹与当前有效配置一致；
- 新会话/新任务能使用能力，已有运行不被中断；
- 测试数据和临时资源全部清理并读回确认。

### 9.3 Production 边界

- 首次部署只验证兼容读取和只读状态，不执行真实保存；
- 任何 Production 配置写入、授权、Retention Execute 和全用户 ACS Rollout 单独审批；
- 不通过 Staging 自动覆盖 Production 配置；
- 代码部署成功不等于能力已经完成 Production 业务验收。

## 10. 完成定义

只有同时满足以下条件，能力引导式启用改造才算完成：

- 14 项能力均有独立表单和独立验证器；
- 不存在通用字段渲染器；
- 前端和直接 API 调用都无法写入半配置启用状态；
- Secret 不回显、不进入普通配置和日志；
- 失败不改变有效配置，成功后 API/Worker 指纹收敛；
- 配置状态页能区分 disabled、incomplete、ready、enabled、degraded 和 blocked；
- Staging 完成真实端到端验收；
- Production 未经单独授权不发生配置变更。
