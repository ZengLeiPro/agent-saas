# 钉钉员工优化研究配套证据

研究日期：2026-09-08。基线：`c73689eab0f4a119f8efc1c5e0f8f8092493f33c`。

主报告：[企业专家与钉钉员工优化研究方案](dingtalk-employee-optimization-plan-2026-09-08.md)。

新对话实际实施先读[执行交接](dingtalk-employee-execution-handoff-2026-09-08.md)。本文件保留最初审计证据，不代表后续修复状态；当前进度与验证见执行交接。

本轮共运行 20 个不同测试文件、281 项现有测试，全部通过：消息链路 8/123，Runtime 与记忆 9/114，界面 3/44。另有 Context 主体校验的真实函数最小复现。测试使用 Node 22.23.1。未修改产品代码，未进行生产 PG、DWS、NAS 实连或外发消息。

以下保留三路审计的详细定位、精确测试命令与复现输出；工作包的最终优先级和统一方案以主报告为准。专项笔记中的候选建议不表示已经实施。

---

# 消息链路专项

# 钉钉员工消息与长期运行可靠性审计（只读）

范围：2026-09-08 当前 /Users/admin/code/agent-saas checkout；未改业务代码、未操作线上、未外发消息。祖先目录和仓库未发现适用 AGENTS.md。轻量检索 MEMORY.md 未找到相关命中，结论来自当前源码和本轮测试。以下“确定缺陷”表示源码状态机足以成立；不表示已在线上复现。

## 一、结论

当前产品具备较扎实的持久化入站/出站、账号身份隔离、租约、群话题与后台任务基础，但其默认行为仍是“收到群 @ 后处理一个话题，或在私聊中替映射用户处理请求”。它还不是一个持续在场、每群/私聊有稳定长期上下文、能及时回应控制消息的员工。

最优先问题不是补一段“积极主动”的提示词，而是统一会话模型、建立持续观察与参与决策，并补上投递恢复闭环。尤其当前存在“管理员已经确认未送达，消息仍无法重新被消费者领取”的确定状态机缺陷。

## 二、当前消息链路及已有能力

1. 事件接收通过远程 Shell 长连接消费 DWS Personal Stream。Gateway 为每个账号取得 PG runtime lease，60 秒 TTL、20 秒续租；使用稳定 invocationId 先取消旧执行，另有 flock 防止重复消费者（server/src/dws/personalEventGateway.ts:15-24、90-127、160-218、331-339）。账号 revision 参与 claim/renew/markEvent，账号换绑或配置变动后旧消费者不能继续合法写入。

2. 入站先写 PG inbox 再进入 Agent。ingest 严格校验当前 profile、事件、conversationId 和非空文本，保存 accountIdentity 与少量引用路由字段；数据库以 (account_id,event_id) 去重，默认最多 8 次失败尝试（server/src/dws/personalMessageRouter.ts:222-296；server/src/data/agentDwsMessages/store.ts:44-75）。Context 唤醒在 durable inbox commit 后异步执行，知识同步失败不会撤销已接收消息（server/src/app/agentDwsRuntime.ts:258-269）。

3. Inbox 使用事务 + SKIP LOCKED、lease fence 与租约保护；同会话/话题 FIFO，跨会话并发默认 4、上限 32。先前未完成事件会阻止同一分区后续事件越过；已明确 pin 到不同 workConversation 的消息可并发（server/src/data/agentDwsMessages/store.ts:145-225；server/src/dws/personalMessageRouter.ts:66-72、168-202、299-420）。

4. 分发采用稳定 runId。崩溃恢复时，已保存 responseText 不重跑 Agent；run 仍 active 则每 30 秒 defer 且不消耗失败预算；已 completed 则从 eventStore 回收输出；failed/cancelled 不盲目重跑副作用（server/src/dws/personalMessageRouter.ts:542-544、597-637、758-806）。这是应保留的可靠性边界。

5. 出站先建立 durable delivery intent，再持久化 provider_start，然后调用 DWS；账号身份、群配置 revision、启用状态和 Agent 状态在 SQL 层一并校验。发送前失败可有限重试，provider 已开始后的异常记为 unknown，避免“超时即再发”产生重复（server/src/dws/orgAgentVisibleReply.ts:193-329；server/src/data/orgGroupAgents/deliveryClaims.ts:45-115）。后台 delivery worker 可以独立取队列，核对任务最新 attempt 与最终权限（server/src/dws/orgAgentDeliveryWorker.ts:34-225）。

6. 已有针对重授权、自回声、组织权限变化、完成通知私有可见性和审批恢复的保护。群内 DwsBusiness 写操作可进入 durable 审批；普通 AskUserQuestion 不支持，将需求转普通文本（server/src/dws/personalMessageRouter.ts:465-506、925-961）。

7. 已有 3 秒群首回兜底“收到，我正在处理，完成后会在这里回复结果”，如果兜底已确认发送，最终回复另用一个确定幂等键。常规回复通过 DWS reply --uuid 或 send --idempotency-key，单条最多 12,000 个 Unicode 字符，超过后加“消息已截断”（server/src/dws/orgAgentVisibleReply.ts:29-49、86-127；server/src/dws/personalMessageSender.ts:17-21、158-201）。

## 三、与目标明确不一致的行为

### 1. 已有话题隔离，但缺少长期 channel 上下文与自然续话调度

Active 群首先按原生引用、thread/root message 或显式任务短号寻找 WorkConversation；找不到时 rootKey 直接取本条 messageId/eventId，并创建新 WorkConversation。因此同群两条没有引用的新 @，默认就是两个工作 session。独立 thread/session 本身合理，也与官方 Claude Tag 的 channel 主会话加 thread 工作会话设计兼容；本项目真正缺口是上层 channel 主会话、连续上下文调度和非引用续话归属。所谓“继续这个任务”只有原生 thread 已定位且候选唯一才直接续接；同群仅有一项任务但没有引用，也要求用户补任务引用（server/src/dws/orgAgentSharedGroupContext.ts:140-188；server/src/dws/orgAgentConversationRouting.ts:24-47；server/src/**tests**/dwsOrgGroupMessageRouter.test.ts:83-119）。

Legacy/shadow 群和私聊另走 requester binding，唯一键是 (account_id,conversation_id,requester_user_id)，分发时 sessionOwner=requester；active 群则是 Agent serviceIdentity 所有（server/src/data/agentDwsMessages/store.ts:326-377；server/src/dws/personalMessageRouter.ts:575-596、858-898）。这形成两套语义，解释“有时像员工，有时像依附用户的插件”。

建议：ConversationSpace 成为群/私聊永久边界；channel 前台主会话维护近期日志、摘要与任务索引，thread 工作会话继续承载独立任务；创建新 thread 前由上层调度明确这是新话题、续话还是控制事件，不能丢失 channel 层连续理解。引用优先路由任务；低风险自然续聊可沿当前话题；涉及多个任务副作用再澄清。群/私聊统一 employee-owned，只将人类身份用作调用者和授权来源。

### 2. 非 @ 群消息尚未接入，现有周期拉取不会让员工插话

Gateway eventCommand 当前只把 at_me 映射为 user_im_message_receive_at，其余映射为 user_im_message_receive_o2o_all；router supported types 同样只有两种。提示词甚至明确写“未 @ 的续话不会送达”（server/src/dws/personalEventGateway.ts:331-339；server/src/dws/personalMessageRouter.ts:76-79；server/src/dws/personalMessageRouterHelpers.ts:69-72）。

Context 的 chat 周期同步是每 2 分钟拉规范消息入知识库；服务只 syncWindow/retry，没有触发 inbox 或前台 Agent 的分支，所以不等于主动观察/参与机制（server/src/context/sync/dwsContextRuntime.ts:41-42、95-99、346-390、407-425）。历史数据仅在可治理群范围中标记 group 或已知 workConversation，不猜归最近话题，是值得保留的边界（同文件:474-508）。

主代理已核查官方 DWS 文档存在 user_im_message_receive_group 和 user_im_message_receive_group_all。方案应优先验证部署的 CLI 1.0.60 对指定群实时订阅的兼容性，逐群启用，新增群发现另控；全量群轮询只作补偿。不能把当前代码只实现 @ 误写成钉钉平台固有限制。

### 3. 三秒首回不等于用户发消息后三秒收到

计时器直到目录身份解析、共享群解析、授权、session binding 和 markDispatchStarted 完成后才启动，而且仅 shared 群启用（server/src/dws/personalMessageRouter.ts:480-605）。目录 lookup 远程 Shell timeout 为 60 秒，且可能进行 staffId 与名称两种查询（server/src/dws/requesterIdentityResolver.ts:110-114、201-219）。所以冷启动或目录抖动时，前面可以沉默很久；私聊没有相同兜底。

前台 worker 的 4 个并发槽覆盖完整 dispatch/回复。忙槽时新消息不能被领取，3 秒 timer 也未启动。自然语言“暂停/取消/改成”仍是普通 inbox 消息，受前序 FIFO 阻塞；router 中 AbortController 用于停机/丢租约，不是新的聊天控制事件抢占长任务（server/src/dws/personalMessageRouter.ts:299-420、758-806、922）。后台任务工具的 cancel 能力存在，不代表前台能及时收到 cancel。

建议：独立轻量 front desk actor，快速形成“理解/澄清/已委派”回复；真正执行 durable worker。入站延迟、排队延迟和首回延迟分开计量。stop/amend/status 走受授权的高优先级控制队列，能更新任务而不等待任务自己结束。简单查询允许在短预算内前台完成，避免机械地每句话都创建 worker。

## 四、确定性可靠性缺陷

### D1. unknown 人工确认未送达后，关联 inbox 的 delivery 无法自动重发（P0）

完整状态链：
A. finalizeReplyDelivery 对 unknown/dead_letter 调 markReplyUnknown。
B. markReplyUnknown 将 inbox 置 dead_letter，disposition=delivery_unknown。
C. 管理员 reconcile confirmed_not_sent 只把 delivery 从 unknown 改 pending。
D. delivery 的 claimNext 明确排除其 inbox.state 为 reply_pending 或 dead_letter。
E. inbox 自己的 claimNext 也不包含 dead_letter。

证据：server/src/dws/orgAgentVisibleReply.ts:52-63；server/src/data/agentDwsMessages/store.ts:554-569、157-164；server/src/data/orgGroupAgents/deliveryClaims.ts:166-187、299-315；server/src/routes/agentDwsAccounts.ts:353-374。

故界面显示已经“确认未送达”，但两个消费者均不再接手。修复必须是带权限/证据/fence 的原子 reconcile 状态转换：决定由出站 worker 独立继续，或恢复 inbox 为可领取 reply_pending；继续复用已固定正文和幂等键，禁止重新 dispatch。应同时考虑 fallback 与 final 两种 intent，不能只恢复“收到”后遗失真正结果。

### D2. 私聊 unknown 投递缺少可用的同等人工核对入口（P1）

私聊 send 创建 durable delivery 时 shared 为 undefined，因此没有 bindingId/agentId（server/src/dws/orgAgentVisibleReply.ts:193-211）；目前唯一 reconcile 路由要求 delivery.bindingId 找到当前身份 binding，否则 404（server/src/routes/agentDwsAccounts.ts:353-367）。这使“通用 durable outbox 支持私聊，但 recovery API 只允许群绑定”的模型不对称。

建议把投递恢复升到账号/会话通用 API，以 pinned account identity + destination + requester 当前授权校验；群策略作为附加条件。

### D3. 失败到重试上限后，没有形成面向聊天用户的终态反馈（P1）

Router dispatch/error 最終只 messageStore.fail 和 warn；store 达上限置 dead_letter。没有在该路径创建“执行失败/需要补充信息/系统暂不可用”的 durable 用户通知（server/src/dws/personalMessageRouter.ts:350-375；server/src/data/agentDwsMessages/store.ts:572-609）。若之前已收到统一兜底，用户就停留在“完成后会回复”的承诺；私聊可能完全静默。权限拒绝另有显式回复，不应与执行失败混淆。

应把 run outcome 与 message delivery outcome 分开，并为已接受请求定义 completed/failed/cancelled/waiting_user 的用户可见终态。发送失败时继续在后台恢复通知，不能把业务已结束当作用户已知晓。

## 五、需要故障注入复现或容量验证的风险

1. 入站恢复仍依赖 DWS 自身重放保证。Gateway 在 seen/markEvent 后调用 onEvent，应用未保存可恢复消费 cursor、也未实现 reconnect 后将缺失消息补入 inbox；Context 回补只写知识。onEvent 持久化失败、远程 stdout 断流的消息是否重投必须核实 CLI/provider ack 语义，不能凭本地去重宣称端到端不丢消息（personalEventGateway.ts:253-281）。

2. Stream 失败退避状态存进程内，5 次失败熔断 1 小时；一收到 ready 就清零。重启会清退避，ready 后立即断线可一直以首次失败节奏循环。没有应用层“流还活着但无事件”的探针/补偿判定（personalEventGateway.ts:45-49、239-249、311-323）。应区分鉴权失效、网络抖动、长连接正常轮换，退避带 jitter，稳定运行一段时间才清失败；状态可被运维观测。

3. Outbox claim 与 inbox 共用 router 槽，runOnce 每次先试 delivery 再领取 inbox；大量外发积压可能压住新入站。应独立 worker pool、分租户/账号限流与公平调度，不能仅加大 maxConcurrency（personalMessageRouter.ts:299-315）。

4. Outbox 没有独立续租流程；当前 120 秒默认 TTL 通常覆盖 60 秒发送，但远程准备/启动排队/transport 超时叠加可能越过 TTL，真实送达随后无法 markSent，最终 unknown。需故障注入慢 remote resolve、慢 sandbox startup、成功回执晚于 lease（personalMessageRouter.ts:67；personalMessageSender.ts:65-100；deliveryClaims.ts:190-218）。

5. 所有 provider_started 后 error 都进入 unknown，包括服务端明确拒绝的业务错误；这虽避免重发，却把可判定未发送和真正超时混为一谈，可能造成不必要人工处理。需要 connector 返回结构化 certainty=rejected/accepted/ambiguous，再决定退避、终止或对账（orgAgentDeliveryWorker.ts:183-223）。

6. 配置修订的 exact revision fence 能阻止旧权限发送，但“允许能力未变的文案调整”也会使旧 intent 过期。应明确自动重新评估可见性/重编译结果还是安全终结，并给用户状态，不能无限等待或假装当前配置可直接用于旧结果（deliveryClaims.ts:71-88）。

## 六、主动员工机制与聊天策略建议

建议建立 ObservedEvent → ConversationJournal → AttentionDecision → FrontDeskTurn → WorkOrder → DeliveryIntent。观察不必每条都调用大模型，先排除自己发言、重复、无关通知，合并短时间连发；重要提醒、明确提问、被承诺事项到期、任务完成可唤醒。模型的 attention 决策只返回 ignore/remember/respond/delegate/clarify，并记录理由；“可以看见”不等于“每条都回复”。

每群/私聊可配置：仅点名响应、点名后延续窗口、相关话题参与、主动值守；另配静默时间、发言频率、冷却、未决承诺、人工接管。已授权群实时订阅是主链路，持久化 cursor + 重叠时间窗口 messageId 去重是断连补偿。heartbeat 只处理新日志/任务到期/待办变化，不向每个闲群周期发“我还在”。

提示词应说清：员工的职责与当前群关系；何时沉默；执行前简短说将做什么；复杂/长时任务立即委派且负责验收；不把 BackgroundTask/Worker/短号当普通聊天默认词汇；需要补充信息时自然提问并保留任务状态；临近承诺期限或出现阻塞主动告知。反馈可用“我先核一下近三个月的数据，查完在这里给你结论。”“数据查到了，两家供应商的报价异常，我再把订单逐项核一下。”避免所有工作统一“收到，我正在处理”，也避免把完整技术过程刷进群。長材料发摘要加持久化文档，不能靠 12,000 字静默截断承担正式交付。

## 七、建议验收矩阵

- 同一员工加入两个群和两个私聊：A 群/私聊历史互不泄漏；同群无引用连续聊天保持自然上下文；多话题同时存在时引用可精确定位，危险操作歧义必须澄清。
- 人 A 发起任务，人 B 在同群补充：共享会话上下文可理解，但权限仍各自验证；改绑账号后旧消息不由新身份发出。
- 已启用群未 @ 的追问可接收；无关闲聊可沉默；自己消息与其他 Agent 消息不会无限互触。
- 同群用户先发长任务，2 秒后发“暂停”，控制事件应在约定 SLO 内生效；另一群短问不受长任务影响。
- 入站落盘前/后、dispatch 前/后、发送前/后分别 kill worker：没有重跑已完成副作用；全部未送達最终可见补偿状态。
- mock provider 真成功但客户端 timeout：unknown 不盲重发；管理员 confirmed_sent 后状态闭环；confirmed_not_sent 后最终正文确实被重发一次；fallback 已送但 final 未发也能恢复。
- 私聊同样覆盖上述 unknown 对账；管理员入口不会因为无群 binding 而拒绝。
- provider 明确 429/拒绝、目录临时失败、失去账号授权分别显示不同状态；重试超限后可见失败而不是永久“处理中”。
- 100 群并发、单群突发、多个租户一起积压：测 p50/p95 入站延迟、排队延迟、首回、完成通知延迟和每账号外发限速；先定 SLO 再容量验收。
- 7 天小规模值守 soak：断网、进程轮换、数据库 failover、CLI 24 小时流超时、权限变更、任务完成通知都能恢复；记录主动发言有用率和被打断投诉率。

## 八、本轮验证

执行目录 /Users/admin/code/agent-saas/server，使用 Node 22.23.1，命令：

PATH=/Users/admin/.nvm/versions/node/v22.23.1/bin:$PATH pnpm exec vitest run src/**tests**/dwsPersonalEventGateway.test.ts src/**tests**/dwsPersonalMessageRouter.test.ts src/**tests**/dwsOrgGroupMessageRouter.test.ts src/**tests**/dwsPersonalMessageSender.test.ts src/dws/orgAgentVisibleReply.test.ts src/dws/orgAgentDeliveryWorker.test.ts src/dws/orgAgentConversationRouting.test.ts src/**tests**/agentDwsMessageStore.test.ts

结果：8 files / 123 tests 全通过，1.52 秒。

- dwsPersonalEventGateway 6
- dwsPersonalMessageRouter 29
- dwsOrgGroupMessageRouter 22
- dwsPersonalMessageSender 12
- orgAgentVisibleReply 11
- orgAgentDeliveryWorker 21
- orgAgentConversationRouting 1
- agentDwsMessageStore 21

这些现有测试多数为 mock/单元契约；通过不证明生产 DWS 收发、真实 PG 多进程组合状态或上述 D1/D2 已覆盖。本轮未新增测试、未做真实发信或线上故障注入。

## 测试原始输出

```text
 RUN  v4.0.18 /Users/admin/code/agent-saas/server
 ✓ src/dws/orgAgentConversationRouting.test.ts (1 test) 2ms
 ✓ src/__tests__/agentDwsMessageStore.test.ts (21 tests) 25ms
 ✓ src/dws/orgAgentVisibleReply.test.ts (11 tests) 6ms
 ✓ src/dws/orgAgentDeliveryWorker.test.ts (21 tests) 10ms
 ✓ src/__tests__/dwsOrgGroupMessageRouter.test.ts (22 tests) 72ms
 ✓ src/__tests__/dwsPersonalMessageRouter.test.ts (29 tests) 120ms
 ✓ src/__tests__/dwsPersonalMessageSender.test.ts (12 tests) 6ms
 ✓ src/__tests__/dwsPersonalEventGateway.test.ts (6 tests) 315ms

 Test Files  8 passed (8)
      Tests  123 passed (123)
   Start at  08:53:36
   Duration  1.52s (transform 2.71s, setup 0ms, import 4.20s, tests 555ms, environment 1ms)
```

---

# Runtime 与记忆专项

# 钉钉员工 Runtime、Worker 与记忆专项审计

范围：2026-09-08 当前 `/Users/admin/code/agent-saas` 工作树，只读代码审计、现有测试、最小函数复现；未改产品代码，未读生产数据库或生产日志。因此“已实现”指调用链存在，不代表生产环境已经开启或端到端健康。没有找到适用的 AGENTS.md。内存检索无相关专项命中，未使用历史记忆作为事实来源。现有 `docs/reviews` 未跟踪文件保留不动。

## 核心判断

现有系统不是完全没有“独立员工/并行 Worker”的基础，而是身份、任务隔离、运行治理已有相当工程投入，关键业务能力在几层边界拼接时断掉了。最应优先修的并非再写一句“要调用子 Agent”：已激活群强制 dispatcher，但 dispatcher 不能直接用 DWS/Context，Worker 又分别被 DWS 策略、Context workspace 身份校验挡住。这两条确定性路径能直接解释“配置了能力、派出了任务，仍然做不了事”。

另外，群个性化指令与治理记忆只确定性注入前台；后台 Worker 的实际 prompt 没有自动继承它们，依赖前台模型在 `Agent.prompt` 中手工复制。工具/技能名单继承是硬机制，工作语义继承仍是软约定。记忆、资料同步、主动发言需要分开：已有钉钉资料同步轮询，但企业员工没有与普通用户等价的自动记忆维护与主动任务调度。

## 现状与真实入口

1. **群前台强制委派已实现。** `routes/agentDwsAccounts.ts:302-311` 激活群绑定要求 Agent 发布为 dispatcher、活动 Worker 支持组织群协议 v2；不能把默认 direct 当成“已激活群不委派”的原因。`runtime/dispatcherMode.ts:11-17,40-47,57-85` 仅暴露 Agent、BackgroundTask、AskUserQuestion、TodoWrite、SessionContext，实质任务必须后台 Worker，运行时再次拒绝执行工具/前台子 Agent。`runtime/subagent/agentToolProvider.ts:76-79,133-168` schema 将 mode 固定为 background，入队成功后立即返回 taskId。

2. **私聊尚未与群统一。** `dws/orgAgentSharedGroupContext.ts:50-51` 仅群 @ 进入 SharedGroup；`dws/personalMessageRouter.ts:575-598,858-898` 群使用 serviceIdentity+orgAgentChannel，legacy 使用 requester 作为 sessionOwner。私聊是否 dispatcher 取决于该员工全局 runtime，且没有群的同等绑定/隔离机制。全局默认 direct 在 `data/orgAgents/runtimePolicy.ts:37,139-142`，只可用于描述新建/legacy 的默认行为。

3. **持久化后台任务不是空壳。** `runtime/background/backgroundTaskService.ts:169-345` 用 parentRunId+toolCallId 固化 task/run/session，支持幂等、staged enqueue、原子激活、work attempt；`runtime/background/orgAgentBackgroundWork.ts:85-125` 保存实际 binding revision、权限名单与 effectiveConfig 快照。后台执行 `backgroundTaskService.ts:528-583` 实际重建 tooling/context，并调用同一 `runSubagent`；终态通过 `backgroundWakeDeliveryReconciler.ts:62-72` 走 DWS completion 路由；`backgroundTaskDwsCompletion.ts:88-139` 校验 work/attempt/fence、持久化重新入箱、缺 outbox 时留 pending，旧 attempt 不再重复播报。

4. **权限继承部分扎实。** `backgroundTaskService.ts:137-145,528-545` 合并 Agent worker policy，并以 Agent 技能名单 AND 群 skillIds 过滤；`subagent/subagentRunner.ts:242-252,854-883` 再做 Worker profile/工具过滤；`runtime/toolPolicy.ts:35-77` 做 channel 工具白名单、live binding、DWS 专属校验。`app/orgAgentChannelPolicyEvaluator.ts:20-38` 每次查 live 主体链与紧急停用，普通配置仍按 attempt pin。应保留这些硬边界，在其上修合法执行路径，不能简单关闭校验。

5. **NAS/工作区隔离已经存在。** `runtime/orgAgentTaskWorkspace.ts:20-34,46-76` 前台共享视图为 Agent root 下 `shared/<binding>/<workConversation>`；每个后台 task/attempt 有 `work/<task>/attempt-N`、独立 workspaceId/sandboxScope、当前话题只读共享 mount。`backgroundTaskService.ts:129-130` 群 Worker 固定 remote 执行；`runtime/orgAgentWorkerCapability.ts:18-52` 只有隔离证据匹配的 worker 才可获得任务目录写能力。不是“仍全部写请求者个人目录”。但整体长期员工工作区、话题共享视图、短命 task workspace 三个身份在工具授权中还未正确区分。

## 确定性缺陷与产品缺口

### A. P0：群 Worker 的 ContextSearch/ContextGet 必然发生 workspace mismatch（已最小复现）

`agent/contextSearchToolProvider.ts:215-218` 要求 `channel.agentPrincipal.workspaceId === context.workspace.id`。群后台的合法 task workspaceId 在 `orgAgentTaskWorkspace.ts:69-75` 被派生为 `<agentWorkspaceId>__task_<digest>`，再经 `backgroundTaskService.ts:287-299`、`backgroundTaskAutomationContext.ts:45-58`、`subagentRunner.ts:579-605` 传入真实 ToolCallContext，而 channel.agentPrincipal 仍是长期员工 workspaceId。二者设计上必不相等。合法群 Worker 一旦调用 ContextSearch/ContextGet，就在访问 scope resolver 之前报 `CONTEXT_RECALL_SUBJECT_MISMATCH`。

这不是越权应被放行，而是把“内容归属空间”和“当前执行工作目录”混成同一字段。前台工具白名单又没有 ContextSearch，所以切 dispatcher 后组织上下文检索没有可达执行层。

建议显式引入 ownerWorkspaceId / executionWorkspaceId / channelScope / workOrderScope；检索鉴权以可信 Agent principal+binding+允许资料源为准，另外验证 Worker lineage、task ownership、isolation attestation。绝不能通过把 task workspaceId 改回 Agent root 来修，否则任务隔离被破坏。

### B. P0：DwsBusiness 也没有合法执行层（代码逻辑确定，未实连 DWS）

dispatcher 白名单不含 DwsBusiness；`dws/sharedGroupBusinessPolicy.ts:61-63` 明确对 executionRole=worker 返回 `organization Worker cannot use DwsBusiness`；真实 Worker 的 executionRole 在 `subagentRunner.ts:596-600` 设置，并由 `toolPolicy.ts:64-70` 传给该策略。所以无论群 UI 配什么 DwsBusiness/dwsResourceIds，当前 activated dispatcher 群中的 worker 都不可执行 DWS 业务工具。

现有安全设计只为有限群资料命令登记资源选择器（sharedGroupBusinessPolicy.ts:40-46，仅 doc.info/read/list/update/copy）；不能宣传成完整钉钉同事能力。建议用 Worker Broker 获得员工专属凭据的受限调用权，继承 task scope、资源白名单与确认记录，所有凭据留 broker。写操作需要前台转交持久化审批，worker 挂起等待同一个 work order 恢复。保留个人连接器隔离、未登记命令拒绝与 live deny，不应开放全量 Shell 直跑 DWS 绕过治理。

### C. P1：群指令与记忆没有确定性下传到实际执行者

`dws/personalMessageRouterHelpers.ts:50-65` 把群管理员指令（8k 字符上限）与治理记忆（12k 总上限）放到前台 `systemContext`。`backgroundTaskService.ts:549-557` 重建后台 channelContext 时不带 systemContext；`subagentRunner.ts:500-515,931-954` 仅加入通用 Worker/system profile/Agent 全局 instructions/可选公司资料；`backgroundTaskService.ts:580` 的 prompt 只是 metadata.prompt 加交付文件合同。虽然 WorkOrder.policySnapshot 存了 effectiveConfig（orgAgentBackgroundWork.ts:111-119），没有在创建/执行 Worker prompt 时读出来。

结果是管理员配置“这个群报告必须用某口径、不要使用某类资料”只能约束前台，Worker 能否遵守依赖前台模型复制。技能 IDs 能力名单确实自动继承，不要把二者混为一谈。建议统一 VersionedExecutionContext 编译器，自动生成并 pin 全局行为、群覆写、明确任务、只读记忆摘录、证据引用、运行权限摘要、输出受众；父模型只写本次任务与分工。用结构化字段区分可信管理员规则和不可信群消息，避免一段长文本混合全部信任等级。

### D. P1：员工记忆并未达到普通用户功能对等

普通用户：`app/runtime.ts:2343-2364` 的 memory_poll reconcile 只枚举 userStore.listAll；`cron/memoryPoll.ts:229-250,302-328` 每 user 恰好一条每日 job，owner=user.id；`cron/executor.ts:172-178` 查真实 userStore owner。Agent service identity 是 `adws-<accountId>`（routerHelpers.ts:76-83），不会自动进入这个用户集合。即使造一条 cron owner，executor.ts:126-134 仍拒绝不存在 owner。

此外 `runtime/sessionCatalog.ts:419-434` 新 orgAgent 会话固定 memoryPolicyVersion=v1；普通 L2 consolidation 要 v2+user projection（memory/consolidation/engine.ts:126-138）；专职 Agent 默认 profile 的 memory.scope=none（data/agentProfiles/builtins.ts:162-170）。所以不能说打开普通用户记忆开关就给员工带来相同能力。

企业专门记忆目前有 DB agent/conversation/task_checkpoint、人工创建/提升/撤销，撤销来源会级联撤销提升条目（data/orgGroupAgents/memoryLifecycle.ts:19-103），这部分值得保留。全仓 createMemory 生产调用只有 `routes/agentDwsAccounts.ts:501`，未找到 runtime 自动提取 writer。读取是 agent 最近 20 条+当前 workConversation 最近 20 条（orgAgentSharedGroupContext.ts:222-249；store.ts:960-962 按更新时间），非语义召回，也不是贯穿整个群的长期记忆；MemorySearch 则按当前文件 workspace.root 查 MEMORY.md/memory（agent/memorySearchToolProvider.ts:67-85），与上述 DB 记忆不是同一存储。

建议统一 Agent Memory 服务：通道事件→提取候选→来源/可信度/受众/保留期限→冲突合并→按 scope 检索；群私聊默认独立，只允许经过明确规则/审批把可共享事实提升为员工记忆；保留溯源撤销。记忆维护使用 Agent principal 的 durable job，增量 cursor+幂等提交，不靠假人类 user。支持展示“最近维护时间、处理消息范围、候选/采用/撤销数、失败及积压”。

### E. P1：已有“资料同步轮询”，缺少“主动参与闭环”和员工 routine

`context/sync/dwsContextRuntime.ts:38-46,95-100,116-122` 已有 60 秒 tick、chat 2 分钟、minutes 30 分钟、wiki 60 分钟的规范数据拉取；app/agentDwsRuntime.ts:146-155,258-263 确实装配且 inbox commit 后 wake。这是 Context 数据同步，不能直接当作员工思考、记忆维护或主动说话。群 stream 当前只收 @ 的限制在 routerHelpers.ts:69-72 明确写入 prompt。现有主动发言字段没有完整观察→决策→任务→投递 runtime，父代理另审证实。

员工 routine 也不能直接复用 CronManage 的人类 owner 模型：dispatcher 没该工具，Worker 在 subagentRunner.ts:105-117 硬剥夺 CronManage；即使另开工具，executor 仍以 userStore owner 验证。应把 CronJob.owner 升级为可区分 user/org_agent 的 principalRef，固定投递 channelScope，创建/执行/恢复/停用均重查权限。

建议沿官方 Tag 对标另建 Participation Scheduler：便宜观察器消费去重消息/定时事件→判断静默/当前对话回应/开线程工作/发起主动任务→交给同一 dispatcher/worker/outbox。群/私聊可配置时段、冷却、每小时额度、值得介入的主题、关注任务与提醒到期；对同一事实去重，多员工防互相触发。资料同步、记忆维护、业务 routine、参与判断四种 job 应共享 durable 调度设施，但语义和指标独立。

### F. P1/P2：协调与聊天 UX 仍有机制性约束

同一前台可一次并发派多个 Agent，工具描述明确同轮并行（agent/descriptions/Agent.md:1-6）；限额为每 parent run 10、tenant 活跃 500、单 Worker 120 分钟/500 turns（subagentLimits.ts:13-19）。但 Worker 硬禁嵌套 Agent/BackgroundTask/AskUserQuestion/CronManage；它不能临时问用户，也无法向子团队继续拆分（subagentRunner.ts:105-117）。审批 hook 会报“请主 Agent 自行执行”（566-570），与 dispatcher 禁亲自执行再次矛盾。建议保留前台集中调度，可让 Worker 发结构化 `needs_input`/`approval_requested`/`delegation_requested`，由 dispatcher 带 work order 关联处理；无需一开始开放任意递归。

长期任务上下文压缩也未对等：普通顶层运行接 `evaluateAutoCompaction`（rawRuntimeRunDispatch.ts:1431-1440），子循环 RunContext（subagentRunner.ts:574-621）没有这个钩子。500 turns 并不意味着能持续500轮而不碰 context 上限。建议给 Worker 接入相同 compaction/checkpoint 服务，验证敏感规则、任务约束、产物引用在压缩恢复后仍保留。不同任务仍冷启动，不应复制整段群历史。

聊天风格存在直接指令冲突：dispatcherMode.ts:45 要求短任务 ID、queued/running、固定“执行 Agent”话术；agentToolProvider.ts:166 再要求向用户回执 T-ID；routerHelpers.ts:59 则除非歧义不展示内部短号。工具 Agent.md:23 说共享同一工作目录，群后台实际上有隔离任务目录。不能期待模型自行调和这些规则。建议把“任务治理记录”和“对外说话”分开：自然语言确认“我去核对这几份资料，整理好回你”；多任务歧义才展示人类可读任务名；长耗时事件只在阶段变化/失败/需要输入时播报；最终消息提供结论、影响与产物，不倾倒 Worker report 与状态码。失败、取消、运行中、已完成需由平台事件决定，禁止用聊天文案推断。

文件交付目前只有 artifacts/ 才捕获，管理员显式 publish 到群共享目录（orgAgentArtifactPublisher.ts:14-15）。这是可用治理基础，但员工自动交付需求应补“受众匹配的自动发布/人工审核策略+有效链接/钉钉文件回传+送达状态”，否则后台报告“文件已完成”用户仍拿不到成品。不要用全局员工共享目录代替受众隔离。

## 建议实施顺序和验收

阶段 0：修两条能力断路，冻结一套完整场景回归。先让一个已激活群的普通成员完成“查授权 Context→读取授权钉钉资料→生成文件→返回可访问成果”，并用未授权资源/其他群作阴性验证；确认同一群前台在工作期间可继续接第二件事。加运行 trace 展示工具为何未暴露/被哪层拒绝，后台要能看到有效配置和 Worker 最终 prompt 摘要。

阶段 1：统一群与私聊的 Agent principal/channel/thread/task 模型；把 Context 身份拆清；版本化 ExecutionContext 自动下传；DWS Broker Worker 限权；needs_input/审批/取消/补充/恢复都关联同一任务，测试并行与重启。保持群主会话与任务 thread 分层；官方 Tag 本身也这样分层，问题在连续跟进路由、主会话持久认知，而不是必须删掉 workConversation。

阶段 2：员工 Memory 服务、principal-aware routine、Worker compaction 和结果验收；在业务副作用边界采用幂等 receipt/checkpoint，崩溃后区分安全可重放与需核对，复用现有 staged work/attempt/fence/artifact manifest。先不把用户偏好或单聊敏感事实全局推广。

阶段 3：把已有 Context 拉取接 Participation Scheduler，从只观察统计和建议发言开始，再按群开启主动参与；主动与被动任务走相同授权/队列/投递/审计路径。验收指标应至少含首个用户可见回执时延、第二条消息响应时延、任务完成率、权限误拒率、Context 召回成功率、最终成果可访问率、重复/漏发率、记忆滞后、每次有效主动参与成本、静默准确率；数值目标经试点基线确定，不能冒充现有生产 SLO。

核心测试矩阵：同员工跨群/跨私聊隔离；同群连续未引用消息承接与新主题分流；两个并行 worker 的权限/目录/产物隔离；合法 worker Context 查询成功且伪造 lineage 失败；Worker DWS 授权资源可读、未知资源失败、写操作等待批准后准确恢复；群 instructions+memory 确定性下传；配置收窄 live deny；前台 prompt 不出现内部标识；压缩/重启后约束不丢；routine owner 不依赖创建者账户；维护 job 提取/去重/撤销/跨群提升；主动参与的冷却/静默/互相触发防护；任务完成但消息发送未知时保留可恢复状态。现有单模块测试通过不能替代该组合回归。

## 本次验证证据

在 Node `/Users/admin/.nvm/versions/node/v22.23.1/bin` 下运行：

```sh
PATH=/Users/admin/.nvm/versions/node/v22.23.1/bin:$PATH pnpm exec vitest run src/__tests__/dispatcherMode.test.ts src/__tests__/orgAgentRuntimePolicy.test.ts src/__tests__/backgroundTaskDwsCompletion.test.ts src/__tests__/memoryPoll.test.ts src/runtime/background/orgAgentBackgroundWork.test.ts src/runtime/subagent/subagentToolPolicy.test.ts src/runtime/orgAgentTaskWorkspace.test.ts src/data/orgGroupAgents/memoryLifecycle.test.ts --maxWorkers=2
```

workdir=`/Users/admin/code/agent-saas/server`。结果 **8 个文件，108 个测试通过**（2.70s）。fixture 打印预期的 legacy completion 拒绝、memory PERSONA 缺失警告，无测试失败。

随后为新发现的 Context 组装问题检查原有测试：

```sh
PATH=/Users/admin/.nvm/versions/node/v22.23.1/bin:$PATH pnpm exec vitest run src/agent/contextSearchToolProvider.test.ts --maxWorkers=2
```

结果 **1 个文件，6 个测试通过**（134ms）。合计 **9 个文件，114 个现有测试通过**，不含任何 PG/真实 DWS/NAS 端到端验证；没有为了审计修改/新增仓库测试。

Context workspace 最小复现完整命令（同 workdir，直接导入生产函数）：

```sh
PATH=/Users/admin/.nvm/versions/node/v22.23.1/bin:$PATH pnpm exec tsx -e 'import { resolveContextRecallSubject } from "./src/agent/contextSearchToolProvider.ts"; import { deriveOrgAgentTaskWorkspace } from "./src/runtime/orgAgentTaskWorkspace.ts"; const task = deriveOrgAgentTaskWorkspace({agentWorkspaceId:"agent_workspace_a",agentRoot:"/tmp/agent-a",agentMountSubPath:"tenant-a/agents/agent-a",sharedReadOnlySubPath:"tenant-a/agents/agent-a/shared/bind-a/topic-a",taskId:"bg-a",attemptNo:1}); const base = {sessionId:"child-a", workspace:{id:"agent_workspace_a",root:"/tmp/agent-a",userId:"adws-a",tenantId:"tenant-a"},channelContext:{channel:"dingtalk",sessionOwner:{id:"adws-a",username:"agent-dws:a",role:"user",tenantId:"tenant-a"},orgAgentChannel:{agentId:"agent-a",contextEnabled:true,allowedSourceIds:["source-a"],agentPrincipal:{tenantId:"tenant-a",agentId:"agent-a",workspaceId:"agent_workspace_a"},channelPrincipal:{conversationId:"conversation-a"}}}}; for (const [name, workspaceId] of [["front", "agent_workspace_a"],["worker",task.taskWorkspaceId]]) {try {console.log(name, JSON.stringify(resolveContextRecallSubject({...base,workspace:{...base.workspace,id:workspaceId}} as never)))} catch(e) {console.log(name, String(e))}}'
```

原始输出：

```text
front {"tenantId":"tenant-a","userId":"adws-a","workspaceId":"agent_workspace_a","sessionId":"child-a","channelScope":{"conversationId":"conversation-a","allowedSourceIds":["source-a"]}}
worker ContextRecallAuthorizationError: CONTEXT_RECALL_SUBJECT_MISMATCH
```

该复现证明真实 derive 函数产生的 task identity 与真实 recall 入口不兼容；不是完整模型会话复现，也没有调用真实 DWS 服务。DWS 断路为静态组合逻辑证明。群指令缺失为真实调用链缺字段证明，未测模型漏抄概率。

---

# 身份、配置与界面专项

# 钉钉员工身份、配置与工作区审计

审计时间：2026-09-08；工作区：`/Users/admin/code/agent-saas`。仅静态代码审计与现有 UI 测试，未查询生产数据、未实际发钉钉消息、未修改仓库。未发现当前仓库及父级适用 AGENTS.md。轻量 memory 搜索未命中相关实现，不使用历史记忆作为结论依据。已保留原有 untracked `docs/reviews/` 文件。

## 核心判断

当前不是“没有独立员工基础”，而是**组织专家定义、Agent 专属钉钉身份、共享群任务体系、旧的人类请求者会话体系共存，且没有统一的员工配置与生命周期合同**。群聊激活路径已有 Agent principal、独立目录、工具收窄、任务隔离等实质实现；私聊、shadow 群仍走另一套模型。这足以解释“能用一些功能，但配置别扭、改了不一定完整生效、像半成品”的体验。建议保留已有持久化与权限基础，收敛主体/配置/会话模型，不重写整套接入。

## 已实现与边界

1. **组织独立拥有 Agent 及专属钉钉账号关联已实现。** `AgentDwsAccountRecord` 以 `tenantId + agentId` 归属，没有 ownerUserId；createdBy/updatedBy 是审计字段（`server/src/data/agentDwsAccounts/types.ts:40-65`）。账号创建依赖组织 managed Agent（`store.ts:102-125`）。OAuth 要求精确 `corpId:userId`，不是任意组织 selector（`types.ts:77-92`）。UI 明确这里只关联事先准备的真实专属钉钉成员，不自动创建通讯录账号（`web/src/components/AgentDwsAccounts/index.tsx:539-543,741-743`）。因此“独立钉钉账号”已有接入，自动开户尚未实现。
2. **Agent 模型目录和连接器凭据目录已与人类隔离。** 物理逻辑目录分别是 `<globalAgentCwd>/<tenant>/.agent-<agentId>` 与 `.agent-connectors-<agentId>/dws`（`server/src/workspace/resolver.ts:75-105`）；稳定 workspace ID 是 `ws_<tenant>__agent_<agentId>`（`runtime/workspaceIdentity.ts:33-44`）。群任务另有 `shared/<binding>/<workConversation>` 和 `work/<task>/attempt-N`（`runtime/orgAgentTaskWorkspace.ts:20-34,46-75`）。这些是 NAS/PVC 子目录挂载基础，**本次没有验证生产实际 NAS 挂载、备份、配额、快照或灾备**。
3. **已激活共享群拥有独立主体和工作会话。** dispatch 将人类保留为 `user/externalActor`，sessionOwner 用服务身份，明确携带 `AgentPrincipal` 与 ChannelPrincipal（`dws/personalMessageRouter.ts:858-896`）；workspacePrincipal 也对共享群选择 sessionOwner（`agent/workspacePrincipal.ts:3-14`）。这不是借 @ 者身份执行。
4. **全局配置相当丰富。** OrgAgent 有指令、固有技能、知识、audience、guardrail、runtime（`data/orgAgents/types.ts:95-134`）；runtime 支持前台/Worker 模型、直接执行/dispatcher、记忆范围、工具/MCP/系统能力、执行环境、轮次等（`data/orgAgents/runtimePolicy.ts:35-97`）。UI 已通过治理版本 preview + publish 保存（`web/src/components/OrgAgentManager/hooks.ts:174-208`），不能简单说“全局配置没做”。
5. **群级配置已做，但只有收窄快照，未成为完整继承系统。** binding.effectiveConfig 有显示名、群指令、知识源、技能/工具/DWS 资源、记忆读取、角色及发言字段（`data/orgGroupAgents/types.ts:50-95`）。新增 binding 默认技能/工具/知识源全空（`:511-518`），保存仅合并少数兼容缺省字段（`routes/agentDwsGroupWorkspaceSchemas.ts:139-151`），没有“跟随全局/覆盖/恢复继承”的语义。
6. **权限检查有实质实现。** 群能力只能收窄发布能力、须满足账号 Context 授权、须 dispatcher 与 Runtime Worker v2（`routes/agentDwsAccounts.ts:302-327`）；每次工具调用再检查活动 binding，DWS 写操作走持久审批（`runtime/toolPolicy.ts:35-76`）。目前共享群 DWS 资源只准 `doc:<nodeId>`（`routes/agentDwsGroupWorkspaceSchemas.ts:154-173`），尚不是人类 DWS 全业务能力。

## 确定性问题与可验证缺口

### A. 私聊仍以人类请求者为主体；群与私聊未统一

`orgAgentSharedGroupContext.ts:50-51` 仅处理 `user_im_message_receive_at`，私聊返回 legacy。随后 binding 按 `account + conversation + requesterUserId` 建立（`personalMessageRouter.ts:575-585`；`data/agentDwsMessages/store.ts:362-372`），dispatch `sessionOwner=requester`（`:898`），runtime requested principal 因没有 orgAgentChannel 成为 user（`rawRuntimeRunDispatch.ts:830-839`）。但 cwd 已是 Agent 根目录（`personalMessageRouter.ts:819-830`），workspace ID 又可由 orgAgentId 派生成 Agent workspace（`runtime/runtimeSessionIdentity.ts:11-15`）。

结论：私聊已有独立 session，但“独立 session”不等于“全链路 Agent 主体”。用量归属、审计主体、文件作用域、访问控制仍有混合语义。**不能据此直接声称已泄漏私人凭据**：raw runtime 对 orgAgent 明确剥离个人 connector identity（`rawRuntimeRunDispatch.ts:881-898`），也跳过个人 persona（`:976-979`）。风险是主体一致性未证明，必须用跨群/跨私聊隔离验收覆盖。

工作台的数据资源视图只遍历 group（`routes/agentDwsGroupWorkspaceView.ts:24-30,49-64`），发现与创建 binding 也硬编码 group（`routes/agentDwsAccountDiscovery.ts:27-31,75-89`）。因此不能在现界面完整管理某一私聊的指令、工具、记忆及运行行为。

### B. “保存成功”和“实际执行一致”存在至少三类明确断点

- **群指令静默截断**：API 接受 20,000 字（`agentDwsGroupWorkspaceSchemas.ts:33-35`），实际提示语只注入前 8,000（`personalMessageRouterHelpers.ts:50-53`）；UI 输入框无对应限制（`GroupAgentWorkspacePanel.tsx:604-610`）。后半段规则保存成功但模型永远看不到。
- **群指令未确定性传给 Worker**：群指令仅注入前台 systemContext；后台重建 channelContext 仅保留 orgAgentChannel，没有群指令文本（`background/backgroundTaskService.ts:549-556`），子 Agent system instructions 只接 `parentSession.orgAgentSnapshot.instructions`（`subagent/subagentRunner.ts:500-510,935-942`），任务 prompt 来自前台提出的 request.prompt（`backgroundTaskService.ts:578-581`）。工单 policySnapshot 虽存 effectiveConfig（`background/orgAgentBackgroundWork.ts:111-119`），不等于把它作为执行指令注入。结论是群规则目前依赖前台主动转述，缺乏确定性继承，而不是所有 Worker 每次必然违反群规则。
- **长会话内配置更新会出现前后台不同版本**：首次 session snapshot 同时固定 instructions、skills、knowledge、runtime（`sessionCatalog.ts:32-52`），存在已有 session 就复用旧 snapshot（`orgAgentSessionResolution.ts:44-46`）；下一条普通前台消息仍读当前发布 OrgAgent 并合并 runtime、筛当前技能（`rawRuntimeRunDispatch.ts:914-922,1221-1229`），新派 Worker 却读原 session snapshot 的 workerModel、runtime、技能（`backgroundTaskService.ts:137-156,528-536`）。所以管理员更新模型/指令/技能后，同一长会话中新派出的 Worker 可能仍用旧版。固定进行中的任务快照是合理的，但固定整个长期对话中的所有未来任务不是同一个产品合同。
- **仅作为知识挂载的技能在群配置中丢失**：常规专家运行时将 allowedSkills 与 allowedKnowledge 合并（`data/orgAgents/runtimePolicy.ts:337-341`）；群目录将两者分别返回（`agentDwsGroupWorkspaceView.ts:72-75`），UI 只取 skillIds（`GroupAgentWorkspacePanel.tsx:525`），激活也仅准 agent.allowedSkills（`agentDwsAccounts.ts:312-314`）。只挂在 allowedKnowledge 的能力不能在群启用，形成“专家已有知识，群里不可用”的配置落差。

### C. 新群接入与账号换绑没有完整生命周期

- 无 binding 的群被拒绝（`orgAgentSharedGroupContext.ts:53-54`），新建 shadow 后返回 legacy（`:60`），而默认 enabled=false 并不在 shadow 分支阻止旧执行。这是有意兼容机制，UI 也写“未激活保持旧路由”（`GroupAgentWorkspacePanel.tsx:287-289`），但与“发现 → 安全配置 → 激活独立员工”的直觉不一致，应显式迁移状态，不能把旧路径隐含在未激活状态中。
- 账号身份改变后旧 binding 不允许认领（`bindingIdentityStore.ts:52-73,93-108`），这是正确防串身份措施；然而界面/API 提示为当前身份新建账号配置（`agentDwsAccounts.ts:222-224`），数据库又唯一约束 `(tenant_id,agent_id)`（`governance-schema/agentDwsMigrations.ts:49`）。现账号 store 仅提供整租户 delete，没有单员工渠道账号替换/归档操作（`data/agentDwsAccounts/store.ts:18-47`）。同一员工原地更换钉钉身份后的恢复指导无法闭环；只能回原身份或额外工程处理，不能要求用户复制整个员工丢失连续身份。
- 目前群需要先收到一次 @ 才能发现（`AgentDwsAccountDiscovery.ts:27-31`，UI `GroupAgentWorkspacePanel.tsx:331,370`），无法默认“加进任意群即按全局配置开始工作”。主动发言还被 API 硬拒绝（`agentDwsAccounts.ts:273-275`），UI 保存强写 `proactive:false,requireMention:true`（`GroupAgentWorkspacePanel.tsx:573-574`）。这不是单靠改提示语解决的事情。

### D. 管理界面面向实现部件，缺少员工视图

专家详情是近千行长弹窗，末部嵌套账号授权区（`OrgAgentFormDialog.tsx:448-457,919-924`）；独立钉钉账号页面另有 Context 范围、群工作台（`AgentDwsAccounts/index.tsx:682-685,727-735`）。组织导航也把企业专家与钉钉账号分为不同节点（`OrganizationManagementContent.tsx:88-97`）。用户必须理解专家发布、账号授权、Context 采集、群 binding、工具上限、群激活等多个概念。

Context 要人工填 conversationId（`ContextPolicyDialog.tsx:339-362`），群以原始 ID 标題展示、DWS 资源人工填 doc:nodeId（`GroupAgentWorkspacePanel.tsx:590,650-662`），生效配置主要是 JSON dump（`:762-775`）。已有可配置项很多，但没有明确解释“员工全局规则是什么、当前群覆盖什么、最终何时生效、为什么不可用”。普通文件接口依赖登录人 resolveUserCwd（`server/src/routes/file.ts:185-228`）；本次未发现完整员工文件中心，不能把底层已有独立目录等同于管理员能像管理人类用户那样浏览、编辑、恢复员工 workspace。

## 建议目标模型

**稳定员工主体**：保留现 managed Agent/OrgAgent 主键，统一 `Principal(kind=org_agent, tenantId, agentId)`。人类 requester、创建者、管理员是独立 actor，不能再成为员工 session owner。不要为了兼容功能创建假人类账号并赋一堆隐式权限；将凭据、计划、文件、用量、记忆和任务服务逐项改成接受 principal。

**渠道连接**：`AgentChannelAccount(accountId,agentId,provider,externalTenantId,externalUserId,identityEpoch,credentialRef,status,capabilities)`；凭据独立密钥/目录。保留旧身份 epoch 与历史事件的绑定，换绑是显式可审计操作。同平台一个当前主账号可约束，但需要支持归档连接及后续飞书/企微连接，不能让唯一约束阻断恢复。

**统一会话**：`ConversationBinding(bindingId,agentId,channelAccountId,providerConversationId,kind,peerId,identityEpoch,status,overrideRevision)` 同时覆盖群和私聊；默认存在一个持续主会话，复杂任务再派生 workConversation/workOrder。不同群和私聊严格隔离临时上下文/文件/会话记忆；共享员工知识和全局记忆必须经显式作用域规则注入。

**统一配置编译器**：组织授权上限 → 员工发布默认值 → 渠道能力上限 → 会话覆盖 → 本次任务快照。每个字段区分 inherit/override/disabled；指令采用“全局规则 + 会话补充”，不允许会话删掉全局安全边界；工具/知识/资源授权取交集。给每次运行产出 `effectiveConfigDigest + sourceRevision + fieldProvenance + unavailableReasons`，前台和 Worker 都从同一结果导出各自角色提示语。**发布更新作用于下一次新 run/新 task；已执行任务保持旧快照；紧急撤权立即生效**。后台 UI 明示新版本影响哪些会话/任务，支持回滚。

**员工工作区**：沿用 `.agent-<id>`，补 principal manifest、文件目录、配置 materialization、备份/配额/恢复/导出；全局共享资料与各会话目录分开，Worker 只挂任务工作目录及当前授权只读资料，不挂整员工 root。连接器凭据继续隔离。必须验证“多群并发写不同目录、重启后文件/设定/记忆保留、员工管理员变更不改变目录、旧人类离职不影响员工运行”。

**统一员工详情**：员工列表展示姓名/岗位/在线状态/渠道健康/待处理任务；详情固定入口为概览、职责与默认行为、知识和能力、账号、参与的会话、文件、记忆、任务与计划、运行诊断。点某个群或私聊进入同结构配置，显示“继承：全局简洁回答；本会话追加：只处理报价”等差异，并提供恢复继承。上线向导按“选择专属账号 → 身份校验 → 默认能力 → 会话与主动策略 → 试运行 → 启用”走；技术 ID、JSON、lease/fence 只放诊断展开区。资源选择器优先名称/搜索/权限提示，无法枚举时仍允许高级 ID 入口但不能作为默认用户流程。

## 迁移与优先级

P0：修复 20k/8k 截断；把会话指令编入 Worker 系统契约；统一新任务配置版本；修复知识技能集合；完成原地渠道身份换绑合同；整理 shadow 状态避免默认落旧主体；补“配置保存但尚未全部同步”的准确状态。

P1：把私聊迁入 AgentPrincipal 与统一 binding，迁移时保留原 session 对照表/消息审计，不把多个用户私聊合并；为存量群建立明确 legacy/observe/active/paused 状态，按群灰度。上线员工文件入口和统一配置继承视图。

P2：统一钉钉会话发现、默认加入策略、主动会话配置；资源授权从文档扩到业务模块；纳入员工计划/记忆任务/跨渠道 adapter。主动发言能力的 provider 技术限制须由外部平台研究确认，不应在 UI 制造不可执行开关。

P3：备份恢复、员工转交/离职归档、换渠道账号/跨版本回滚、管理员批量配置、成本与质量运营。NAS、DB 配置、凭据都需要独立可恢复，但不能把凭据备份明文放入模型可读 workspace。

验收最少包括：A/B 群及 A/B 私聊互不串上下文；身份/文件归属始终 agentId；重启和管理员离职不丢设置；群特殊规则确定性到达子 Agent；修改全局 Worker 模型后旧群新任务实际用新版；仅挂载知识技能也可按授权在群调用；换绑身份保留旧审计且不认领旧私聊；发布/群配置预览结果与真实运行的 config digest 一致。

## 本次验证

执行 `PATH=/Users/admin/.nvm/versions/node/v22.23.1/bin:$PATH NODE_ENV=test pnpm exec vitest run src/components/AgentDwsAccounts/GroupAgentWorkspacePanel.test.tsx src/components/AgentDwsAccounts/index.test.tsx src/components/OrgAgentManager/OrgAgentManager.test.tsx --maxWorkers=2`（cwd=web）。

结果：3 文件、44 测试通过，2.61 秒；GroupAgentWorkspacePanel 13、OrgAgentManager 28、账号 index 3。OrgAgentManager 既有测试输出 React act warning，但无失败。这些是 mock API 的组件测试，验证已有 UI 合同，不证明私聊主体、配置版本传递、真实 OAuth、实际 NAS 或钉钉端到端可靠性。现测试通过与上述跨层设计断点可以同时成立。
