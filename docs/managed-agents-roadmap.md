# Managed Agents 架构解读与本项目改造路线图

> 目标读者：后续接手本仓库的新会话 Agent。  
> 目标效果：只读本文，即可理解 Anthropic《Scaling Managed Agents: Decoupling the brain from the hands》的核心思想、当前项目已经具备哪些基础、还缺哪些模块，以及应该按什么顺序逐步修改。  
> 原文：<https://www.anthropic.com/engineering/managed-agents>（Anthropic Engineering，Published Apr 08, 2026）。

---

## 0. 本文使用方式

如果你是新会话 Agent，请先读本节，然后按后文路线执行：

1. **不要一上来改代码。** 先用 `rg` 查看本文提到的文件和现状，确认代码是否已变化。
2. **优先保持接口稳定。** Managed Agents 的核心不是“加更多工具”，而是把 `session`、`harness/brain`、`sandbox/hand` 的边界变成稳定协议。
3. **所有长任务状态必须 durable。** 如果某个状态只存在于 WebSocket、内存变量、当前 Node 进程或某个容器里，它就不是 Managed Agents 需要的可靠状态。
4. **生产默认不要信任 sandbox。** sandbox 里运行的是模型生成的代码，原则上不应能读到用户 OAuth token、Git token、平台密钥或内部网络凭据。
5. **每一步都要能独立上线。** 本文路线按 P0/P1/P2/P3/P4 拆分，不要求一次性重构。

---

## 1. Anthropic 文章完整解读（中文转述）

### 1.1 文章主题

Anthropic 这篇文章标题是 **“Scaling Managed Agents: Decoupling the brain from the hands”**，核心问题是：

> 如何设计一个能承载长周期 Agent 工作的基础设施，使它不会被当前某一种 harness、某一个 sandbox、某一种上下文管理技巧或某一代模型能力锁死？

文章指出，Agent harness 往往会编码很多关于“模型做不到什么”的假设。例如，早期 Claude Sonnet 4.5 在接近上下文上限时会过早收尾，这被称为“context anxiety”。Anthropic 当时在 harness 里加入 context reset 来缓解。但到 Claude Opus 4.5，这个行为消失了，原先的 reset 反而变成了负担。

这说明：

- 模型能力会变；
- harness 中的经验性补丁会过期；
- 系统不应把某一代模型的限制固化成长期架构；
- 更好的方法是设计稳定接口，让底层实现可以替换。

Anthropic 把这个问题类比为操作系统的抽象设计：几十年前的 OS 把硬件虚拟化成 `process`、`file` 等抽象。无论底层是老式磁盘还是现代 SSD，`read()` 这样的接口仍然稳定。Managed Agents 希望对 Agent 系统做类似虚拟化。

### 1.2 三个被虚拟化的组件

文章把 Agent 系统拆成三个核心组件：

1. **Session**  
   发生过的一切的 append-only log，也就是长期、可恢复、可查询的事件记录。

2. **Harness / Brain**  
   调用 Claude、组织上下文、解释模型输出、路由工具调用的循环。文章里也把 Claude + harness 称为 “brain”。

3. **Sandbox / Hand**  
   Claude 执行动作的地方，例如容器、文件系统、shell、浏览器、手机、模拟器、MCP server、外部工具等。文章里把这些执行环境称为 “hands”。

这三个组件应该通过少量稳定接口相互连接，而不是绑在同一个容器或同一个进程里。

### 1.3 “不要养宠物”：单容器设计的问题

Anthropic 最初把所有 Agent 组件放进一个容器：

- session；
- agent harness；
- sandbox；
- Claude 可编辑的文件；
- Claude 可运行的代码；
- 工具和凭据。

这种设计有短期好处：

- 文件编辑就是本地 syscall；
- 没有复杂服务边界；
- 开发简单。

但它把整个系统变成了基础设施里的 **pet**。在 pets-vs-cattle 比喻里：

- pet 是有名字、要手工照顾、不能丢的个体；
- cattle 是可替换、可重建、可横向扩展的资源。

单容器 Agent 的问题是：

1. 容器挂了，session 就丢了。
2. 容器卡住，工程师要“照顾”它，而不是直接替换它。
3. 唯一观察窗口可能只是 WebSocket event stream。这个 stream 不能区分：
   - harness bug；
   - 网络包丢失；
   - 容器离线；
   - sandbox 内进程卡死。
4. 要调试只能进容器 shell，但容器又包含用户数据，因此调试本身就变成安全风险。
5. harness 假设 Claude 要操作的资源就在同一个容器里。客户如果要让 Claude 访问自己的 VPC，就只能和 Anthropic 网络互联，或者把 Anthropic harness 跑到客户环境里。这说明 harness 对基础设施位置做了错误假设。

### 1.4 解耦 brain、hands、session

文章提出的解决方案是把三者解耦：

- **brain**：Claude + harness；
- **hands**：sandbox 和各种工具；
- **session**：事件日志。

每一层都是接口，每一层都尽量少假设其他层，每一层都可以独立失败、替换、迁移和扩展。

最关键的接口是：

```text
execute(name, input) → string
```

也就是 harness 不再“住在”容器里，而是像调用任何工具一样调用容器：传入工具名和输入，返回字符串结果。

这样容器就变成 cattle：

- 容器死了，harness 把它当成 tool-call error；
- Claude 如果决定 retry，可以通过标准 recipe 重建容器；
- 标准初始化接口类似：

```text
provision({ resources })
```

这意味着不再修坏容器，而是重建 hand。

### 1.5 harness 也要 cattle 化

文章进一步指出，harness 自己也不能是 pet。

由于 session log 放在 harness 外部，harness 崩溃时不应丢状态。新的 harness 可以通过：

```text
wake(sessionId)
getSession(id)
emitEvent(id, event)
```

恢复执行：

- `wake(sessionId)`：唤醒某个 session；
- `getSession(id)`：读取已有事件日志；
- `emitEvent(id, event)`：Agent loop 运行过程中持续写入 durable events。

因此 harness 进程不需要长期保存关键状态。它只是读取 session log、调用模型、调用 hands、写回事件。

### 1.6 安全边界：token 不能进入 sandbox

文章强调，在耦合设计中，Claude 生成的不可信代码和凭据位于同一个容器。这样 prompt injection 只要诱导 Claude 读取环境变量，就可能拿到 token。一旦攻击者拿到 token，就可以启动新的无限制 session 或访问外部系统。

文章认为，仅仅缩小 token scope 是缓解，但不是结构性解决方案。原因是：这仍然假设 Claude 无法用一个窄权限 token 做坏事，而模型会越来越聪明。

结构性解决方案是：

> token 永远不要出现在 Claude 生成代码运行的 sandbox 中。

文章提到两种模式：

1. **Auth bundled with resource**  
   例如 Git：初始化 sandbox 时，用 repository access token clone repo，并把 token 接到本地 git remote。sandbox 内可以 `git pull` / `git push`，但 agent 永远不能直接读取 token。

2. **Auth held in a vault outside sandbox**  
   对自定义工具和 MCP：OAuth token 存在安全 vault。Claude 通过专用 proxy 调 MCP 工具。proxy 拿到与 session 关联的短期 token / capability，再去 vault 找真实凭据并代发请求。harness 本身也不知道真实凭据。

这部分是 Managed Agents 的安全核心：不仅 sandbox 不知道 credentials，最好 harness 也不知道。

### 1.7 Session 不是 Claude 的 context window

长周期任务经常超过模型上下文窗口。传统方法包括：

- compaction：让模型总结上下文；
- memory tool：让模型把信息写入文件；
- trimming：删除旧 tool results、thinking blocks 等 token。

这些方法都存在一个问题：它们会做不可逆的保留/丢弃决策。未来某一步到底需要哪些 token 很难提前知道。一旦 compacted messages 被从上下文窗口中移除，而原始内容没有 durable 存储，就无法恢复。

文章提出：

> session log 是 context window 之外的 context object。

session 不是模型当前看到的 prompt，而是可长期保存和查询的事实源。brain 可以通过：

```text
getEvents()
```

按位置查询事件流，例如：

- 从上次停止的位置继续读；
- 倒回某个事件前几步，查看之前发生了什么；
- 重新读取某个 action 前后的上下文；
- 选取 event stream 的 positional slice。

然后 harness 可以任意变换这些事件，再塞回 Claude 的上下文窗口。变换策略可以随模型和任务变化，包括：

- context organization；
- prompt cache friendly layout；
- context engineering；
- 摘要；
- 删除低价值 tool result；
- 只保留关键事件。

关键是：**原始 session log 仍然 durable 存在，context window 只是派生视图。**

### 1.8 Many brains

解耦 brain 和 hands 后，brain 可以变成 stateless harness 集群。

文章指出，原先把 brain 放在容器里时，每个 brain 都要等容器 provision：

- clone repo；
- 启动进程；
- 拉 pending events；
- 初始化 sandbox。

即使某个 session 根本不需要 sandbox，它也要先付这个启动成本。这会影响 TTFT（time-to-first-token），也就是用户最敏感的“从接受任务到第一个 token 出现”的延迟。

解耦后：

- orchestration layer 先从 session log 拉 pending events；
- stateless harness 立刻开始推理；
- 只有模型真的需要容器时，才通过 tool call provision hand。

文章称这种架构让 p50 TTFT 下降约 60%，p95 下降超过 90%。

Many brains 的本质是：

- 扩容就是启动更多 stateless harness；
- session log 在外部；
- hand 只在需要时连接；
- harness 不携带必须保活的本地状态。

### 1.9 Many hands

文章还希望一个 brain 可以连接多个 hands。Claude 需要理解多个执行环境并决定把工作发到哪里。早期模型可能不擅长这个，所以最初采用单容器。但随着模型变强，单容器反而成为限制：一旦容器失败，brain 正在触达的所有 hand 状态都会被牵连。

解耦后，每个 hand 都是一个工具：

```text
execute(name, input) → string
```

这个统一接口可以覆盖：

- custom tools；
- MCP server；
- Anthropic 自己的工具；
- container；
- phone；
- Pokémon emulator；
- 未来还没想到的执行环境。

因为 hand 不和某个 brain 绑定，brain 之间甚至可以传递 hands。

### 1.10 结论：Managed Agents 是 meta-harness

文章最后把 Managed Agents 定义为一种 **meta-harness**。

它不押注某一种具体 harness，不假设 Claude 永远需要某一种上下文策略、某一种 sandbox 或某一种工具集。它只对 Claude 周围的接口有明确意见：

- Claude 需要操作 state：session；
- Claude 需要执行 computation：sandbox / hand；
- Claude 需要扩展到 many brains 和 many hands；
- 系统要在长时间维度上可靠、安全地运行。

也就是说，Managed Agents 的重点不是“今天的 Claude 该怎么提示”，而是设计能承载未来 Claude 的稳定 substrate。

---

## 2. 当前权威状态（截至 2026-06-21）

> 本节是本文的状态入口。后续章节中的 P0/P1/... 仍保留实施历史和细节，但如果状态描述冲突，以本节和第 13、14 节为准。

当前项目已经具备 Managed Agents v0 的核心闭环：

- **Session 是 durable 事实源。** `EventStore` 已有 file / PG 两套实现；PG backend 下 runtime events 外部化到 PostgreSQL，支持多 brain 共享。`SessionContextService` 已把 session 暴露为可查询 context object，而不是只依赖模型当前 context window。
- **Brain / harness 已具备 cattle 化基础。** `PgRunStore`、`RuntimeScheduler`、worker lease、`wakeRuntimeSession()`、`run_state_changed` 事件、Web enqueue-only 已落地；PG backend 下 Web chat 默认 enqueue run，由 scheduler acquire lease 后 wake。
- **Hand / sandbox 已具备 many-hands 基础。** 统一 `ToolInvocationRequest` / `ToolInvocationResponse` envelope、`ExecutionTransport`、`HttpTransport`、`HandStore`、`HandManager`、server-remote hand、tenant remote hand、client daemon、health scanner、handId routing 已落地。
- **Credential boundary 已有 baseline。** MCP 调用已统一走 `McpProxy`；tenant remote hand 支持 `authTokenRef` 由 `SecretVault` 解析；远端 hand wire request 不携带 `workspace.root`。但仍需要系统化安全审计来证明 secret 不会进入 sandbox、日志、metadata 或 crash dump。
- **当前最大剩余工作不是重写架构，而是生产化验证。** 重点是把已有 chaos baseline 扩展成生产 / staging 验收矩阵，并继续推进跨进程 streaming / fanout 压测、PG 查询下推、hand provisioning hydrate、tenant isolation、安全审计和观测告警。

---

## 3. 将文章映射到本项目：术语对照

| Anthropic 术语 | 本项目当前对应物 | 当前成熟度 | 最新状态 |
|---|---|---:|---|
| Session | `EventStore`、`FileEventStore`、`PgEventStore`、`SessionCatalog`、`SessionContextService` | 高 | append-only log、PG durable backend、session context tools、derived summary/raw log 分离已落地；仍需 PG 原生事件查询、schema versioning、长期 retention/GC 策略。 |
| Brain / Harness | `RawAgentLoop`、`rawRuntimeRunDispatch.ts`、`wakeRuntimeSession()`、`RuntimeScheduler`、Web enqueue-only | 中高 | durable run + lease + wake 基础闭环已落地；已有真实 PG / 子进程 chaos baseline，仍需 staging/production 多实例演练、跨进程 replay/fanout 压测和调度观测。 |
| Hand / Sandbox | `ExecutionProvider`、`ExecutionTransport`、`HttpTransport`、`HandStore`、`HandManager`、hand-server、client daemon | 中高 | envelope、server-remote、hand registry、health scanner、handId routing、tenant/client hand 已落地；仍需完整 provision hydrate、remote cancel/streaming 压测。 |
| `execute(name,input)` | `ToolInvocationRequest` / `ToolInvocationResponse` / stream chunks | 高 | 统一 envelope 是正式接口入口；不要退回 provider-specific 调用。 |
| `wake(sessionId)` | `wakeRuntimeSession(config, run, { lease })` | 中高 | 可从 `SessionCatalog` / run metadata / EventStore 恢复上下文，并处理 durable cancel / approval / ask-user resume；仍需 chaos 验证。 |
| `emitEvent(id,event)` | `EventStore.append()` / `appendBatch()` + `run_state_changed` 等事件 | 高 | 运行时状态、工具调用、interaction、hand health、provisioning logs 等均已有事件形态；仍需统一 schema version / projection 校验。 |
| Many brains | PG EventStore + `PgRunStore` + `RuntimeScheduler` + `PgSessionLock` | 中高 | 多 worker lease 基础已落地；已有 multi-worker chaos baseline，剩余重点是生产拓扑下的跨进程 stream delivery 与运维观测。 |
| Many hands | `HandStore`、`HandManager`、`<available-hands>`、handId routing、tenant/client daemon hand | 中高 | capability registry 与 routing 基础闭环已落地；继续补 hand lifecycle 的生产验证和 hydrate。 |
| Vault / proxy | `SecretVault` baseline、`McpProxy`、tenant hand `authTokenRef`、client daemon registry | 中 | proxy/vault baseline 已有；仍需端到端 secret isolation 审计和 production vault backend。 |

---

## 4. 已完成能力与当前边界

### 4.1 Durable run state machine（已完成基础闭环）

当前已经有 `server/src/runtime/runStore.ts` 和 `PgRunStore`。PG backend 会创建 `runtime_runs` 表，记录 `run_id`、`session_id`、`user_id`、`tenant_id`、`status`、`worker_id`、`lease_expires_at`、`idempotency_key`、`execution_target`、`workspace_id`、`metadata` 以及 Responses API session state 字段。

`RunStore` 已支持：

- `upsertPending()`：创建 / 合并 pending run；
- `markStatus()`：更新 `pending` / `running` / `waiting_approval` / `waiting_user` / `waiting_hand` / `completed` / `failed` / `cancelled` / `orphaned` 等状态；
- `findByIdempotencyKey()`：跨进程幂等事实源；
- `listRecoverable()`：供 scheduler 扫描 pending 和 expired lease；
- `acquireLease()` / `renewLease()` / `releaseLease()`：worker lease 生命周期。

**当前边界：** 数据结构和本地真实 PG / 子进程 chaos baseline 已具备；下一步要把同一 run 不重复执行、lease 过期接管、terminal state 幂等、idempotency key 等断言搬到 staging/production 拓扑持续验证。

### 4.2 RuntimeScheduler / worker lease（已完成基础闭环）

当前已经有 `server/src/runtime/scheduler.ts`。`RuntimeScheduler` 会扫描 recoverable run，尝试 acquire lease，写 `run_lease_acquired`，再根据配置：

- `autoWake=true`：调用 `wakeRuntimeSession()`；
- `autoWake=false`：把 recoverable run 标为 `orphaned`，避免未确认部署策略时自动恢复。

PG runtime 装配时默认 `autoWake=true`，Web enqueue-only 的 run 会由 scheduler acquire lease 后执行。

**当前边界：** scheduler 能工作，且已有 server restart / multi-worker 等 chaos baseline；production 上线前仍需要在真实部署拓扑中持续演练 wake 期间 renew 失败、DB 短暂不可用、跨进程 event delivery 等场景。

### 4.3 Session-as-context（已完成基础闭环）

当前已经有 `SessionContextService`，提供：

- `getEvents()`；
- `getEventsAround()`；
- `getRunEvents()`；
- `getToolTrace()`；
- `searchEvents()`。

并且已经暴露为模型可调用 safe tools：

```text
session_get_events
session_search_events
session_get_tool_trace
```

这意味着 Agent 可以主动查询 durable session log，而不是完全依赖 harness 一次性把历史塞进 prompt。

**最新状态（2026-06-21，commit `7644d5f`）：** `SessionContextService` 已优先调用 `EventStore` 的 query-downpush 方法；`PgEventStore` 已支持 `listPage(sessionId,{runId,type})`、`listAround()`、`listByRun()`、`listByToolCall()`、`search()`，并补 session/run/type/toolCallId 相关索引；`FileEventStore.listPage()` 也支持 runId/type 过滤，保持 dev/file backend 语义一致。

**当前边界：** search 仍是受 limit 限制的 `event_json::text ILIKE` baseline，不是最终全文检索方案；session context tools 仍需更细的 prompt-exfiltration 审计、查询成本指标、tenant-aware audit projection 与长期 retention/GC 策略。

### 4.4 Hand lifecycle / many-hands（已完成基础闭环）

当前已经有 durable `HandStore` / `PgHandStore` 和 `HandManager`。`HandRecord` 记录 handId、sessionId、workspaceId、type、status、endpoint、capabilities、lease、metadata。`WorkspaceToolProvider` 能解析工具入参里的 `handId`，从 `HandStore` 读取 hand record，并按 hand type 选择 transport，而不是只使用 workspace 默认 `executionTarget`。

当前已具备：

- `ToolInvocationRequest` / `ToolInvocationResponse` 统一 envelope；
- `HttpTransport` 调用 server-remote hand，且 wire request 不序列化 `workspace.root`；
- hand-server `/health` / `/tools` / `/provision` / `/execute` / `/execute-stream` / cancel endpoint；
- `HandHealthScanner` 周期探测 server-remote hand；
- tenant remote hand 静态 attach policy；
- session 内唯一 ready tenant hand 自动路由；
- client daemon reverse WebSocket hand；
- per-device client daemon registry 与 token rotation/revocation baseline。

**当前边界：** hand lifecycle 已有，但 hand cattle 化仍需要补强 provision recipe 的 repo / artifact hydrate、长命令 streaming/cancel 压测、hand kill/reconnect chaos、capability prompt 与 policy 的端到端验证。

### 4.5 Credential boundary / Vault / MCP proxy（已有 baseline，仍需安全审计）

当前已经完成的方向：

- `McpClientToolProvider` 通过 `McpProxy` 调用 MCP，不再把 direct manager invocation 作为唯一入口；
- tenant remote hand 支持 inline `authToken`（dev/staging）或 `authTokenRef`（生产推荐）二选一；
- `authTokenRef` 由 `SecretVault` 解析，`HandStore` 只记录 ref / audit metadata，不持久化明文；
- `HttpTransport` 不把 brain-local `workspace.root` 发到远端 hand；
- client daemon registry 支持 per-device token、rotation、revocation baseline。

**当前边界：** 仍需做完整 threat model 和自动化验证，证明 sandbox / hand 进程、日志、metadata、crash dump、tool output 中都不会出现用户 OAuth token、Git token、平台密钥或 internal network credential。

### 4.6 WebSocket 与 runtime lifecycle（已完成 enqueue-only 基础闭环）

PG backend 下，Web chat 已默认走 enqueue-only：

1. Web 入站层生成 `sessionId` / `runId` / `streamId`；
2. 写 `SessionCatalog`；
3. append `user_message_submitted`；
4. 调 `RuntimeScheduler.enqueue()`；
5. append `run_enqueued`；
6. WebSocket 返回 stream/session/run id 并订阅后续事件，不直接持有长 run generator。

Abort / approval / AskUserQuestion resume 也已经 durable 化到 command event + run metadata + scheduler wake 路径。

**当前边界：** 同进程 stream bridge 已有；跨进程部署仍要依赖 PG NOTIFY / cursor replay / durable event projection。生产化重点是让 Web 进程与 scheduler worker 分离时，live streaming、reconnect replay、terminal done/error 都可靠。

### 4.7 Tool streaming / cancel protocol（已有基础闭环，需压测和完善）

当前已经有 durable tool invocation 事件、`ToolInvocationStore` / `PgToolInvocationStore`、`tool_invocation_started` / `tool_invocation_completed` / `tool_output_delta` / `tool_progress`、hand-server execute-stream、cancel delivery 与 startup recovery。

**当前边界：** 仍需重点验证远端 hand 长任务 stdout/stderr backpressure、取消进程树清理、brain crash 后 invocation 收敛、cancel delivery retry / dead-letter、terminal run 关联 running invocation recovery。

### 4.8 Many hands capability registry / routing prompt（已完成基础闭环）

当前 `<available-hands>` capability prompt、`HandCapability`、`handId` routing、唯一 ready tenant hand 自动路由均已落地。模型可以在同一 session 中看到多个 hand，并通过工具入参指定目标 hand。

**当前边界：** 需要继续补：冲突 hand 的 routing policy、capability risk 与 approval policy 的一致性、browser / phone / emulator 等非文件系统 hand 的 descriptor 规范、many-hands 下的审计和 UI 可视化。

---

## 5. 下一步建议实施路线图

> 当前不建议再按旧 P0/P1 的“大重构”方式推进。核心架构已经落地，下一步应按生产化风险排序。

### P0：生产拓扑 chaos / staging 验收（最高优先级）

**目标：** 在已有 `server/scripts/verify-runtime-chaos.mts` baseline 之上，把 durable run + scheduler + wake + hand 的异常恢复验证搬到 staging / production-like 拓扑，并形成发布前门禁。

#### Phase 1（已完成，2026-06-22）：单元级真实 PG 门禁 + 缺陷修复

- [x] 新增 4 个 chaos mode：`renew-failure` / `abort-states` / `notify-drop` / `db-unavailable`（详见 §13.5），覆盖"DB 短暂不可用 / PG NOTIFY 丢通知 / worker renew 失败不重复 wake / 全状态 abort + terminal 幂等"。
- [x] 修两个被新场景暴露的真实生产缺陷：A=`markStatus`/`releaseLease` 无 terminal 守卫（terminal 可被改回活跃态）；B=`subscribeAppended` 无重连/catch-up/水位（丢 NOTIFY = silent loss）。顺手修既有 `init()` 并发竞态（advisory lock）。
- [x] 聚合门禁 runner `chaos-gate.mts`（`verify:chaos:gate`）：跑完全部 12 mode + 可追溯报告（JSON/MD）+ 退出码门禁语义。当前 12/12 全绿。
- [x] CI 接入：`.github/workflows/chaos-gate.yml`，发版 tag + 手动 dispatch 触发，失败阻断发版（曾磊定：只在发版时跑，不每次 push）。

#### Phase 2（4 chaos 落地，剩 staging 决策）：端到端真实 server 多进程拓扑

当前 chaos 仍是"单元级真实 PG"（直接 new 组件，不拉真实 server/WS）。下一阶段：

1. [x] 给 `app/runtime.ts`+`index.ts` 加 scheduler-only / ws-only 进程角色开关（底层 lease/enqueue 多进程语义已就绪，缺装配层分离）。
   - 已新增 `AGENT_SAAS_PROCESS_ROLE` / `RUNTIME_PROCESS_ROLE`：
     - `all`（默认）：保持历史 all-in-one 行为，HTTP/WS + enqueue + scheduler wake + cron 同进程。
     - `ws-only`：启动 HTTP/WS 与 durable enqueue；不启动本进程 scheduler wake worker，也不启动 cron 这类后台副作用。
     - `scheduler-only`：只创建 runtime 并启动 scheduler wake worker；不绑定 HTTP/WS listener。
   - 注意：`ws-only` 仍需要装配 `RuntimeScheduler` 对象，因为 WebChannel enqueue 路径复用 `scheduler.enqueue()` 写 durable run；区别是 `RuntimeScheduler.start()` 不在 WS 进程调用。
2. [x] 补真实多进程 E2E / 最小闭环编排脚本：
   - `pnpm -F server verify:multiprocess:minimal`：启动隔离 PG + fake OpenAI streaming endpoint + hand-server + `ws-only` server + `scheduler-only` worker；通过 WebSocket 发送一条 `server-remote` 工具会话，断言 durable enqueue、scheduler wake、remote hand streaming tool output、最终 `done`。
   - `pnpm -F server verify:multiprocess:e2e`：在 minimal 基础上增加中途断开 WebSocket、重连 `resume`、按 PG cursor replay/订阅活跃 run，断言跨进程 live/replay/done。
   - 两个脚本都使用临时 `config.json` / `users.json` / workspace、随机端口、随机 PG table prefix；不读写生产配置或生产 RDS。依赖本机 `docker` 与已存在的 `postgres:16-alpine` image（与 chaos PG modes 一致，脚本使用 `--pull=never`）。
3. [x] **WebSocket 进程和 scheduler worker 物理分离部署**已验证：`verify:multiprocess:e2e` / `verify:chaos:multiprocess:*` 均在真分离拓扑（独立 ws-only + 独立 scheduler-only + hand-server + 隔离 PG）跑通 PG NOTIFY 跨进程 live event / reconnect replay / terminal done。
4. [x] **端到端真实 server 拓扑下复跑 Phase 1 关键场景**：`notify-drop` / `db-unavailable` / `scheduler-restart` / `hand-kill` 4 个 chaos mode 全部移植到真实多进程脚本（见后文"chaos 扩展顺序"），首次在真分离拓扑下端到端证明 chaos Phase 1 修的 defect A（terminal-sink 守卫）+ defect B（subscribeAppended 重连/catchup/水位）成立。
5. [ ] 评估接真实 staging 环境（当前无 staging，端到端验证脚本直打生产 RDS，需隔离）。**暂不推进，曾磊 2026-06-22 决议先放着。**

建议的本地拓扑约定（后续脚本化）：

```bash
# 终端 1：Web/API/WS 入站，只负责 durable enqueue 与 PG NOTIFY live bridge
AGENT_SAAS_PROCESS_ROLE=ws-only PORT=3200 pnpm -F server start

# 终端 2：scheduler worker，只负责 acquire lease + wakeRuntimeSession
AGENT_SAAS_PROCESS_ROLE=scheduler-only pnpm -F server start
```

脚本化验证入口：

```bash
# 最小闭环：真实 ws-only server + scheduler-only worker + hand-server + 隔离 PG
pnpm -F server verify:multiprocess:minimal

# E2E 闭环：在最小闭环上增加 WS 断开重连、durable replay、terminal done
pnpm -F server verify:multiprocess:e2e
```

chaos 扩展（4/4 落地，2026-06-22）：

1. [x] **notify-drop-multiprocess**（`verify:chaos:multiprocess:notify-drop`）：active run 中从外部 `pg_terminate_backend` 杀掉 ws 进程的 PG LISTEN backend，断言 subscribeAppended 重连+catchup 后 ws 客户端仍收完整 tool_result + final text + done，终态 done 仅 1 次。
2. [x] **db-unavailable-multiprocess**（`verify:chaos:multiprocess:db-unavailable`）：active run 中 `docker pause` PG 容器 2s 再 unpause，断言 scheduler.tick + lease.renew + subscribeAppended 全部熬过 blip，run 完成且只 1 次。
3. [x] **scheduler-restart-multiprocess**（`verify:chaos:multiprocess:scheduler-restart`）：active wake 期间 SIGKILL scheduler-only A（短 lease 3s 加速），lease 过期后 spawn scheduler-only B，断言 B 接管后终态 done 仅 1 次（terminal-sink 守卫 + lease 接管语义在真分离拓扑下成立）。中间状态（tool_result / final text）可丢，终态契约必须。
4. [x] **hand-kill-multiprocess**（`verify:chaos:multiprocess:hand-kill`）：active tool 期间 SIGKILL hand-server，断言 ws 客户端收到唯一终态 done，scheduler 不卡 lease，run 不悬挂——把已有的 hand chaos 入口（组件级 `HttpTransport.invoke`）升级为真实 WebSocket chat → enqueue → scheduler wake → server-remote hand → kill → user-facing done。

实现要点：
- 6 个 scenario（`minimal` / `e2e` / `notify-drop` / `db-unavailable` / `scheduler-restart` / `hand-kill`）共享同一 `runScenario()` setup/teardown，差异仅在 WS 交互阶段。
- chaos 分支用一条 long-lived ws message listener 累积事件，避免 collectUntil 切换间隙 message 丢失（EventEmitter 同步派发）。
- fake `run_shell` command 时长设为 ~3s，给 chaos 留实际窗口。
- scheduler-restart 用 fixture override 把 `leaseMs` 从默认 8s 降到 3s，加速 lease 过期 → 第二个 worker 接管。
- chaos-gate Phase 1 单进程 12 mode baseline 不退化（scheduler.stop drain 改动后复跑 12/12 PASS）。

### P1：跨进程 streaming / fanout 压测与低延迟演进

**目标：** 在已有 PG NOTIFY + cursor replay 基础闭环上，补齐高吞吐压测、低延迟 fanout 方案评估和生产退化策略。

建议：

- 压测高吞吐 stdout/stderr 下的 PG `pg_notify` 风暴和写放大；
- 评估 Redis Stream / 专用 stream table 是否比现有 PG NOTIFY + cursor replay 更适合毫秒级 fanout；
- 保持 terminal `run_state_changed` 稳定投影成前端 `done` / `error`；
- 为 token delta / tool output delta 完善 batch、限流、backpressure 和丢弃策略。

### P2：SessionContextService PG 查询下推（baseline 已完成，继续压测/审计）

**目标：** 让 session-as-context 能支撑长 session 和多组织生产数据。

已完成（2026-06-21，commit `7644d5f`）：

- [x] `EventStore` 接口扩展可选 query-downpush 方法：filtered `listPage`、`listAround`、`listByRun`、`listByToolCall`、`search`；
- [x] `SessionContextService` 优先调用 store 侧 query 方法，缺失时回退到旧的 in-memory filter，保持兼容；
- [x] `PgEventStore` 支持 runId/type 分页、eventId around、run events、tool trace、受 limit 限制的 text search；
- [x] PG 补 session/run/type/toolCallId 相关索引；`FileEventStore.listPage` 同步支持 runId/type 过滤；
- [x] 单测覆盖 query-downpush delegation 与 file backend filtered pagination。

仍待办：

- search 从 `event_json::text ILIKE` baseline 演进为可控 JSONB/text/full-text 查询方案，并压测长 session；
- 为 session context tools 增加查询审计、成本指标、tenant/session ACL 显式断言与 prompt exfiltration 风险标记；
- 长期 retention / GC / schema versioning 与 context projection 校验。

### P3：hand provisioning hydrate 完整化

**目标：** 让 hand 真正 cattle 化，坏了可以按 recipe 重建。

建议：

- `/provision` 完成 repo clone/fetch/checkout；
- 完成 artifact download/hydrate；
- setupCommands 幂等执行并记录 durable provisioning logs；
- recipe version/hash 入库；
- provision 失败时 hand status、error metadata、retry policy 明确。

### P4：Secret / Vault / tenant isolation 安全审计

**目标：** 证明 secret 不进入 sandbox，tenant 数据不能串读。

建议：

- 输出 threat model；
- 自动扫描 hand env、常见文件、logs、metadata、tool output；
- 验证 tenant_id 在 run/event/hand/tool invocation/API 查询路径全链路过滤；
- 验证 `authTokenRef`、MCP proxy、client daemon token rotate/revoke；
- 生产 backend 替换或封装 `InMemorySecretVault`。

### P5：观测、运维与文档收口

**目标：** 让 Managed Agents runtime 可运营。

建议：

- 指标：run pending/running/waiting/failed、lease acquire/renew/release、wake latency、tool invocation duration、hand health、cancel latency；
- 日志：runId/sessionId/tenantId/handId/invocationId 全链路 correlation；
- 管理 API：列 recoverable/orphaned/failed runs，手动 retry/cancel/requeue；
- 文档：保持本文第 2、13、14 节为权威状态入口，历史 P0-P11 只作为实施记录。

---

## 5A. 历史实施记录

以下 P1 起的章节保留作为实施记录。旧 P0 已被上面的“当前权威状态”和“下一步路线图”替代；不要再把旧 P0 当成待办。

### P1：Hand lifecycle 与 server-remote 默认化（已完成，2026-06-17）

**目标：** hand 变 cattle。hand 挂了能重建，brain 不关心 hand 具体在哪。

#### P1.1 新增 HandRegistry / HandManager

- [x] PG 表 `runtime_hands`。
- [x] 支持 list/provision/health/destroy。

#### P1.2 hand-server 增加健康与工具发现

- [x] `/health`
- [x] `/tools`
- [x] `/execute`
- [x] `/provision`（幂等准备 workspace，便于 hand-server 重启后由 brain/registry 重放 recipe）

#### P1.3 workspace recipe

- [x] 标准化：

```ts
interface WorkspaceRecipe {
  workspaceId: string;
  repo?: RepoRef;
  files?: ArtifactRef[];
  setupCommands?: string[];
  resources?: ResourceLimits;
}
```

#### P1.4 transport resolver

- [x] 新增 `HandManager.resolveTransport()` 作为 handId/capability 入口。
- [x] 兼容现有 executionTarget。

#### P1 验收

- [x] `server-remote` hand-server 重启后，session 可通过 HandManager 重新登记 hand record，并通过 `/provision` 重放 workspace recipe。
- [x] hand failure 被分类写入 `tool_audit` / EventStore。

---

### P2：Vault / Proxy 安全边界（已完成，2026-06-17）

**目标：** sandbox 和 Claude-generated code 读不到真实 credentials。

#### P2.1 SecretVault

- [x] dev 可用 in-memory / encrypted local file vault（只向边界外返回 `SecretRef`，测试覆盖 scope enforcement）。
- [x] prod 可接外部 KMS/secret manager proxy（`HttpSecretVault` adapter）。

#### P2.2 Capability token

- [x] 每个 MCP tool invocation 拿短期 token。
- [x] token scope 包含 user/session/tool/server。

#### P2.3 MCP proxy

- [x] `McpClientToolProvider.invoke()` 不直接调用 `McpClientManager`，统一走 `McpProxy`。
- [x] MCP config 支持 `envSecretRefs` / `headerSecretRefs`，由 vault resolve 后再连接外部 MCP server。

#### P2.4 Git credentials

- [x] clone/push/pull 可通过 isolated credential helper 按需取 token。
- [x] sandbox env 不注入 `GH_TOKEN` / `GITHUB_TOKEN`，helper/env 校验拒绝明文 token。

#### P2 验收

- [x] sandbox `env` 不注入 Git token，并保留 MCP stdio env 白名单。
- [x] `.git/config` 不含明文 token（credential helper 字符串只含 host-side token command）。
- [x] MCP 调用通过 capability-scoped proxy 边界，MCP secret refs 可由 vault 代取。

---

### P3：Session-as-context 与上下文工程（已完成，2026-06-18）

**目标：** session log 成为模型可查询的长期上下文对象。

#### P3.1 SessionContextService

- [x] `getEvents`
- [x] `getEventsAround`
- [x] `getRunEvents`
- [x] `getToolTrace`
- [x] `searchEvents`

#### P3.2 Session tools

暴露给 Agent：

```text
session_get_events
session_search_events
session_get_tool_trace
```

- [x] `session_get_events`
- [x] `session_search_events`
- [x] `session_get_tool_trace`
- [x] 首跑和 approval resume 均挂载 SessionToolProvider，使 Agent 可主动查询 durable session log。

#### P3.3 Context reconstruction policy

新增策略：

```text
full_replay
recent_window
summary_plus_recent
retrieval_augmented
manual_slice
```

- [x] `full_replay`
- [x] `recent_window`
- [x] `summary_plus_recent`
- [x] `retrieval_augmented`
- [x] `manual_slice`
- [x] RawAgentLoop 默认使用 `summary_plus_recent`，可通过 runtime config 覆盖策略。

#### P3.4 Summary projection

- [x] summary 是派生事件，不覆盖 raw events。
- [x] summary 包含 source event range。
- [x] 新增 `context_summary_created` event，记录 source start/end/count 与 summary 文本。

#### P3 验收

- [x] 大 session 不把全量事件塞入 prompt 也能继续（默认 summary + recent projection）。
- [x] Agent 可主动查过去工具结果。
- [x] compact/summary 后原始事件仍能取回。

---

### P4：Many hands / client daemon（已完成，2026-06-18）

**目标：** 一个 brain 可操作多个执行环境，且支持客户侧 hand。

#### P4.1 Hand capability prompt

- instructions 注入 `<available-hands>`。
- 每个 hand 有能力、风险、约束、状态。
- [x] instructions 注入 `<available-hands>`。
- [x] 每个 hand 有能力、风险、约束、状态。

#### P4.2 client daemon

- 客户机器反向连接。
- 平台不直接入站访问客户网络。
- daemon 注册 hand capabilities。
- [x] 新增 `ClientDaemonTransport` 反向连接抽象，由 daemon 注册 hand capabilities。
- [x] client 调用必须显式携带 `handId`，平台不需要入站访问客户网络。

#### P4.3 hand-to-hand artifacts

- 文件、截图、patch、日志变成 artifact。
- artifact 可在 hands 间传递。
- [x] 新增 artifact record/store 抽象，文件、截图、patch、日志可登记为 artifact。
- [x] `<available-hands>` 路由提示说明跨 hand 传递应通过 `artifactId`。

#### P4 验收

- 同一 session 同时使用 server hand 和 client hand。
- hand A 失败不影响 hand B。
- Agent 能根据 `<available-hands>` 正确路由任务。
- [x] 同一 session prompt 可同时列出 server hand 和 client hand。
- [x] hand A 失败不影响 hand B 的独立状态与路由提示。
- [x] Agent instructions 包含 `<available-hands>`，并说明如何按 capability/risk/status 路由任务。

---

### P5：Scheduler / UI lifecycle / streaming primitives（已完成，2026-06-18）

**目标：** 把 P0-P4 已有基础串成更接近 Managed Agents v0 的运行时闭环：run 可被 worker lease，WebSocket 命令 durable 化，工具调用具备 durable invocation 事件。

#### P5.1 RuntimeScheduler + worker lease

- [x] `RunStore` 增加 `acquireLease` / `renewLease` / `releaseLease`。
- [x] `PgRunStore` 使用 `worker_id` + `lease_expires_at` 原子领取 pending / expired running run。
- [x] 新增 `RuntimeScheduler`，支持 enqueue、start/stop、recoverable run 扫描、lease renew/release。
- [x] app PG runtime 启动时挂载 scheduler；P5 当时采用 `autoWake=false` 的保守默认，把 recoverable run 标记为 `orphaned` 并写事件。该默认值已在 P8 Web enqueue-only 落地后改为 PG backend 下 `autoWake=true`。

#### P5.2 WebSocket 与 runtime lifecycle 进一步解耦

- [x] Web chat 在续聊场景写入 durable `user_message_submitted` command event。
- [x] Web abort 写入 durable `run_cancel_requested` command event，再触发当前进程内 AbortController。
- [x] 这些 command event 走 Runtime EventStore；PG backend 下可被后续 scheduler / worker 观察，不再只是 WebSocket 内存状态。

#### P5.3 Tool streaming / cancel durable primitives

- [x] `PlatformEvent` 新增 `tool_invocation_started` / `tool_invocation_completed` / `tool_output_delta` / `tool_progress`。
- [x] `RawAgentLoop.invokeAuthorizedTool()` 为每次工具调用写 durable invocation start/completed 事件。
- [x] 新增 `ToolInvocationStore` 抽象和 in-memory 实现，用于后续 hand-server `/invocations`、SSE streaming、cancel protocol 接入。

#### P5.4 Roadmap 状态整理

- [x] 文档新增 P5 状态，明确 P1-P4 之后已补 scheduler、Web durable command、tool invocation primitives。
- [x] 底部总结按“已完成 / 仍需生产化”拆分，避免后续 Agent 误以为 P1-P4 仍未开始。

#### P5 验收

- [x] scheduler 可以领取 recoverable run，默认安全标记为 orphaned。
- [x] scheduler autoWake 打开时能把 acquired lease 交给 wake 回调，并支持 renew/release。
- [x] Web abort / user submit 有 durable command event 形态。
- [x] 工具调用 lifecycle 有 durable invocation 事件，后续 hand-server streaming/cancel 可复用。

---

### P6：Many-hands 实际路由闭环（已完成，2026-06-18）

**目标：** P4/P5 已经让 Agent 看见 `<available-hands>` 并能在工具入参里携带 `handId`；P6 把 `handId` 从提示和 envelope 真正接到 runtime transport routing。

#### P6.1 handId-aware WorkspaceToolProvider

- [x] `PlatformToolRuntime` 接收 `HandStore`。
- [x] `WorkspaceToolProvider` 解析工具入参中的 `handId` 后，从 durable `HandStore` 读取 hand record。
- [x] hand 必须存在且 `status='ready'`，否则 fail closed。
- [x] transport 根据 hand record 的 `type` 解析，而不是继续使用当前 workspace 默认 `executionTarget`。

#### P6.2 raw runtime wiring

- [x] raw runtime 首跑和 approval resume 创建 `PlatformToolRuntime` 时注入 `config.handStore`。
- [x] 同一 session 内，模型可根据 `<available-hands>` 选择 server hand 或 client hand，并通过 `handId` 实际路由到对应 transport。

#### P6 验收

- [x] 单测覆盖：workspace 默认 `server-local` 时，工具入参指定 client handId，会路由到 `client` transport，而不是本地 transport。

---

### P7：Scheduler auto-wake + wake context restore（已完成，2026-06-18）

**目标：** 在 P5 已有 scheduler / worker lease 基础上，补齐安全自动恢复入口。P7 当时仍保留 `autoWake=false` 的保守默认；该默认值已在 P8 Web enqueue-only 落地后更新为 PG backend 下 `autoWake=true`。

#### P7.1 runtime scheduler 配置

- [x] 新增 `runtimeScheduler` 配置段：
  - `autoWake`
  - `pollIntervalMs`
  - `leaseMs`
  - `renewIntervalMs`
- [x] `config.example.json` 在 P7 当时说明默认 `autoWake=false` 的安全策略；P8 后已更新为 PG EventStore 下默认 `autoWake=true`，并保留显式设为 `false` 的保守恢复策略。
- [x] app PG runtime 启动 scheduler 时读取配置；P7 阶段默认不自动执行，P8 后 PG Web enqueue-only 默认自动 wake。

#### P7.2 wakeRuntimeSession

- [x] 新增 `wakeRuntimeSession(config, run, { lease })` 作为 scheduler wake callback。
- [x] wake 时从 `SessionCatalog` 恢复：
  - `sessionId`
  - `userId` / `username`
  - `cwd`
  - `transcriptPath`
  - `model`
  - `workspaceId`
  - `executionTarget`
- [x] wake 时读取 durable EventStore，并在真正调用模型前处理 durable control state：
  - 已有 `run_cancel_requested` 时直接 release 为 `cancelled` 并写 `run_state_changed`；
  - 仍有 unresolved approval 时 release 为 `waiting_approval`，等待后续 approval resume；
  - 否则恢复 inbound message 后进入 raw runtime dispatch。

#### P7.3 复用原 runId 与 lease heartbeat

- [x] `AgentRunOptions` 增加内部 `runtimeRunId`，scheduler wake 复用已 acquire lease 的 durable runId，避免恢复时新建第二个 run record。
- [x] 首跑创建 run record 时把 wake 所需的 message 摘要写入 run metadata，作为自动恢复时的第一优先来源。
- [x] wake 执行期间按 `renewIntervalMs` 周期性 `lease.renew()`；renew 失败会 abort 当前恢复执行。
- [x] wake 完成后根据当前 RunStore status release lease，清理 `worker_id` / `lease_expires_at`。

#### P7.4 验证

- [x] scheduler 单测覆盖：
  - `autoWake=false` 时 recoverable run 标记为 `orphaned`；
  - `autoWake=true` 时 acquired lease 交给 wake callback；
  - wake callback 失败时 run 标记为 `failed`。
- [x] wake 单测覆盖：自动恢复前观察到 durable cancel command 时，不调用模型，直接 release 为 `cancelled` 并写 `run_state_changed`。

---

### P8：Web chat 默认 enqueue-only（已完成，2026-06-18）

**目标：** WebSocket 只提交命令与订阅事件，不再默认持有长 run 生命周期；Web chat producer 在入站层创建 durable session/run/message command，由 `RuntimeScheduler` 领取 lease 后通过 `wakeRuntimeSession` 执行。

#### P8.1 WebChannel producer 化

- [x] `WebChannelConfig` 新增 `enqueueRuntime` 注入点，包含 `RuntimeScheduler`、`RunStore`、`SessionCatalog`。
- [x] PG runtime 装配时默认给 WebChannel 注入 `enqueueRuntime`；file backend 仍保留 direct dispatch 兼容路径。
- [x] Web chat 在通过权限、幂等、STT、session ownership 校验后，先在 Web 入站层生成 `sessionId` / `runId` / `streamId`。
- [x] 新会话在入队前写入 `SessionCatalog`，确保 scheduler wake 能恢复 `cwd`、user、model、workspace、executionTarget 等上下文。
- [x] Web chat 写入 durable `user_message_submitted`，再调用 `RuntimeScheduler.enqueue()` 写 `pending` run。
- [x] 新增 `run_enqueued` 平台事件，记录 run 已进入 durable queue。
- [x] 入队成功后 WebSocket 只返回 `stream_id`、`session` 与 queued/busy 类用户状态，不再调用 `this.dispatch(...)` 直接执行 Agent loop。

#### P8.2 Scheduler 默认执行 Web 队列与同进程 stream bridge

- [x] PG backend 下 `RuntimeScheduler` 的 app 装配默认 `autoWake=true`，使新入队 Web run 能被 scheduler 正常领取并执行。
- [x] `config.example.json` 更新为默认 `autoWake=true` 的 Web enqueue-only 说明；如需保守恢复策略，可显式设为 `false`。
- [x] `wakeRuntimeSession` 继续复用已有 durable context restore：优先读取 run metadata 中的 `wakeMessage`，并在调用模型前处理 durable cancel / pending approval。
- [x] `wakeRuntimeSession` 增加 `onOutboundEvent` 回调，scheduler 后台执行时可把 `OutboundEvent` 交给外部投递器。
- [x] WebChannel 新增 `publishRuntimeOutboundEvent()`，把 scheduler wake 的常见输出（session/text/thinking/tool_result/permission/ask_user/done/error）写入 EventBuffer/UserEventLog；同进程部署下，Web 请求线程不再持有 generator，仍可获得短期 live/reconnect 流。
- [x] app runtime 延后到 WebChannel 注册和 stream sink 绑定后再启动 scheduler，避免启动期 wake 的同进程 bridge 完全无接收方；WebChannel 尚未 start 时会显式 warn，而不是静默丢弃。

#### P8.3 durable cancel 衔接

- [x] enqueue-only active stream 记录 `runId`。
- [x] Web abort 写入 `run_cancel_requested` 时携带 `runId`，并对已知 pending run 调用 `RunStore.markStatus(runId, 'cancelled')`。
- [x] 新增同进程 `runtimeRunController`，scheduler wake 执行期间注册 `runId -> AbortController`；Web abort 可中断已开始 wake 的同进程 run。
- [x] scheduler wake 前已有 cancel command 时，沿用 P7 逻辑直接 release 为 `cancelled`。
- [x] enqueue-only 分支增加失败兜底：入队/事件写入失败时返回 `done(error)`、标记幂等 failed、清理 active stream，并尽量把 run 标记 failed。
- [x] `stream_id` 下行事件携带 durable `runId`，为后续 runId-first abort/retry 协议做准备。
- [x] WebChannel 本地幂等记录保存 `sessionId/runId/streamId`；同一 `client_msg_id` 命中 in-flight 时会重放 ACK + stream/session 信息，而不是只 ACK。

#### P8.4 验证

- [x] 单测覆盖：配置 `enqueueRuntime` 后，Web chat 不调用 direct dispatch，而是写入 scheduler enqueue payload，并向前端返回 `stream_id` / `session`。
- [x] 单测覆盖：enqueue 失败后返回终态 `done(error)` 并清理 active stream。
- [x] 单测继续覆盖：未配置 `enqueueRuntime` 的 file/dev 兼容路径仍会把 resolved `executionTarget` 传给 direct dispatch。
- [x] `pnpm -F server typecheck` 通过。
- [x] `pnpm -F server exec vitest run src/__tests__/webChannelExecutionTarget.test.ts src/__tests__/runtimeScheduler.test.ts src/__tests__/runtimeWake.test.ts` 通过。

#### P8 后仍需生产化增强

- [ ] 把当前同进程 stream bridge 升级为跨进程 PG NOTIFY / Redis / durable stream table；否则 scheduler 与用户 WebSocket 分布在不同进程时，只能依赖后续 durable replay 能力。
- [x] 将 approval resume 也改成 enqueue-only：用户 respond 写 durable `interaction_resolved` command，并把原 approval run 重新置为 `pending` 交给 scheduler wake。
- [x] Web abort 协议升级为 runId-first，前端直接携带 `runId`，`streamId` 只作兼容。
- [x] 为 PG `RunStore` 增加按 `idempotencyKey` 查询/返回已有 run 的 API，替代 WebChannel 进程内 60s LRU 作为跨进程幂等事实源的基础。
- [ ] 做真实多实例系统验证：Web enqueue、scheduler acquire、server kill/restart、hand kill、网络中断、前端 reconnect/replay。

---

### P10：Durable interaction / approval resume enqueue-only（已完成基础闭环，2026-06-18）

**目标：** 用户 respond 不再由 WebSocket 进程直接拉起 `resumeApprovalDispatch()` generator；Web 入站层只写 durable command / run metadata，再由 `RuntimeScheduler` 领取 lease 并通过 `wakeRuntimeSession` 恢复 approval resume。

#### P10.1 Web respond durable command

- [x] `tryResumePersistedApproval()` 在配置 `enqueueRuntime` 时，不再直接创建 stream 并消费 `resumeApprovalDispatch()`。
- [x] Web respond 会先从 durable EventStore / replay state 确认 pending approval 与 runId；`enqueueRuntime` 已启用但缺少 meta/runId 时 fail closed，不再落回 direct generator。
- [x] respond 写入 `interaction_resolved` 平台事件，记录 `sessionId`、`runId`、`interactionId`、`interactionType='approval'`、`userId`。
- [x] 原 approval run 通过 `RunStore.markStatus(runId, 'pending', 'approval_resolved_enqueue_resume', { resumeApproval })` 重新进入 scheduler 可领取状态；重复 respond 会先检查既有 `interaction_resolved` / `approval_resolved`，terminal run 不会被重新激活。
- [x] `RuntimeScheduler.enqueue()` 对同一 `runId` 合并 metadata，不新建第二个 run。

#### P10.2 wakeRuntimeSession approval-resume path

- [x] `wakeRuntimeSession()` 识别 `run.metadata.resumeApproval` 后走 `createRawApprovalResumeDispatch()`。
- [x] approval resume wake 复用原 `runId`、原 session metadata、lease heartbeat、`runtimeRunController` abort，并要求 durable `interaction_resolved` command 存在。
- [x] pending approval 且没有 `resumeApproval` metadata 时仍 release 为 `waiting_approval`，等待后续 respond command；进入 resume path 后写入 `resumeApprovalConsumedAt` 防止后续误触发。

#### P10.3 当前边界（已被后续章节更新）

- [x] `AskUserQuestion` durable tool-call resume 已由第 18 节补齐基础闭环。
- [ ] 通用 permission_request 的实时 Promise Map 仍作为兼容快路径存在；P10 本阶段优先完成 approval resume enqueue-only。
- [x] `interaction_requested` / `interaction_resolved` 已扩展为 durable pending interaction projection 的事实源；`interaction_expired` 仍可作为后续审计增强。

#### P10 验收

- [x] approval respond 在 PG/enqueueRuntime 模式下只写 durable command 并 enqueue 原 run。
- [x] scheduler wake 可根据 `resumeApproval` metadata 恢复 `resumeApprovalDispatch()`。
- [x] Web respond 立即返回 `respond_ok`，后续输出由 scheduler wake 的 outbound sink 投递。
- [x] admin Web 会话支持 `approvalPolicy.autoApproveRunShell`，由输入框 `Shell` 开关写入 durable run metadata；scheduler wake 恢复后仍可对同一 run 的 `run_shell` 使用 `policy_auto`，但不影响其它危险工具审批。

---

### P11：runId-first control plane（已完成基础闭环，2026-06-18）

**目标：** 控制面以 durable `runId` 为事实源，`streamId` 仅作为 UI stream 兼容字段。

#### P11.1 协议类型与前端状态

- [x] 服务端 WS 协议 `stream_id` / `abort_ok` / `active_stream` / `stream_started` / `session_status` 补齐 `runId` 字段。
- [x] shared WS 协议同步补齐 `runId` 字段，并扩展 `session_status.status` 支持 durable run statuses。
- [x] shared store 新增 `runId` 状态；收到 `stream_id.runId`、`active_stream.runId`、`stream_started.runId` 时保存。
- [x] 前端停止逻辑优先发送 `{ action: 'abort', runId }`，缺少 runId 时 fallback `streamId`。

#### P11.2 Web abort runId-first

- [x] `WsAbortMessage` 改为 `runId?: string; streamId?: string`。
- [x] `WebChannel.handleAbort()` 优先按 `runId` 查 active stream 或 durable `RunStore`。
- [x] 即使当前进程没有 active stream，只要 `RunStore.get(runId)` 可见，也会写 `run_cancel_requested`、标记 run `cancelled`、best-effort 调 `runtimeRunController.abort(runId)`；同时携带 `runId`/`streamId` 时会校验一致性。
- [x] legacy `streamId` abort 仍兼容，并尽量回填 `runId`。

#### P11.3 RunStore idempotency lookup

- [x] `RunStore` 新增 `findByIdempotencyKey(userId, idempotencyKey)`。
- [x] `PgRunStore` 实现按 `(COALESCE(user_id,'__anonymous__'), idempotency_key)` 查询最近 run。
- [x] PG active idempotency unique index 调整为表达式索引 `(COALESCE(user_id,'__anonymous__'), idempotency_key)`，并显式 drop 旧同名索引，避免旧 schema 被 `IF NOT EXISTS` 静默保留。
- [x] Web chat 在内存幂等 cache miss 后查询 durable `RunStore.findByIdempotencyKey()`，active run 会重放 ACK / `stream_id` / `session`，避免跨进程重复入队。

#### P11.4 当前边界

- [ ] `/api/sessions/:sessionId/stream-status` 仍主要依赖 WebChannel / EventBuffer 的同进程 active 状态；跨进程 durable status endpoint 仍待 P9 或后续生产化阶段补齐。
- [ ] run retry API 尚未实现；当前 retry 仍是 failed user bubble 重新发送新 `client_msg_id`。
- [ ] `RunStore.getActiveBySession()` / `listBySession()` 尚未加入，本阶段优先补 runId-first abort 与 idempotency lookup。

#### P11 验收

- [x] 客户端可保存 durable `runId`，并优先用 runId abort。
- [x] 服务端可在没有 active stream 的情况下按 runId cancel pending/running run。
- [x] server/web 类型检查和核心 runtime/web tests 通过。

---

## 6. 修改时要重点查看的文件

### Runtime / session

- `server/src/runtime/types.ts`：`EventStore`、`PlatformEvent` 类型。
- `server/src/runtime/fileEventStore.ts`：文件 JSONL backend。
- `server/src/runtime/pgEventStore.ts`：PG backend 和 sequence。
- `server/src/runtime/rawAgentLoop.ts`：事件 append、模型循环、工具调用。
- `server/src/runtime/rawRuntimeRunDispatch.ts`：raw runtime dispatch、tooling 收集、resume/wake 入口。
- `server/src/runtime/approvalStore.ts`：approval durable 化方向。
- `server/src/runtime/pgSessionLock.ts`：当前同 session 并发保护。

### Hand / tool runtime

- `server/src/runtime/handProtocol.ts`：统一 tool invocation envelope。
- `server/src/runtime/httpTransport.ts`：server-remote transport。
- `server/src/runtime/executionTransport.ts`：transport interface。
- `server/src/runtime/inProcessTransport.ts`：本地 provider wrapper。
- `server/src/agent/toolRuntime.ts`：WorkspaceToolProvider、ExecutionProvider、ExecutionTargetKind。
- `server/src/agent/containerExecutionProvider.ts`：server-container hand。
- `docker-compose.yml`：server 与 hand-server 部署关系。

### Builtin / MCP / skill tools

- `server/src/agent/builtinTools.ts`：Edit/Glob/Grep/TodoWrite/AskUserQuestion。
- `server/src/agent/memorySearchToolProvider.ts`：memory_search/memory_list。
- `server/src/agent/skillToolProvider.ts`：Skill 工具。
- `server/src/mcp/clientManager.ts`：MCP client lifecycle。
- `server/src/mcp/clientToolProvider.ts`：MCP 工具桥接。

### Web / channel / UI lifecycle

- `server/src/channels/web/channel.ts`：当前 WebSocket 与 runtime lifecycle 耦合最多的地方。
- `server/src/channels/web/eventBus.ts`：event bus / user/session event projection。
- `server/src/channels/web/interactionStore.ts`：当前交互状态。
- `server/src/channels/eventConsumer.ts`：runtime event 到 channel handler 的消费逻辑。

### App config / bootstrap

- `server/src/app/runtime.ts`：PG EventStore、SessionLock、MCP manager、skills wiring。
- `server/src/app/config.ts`：runtimeEventStore、serverRemote 等配置 schema。
- `config.example.json`：新增配置时同步更新。

---

## 7. 设计原则与禁止事项

### 7.1 设计原则

1. **事件优先**  
   任何影响恢复的状态都要写 durable event 或 durable table。

2. **接口稳定**  
   新 hand 能力应走统一 invocation envelope，不要为每种 hand 加一套 ad-hoc 调用路径。

3. **derived view 可丢，source log 不可丢**  
   transcript、summary、UI blocks 都是 projection；EventStore 是事实源。

4. **brain stateless**  
   brain 可以 cache，但不能依赖 cache 生存。

5. **hand replaceable**  
   hand 失败时优先分类、重建、重试，而不是修复原 hand。

6. **credentials unreachable**  
   sandbox 内不应有真实 credential。

7. **UI 只是订阅者**  
   WebSocket 不应拥有 run 生命周期。

### 7.2 禁止事项

1. 不要把新的关键 run 状态只存在内存 Map。
2. 不要让 approval/AskUserQuestion 只能由当前 WebSocket resolve。
3. 不要把用户 token 注入 sandbox env。
4. 不要把 `workspace.root` 发送到远端 hand。
5. 不要新增只适用于 `server-local` 的工具协议。
6. 不要用 summary 覆盖或删除 raw events。
7. 不要把 MCP 工具按 `mcp__*` 前缀无条件放行；应逐工具/逐用户/逐 session 授权。

---

## 8. 推荐数据模型草案

### 8.1 runtime_runs

```sql
CREATE TABLE runtime_runs (
  run_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  user_id TEXT,
  username TEXT,
  channel TEXT,
  model TEXT,
  status TEXT NOT NULL,
  status_reason TEXT,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  failed_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  worker_id TEXT,
  lease_expires_at TIMESTAMPTZ,
  idempotency_key TEXT,
  execution_target TEXT,
  workspace_id TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'
);

CREATE INDEX idx_runtime_runs_session ON runtime_runs(session_id);
CREATE INDEX idx_runtime_runs_status ON runtime_runs(status, lease_expires_at);
CREATE UNIQUE INDEX idx_runtime_runs_idempotency
  ON runtime_runs(user_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
```

### 8.2 runtime_hands

```sql
CREATE TABLE runtime_hands (
  hand_id TEXT PRIMARY KEY,
  session_id TEXT,
  workspace_id TEXT NOT NULL,
  type TEXT NOT NULL,
  status TEXT NOT NULL,
  endpoint TEXT,
  capabilities JSONB NOT NULL DEFAULT '[]',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  lease_expires_at TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}'
);

CREATE INDEX idx_runtime_hands_session ON runtime_hands(session_id);
CREATE INDEX idx_runtime_hands_status ON runtime_hands(status);
```

### 8.3 runtime_interactions

```sql
CREATE TABLE runtime_interactions (
  interaction_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  run_id TEXT,
  tool_call_id TEXT,
  type TEXT NOT NULL,
  status TEXT NOT NULL,
  prompt JSONB NOT NULL,
  response JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}'
);

CREATE INDEX idx_runtime_interactions_session ON runtime_interactions(session_id);
CREATE INDEX idx_runtime_interactions_status ON runtime_interactions(status, expires_at);
```

### 8.4 runtime_tool_invocations

```sql
CREATE TABLE runtime_tool_invocations (
  invocation_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  run_id TEXT,
  tool_call_id TEXT NOT NULL,
  hand_id TEXT,
  tool_name TEXT NOT NULL,
  status TEXT NOT NULL,
  input JSONB,
  output_ref TEXT,
  error TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}'
);

CREATE INDEX idx_runtime_tool_invocations_session ON runtime_tool_invocations(session_id);
CREATE INDEX idx_runtime_tool_invocations_run ON runtime_tool_invocations(run_id);
CREATE INDEX idx_runtime_tool_invocations_status ON runtime_tool_invocations(status);
```

---

## 9. 事件类型扩展建议

建议在 `PlatformEvent` 中逐步加入或标准化以下事件：

```text
run_enqueued
run_lease_acquired
run_started
run_state_changed
run_completed
run_failed
run_cancel_requested
run_cancelled

interaction_requested
interaction_resolved
interaction_expired

tool_invocation_started
tool_output_delta
tool_progress
tool_invocation_completed
tool_invocation_failed
tool_invocation_cancelled

hand_provision_requested
hand_provisioned
hand_health_changed
hand_destroyed
hand_failure

context_summary_created
context_slice_loaded
session_search_performed
```

每个事件应包含：

- `sessionId`
- `runId`（如果适用）
- `timestamp`
- `actor`（user/system/worker/tool）
- `correlationId` / `traceId`
- `schemaVersion`

---

## 11. 最小成功定义

当以下条件满足时，可以认为本项目达到 Managed Agents v0：

1. **Durable session**：所有关键事件都在 PG EventStore 中，可分页读取。
2. **Cattle brain**：server 进程重启后，未完成 run 不丢，能恢复或进入明确 terminal state。
3. **Cattle hand**：hand failure 被识别为 tool/hand failure，可重建或切换 hand。
4. **UI 解耦**：WebSocket 断开不等于 run 结束。
5. **Credential boundary**：sandbox 不能读取真实用户 token。
6. **Session-as-context**：Agent 能查询 session 历史，而不是依赖一次性 prompt replay。
7. **Many brains ready**：两个 server 实例共享 PG，不会并发执行同一 session run。
8. **Many hands ready**：至少能在同一 session 中描述和选择两个不同 hand。

---

## 12. 总结

Anthropic 文章的核心不是一个新工具列表，而是一个稳定的 Agent 操作系统抽象：

```text
Session = durable append-only context object
Brain   = stateless, replaceable harness
Hand    = replaceable execution environment/tool endpoint
```

当前 v0 已落地能力见 §13，剩余 TODO 见 §14。后续修改时，请优先保持这些边界清晰——不要为了短期功能把 brain、hand、session 再次耦合回同一个不可替换的 pet。

---

## 13. 当前 v0 能力快照（截至 2026-06-21）

按 Anthropic 三层抽象（Session / Brain / Hand）组织。这一节是新会话 Agent 接手时的"我现在站在哪里"的入口；具体文件位置见 §6，未完成项见 §14。

### 13.1 Session 层（durable 事实源）

- **EventStore**：`PgEventStore` 提供 `append` / `appendBatch` / `list` / `listPage(afterCursor)`，commit 后通过 `pg_notify(channel, range-payload)` 广播；`subscribeAppended()` 是 LISTEN 入口。Web replay 走 durable session cursor。
- **RunStore**：`PgRunStore` 已支持 lease（`acquireLease` / `renewLease` / `releaseLease`）、`findByIdempotencyKey(userId, key)`、`getActiveBySession` / `listBySession`、`markStatus`。
- **ToolInvocationStore**：`PgToolInvocationStore` start/complete + cancel state machine（`requestCancel` / `markCancelDelivered` / `listCancelRequested`）；启动期 `recoverRunningToolInvocations()` 收敛 terminal run 关联的 running invocation。
- **interactions durable**：`interaction_requested` / `interaction_resolved` 携带 `runId` / `toolCallId` / `invocationId` / `response`；`interactionProjection.ts` 重建 pending。
- **session-as-context**：`SessionContextService` 暴露 `getEvents` / `getEventsAround` / `getRunEvents` / `getToolTrace` / `searchEvents`；同时挂载 `session_get_events` / `session_search_events` / `session_get_tool_trace` 三个 Agent 工具。
- **derived view 不覆盖 raw**：`StreamEventBatcher` 在 EventStore 之前 coalesce 高频 `tool_output_delta` / `tool_progress`；`context_summary_created` 是派生事件，原始事件仍 durable。

### 13.2 Brain 层（无状态、可恢复）

- **Scheduler + lease**：`RuntimeScheduler` 扫描 pending / expired-lease 的 run，acquire lease 后调用 wake callback；PG runtime 默认 `autoWake=true`（file backend 仍走 direct dispatch 兼容路径）。
- **wakeRuntimeSession**：从 `SessionCatalog` 恢复 cwd / user / model / workspaceId / executionTarget；在调用模型前观察 durable 控制状态（`run_cancel_requested` → cancelled；unresolved approval → `waiting_approval`；unresolved ask_user → `waiting_user`；resolved 且带 `resumeApproval` / `resumeInteraction` metadata → 走对应 resume dispatch）。
- **RawAgentLoop**：`resumeApproval()` / `resumeInteraction()` append `tool_result` 解除未闭合 tool-call 后继续模型 turns；context reconstruction 默认 `summary_plus_recent`，可配置 `full_replay` / `recent_window` / `retrieval_augmented` / `manual_slice`。
- **WebChannel enqueue-only**：Web chat 在通过权限/幂等/STT 校验后写 `user_message_submitted` + `RuntimeScheduler.enqueue()` + `run_enqueued`；abort 协议 `runId`-first（兼容 `streamId`），写 `run_cancel_requested` 并 best-effort 调 `runtimeRunController.abort(runId)`。同进程 stream bridge 用于 live replay，跨进程走 PG NOTIFY + cursor replay。
- **idempotency 跨进程事实源**：内存 LRU miss 时查 `RunStore.findByIdempotencyKey`，active run 重放 ACK / `stream_id` / `session`。

### 13.3 Hand 层（可替换执行环境）

- **统一 envelope**：所有 hand 调用走 `ToolInvocationRequest` / `Response` / `StreamChunk`，对应 Anthropic 的 `execute(name, input)`。`workspace.root` 不序列化到远端 hand。
- **HandStore / HandManager**：durable hand records；`<available-hands>` capability prompt 含 type / status / risk / constraints / capabilities；工具入参 `handId` 由 `WorkspaceToolProvider` 解析 + per-hand `HttpTransport`。`HandStore.listByType(type, {status?})` 支持 health scanner 切片扫描。
- **hand-server**：`/health` / `/tools` / `/provision`（B3：解析完整 `WorkspaceRecipe`，执行 `setupCommands`，返回每步 `logs[]`；repo / artifact hydrate 当前 `skipped` 占位）/ `/execute` / `/execute-stream`（真实 stdout/stderr SSE + drain backpressure + heartbeat）/ `DELETE /invocations/:id`（process-group SIGTERM→SIGKILL）。SSE parser 加固，frame/buffer 上限。
- **HandHealthScanner（B4）**：PG runtime 默认 30s/5s 周期扫描 server-remote hand `/health`，状态翻转写 `hand_health_changed` 事件并 markStatus；ready→ready 不写库避免风暴。
- **TenantHandAttachPolicy（B1）**：`tenantRemoteHand.users` 与 `tenantRemoteHand.tenantIds` allow-list 独立放行（任一命中 attach；都未声明对所有用户可见）；`evaluateTenantHandAttachPolicy()` 纯函数判定，`resolveUserTenantId` callback 把 UserStore.tenantId 暴露给 dispatch。
- **唯一 ready tenant hand 自动路由（B2）**：`pickSoleReadyTenantHandId()` 由 `WorkspaceToolProvider` 与 `RawAgentLoop` 共用，session 内仅 1 个 ready tenant-remote hand 时工具入参无显式 `handId` 也自动路由；effective handId 写入 `tool_invocation_started` metadata，`autoRoutedHandId` 让审计区分。
- **Provisioning logs**：brain 端 `appendProvisioningLogs()` 把 hand-server 返回的每步 `{step, command, stdout, stderr, exitCode, durationMs, status, note}` 各自落 `hand_provisioning_log` PlatformEvent。
- **ClientDaemon**：`ClientDaemonGateway`（reverse WebSocket，由 HTTP server upgrade 挂载）+ `ClientDaemonRunner` CLI + `clientDaemonProtocol.ts`（`daemon_hello` 现含 `capabilitiesVersion?` / `resumeInvocations?` 两个 forward-compatible 字段）+ heartbeat timeout scanner（先 `close(1011)` 再 `terminate()` 强制销毁 socket）+ grace-period reconnect（`disconnectGracePeriodMs` 配置；同 handId 在 grace 内重连保留 pendingInvokes）+ capability resync（`capabilitiesVersion` 匹配则跳过 capability 覆写，`metadata.capabilityResync='skipped_same_version'` vs `'updated'`）。
- **ClientDaemonRegistry（C1）**：per-device capability token + vault-backed bearer + active/disabled 状态机。`InMemoryClientDaemonRegistry` / `PgClientDaemonRegistry`；`issueClientDaemonDeviceCredential()` 一站式 put+register；rotation = 重发 issue（旧 token 因 vault ref 变化失效），revocation = `setStatus('disabled')`。Gateway 两阶段 auth：upgrade 时检测有无 registry，hello 时再做 per-device 校验；命中 registry 但 token 不匹配 fail closed，不回落 shared bearer。
- **Daemon packaging（C5）**：`daemon-packaging/` 含 Dockerfile + launchd `.plist.template` + systemd `.service.template` + 跨平台 `install.sh`，安装为长驻服务；token / URL / workspace 通过 env vars 注入。
- **TenantRemoteHands**：静态配置的 tenant ECS hand appliance；config 支持 `authToken`（dev）或 `authTokenRef`（生产）二选一，token 不写入 `HandStore` 持久化字段。`TenantRemoteHandResolver` 用 `actor: 'system'` 走 `SecretVault` 取 plaintext。dispatch / cancel delivery 共用同一 resolver。
- **ArtifactService**：`ArtifactStore`（metadata）+ `ArtifactBlobStore`（local content-addressed / OSS，二选一）+ HMAC/OSS signed read URL + ACL route + retention GC + `ArtifactCreate` 内置工具（拒绝 `.env` / `.git/` / `.ssh/` / `.npmrc`）。
- **ToolInvocationCancelDelivery**：基于 hand endpoint + per-hand auth 的 best-effort `DELETE /invocations/:id`；HTTP 临时失败写 `cancelDeliveryNextAttemptAt`，由 app runtime retry scanner 重试；超过最大次数写 `dead_letter`；hand-server unknown invocation (`cancelled:false`) 作为终态收敛。

### 13.4 安全边界（credentials unreachable）

- **文件类工具**：走 `onInteraction` 路径校验；workspace `Edit` / `Write` 拒绝 `.env` / `.git/` / `.ssh/` / `.npmrc` 等敏感路径。
- **HttpTransport**：剥离 `workspace.root` 与 `AbortSignal`；invocationId 序列化到 wire。
- **MCP**：`McpProxy` + `CapabilityToken`（scope=user/session/tool/server）；MCP config 支持 `envSecretRefs` / `headerSecretRefs`，vault resolve 后再连接外部 MCP server。
- **Git credential isolation**：sandbox env 不注入 `GH_TOKEN` / `GITHUB_TOKEN`；`.git/config` 仅引用 host-side credential helper 字符串。
- **SecretVault（A2/A3/A4/A5）**：`appConfig.secretVault` discriminated union 选 `memory` / `encrypted-file` / `http`；`HttpSecretVault` 内置 LRU plaintext cache（`cacheTtlMs`/`maxCacheEntries`/`nowMs`），rotate/revoke 自动 invalidate + public `invalidate(ref)`。共享 `bearerCredentialFields` + `applyBearerCredentialRefine` helper（互斥 / min(8) inline / looksLikeSecret refine），`serverRemote` / `tenantRemoteHand` / `clientDaemon` 三处复用同一份语义；`serverRemote.authTokenRef` 与 `clientDaemon.authTokenRef` 均由 runtime.ts 装配阶段统一通过 vault `actor:'system'` 解析为 plaintext 注入下游；`ClientDaemonGateway.setAuthToken(token?)` 支持 vault rotation 时热替换无需重启。
- **PerDeviceDaemonAuth（C1）**：daemon 不再共用 `clientDaemon.authToken`；`ClientDaemonRegistry` + vault 提供 per-device bearer 与状态机。Gateway 校验拆 upgrade / hello 两阶段，命中 registry 但 token mismatch fail closed（禁止回落 shared bearer）。
- **TenantScopedEnv（P4 防御纵深，2026-06-23 落地）**：`server/src/agent/tenantEnv.ts` `buildTenantScopedEnv(options, workspace)` 给 ServerLocal / Container 两条路径走同一身份装配规则。平台/匿名（tenantId 缺失或 === DEFAULT_TENANT_ID）保留完整 `process.env` + 注入默认组织 PAT；非平台组织先剔除 `SENSITIVE_ENV_KEYS`（AZEROTH/GH/OPENAI/ANTHROPIC/DASHSCOPE/MOONSHOT/BAIDU/ZHIPU/DEEPSEEK/KIMI/GROQ）再按 `tenantSharedEnv[tenantId]` 覆盖 + 按 (tenantId, username) 注入 per-tenant azeroth PAT。`createDefaultExecutionTransportRegistry({ envBuilder })` 在 `app/runtime.ts` 装配时统一注入；同步补齐"组织用户在容器里调 ky-azeroth CLI"功能缺失（之前 ContainerExecutionProvider 默认 `options.env={}`，容器零 env → CLI 报"未授权"）。
- **WakeTenantIdFailSafe（疑点 3 加固，2026-06-23 落地）**：`resolveSessionOwnerTenantId` 加 try/catch + warn log + 返回 undefined（不向上 throw、不静默回填 'kaiyan'），防止 UserStore 故障让一次 wake 全栈 throw，也防止组织 admin 被误判为平台 admin。4 个 unit case（runtimeWake.test.ts）锁死 valid string / 未配置 / undefined / 抛错四分支。
- **ServerLocalSandboxGuard 路径变形（P5，2026-06-23 落地）**：`findDeniedPathMention` 从字面 `command.includes(normalized)` 升级到覆盖双斜杠 `//`、单点 `/./`、尾随斜杠等 shell normalize 后等价但字面不同的 bypass。已知 limitations（honest documented in `toolRuntime.ts` + 3 个 LIMITATION 测试明确标记）：动态构造（`$VAR`/`$()`/反引号）、引号分段、symlink、base64/heredoc/find -exec 仍未挡，需 shell-quote tokenize + realpath 二次校验，留作后续 ticket。当前主防御仍是 `toolRuntime.ts:608-626` 的 A+C gate（fail-closed），本 guard 是给平台 admin 自防 prompt-injection 的兜底。

### 13.5 真实多进程 chaos baseline + 发布前门禁（2026-06-22 升级）

`server/scripts/verify-runtime-chaos.mts` 已全部为真实 PG / 子进程断言（不再是 plan-only），共 **12 个 mode**。package script：`pnpm -F server verify:chaos`（=all）、以及逐 mode 的 `verify:chaos:<mode>`。

**聚合门禁 runner**：`server/scripts/chaos-gate.mts`（`pnpm -F server verify:chaos:gate`）串行跑全部 mode（每个 mode 独立子进程，互不污染），产出可追溯报告（JSON + Markdown，落 `server/.chaos-reports/`，已 gitignore），退出码即门禁结论（全过 0 / 任一失败 1）。与 `--mode=all`（fail-fast、只 console.log）区别：跑完所有 mode + 完整报告，适合发布前门禁。CI：`.github/workflows/chaos-gate.yml`，发版 tag（`v*`）+ 手动 dispatch 触发，失败阻断发版。

覆盖断言：
- `hand-cancel` / `hand-kill`：local hand-server cancel + terminal stream 收敛。
- `server-restart`：临时 PG + scheduler worker 死亡后 lease 过期、新 worker 接管。
- `multi-worker`：两个共享 PG 的 scheduler worker，断言同一 run 只被一次 acquire/complete。
- `network-interrupt`：本地 TCP proxy 切断 hand-server `/execute-stream`，断言活动 stream 收敛终止。
- `ask-user-resume`：PG + 子进程 scheduler + PG NOTIFY + fake Chat Completions，端到端验证 ask_user durable resume。
- `client-daemon`：真实 daemon 子进程 + SIGSTOP 冻结，验证 register → stream → scanner kick → unhealthy → reconnect → 新调用正常路由。
- `daemon-network`（C6）：TCP proxy `blip()` 在 daemon ↔ gateway 中间 destroy in-flight sockets 但保留 listener，验证 daemon 自动重连后二次调用仍成功。toxiproxy 丢包率/延迟分布与 iptables NAT 表过期等更复杂场景留作后续。
- **`renew-failure`（新）**：worker A 领取后 lease 被 worker B 抢占，A 的 renew 必然失败（worker_id 不匹配）；断言掉队的 A 无法 release/markStatus 覆盖新 owner 终态，terminal 是 sink → "renew 失败不产生重复 wake / terminal 状态一致"。
- **`abort-states`（新）**：pending/running/waiting_approval/waiting_user 四态均可 abort 到 cancelled，且 cancelled 后终态幂等（不可复活）。运行中 tool invocation abort 由 hand-cancel 覆盖。
- **`notify-drop`（新）**：真实 PG 上 `pg_terminate_backend` 杀掉 subscriber 的 LISTEN 后端，断线窗口内 append 一批（NOTIFY 丢失），断言 subscriber 自动重连 + catch-up 补回（不漏/不重/按序）。验证 `subscribeAppended` 重连加固。
- **`db-unavailable`（新）**：`docker pause/unpause` 冻结再恢复 PG，断言 subscriber 熬过 blip 后继续收事件无 silent loss，且被领取的 run 恰好完成一次（completed 后不可重新 acquire）。

**门禁加固（同期落地的生产代码修复）**：
- `runStore.ts` `markStatus`/`releaseLease` 加 **terminal-sink 守卫**（已 completed/failed/cancelled/orphaned 不可被改回活跃态；release 仍清 lease 但不降级 terminal）——defect A。
- `pgEventStore.ts` `subscribeAppended` 加 **LISTEN 重连 + 断线 catch-up + per-session 消费水位 + 可选安全轮询**（原实现单连接无重连无自愈，丢 NOTIFY = silent loss）——defect B。新增 `pgEventStoreNotify.test.ts` 覆盖重连/水位/丢 NOTIFY 恢复（+4 测试，715 全绿）。
- `runStore.init` / `pgEventStore.init` 加 **advisory lock 串行化并发 init**，修既有 `CREATE INDEX IF NOT EXISTS` 并发撞 pg_class 唯一约束（23505）的竞态——many-brains 多实例同时启动也受益。

注：PG mode（server-restart/multi-worker/ask-user-resume/renew-failure/abort-states/notify-drop/db-unavailable）需本机已有 `postgres:16-alpine` Docker image（脚本用 `--pull=never`；CI 在 workflow 里先 `docker pull`）。`db-unavailable` 还需 docker `pause`/`unpause`。

> **Phase 2 真实多进程拓扑验证（2026-06-22 完成 chaos 落地，剩 staging 决策）**：
>
> 角色开关：`AGENT_SAAS_PROCESS_ROLE=ws-only|scheduler-only|all`（`RUNTIME_PROCESS_ROLE` 别名）；ws-only 不调 `RuntimeScheduler.start()` 但仍装配 scheduler 对象给 enqueue 复用，scheduler-only 不绑 HTTP/WS listener。
>
> 多进程 chaos 6 个 scenario 全部落地（`server/scripts/verify-runtime-multiprocess-e2e.mts` + 6 个 thin wrapper + 6 个 npm script `verify:multiprocess:*` / `verify:chaos:multiprocess:*`）：
>
> | scenario | 验什么 | 状态 |
> |---|---|---|
> | `minimal` | ws-only 接 enqueue + scheduler-only wake + remote hand 流 + 终态 done | ✅ |
> | `e2e` | minimal + WS 断 → 第二连接 resume → PG cursor replay → done | ✅ |
> | `notify-drop` | 杀 ws 进程 PG LISTEN backend，subscribeAppended 重连+catchup 仍交付完整 tool_result + final text + done | ✅（端到端覆验 chaos Phase 1 defect B）|
> | `db-unavailable` | docker pause PG 2s 再 unpause，scheduler.tick + lease.renew + subscribeAppended 全熬过 blip，run 仅 1 次 done | ✅（端到端覆验 defect A+B + scheduler.stop drain）|
> | `scheduler-restart` | SIGKILL scheduler-only A → 3s lease 过期 → spawn scheduler-only B → B 接管 → 唯一终态 done | ✅（端到端覆验 terminal-sink 守卫 + lease 接管在真分离拓扑下成立）|
> | `hand-kill` | active tool 期间 SIGKILL hand-server → 唯一终态 done，scheduler 不卡 lease | ✅（替代组件级 `HttpTransport.invoke` chaos，覆盖用户可见投影）|
>
> 同期落地的产品代码修复：
> - `app/runtime.ts`：scheduler-only 模式跳过 same-process WebChannel stream bridge（消除大量 "Runtime outbound event dropped before WebChannel start" 误报；scheduler-only 进程结构上无 WS 客户端，bridge 是 noop，跨进程靠 PG NOTIFY）。
> - `runtime/scheduler.ts`：`stop()` 加 in-flight tick drain（while ticking → 10ms poll），防止 shutdown 时 `tryHandle()` → `lease.release()` → `releaseLease()` 与 `pgEventStore.close()` 末态 race 导致 "Cannot use a pool after calling end on the pool" unhandled rejection。
>
> Phase 1 单进程 chaos-gate 12/12 不退化（scheduler.stop drain 改动后复跑全过）。
>
> 剩 Phase 2 §5：评估真实 staging 环境，曾磊 2026-06-22 决议先放着（当前无 staging，多进程脚本已能在隔离 PG 上证明跨进程契约）。
>
> **追加 scenario：approval-resume（2026-06-23 落地）** — `server/scripts/verify-runtime-multiprocess-approval-resume.mts` + `pnpm -F server verify:multiprocess:approval-resume`。**独立脚本**（不在主 `verify-runtime-multiprocess-e2e.mts` 框架的 6 scenario 内），因为 chat payload 不传 `autoApproveRunShell`（让 permission_request 真触发），交互链路把"用户切走 / 重连 → 继续审批"作为核心 chaos 段：ws-only 接 chat → durable enqueue → scheduler-only wake → fake model 触发 permission_request → user 关 WS → 新 WS resume(active_stream binds runId) → respond approve → ws-only 写 `interaction_resolved` → 原 run 重新置 pending → scheduler-only 通过 `approval_resume_wake` 接管 → 真跑 run_shell（hand-server local）→ 第二轮 fake model → final text + 唯一终态 done。断言强度：唯一 done × 1 + tool_result 含 marker + final text + PG `runtime_runs.status=completed` + `approval_resolved` 事件 + `run_state_changed` reason 含 `approval:*` / `approval_resolved:*` / 终态 `completed`。补齐主框架"单 platform admin + autoApproveRunShell 跳过 permission"的覆盖缺口；ws / scheduler 物理分离 + 跨 WS 实例的 durable command 链路在真实拓扑下成立。

---

## 14. 当前权威剩余 TODO

按主题分组，每项独立可上线。不再按时间顺序记录历史 changelog —— 已落地的内容见 §13、设计意图见 §1 / §4 / §7。

### 14.1 Client daemon 生产化（chaos baseline 与 reverse WebSocket gateway 已闭环）

#### 已完成（2026-06-19）

- [x] 生产级 packaging baseline：`daemon-packaging/` 含 Dockerfile + macOS launchd `.plist.template` + Linux systemd `.service.template` + 跨平台 `install.sh`（写 EnvironmentFile / 设权限 / launchctl bootstrap / systemctl enable --now / --uninstall 反向）。配置经 env vars 注入；journald 默认日志轮转。
- [x] per-device capability token + rotation/revocation：`ClientDaemonRegistry` 接口 + `InMemoryClientDaemonRegistry`（dev/tests）+ `PgClientDaemonRegistry`（PG runtime 表 `runtime_client_daemon_devices`）。token plaintext 仅放 SecretVault，registry 只持 `tokenVaultRef`；`issueClientDaemonDeviceCredential()` 一站式 put+register；`verifyClientDaemonBearer()` 常量时间比较；rotation = 重发 `issue*`，旧 token 因 vault ref 变化即失效；revoke = `setStatus('disabled')`。Gateway 拆 `authenticateUpgrade` / `authenticateHello` 两阶段：注册了 device 但 token 不匹配 → fail closed（不回落 shared bearer，防止 revocation 被绕过）；无 device record → 兼容 shared bearer。
- [x] daemon-side reconnect resume（基础闭环）：`disconnectGracePeriodMs` 配置（默认 0 兼容旧行为）；socket 断开时若有 pending invokes，把 connection 放入 `gracefulDisconnects: Map<handId, {connection, timer}>`；同 handId 在 grace 窗内重连 → `connection.rebindSocket(newWs)`，pendingInvokes Map 不被失败，新 socket 收到 `invoke_completed` 帧后路由到原 caller。runner 端 `activeInvocations` 在 ws close 时仍 abort（进程级 resume 留作 follow-up；协议 hello.resumeInvocations 已就位）。
- [x] capability resync：`daemon_hello.capabilitiesVersion?: string` 内容 hash（runner 端 `hashCapabilities()` 用 sha-256 截 32 hex；只折叠 `cap.name/risk + tools(id,name,risk,approvalMode)`，descriptive 字段不参与）；grace 重连时 cached version 与 incoming version 都存在且相等 → 跳过 `capabilities` 覆写并写 `metadata.capabilityResync='skipped_same_version'`；不等或缺失 → `'updated'`。
- [x] 真实网络故障注入 chaos baseline：`pnpm -F server verify:chaos:daemon-network` 加 TCP proxy `blip()`（destroy in-flight sockets 但保留 listener），端到端验证 daemon ↔ proxy ↔ gateway 抖动后自动重连且二次调用仍成功。`startTcpProxy()` 现同时提供 `interrupt()`（旧）与 `blip()`（新）。

#### 仍待办

- 自动升级 channel（packaging 已就位，缺 update server + 滚动策略）。
- 配置下发：当前 packaging 由人工写 env；生产化需要 admin push 配置 + daemon 拉取确认。
- 设备注册 UX：当前 ops 通过 C1 admin API 手动注册；缺 Web UI 一键注册 + 出 token。
- daemon-side 进程级 invocation resume：当前 runner 端 ws close 仍 abort `activeInvocations`，spawn 的 shell/git 不能跨 socket 切换。需要让 runner 持有 invocation registry，在重连后用协议 `resumeInvocations` 申报，gateway 端再 join 已有的 pending response。protocol 已 forward-compatible。
- 多实例 sticky routing / 共享 gateway broker：daemon WebSocket 仍是单 server 进程内资源；多实例部署需要 nginx sticky / Redis broker / NATS。当前生产形态是单 Mac Mini launchd，未触发；deferred 到多实例部署阶段。
- 真实更复杂网络故障：toxiproxy 丢包率/延迟分布、iptables NAT 表过期。`blip()` 是单 RST；后续可在脚本里加 toxiproxy 容器拉起。

### 14.2 Artifact 后续增强（local + OSS backend、signed URL、ACL、retention GC 已闭环）

- 跨云 S3-compatible adapter。
- 大文件 multipart upload。
- artifact-producing hand streaming（让 hand 直接产出 artifact，而非先落 workspace 再 `ArtifactCreate`）。
- 跨 hand artifact transfer E2E（artifact 在 hands 间作为"hand-to-hand"对象传递）。
- 对象存储 lifecycle policy 对齐（OSS 的 expiration rule 与 retention GC 解耦）。

### 14.3 Tenant hand 健康 / 路由生产化（静态路由 + vault credential 已闭环）

#### 已完成（2026-06-19）

- [x] tenant identity 升级：`UserRecord/UserInfo` 新增可选 `tenantId`，`UserStore.create/update` 接收；`tenantRemoteHand` 配置加 `tenantIds?: string[]` 与 `users?` 并列。Attach policy 抽到纯函数 `evaluateTenantHandAttachPolicy()`，独立可测；union-permissive 语义：两个 list 都未声明 → 所有用户可见；任一命中 → attach。`RawRuntimeRunDispatchConfig` 加 `resolveUserTenantId({userId, username})` callback，runtime.ts 接 `userStore.findById/Username`。
- [x] 默认路由：session 内唯一 ready tenant-remote hand 时自动路由。`pickSoleReadyTenantHandId()` 纯函数（在 `handStore.ts`）由 `WorkspaceToolProvider` 与 `RawAgentLoop` 共用；判定条件 `status='ready' + type='server-remote' + metadata.tenantRemoteHandId` 存在。effective handId 写入 `tool_invocation_started` 的 metadata（同时记 `autoRoutedHandId` 让审计区分显式 vs 自动）。
- [x] workspace recipe 增强：hand-server `/provision` 解析完整 recipe（workspaceId / repo / files / setupCommands / resources.timeoutMs），实际执行 `setupCommands` 并返回每步 `{ step, command, stdout, stderr, exitCode, durationMs, status, note }`。brain 端 `appendProvisioningLogs()` 把每条写入 `hand_provisioning_log` PlatformEvent（默认 workspace hand + 每个 tenant remote hand 均写）。repo clone/fetch/checkout 与 artifact signed URL hydrate 已落地到 hand-server `/provision`；失败会返回 step logs、`recipeVersion`/`recipeHash` 与 retry policy metadata。host-side git credential helper 仍作为私有 repo token 注入层的后续增强。
- [x] health / lease scanner：`HandHealthScanner` 周期 30s 扫描 `server-remote` 状态为 `ready` / `unhealthy` 的 hand，对每个调 `GET <endpoint>/health` (5s 超时)。失败/throw/`body.status!=='ok'` → flip 到 unhealthy + 写 `hand_health_changed` 事件；恢复同理；ready→ready 不写库避免风暴；per-hand bearer 走 `resolveHandAuthToken` 复用 tenant resolver，无 token 回退 `defaultServerRemoteAuthToken`。

#### 已完成补充 / 仍待办

- [x] 重试驱动 baseline：`HandHealthScanner` 对缓存了 `WorkspaceRecipe` 的 unhealthy server-remote hand 按 `metadata.provision.retryPolicy` 到期 replay `/provision`，成功收敛为 ready，失败写 attempts/nextAttemptAt/lastError。后续仍需把 artifact signed URL 从 durable recipe 中拆成按需重签，避免长期缓存 ephemeral URL。
- 可选 `HAND_SERVER_BACKEND=sdk` adapter：评估后跳过——现有 `server-container` backend 已覆盖组织跑 SDK 在 docker 内的场景；为未充分使用的"sdk" stub 保留 schema 表面违反 KISS。如果未来有具体组织场景再补。
- 私有 repo credential helper 生产化：repo hydrate 已能 clone/fetch/checkout；serverRemote/tenantRemoteHands 可配置 recipe 并缓存重放；后续需把 tenant-scoped token 通过 host-side git credential helper 注入，避免 token 进入 sandbox/log。

### 14.4 Vault baseline 后续生产化（`InMemorySecretVault` + tenant hand `authTokenRef` 已闭环）

#### 已完成（2026-06-19）

- [x] 外部 KMS adapter 落地：`secretVaultConfigSchema` discriminated union 接入 `appConfig.secretVault`，三种 backend `memory` / `encrypted-file` / `http`。runtime.ts 用 factory 选择实现；`encryption-file` 与 `http` 都要求 inline 或 env-var 二选一（vault 自身 auth 不能走 vault ref，鸡生蛋）。`InMemorySecretVault` 仍是默认（dev），生产改 `backend: 'http'` 即可对接外部 KMS proxy。
- [x] `serverRemote` 复用共享 bearer credential schema：抽出 `bearerCredentialFields` + `applyBearerCredentialRefine(value, ctx, {allowEmpty?})` helper；`serverRemoteConfigSchema` / `tenantRemoteHandSchema` / `clientDaemonConfigSchema` 三处共用同一份 authToken | authTokenRef 互斥 + min(8) inline + looksLikeSecret refine。runtime.ts 装配阶段统一通过 `secretVault.getSecret(ref, actor:'system', scope:'secret:server_remote:read')` 解析为 plaintext；dispatch / cancel delivery 仍按 plaintext 接口接收，签名零变更。
- [x] `HttpSecretVault` 内置 cache：`cacheTtlMs`（默认 30s，设 0 关闭）+ `maxCacheEntries`（默认 256）+ `nowMs` 注入。命中 / 写入按 Map 插入顺序做 LRU 淘汰；`rotateSecret` / `revokeSecret` 调用后自动 invalidate；新 public `invalidate(ref)` 供外部 KMS webhook 强制失效。cache key 只用 refId（远端已按 caller scope ACL，本地 cache 处于受信 vault adapter 内层）。
- [x] `clientDaemon.authToken` 走 vault-backed token ref：`clientDaemonConfigSchema` 用 `bearerCredentialFields` + `allowEmpty=true`（dev 仍可 no-auth）。runtime.ts 装配阶段从 vault 解析 plaintext 注入 gateway；`ClientDaemonGateway` 加 mutable authToken + `setAuthToken(token?)` 公共方法，支持 vault rotation 时热替换无需重启。

#### 仍待办

- 真正的外部 KMS 落地验收：`HttpSecretVault` 类已就位，但生产 KMS（AWS Secrets Manager / GCP Secret Manager / aliyun KMS / Vault）还需要厂商特定的 sidecar/adapter（每家 API 不同）。当前 `HttpSecretVault` 的 wire protocol（`POST /secrets/resolve { ref, caller }` 返回 `{ value }`）是简化形态；接入真厂商时要么加各家 adapter 子类，要么部署一个轻量翻译 sidecar。
- per-actor cache scoping：当前 cache key 只用 refId；多 caller 共享 cached plaintext 满足"受信 vault adapter 内层"的设计假设，但如果未来引入 less-trusted in-process consumer，需要 caller 也参与 key（或不 cache）。文档已注明该决策点。

### 14.5 流式吞吐与跨进程 fanout（基础闭环已完成）

- 高吞吐 stdout/stderr 下的 PG `pg_notify` 风暴 / 写放大压测（当前已有 batch coalesce + range payload，但缺真实压测数据）。
- 跨进程低延迟 fanout：当前 PG NOTIFY + cursor replay 已可工作，但若要做毫秒级 live fanout，需要考虑 Redis Stream / 专用 stream table 的取舍。

### 14.6 多组织全栈改造（PR 1-9 + 补丁落地，SaaS 上架阻塞真清零 v2）

> 详细交接文档：`assets/20260621/多组织改造交接文档.md`（在 admin workspace，agent-saas 仓库之外）
> 端到端测试报告（三轮 17 场景 + 3 BUG 修复轨迹）：`docs/tenant-isolation-e2e-test-2026-06-21.md`
> Workflow 复核 verdict 矩阵：`assets/20260621/tenant-pr-review/00-总索引-verdict矩阵.md`
> 前期侦察：`assets/20260614/平替验证/p1-多组织隔离侦察.md`

#### 已完成（2026-06-21 / 7 commit）

按"骨架 → 身份 → 数据 → 路径 → 修复 → 配置面 → 收尾"切片串行：

- **PR 1（`657370e3`）TenantStore 骨架 + /api/tenants admin CRUD（纯加法 0 行为变更）**
  - `data/tenants/{types,store,index}.ts`：file-backed store，slug `^[a-z][a-z0-9-]{1,30}$`
  - `ensureDefaultTenant`：启动期幂等保证 `kaiyan` 存在
  - `routes/tenants.ts`：admin-only GET/POST/PATCH；29 单测

- **PR 2（`a9671ea7`）JWT 加 tenantId + isPlatformAdmin/requirePlatformAdmin**
  - `JwtPayload.tenantId` 必选；`UserRecord/UserInfo.tenantId` required
  - `isPlatformAdmin(payload)` = role==='admin' && tenantId===DEFAULT_TENANT_ID
  - `requireAdmin`（任意 admin）+ `requirePlatformAdmin`（仅平台 admin）
  - UserStore.load() 启动期回填旧记录 tenantId='kaiyan' + 持久化

- **PR 3（`360b8ca9`）PG runtime_events/runs/tool_invocations 加 tenant_id 列**
  - `EventStore.append(event, ctx?)` 加可选 ctx 参数（避免 PlatformEvent 18 分支 invasive 改动）
  - 三表 `ALTER ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'kaiyan'` + 索引
  - 兼容存量 RDS（已落 134 sessions × 1014 events 自动加列）

- **PR 4（`51a7130f`）workspace 路径加 tenant 层 + sandbox {{TENANT_CWD}}**
  - `resolveUserCwd` 路径 `<cwd>/<tenant>/<user>/`；slug 非法 fallback DEFAULT
  - `ensureUserWorkspace` 扁平→tenant 层迁移
  - `engine/sandbox.ts` 加 `{{TENANT_CWD}}` 模板变量 + `{{OTHER_TENANT_WORKSPACES}}` 魔法 token
  - `{{OTHER_USER_WORKSPACES}}` 改扫 tenant 内（不再误 deny 跨 tenant 根）

- **PR 5（`4822323e`）复核发现修复（5 P0 + 4 P1）**
  - Workflow 复核（8 sonnet Explore agent / 768k token / 10 min）报告 7 P0 + 10 P1 阻塞 push
  - 修：跨组织密码重置（P0-1）/ root mode 全盘读（P0-2）/ viewAs 后门（P0-3）/ dispatch 未透传（P0-4）/ syncSkills 路径回归（P0-7）/ isPlatformAdmin 字面值（P1-1）/ middleware fail-closed（P1-4）/ sandbox basename（P1-8）

- **PR 6（`55e014b3`）azeroth-tokens 二级 + settings.json per-tenant + cron/migrations**
  - **P0-6 azeroth-tokens v2**：`{tenants:{slug:{tokens:{user:pat}}}}` 二级查表；v1 扁平兼容自动归默认 tenant；客户组织 username 与开沿同名也拿不到开沿 PAT
  - **P0-5 settings.json per-tenant**：`workspace-shared/<tenantSlug>/.claude/settings.json` 扫子目录拼 `tenantSharedEnv`；`buildEnv(config, tenantId?)` 优先 tenant 覆盖；sandbox 加 `{{OTHER_TENANT_SETTINGS}}` 全部 deny
  - **P1-5** cron/startup migrations/cleanup 3 处 `resolveUserCwd` 调用补 tenantId

- **PR 7（`5acadc95`）sessions canAccessSession + projectKey 迁移 + 内部入口 tenantId + 20 测试**
  - **P0-3 残余**：`canAccessSession(reqUser, meta, userStore)` 单一守门函数；替换 11 处单 sessionId 操作旁路（GET/PATCH/auto-title/fork/stats/stream-status/pending/restore/permanent/delete）；trash 改 isPlatformAdmin
  - **P1-6 transcript projectKey 迁移**（startup.ts BUG 6）：扫所有用户，扁平 oldProjectKey vs 新 newProjectKey rename `.jsonl + .meta.json`，**解决"PR 4 升级后会话消失"问题**
  - **P1-2** channel.ts admin 代操作 4 处 lookup ownerRecord.tenantId
  - **P1-7** artifact / voice / preview owner 参数透传 + cross-tenant 校验
  - **P1-9** 新增 `__tests__/tenantIsolation.test.ts` 5 大类 20 测试

#### 关键设计决策（与曾磊 2026-06-21 协议）

| 决策点 | 选择 | 理由 |
|---|---|---|
| tenantId 形式 | **slug**（`kaiyan` / `wain`） | 人类可读，路径/配置/审计友好 |
| 第一批场景 | **开沿 1 tenant + 1 个真实陌生客户** | 最小灰度形态 |
| UserRole 拆分 | 不拆，加 `isPlatformAdmin` helper | 避免改 78 处 `role === 'admin'` |
| EventStore tenantId | 加 ctx 参数 | 不破坏 PlatformEvent union |

#### 已完成 PR 8 + PR 9 + PR 9 补丁（2026-06-21 夜 端到端实测发现真实 bug 并修复）

完整测试报告 `docs/tenant-isolation-e2e-test-2026-06-21.md`。本节摘要：

**PR 8（`fb04e619`）修 P0 BUG #2：wake 路径绕过 ensureUserWorkspace 导致新组织首跑 ENOENT**

- 端到端测试**第一轮**发现：admin 浏览器新建会话发消息触发 `run_shell` → `tool error: spawn /bin/sh ENOENT`
- 根因：PR 8 enqueue-only + scheduler wake 路径绕过了 `engine/dispatch.ts:309` 的 `ensureUserWorkspace` 调用。`wakeRuntimeSession()` 直接调 `createRawRuntimeRunDispatch()` 跑 raw runtime，所有新 tenant / 新用户首跑必踩 cwd 物理目录不存在 → hand-server spawn `/bin/sh` ENOENT
- 修法：`RawRuntimeRunDispatchConfig` 加 `workspaceProvisioner?` 回调；`wakeRuntimeSession` 在所有早返回检查（cancel/waiting）之后、所有 dispatch 之前调一次；`app/runtime.ts` 装配阶段注入，内部按 session.userId/username 反查 UserStore 拿到完整 WorkspaceUser（含 tenantId / realName），调 `resolveUserCwd` + `ensureUserWorkspace`。Raw runtime 本身保持跟物理 workspace 解耦——provisioner 抛错 release failed 并写 `run_state_changed`
- 顺手修 P3 BUG #1：`/api/auth/me` handler 漏返 `tenantId` 字段（UserInfo type 定义为 required，前端拿不到）
- 回归测试 +2：`runtimeWake.test.ts` 覆盖 provisioner fail / cancel skip provisioner

**PR 9（`11c6c2de`）+ 补丁（`1eab4eff`）修 P1 BUG #3：组织 admin 跨组织文件读写泄漏**

端到端测试**第二轮**发现：用 `wain_admin` 调 `run_shell` 跑 `cat /Users/admin/workspace-openai-runtime/kaiyan/admin/MEMORY.md | head -10` → **EXIT=0 真实读到开沿 MEMORY 内容**（"开沿科技（中国福建泉州）..."等业务数据）。任意客户组织 admin = 全平台跨组织读权限。

PR 9 第一刀（6 文件多层加固）：`engine/dispatch.ts` + `routes/file.ts` + `routes/voice.ts` + `runtime/artifactService.ts` + `app/routes.ts` 把所有"admin 跳过校验"判断从 `role === 'admin'` 收紧到 `isPlatformAdmin = role === 'admin' && tenantId === DEFAULT_TENANT_ID`。API 层（file/voice/artifact）验证立即生效——`GET /api/file/read?path=<跨组织绝对路径>` 之前 200 泄漏，现在 403。

**但 run_shell 复测仍泄漏**——深挖发现**架构假设级根因**：

> **`raw runtime`（rawAgentLoop / rawRuntimeRunDispatch）跟 `engine/dispatch.ts` 是两条独立 dispatch 路径**。sandbox-exec / extraDirs / sharedDirs 等 OS 层防御**只在 `engine/dispatch.ts` 装配**；PR 8 enqueue-only 把 Web 默认切到 raw runtime 之后，sandbox 跨组织 deny 在生产**从来没生效过**——PR 9 第一刀改的 dispatch.ts 部分是"正在被绕过的死代码"。
>
> 这条"两条 dispatch 路径"的架构事实已记入 `MEMORY.md` 第 57 行硬事实段。未来涉及防御加固，**优先看 raw runtime 链路是否真在那条路上**。

PR 9 补丁（`1eab4eff`）先做止血：唯一实际生效的工具权限防御点是 `agent/toolRuntime.ts` 的 `run_shell` gate，临时收紧到 `!isPlatformAdmin`，让组织 admin / 普通 user 不再能通过 raw host path 读跨组织文件。随后已升级为 A+C：execution routing 默认让平台 admin 走 `server-local`、非平台用户走 `server-container`（本机 Docker 隔离 fallback），工具层仍优先自动路由唯一 ready tenant-remote hand；`run_shell` 作为 agent 基础能力允许非平台用户在隔离执行环境中执行，非平台用户落到 `server-local` 仍 fail-closed。

浏览器端到端复测：`wain_admin cat /Users/admin/workspace-openai-runtime/kaiyan/admin/MEMORY.md` 之前 EXIT=0 + 真实泄漏 → 止血版为 platform-admin-only；最新语义为 A+C：`wain_admin` 默认不再落 `server-local`，而是走 `server-container` 或唯一 ready tenant-remote hand；若误落 `server-local` 应失败，隔离 hand/container 内可运行自己的 shell，但不能触达其他组织 workspace。

77/711 测试零回归（+8 累计：4 isPlatformAdmin 真值表 + 2 sandbox 模板 + 2 toolRuntime 组织 admin/fail-closed）。

#### 三轮测试方法学沉淀

1. **静态复核抓不到 PR 8 与 PR 4 的兼容缝隙**：PR 5 Workflow + 8 sonnet Explore agent + 768k token + 10 min 报告 7 P0 + 10 P1，但都是读代码——PR 8 enqueue-only 绕过 ensureUserWorkspace 这个事实必须**真跑一次 fresh tenant 首跑**才能暴露。
2. **prompt 层防御 ≠ 系统级防御**：本次测试中 agent 几次主动拒绝跨组织操作（PERSONA 引导），看似安全——但 prompt 防御只挡老实模型，prompt-injection 一打就破。测试必须主动"打穿"prompt 层去验证下面那层防御。
3. **"改一行就行"是常见错觉**：第二轮判断"修法只是改 dispatch.ts 一行"对静态读代码合理，但实际 Web enqueue-only 默认路径完全绕过那条代码——只有真跑一遍才知道防御是否在生产链路上。PR 9 第一刀涉及 6 文件 + 4 测试 + 77/709 测试零回归看似完美，但实际拦不住 BUG，直到第二次定位到 toolRuntime gate 才真正解决。
4. **架构假设迁移规则**：每次重大架构改造（单组织 → 多组织 / 同步 dispatch → scheduler wake / engine → raw runtime）都会让旧 invariant 失效。本次崩塌的不只是 `isAdmin` 字面值，更是"engine/dispatch.ts 是唯一 dispatch 入口"这条底层假设。

#### 最新后续（PR 10+ 候选，不阻塞 SaaS）

- **run_shell 权限模型已从 role-based 止血升级为 A+C**：`run_shell` 是通用 agent 操作自己 sandbox/hand 的基础能力，不再长期按“只有平台 admin”理解。当前规则：平台 admin 默认 `server-local`；非平台用户（组织 admin / 普通 user）默认 `server-container`，作为本机 Docker 隔离 fallback；session 内唯一 ready tenant-remote hand 仍会被工具层优先自动路由；非平台用户落到 `server-local` 继续 fail-closed，避免复发 wain_admin 跨组织 cat 事故。
- **wake/resume 身份传播补齐 tenantId**：`wakeRuntimeSession()` 恢复 approval / interaction / 普通 wake context 时，`sessionOwner` 会通过 `resolveUserTenantId` 补回 tenantId，避免后续 platform/tenant 判定依赖不完整身份。
- **P1-3 userOverrides / SkillConfigStore 二级 key**：`config.agent.userOverrides` 改 `Record<tenant, Record<username, ...>>`；当前单 tenant 不暴露此风险，第二个真实组织大规模上线前补即可（wain-test 已建测试组织但 userOverrides 为空，未触发）
- **trash 接口让组织 admin 看自己 tenant 内 trash**（当前仅 `isPlatformAdmin` 可访问 trash）
- **raw runtime server-local sandbox guard 已补 baseline（commit `7644d5f`）**：raw runtime / approval resume / interaction resume 会把 `dispatch.sandbox.denyRead` 模板展开为 `sandboxPolicy` 并传到 `WorkspaceRef`；`ServerLocalExecutionProvider` 对 read/write/list 解析后路径和 `run_shell` 直接引用的 denied absolute path fail-closed。注意：这是 portable host-path guard，不是 macOS `sandbox-exec` 完整移植；A+C 的非平台用户默认 `server-container` / tenant hand 仍是主隔离层，后续若要覆盖更复杂 shell 逃逸、symlink/canonical path、平台 admin 技能越界，需要继续补 OS sandbox 或更强 policy engine。
- **MEDIUM 系列**：UserStore.load fire-and-forget persist 改 await / dispatch-audit.jsonl 按 tenant 分文件 / PgSessionLock 加 tenant 盐 / findTranscriptPathBySessionId tenant 索引 / PG 版本校验

#### 运行时实测前置（已完成 ✅）

PR 1-9 + 补丁全部 push 后**已在 2026-06-21 夜重启 3200 三次跑通端到端验证**：

- ✅ 启动期 4 项迁移：TenantStore.ensureDefault 创建 `data/tenants.json` / UserStore.load 回填 admin tenantId='kaiyan' / **BUG6: Migrated 650 transcript files to tenant-aware projectKey** / PG `ALTER TABLE ADD COLUMN IF NOT EXISTS tenant_id` 三表（IF NOT EXISTS 静默成功）
- ✅ admin 浏览器登录：230 个旧会话完整加载 + 旧 transcript 可读 + 续发消息工具调用闭环（PR 7 BUG 6 修复 100% 验证）
- ✅ 创建第二组织 `wain-test` + 2 用户（wain_admin / wain_user）
- ✅ 11 个 API 越权矩阵（viewAs/__all__/__others__ / root mode / owner 跨组织 / 跨组织改密 / 跨组织 sessionId / requireAdmin / requirePlatformAdmin）全部 403
- ✅ wain_admin 浏览器新建会话发消息端到端跑通（cwd 正确落在 `wain-test/wain_admin/`，workspace 被 `workspaceProvisioner` 完整初始化含 `.claude / .browser-profile / .venv / MEMORY.md / PERSONA.md`）
- ✅ PR 11 abort/cancel：主机 `/bin/sh -c for i...` 进程组 3 秒内被 SIGTERM/SIGKILL 清理
- ✅ 17 天前旧会话 resume：续发 run_shell 返回 `/Users/admin/workspace-openai-runtime/kaiyan/admin RESUME_OK_215317`
- ✅ P1 BUG #3 修复回归：wain_admin 跨组织 cat 之前 EXIT=0 泄漏；最新 A+C 规则为非平台用户默认 `server-container` / tenant hand，误落 `server-local` fail-closed，隔离 hand/container 内允许 `run_shell`。

**SaaS 上架前阻塞真清零 v2**。第一个真实客户组织 admin 在 read / artifact / `server-local run_shell` 三条主链路都被收紧到只能访问自己组织资源；`run_shell` 不再被描述为永久 platform-admin-only，而是由 A+C 策略让非平台用户默认走 `server-container` / tenant hand。wain-test + wain_admin / wain_user 测试数据保留作第二客户灰度（无需清理，下次对接真实客户可对照参考）。

#### P4/P5 防御纵深 + 端到端覆盖（2026-06-23 落地，4 commit）

针对 `docs/tenant-isolation-e2e-test-2026-06-21.md` 三轮端到端测试后开的 5 个测试覆盖盲区疑点，重审后真实优先级为 1（容器端到端）→ 3（wake 断言）→ 5（跨进程 approval）→ 4（env 防御纵深）→ 2（sandbox guard 升级）。曾磊定全部落地：

| Commit | 主题 | 价值 |
|---|---|---|
| `ee6e1a1f` | 疑点 1：`verify:tenant-container-smoke` wain_admin/wain_user 端到端真跑 Docker | 首次端到端证明 A+C 路由对非平台用户真实生效（stdout 含 `/workspace` + `Linux` + 容器 hostname）；wain_admin 显式 `executionTarget=server-local` 被 `chat_rejected access_denied`（`allowUserOverride=false`）|
| `ee6e1a1f` | 疑点 3：`resolveSessionOwnerTenantId` 加 fail-safe + 4 case 锁死 | 见 §13.4 WakeTenantIdFailSafe |
| `f5ad42ba` | 疑点 5：`verify:multiprocess:approval-resume` 独立 scenario | 见 §13.5 追加 scenario |
| `095459fe` | P4 / 疑点 4：raw runtime + container 子进程 env tenant 隔离 | 见 §13.4 TenantScopedEnv；当前 toolRuntime gate 已挡非平台用户 server-local，此为防御纵深；同时补齐组织用户容器内 ky-azeroth 功能缺失 |
| `ae095ef9` | P5 / 疑点 2：server-local sandbox guard 路径变形 bypass | 见 §13.4 ServerLocalSandboxGuard |

重审降级（写进 commit message 与 `assets/20260622/e2e测试覆盖盲区调研.md`）：疑点 4 当时被子 agent 报告判为"严重 gap 硬阻塞"，重审 `toolRuntime.ts:608-626` gate 后发现 fail-closed 已挡死所有"非平台用户 → server-local"路径，env 全继承不构成真泄漏；P4 实施意义是防御纵深 + 容器侧功能补齐。疑点 2 sandbox guard 只对平台 admin 生效（平台 admin 跨组织在产品语义下合规），P5 升级是给平台 admin 自防 prompt-injection 的兜底，**不阻塞 SaaS**。

测试覆盖：78/743 全测试零回归（+13 新 case 跨 4 commit）。launchd `com.agent-saas.server` 重启后真上线，wain_admin/wain_user 端到端复测仍通过。SaaS 上架阻塞清零状态由 v2 升级到 **v3（防御纵深 + 端到端覆盖闭环）**。
