# Invocation Correlation Contract

## 目标

`CorrelationContext` 是 Brain、Runtime Worker、Transport、Hand 与 ACS/Sandbox 共用的最小调用关联契约。当前协议版本为 `1`。它只描述身份，不承载工具参数、用户或模型正文、凭据、租户/用户身份、本机路径等业务或敏感数据。

## 字段所有权

| 字段 | 创建者 | 语义与传播边界 |
|---|---|---|
| `version` | 协议 | 固定为 `1`；不支持的版本在信任边界拒绝 |
| `sessionId` | Brain | 会话身份；随调用向下传播，不由 Hand/Sandbox 改写 |
| `runId` | Brain/Runtime | durable run 身份；随调用向下传播 |
| `toolCallId` | 模型适配层/Brain | 一个 run 内的工具调用身份 |
| `invocationId` | Brain | logical invocation 与 TASK-316 幂等主键；重试、重放、取消和对账始终保持不变 |
| `attemptId` | Runtime Worker | 通过 durable gate 后、真正进入 provider 前创建；每次真实新执行不同 |
| `handId` | Brain 的可信路由层 | 选中的 Hand；模型输入不能覆盖已解析的可信路由结果 |
| `sandboxId` | ACS Orchestrator | 根据已解析的 sandbox ref 添加；上游值不作为资源选择依据 |
| `releaseId` | 可信部署层 | 仅有可信发布身份时填写；当前链路不伪造 |

所有 ID 只能使用安全字符 `[A-Za-z0-9._:@-]`，最长 256 字符。解析器拒绝未知字段、非法格式、版本不支持，以及 legacy `context.invocationId/handId` 与版本化字段冲突。

## 生命周期

1. Brain 根据 `runId + toolCallId` 复用既有 `invocationId`，先完成 durable start/claim/cancel 检查。
2. 只有 gate 确认本次将进入 provider 时，Worker 才创建 `attemptId`。同一次 HTTP 连接重试、SSE 断连恢复和结果轮询复用该 attempt。
3. Hand 仍按 `invocationId` 做 single-flight、journal、cancel tombstone 和结果重放。journal 可记录首次真实执行的 `executionAttemptId`，但绝不按它查重。
4. ClientDaemon 对同一 `invocationId` 的并发重复派发明确拒绝，且在途 entry 只能由创建它的执行清理，避免覆盖后取消错位或重复副作用。
5. durable replay、cancel-before-start 不执行 provider，因此不产生 Hand/Sandbox 新 attempt。重启时 `running → interrupted/indeterminate` 继承原 invocation/attempt 记录。
6. ACS 用 `invocationId` 处理取消与在途映射，并把可信 `sandboxId` 加入 runner correlation；SandboxRunner 原样交给本地 provider。

## 向后兼容与信任边界

旧请求可以只有字符串类型的 `context.invocationId/handId`，接收端会降级为 version `1` context；字段一旦出现但不是字符串，必须拒绝，不能当成“未提供”。新发送端同时保留 legacy 字段并发送 `correlation`，便于滚动升级；两者不一致时 fail closed。Hand、ACS 与 ClientDaemon 都重新解析版本、字段 allowlist 和 ID 格式，不能相信上游已经校验。

## 日志契约

统一 logger 从 invocation AsyncLocalStorage 读取 context，只输出上述 ID allowlist，并缩短过长 ID。解析失败只报告固定错误类别，不回显不可信字段名或版本值。`runId/sessionId` 继续沿用现有 request context 显示；日志不会从 correlation 接收 `tenantId`、`userId`、`username`、工具参数、用户/模型正文、token、secret 或路径。该契约只建立稳定接口，不替代后续结构化 tracing、指标或采集平台。
