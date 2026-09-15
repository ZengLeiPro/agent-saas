# KY Agent 外部调用与客户数据库只读查询方案

> 状态：待评审、待实施
>
> 版本：V2（个人 Agent MVP）
>
> 创建日期：2026-09-15
>
> 交付边界：本文只定义产品与技术方案，不包含 Workflow、部署、生产配置或数据迁移变更

---

## 一、结论

第一阶段不依赖组织 Agent，采用更简单的方案：

```text
一个客户组织
→ 一个或多个专用外部调用账号
→ 每个账号使用自己的个人 Agent
→ 外部 API Key 固定映射到账号
→ 无界面 WebSocket 客户端复用现有 Agent Runtime
→ 外部只接收最终结果
→ 平台后台保留完整会话、执行过程与计费
```

当 Agent 需要查询客户数据库时，第一阶段不要求专门制作 Skill，但必须提供模型之外的受控只读数据库查询工具：

```text
个人 Agent
→ 通用只读数据库查询 Tool
→ 服务端根据 connection_id 取得密钥
→ 客户数据库
```

数据库账号、密码、连接字符串不得写入用户提示语，也不得进入模型上下文、会话记录、个人记忆或 Sandbox。客户只在受保护的连接管理接口登记一次数据库连接，后续会话只引用不敏感的 `connection_id`。

一句话定义：

> API Key 决定使用哪个客户专用账号及个人 Agent；`conversation_id` 承载多轮上下文；`connection_id` 决定可访问哪一个受控只读数据源；模型只能提出查询，不能接触数据库凭据或决定业务授权。

---

## 二、为什么改用个人 Agent

当前组织 Agent 的创建、版本发布、访问范围和运行时投影链路尚未完全稳定。如果把外部 API 建立在组织 Agent 上，会同时引入以下前置依赖：

- 组织 Agent 创建必须成功；
- Agent ID 必须可发现；
- Agent 版本必须发布；
- Assignment 必须保存；
- 运行时投影必须完成；
- 外部服务身份必须被纳入组织 Agent 访问范围。

专用账号的个人 Agent 已经天然具备用户工作区、会话、工具、技能、记忆和模型配置，可以先验证外部系统是否真正需要完整 Agent 能力。

采用个人 Agent 后：

- MVP 不需要创建组织 Agent；
- 外部调用不需要传 `agent_id`；
- API Key 创建时就固定绑定专用账号；
- 每条消息仍然可以触发完整的多轮推理、工具调用和子任务；
- 同一个外部会话可以连续交流，不退化为单次模型调用；
- 将来切换到组织 Agent 时，外部会话 API 可以保持兼容。

该方案是 MVP 的运行目标选择，不代表废弃组织 Agent。组织 Agent 后续仍适合多 Agent 目录、版本治理、统一指派和复杂权限场景。

---

## 三、账号与组织模型

### 3.1 客户组织

- 已经有平台组织的客户：复用现有组织。
- 尚无平台组织的客户：为其创建独立正式组织。
- 禁止所有外部客户共用一个“外部调用组织”。
- 会话、文件、记忆、连接、用量和费用都归属客户组织。

### 3.2 专用外部调用账号

专用账号是非人员账号，只用于一个客户或一个明确的业务集成：

```text
客户 A
├─ ERP 外部调用账号
└─ 客服系统外部调用账号

客户 B
└─ 数据分析外部调用账号
```

隔离原则：

- 不复用员工真实账号；
- 不跨客户共享账号；
- 不把账号密码、Cookie 或 refresh token 交给外部系统；
- 不同数据权限、费用中心或记忆边界使用不同账号；
- 每个账号使用独立用户工作区；
- 账号停用后，其 API Key 同步失效；
- 管理员可以配置该账号的个人 Agent，但不能读取数据库明文密码。

### 3.3 API Client 与 API Key

外部系统拿到的不是 Web 登录凭据，而是专用 API Key：

```text
API Key
→ api_client_id
→ tenant_id
→ service_account_user_id
→ 该账号的个人 Agent
→ allowed_connection_ids
```

建议保存字段：

| 字段                      | 说明                       |
| ------------------------- | -------------------------- |
| `api_client_id`           | 外部集成身份               |
| `tenant_id`               | 固定所属组织               |
| `service_account_user_id` | 固定个人 Agent 所有者      |
| `key_hash`                | API Key 哈希，不保存明文   |
| `key_prefix`              | 后台识别用前缀             |
| `scopes`                  | 会话、结果、连接等权限     |
| `allowed_connection_ids`  | 允许使用的数据连接         |
| `status`                  | active / revoked / expired |
| `expires_at`              | 可选过期时间               |
| `last_used_at`            | 最近使用时间               |

API Key 明文只在创建时展示一次，并支持轮换和撤销。

---

## 四、个人 Agent 的提示词与能力

### 4.1 系统提示词

专用账号调用时使用该账号的个人 Agent，组合内容为：

```text
平台基础规则
+ main Agent Runtime Profile
+ 客户组织资料
+ 客户组织“智能体规则”
+ 专用账号“我的 Agent”中的个人提示词
+ 当前会话上下文
+ 该账号允许加载的个人记忆
```

外部请求不能传入或覆盖 `system_prompt`。管理员通过“我的 Agent”和组织设置管理提示词。

### 4.2 是否必须制作 Skill

第一阶段不必须制作 Skill。

只要个人 Agent 可以看到一个描述清晰的只读数据库查询 Tool，就能根据用户问题生成查询并调用工具。Tool 描述需要说明：

- 支持的数据源类型；
- 可以访问的 schema 和表；
- 输入字段和限制；
- 查询结果格式；
- 超时、行数和敏感字段规则。

Skill 适合后续补充：

- 客户业务术语和指标口径；
- 固定分析步骤；
- 多表关联规范；
- 常见问题模板；
- 查询后如何生成报告；
- 特定行业的判断规则。

因此，第一阶段的安全边界在 Tool，不在 Skill。Skill 只是提高业务准确性，不承担数据库认证和授权。

---

## 五、数据库连接方案

### 5.1 禁止把密码放进提示语

以下请求不允许：

```json
{
  "message": "数据库地址是 db.example.com，账号 readonly，密码 xxx，请查询销售数据"
}
```

原因包括：

- 用户输入会进入会话 transcript；
- 可能进入请求日志、错误日志和管理后台；
- 会发送到模型提供方；
- 可能被长期记忆或摘要再次保存；
- 可能出现在 Shell 命令和工具调用记录中；
- 提示词注入可以诱导模型泄漏凭据；
- 只读账号仍可能泄漏全部可读数据或拖垮数据库。

如果历史会话中已经发送过真实数据库密码，应按凭据泄漏处理并立即轮换。

### 5.2 连接登记

客户管理员通过受保护接口或管理后台登记数据库连接：

```http
POST /v1/database-connections
Authorization: Bearer <management-credential>
Content-Type: application/json
```

```json
{
  "name": "生产订单只读库",
  "engine": "postgresql",
  "host": "db.customer.internal",
  "port": 5432,
  "database": "orders",
  "username": "agent_reader",
  "password": "仅本次提交",
  "ssl_mode": "verify-full",
  "allowed_schemas": ["reporting"],
  "allowed_tables": ["reporting.orders", "reporting.customers"]
}
```

服务端必须：

1. 禁止记录请求正文和密码。
2. 使用 TLS 接收请求。
3. 将凭据加密保存到独立 Credential Store。
4. 验证连接与只读权限。
5. 返回不敏感的 `connection_id`。
6. 将连接绑定到固定租户和允许的 API Client。
7. 支持测试、轮换、停用和删除。

响应：

```json
{
  "id": "dbc_01K...",
  "name": "生产订单只读库",
  "status": "ready",
  "engine": "postgresql"
}
```

### 5.3 客户数据库不可公网访问时

不要求客户把数据库开放到公网。推荐在客户网络内部署查询网关：

```text
KY Agent 只读查询 Tool
→ 双向认证的客户查询网关
→ 客户内网数据库
```

数据库凭据保留在客户环境，平台只保存网关连接身份。查询网关必须执行相同的租户绑定、只读限制、SQL 校验、超时、结果裁剪和审计。

---

## 六、只读数据库查询 Tool

### 6.1 Tool 契约

MVP 可以提供一个通用工具：

```ts
database_query_readonly({
  connectionId: string,
  sql: string,
  parameters?: unknown[],
  maxRows?: number
})
```

但 `connectionId` 不能由模型自由选择。运行时应根据当前 API Client 和会话上下文解析允许的连接，并拒绝任何未授权连接。

返回示例：

```json
{
  "columns": ["customer_name", "total_amount"],
  "rows": [
    ["客户甲", 125000],
    ["客户乙", 98000]
  ],
  "row_count": 2,
  "truncated": false,
  "duration_ms": 43
}
```

### 6.2 只读必须多层实施

不能只判断 SQL 是否以 `SELECT` 开头。至少同时实施：

1. 数据库使用专用只读角色，只授予必要 schema、view 和 table。
2. 优先连接只读副本或报表库，不直接访问生产主库。
3. 每次查询开启数据库原生只读事务。
4. 使用 SQL AST 解析器拒绝写操作、多语句、危险函数和绕过语法。
5. 只允许配置中的 schema、view、table 和字段。
6. 强制 `statement_timeout`、连接超时和最大并发。
7. 强制最大行数、最大结果字节数和分页。
8. 禁止文件、网络、扩展、系统命令和管理函数。
9. 对手机号、证件号、银行卡等字段进行脱敏或直接禁止返回。
10. 记录查询摘要、耗时、行数和关联 ID，但不记录凭据。

### 6.3 权限来源

权限判断必须来自可信服务端上下文：

```text
API Key 解析出的 tenant_id
+ service_account_user_id
+ allowed_connection_ids
+ 数据连接自己的 schema/table allowlist
= 本次查询的最大权限
```

用户提示语、模型生成 SQL、Header 或 query string 都不能覆盖这些权限。

### 6.4 查询结果与记忆

- 查询结果可以进入当前执行上下文和会话 transcript。
- 默认禁止原始数据库行进入长期个人记忆。
- 长期记忆只允许保存经过脱敏的结论或用户明确确认的摘要。
- 会话导出和后台查看继续受组织权限控制。
- 客户可以配置会话及查询结果保留时间。

---

## 七、外部会话 API

### 7.1 调用目标

MVP 中 API Key 已经固定绑定个人 Agent，因此不要求 `agent_id`：

```text
Authorization: Bearer <API_KEY>
→ 找到客户组织
→ 找到专用账号
→ 使用该账号的 personal agentTarget
```

服务端内部生成：

```json
{
  "kind": "personal",
  "tenantId": "由 API Key 解析"
}
```

### 7.2 创建会话

```http
POST /v1/conversations
Authorization: Bearer <API_KEY>
Idempotency-Key: <unique-key>
```

```json
{
  "external_conversation_id": "customer-analysis-001",
  "database_connection_id": "dbc_01K...",
  "metadata": {
    "business_id": "SO-10086"
  }
}
```

返回：

```json
{
  "id": "conv_01K...",
  "external_conversation_id": "customer-analysis-001",
  "status": "active",
  "database_connection": {
    "id": "dbc_01K...",
    "name": "生产订单只读库"
  }
}
```

### 7.3 发送消息

```http
POST /v1/conversations/{conversation_id}/messages
Authorization: Bearer <API_KEY>
Idempotency-Key: <unique-key>
Content-Type: application/json
```

```json
{
  "message": "查询今年销售额最高的十个客户，并分析增长原因。",
  "model": "inherit",
  "reasoning": {
    "enabled": true,
    "effort": "high"
  },
  "response_mode": "final",
  "wait_timeout_ms": 120000
}
```

参数说明：

| 字段                | 说明                                 |
| ------------------- | ------------------------------------ |
| `message`           | 本轮用户输入                         |
| `model`             | `inherit` 或账号有权使用的模型       |
| `reasoning.enabled` | 是否允许使用推理能力                 |
| `reasoning.effort`  | low / medium / high 等支持档位       |
| `response_mode`     | MVP 固定为 `final`                   |
| `wait_timeout_ms`   | HTTP 等待时间，不是 Agent 总执行时间 |

在等待时间内完成时返回 `200`：

```json
{
  "conversation_id": "conv_01K...",
  "execution_id": "exec_01K...",
  "status": "completed",
  "output": {
    "text": "今年销售额最高的十个客户为……"
  },
  "usage": {
    "effective_model": "model-id",
    "reasoning_effort": "high"
  }
}
```

超过 HTTP 等待时间时返回 `202`，Agent 继续执行：

```json
{
  "conversation_id": "conv_01K...",
  "execution_id": "exec_01K...",
  "status": "running",
  "result_url": "/v1/executions/exec_01K..."
}
```

### 7.4 查询最终结果

```http
GET /v1/executions/{execution_id}
Authorization: Bearer <API_KEY>
```

只向外部返回执行状态、最终输出、受控错误和计量摘要，不返回：

- chain-of-thought；
- 数据库凭据；
- 内部系统提示词；
- 工具内部参数中的敏感内容；
- 服务器或 Sandbox 路径。

### 7.5 多轮会话

后续问题继续调用同一个 `conversation_id`：

```json
{
  "message": "只看华东地区，再与去年同期比较。",
  "model": "inherit",
  "reasoning": {
    "enabled": true,
    "effort": "medium"
  },
  "response_mode": "final"
}
```

服务端恢复同一个内部 session，保留前文和之前的查询结论。每条消息内部仍可进行多轮模型推理和多次工具调用。

---

## 八、无界面 WebSocket 适配器

公共 HTTP API 不重新实现 Agent Runtime，而是通过内部无界面客户端复用现有 WebSocket 协议。

适配器负责：

1. 将 API Key 解析为专用账号身份。
2. 创建或恢复该账号的内部 session。
3. 将外部 conversation 映射到固定 session。
4. 生成 personal `agentTarget`。
5. 提交消息、模型、reasoning、附件等参数。
6. 消费模型、工具和终态事件。
7. 识别真正执行终态并提取最终 assistant 输出。
8. HTTP 断开后保持内部执行继续运行。
9. 重连后从 durable session/run 状态恢复。
10. 用幂等键避免重复执行查询或其他副作用。

WebSocket 只是内部实现细节，不对外成为公共协议。

---

## 九、后台会话、审计与计费

### 9.1 后台必须可见

平台管理员和对应组织管理员应能看到：

- 客户组织和专用账号；
- API Client 和 API Key 前缀；
- 外部 conversation ID 与内部 session ID；
- 用户输入、最终输出和完整执行事件；
- 模型调用、工具调用、SQL 查询摘要、耗时和错误；
- database connection 名称，不显示密码；
- execution、run、toolCall、invocation 等关联 ID；
- Token、数据库查询、工具和 Sandbox 用量；
- 费用归属和计费明细。

外部只返回最终结果不等于内部不记录过程。外部输出是裁剪视图，后台使用完整持久事件。

### 9.2 会话标签

每个外部会话至少记录：

```text
source = external_api
tenant_id
api_client_id
service_account_user_id
external_conversation_id
database_connection_id
session_id
```

每次执行至少记录：

```text
execution_id
run_id
requested_model
effective_model
reasoning_effort
idempotency_key
usage
cost
status
```

### 9.3 计费

费用归属客户组织，并可按 API Client 和专用账号拆分。至少统计：

- 输入、输出、缓存和推理 Token；
- 实际生效模型；
- 数据库查询次数、耗时和返回数据量；
- 工具、MCP、浏览器和 Sandbox 用量；
- 多模态用量；
- 成功、失败、恢复和取消状态；
- 定价版本、成本和对客户计费金额。

数据库查询失败不应隐藏已经产生的模型或工具成本；幂等命中不得重复计费。

---

## 十、错误与安全策略

| 场景                     | 行为                                        |
| ------------------------ | ------------------------------------------- |
| API Key 无效、过期或撤销 | `401`                                       |
| 专用账号停用             | `403 account_disabled`                      |
| 组织未开放个人 Agent     | `409 personal_agent_unavailable`            |
| 数据库连接未授权         | `404`，防止枚举                             |
| 数据库连接不可用         | `409 database_connection_unavailable`       |
| SQL 不符合只读策略       | 工具拒绝，允许 Agent 改写一次或返回受控失败 |
| 查询超时或结果过大       | 截断或失败，不继续消耗数据库资源            |
| HTTP 等待超时            | `202`，内部继续运行                         |
| 相同幂等键、相同请求     | 返回原 conversation/execution               |
| 相同幂等键、不同请求     | `409 idempotency_conflict`                  |
| WebSocket 临时断开       | 按 durable 状态恢复                         |
| API Key 撤销             | 阻止新请求，运行中任务按明确策略处理        |

任何错误都不能回显密码、完整连接串、内部 SQL 校验细节、系统提示词或其他租户信息。

---

## 十一、实施阶段

### P0：专用账号与调用身份

- 支持创建非人员专用账号。
- 为账号配置个人 Agent 和独立工作区。
- 创建 API Client 与 API Key。
- 将 API Key 固定映射到 tenant 和账号。
- 增加会话来源、外部业务 ID 和 API Client 元数据。
- 确认组织的个人 Agent 功能已开启。

退出条件：不使用 Web 登录凭据，API Key 可以安全解析到唯一客户组织和个人 Agent。

### P1：多轮外部 Agent API

- 实现 conversation 创建与恢复。
- 实现消息提交与 execution 查询。
- 实现无界面 WebSocket 适配器。
- 支持 model、reasoning、effort、等待超时和幂等。
- 外部默认只返回最终输出。
- 后台保留完整执行过程。

退出条件：同一 conversation 连续交流两轮，其中至少一轮触发多步 Agent 执行，外部获得最终结果，后台能完整回放。

### P2：客户数据库只读查询

- 实现数据库连接登记、加密存储、测试、轮换和撤销。
- 实现租户与 API Client 的连接授权。
- 实现通用只读数据库 Tool。
- 增加只读角色、AST 校验、allowlist、超时、行数和结果大小限制。
- 对查询结果实施脱敏和长期记忆限制。
- 支持客户内网查询网关。

退出条件：模型上下文、会话、日志和 Sandbox 中均不存在数据库密码；真实只读查询成功；越权、写入、大查询和跨租户访问均被拒绝。

### P3：运营与计费

- 增加 API Key 创建、轮换和撤销界面。
- 增加外部会话和完整过程查询。
- 增加数据库连接状态与查询审计。
- 增加调用配额、并发、速率限制和预算告警。
- 按组织、API Client、账号、模型和连接统计费用。

### P4：组织 Agent 扩展

组织 Agent 创建链路稳定后，再增加可选 `agent_id`：

```json
{
  "agent_id": "org-...",
  "message": "……"
}
```

未传 `agent_id` 时继续使用 API Key 绑定的个人 Agent，保持 MVP 客户兼容。

---

## 十二、验收清单

### 12.1 身份与会话

1. 每个 API Key 只能访问固定客户组织和专用账号。
2. 不同客户账号的 workspace、会话、记忆和文件完全隔离。
3. 同一 conversation 的第二轮能够引用第一轮结论。
4. HTTP 超时后仍能通过 execution 查询最终结果。
5. 网络重试不会创建重复会话或重复执行。
6. 停用账号或撤销 API Key 后新请求立即失败。

### 12.2 数据库安全

1. 数据库密码只在登记入口出现一次且不进入日志。
2. 模型输入、会话 transcript、记忆和工具结果中不存在密码。
3. 写入语句、多语句和危险函数均被拒绝。
4. 查询只能访问已授权 schema、table 和字段。
5. 超时、最大行数、最大字节数和并发限制生效。
6. 跨租户 connection ID 无法枚举或使用。
7. 敏感字段按策略脱敏。
8. 数据库凭据轮换后无需修改会话和提示词。

### 12.3 后台与计费

1. 可通过外部 conversation ID 定位内部 session 和 execution。
2. 后台可以查看完整 Agent 执行过程和查询审计。
3. 外部只能看到最终输出和受控状态。
4. 实际模型、Token、工具和查询用量可以对账。
5. 费用能够归属客户组织并按 API Client 拆分。

### 12.4 端到端证据

最终验收至少保留：

- 外部 HTTP 请求和最终响应；
- 两轮以上 conversation 上下文延续证据；
- 内部 session、execution、run 和 toolCall readback；
- 数据库查询审计及写操作拒绝证据；
- 后台完整过程和计费 readback；
- 跨租户、撤权、超时恢复和幂等测试结果。

CI、单元测试、健康检查或 WebSocket 建连成功均不能单独替代真实业务验收。

---

## 十三、建议代码落点

| 能力                    | 建议位置                                           |
| ----------------------- | -------------------------------------------------- |
| 公共外部 API            | `server/src/routes/externalAgentApi.ts`            |
| API Client 与 Key       | `server/src/data/externalClients/`                 |
| 外部会话映射            | `server/src/data/externalConversations/`           |
| 无界面 WebSocket 客户端 | `server/src/externalAgent/headlessWebClient.ts`    |
| 最终结果聚合            | `server/src/externalAgent/finalOutputCollector.ts` |
| 数据库连接与凭据        | `server/src/data/databaseConnections/`             |
| 只读查询策略            | `server/src/databaseQuery/readOnlyPolicy.ts`       |
| 只读查询 Tool           | `server/src/agent/tools/DatabaseQueryReadonly.ts`  |
| 管理后台                | `web/src/components/ExternalAgentAccess/`          |
| 共享 API 类型           | `shared/src/types/externalAgent.ts`                |

具体文件名可在实施时根据现有模块边界调整，但必须保持公共 API、身份映射、凭据存储、数据库执行和 Agent Runtime 的职责分离。

---

## 十四、MVP 最终形态

```text
客户管理员
├─ 创建客户专用调用账号
├─ 配置该账号的“我的 Agent”
├─ 创建 API Key
└─ 登记只读数据库连接，取得 connection_id

外部业务系统
├─ 用 API Key 创建 conversation
├─ 可选绑定 connection_id
├─ 连续发送多轮自然语言消息
└─ 只接收最终结果

KY Agent 平台
├─ 以专用账号的个人 Agent 执行
├─ 通过无界面 WebSocket 复用完整 Agent Runtime
├─ 由受控 Tool 查询数据库，模型不接触凭据
├─ 持久化完整会话与执行过程
└─ 按客户组织和 API Client 计量计费
```

该 MVP 不依赖组织 Agent、不要求 Agent ID、不强制制作 Skill，也不把数据库密码放进提示语；同时保留未来升级到组织 Agent、业务 Skill 和更多受控数据能力的兼容空间。
