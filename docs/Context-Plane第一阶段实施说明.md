# Context Plane 第一阶段实施说明

## 目标

将钉钉聊天、文档与听记作为独立于个人 Markdown 记忆的业务上下文持续同步到 Agent-SaaS，并提供可鉴权、可溯源、可撤权的检索闭环。

本阶段坚持：

- DWS 事件只负责唤醒，权威正文由 DWS 回源读取；
- Context Plane 与 `MEMORY.md` 分离；
- tenant/user/Agent scope 由服务端计算，模型不能指定身份；
- `org_knowledge` 使用现有 Assignment，deny-overrides-allow；
- PostgreSQL 起步，不引入图数据库或向量数据库。

## 数据层

Governance migration v24 创建：

- `context_sources`
- `context_collections`
- `context_sync_partitions`
- `context_source_records`
- `context_record_revisions`
- `context_evidence`
- `context_outbox`

Store 支持 Source/Collection 管理、partition lease/fencing、固定窗口分页、修订历史、Evidence、Outbox 与水位原子提交。Outbox `BIGINT` cursor 在 JavaScript 边界始终使用十进制字符串。

## DWS 同步

生产 executor 通过现有 `server-remote` Shell transport，在每个 Agent 独立的 DWS connector workspace 中执行确定性 argv：

- 聊天：`dws chat message list-all`
- Wiki 清单：`dws wiki space list` + 递归 `dws wiki node list`
- 文档正文：`dws doc read`（仅 Markdown 可读类型；其余显式 metadata-only/unreadable）
- 听记发现：`dws minutes +list-all`
- 听记摘要/转写：`dws minutes get summary/transcription`

运行策略：

- DWS Context scheduler 是独立于主 Agent 的后台 worker；主 Agent 只读 Context，不参与同步写入；
- 钉钉聊天历史学习和实时监听分别支持 `none / selected / all`；Wiki 与听记也必须显式启用，缺失或畸形策略对三类数据一律 fail-closed；
- 聊天历史及听记回填可配置 1—365 天，selected 每项最多 100 个 `conversationId`；配置使用 revision/CAS 和治理审计；
- 实时监听按 `all` 或每个 selected conversation 保存服务端 consent timestamp；新增、缩减或重启范围不会隐式采集授权前内容，也不会因首次事件自动回填 30 天；
- 每次范围变更清空三类数据的 partition 水位与 coverage，并提升 lease fence；旧 worker 一旦 fence 失效不可重新夺租，后续按当前历史窗口及实时 consent timestamp 重建；事件只负责叫醒，定时扫描继续承担完整性和 durable retry；
- DWS `chat message list-all` 只接受时间窗，不接受会话过滤。selected 会话因此在一次权威时间窗扫描内做 scope gate，不会按会话重复调用上游；未选中内容不会写入 Context Store；
- 聊天每 2 分钟、听记每 30 分钟、Wiki 每 60 分钟进入调度；
- 失败窗口、分页 cursor、退避时间持久化，worker 优先精确重放；
- 上游 page/item/detail 截断时落当前证据但不保存下一页 cursor、不推进水位；
- 本地内容上限裁剪可完成，但显式记录 `content_limit`；
- Wiki 不再把 `doc +search` 的最近访问结果冒充全量清单；同步通过空间列表和最多 4 层、每空间最多 500 节点的有界递归建立 inventory；
- 完整 Wiki inventory 后执行撤权对账，缺失文档写入 `revoked` 修订；任一分页、深度/数量上限或不可解析条目都会标记 incomplete，禁止执行 partial inventory sweep；
- 不可读正文写入记录 metadata 与 Evidence；Wiki 单文档正文回源若确定性返回 403/404，会立即提交该文档 `revoked` revision，权限恢复后可由新正文恢复；账户级 401/403 仍使用 `CONTEXT_SYNC_REFUSED`；
- 长时间 Wiki inventory 在每次 DWS 命令前执行节流 lease heartbeat；单次命令跨越 lease 时会在下一次 heartbeat fail-closed，不能用过期 lease 落库；
- 终页记录、Revision、Evidence、Outbox、Wiki inventory 撤权与 high watermark 在同一 PostgreSQL 事务提交；防御性上限为 20,000 条记录，覆盖当前/缺失 Wiki inventory 的最坏组合。

每个 Collection provision 时同步创建空的 `org_knowledge` Assignment Set：默认无人可读，管理员可在现有“记忆与知识 → 资源治理”中分配。暂停 Agent DWS 账号会同时 `disabled` Context Source/Collection 并提升全部 partition fence；Source 镜像保存账号 revision，Context Store 在事务入口核对权威账号状态/revision，不匹配时拒绝旧 worker 写入。策略镜像失败会先禁用 Source 再返回错误；检索直接读取账号策略真源，不把 Source 镜像当权限依据。

## 检索与 ACL

新增 Agent 工具：

- `ContextSearch`：PostgreSQL exact/`ILIKE` 检索，支持来源、类型和时间过滤；
- `ContextGet`：按 opaque hit id 获取单条结果。

两者返回 Evidence、freshness、route、derived/degraded 状态，并为每个 hit 返回可复制到回答的 `[CITE]{contextId,label}[/CITE]` 标记。工具输入不包含 `tenantId` 或 `userId`。检索 SQL 同时执行 domain enable、conversation scope、聊天历史 `lookbackDays`、听记 `lookbackDays` 与实时 per-scope consent timestamp；缩短窗口或从历史切到实时后，旧记录即时不可见。

组织 Agent 新会话首次固定 Collection assignment snapshot；已有会话不因后续扩权刷新。每次调用都重新读取当前 Assignment：任何新增、删除或版本漂移均使整次查询 fail-closed。迁移前没有 Collection pin 的旧会话继续使用当前授权。

聊天引用点击调用 owner-only API：

- `GET /api/sessions/:sessionId/context-citations/:contextId`
- `contextId` 是 HMAC 签名的 opaque routing data，不是权限凭证；revision 或其他字段被篡改时签名校验失败；
- 每次点击重新校验 JWT 当前用户、Session owner/tenant、组织 Agent assignment pin、当前 deny-overrides-allow ACL 和 record revision；
- 跨用户、跨租户、撤权、删除/撤销 revision、篡改 ID 都返回不可见；
- Evidence API 与 Agent 推理进程解耦，Agent 不可用时仍能从 PostgreSQL 展示来源证据。

## 管理 API 与 UI

管理 API：

- `GET /api/admin/context-plane/snapshot`
- `GET /api/admin/context-plane/evidence`
- `PATCH /api/agent-dws-accounts/:accountId/context-policy`

Agent 钉钉成员账号页提供历史学习/实时监听双范围、Wiki/听记显式开关、回填天数、最近事件会话快捷选择和 CAS 冲突提示。新账号与存量缺策略账号默认三类数据均不采集，不会隐式全量回填。Context Admin Router 已挂载到上述 `/api/admin/context-plane/*` 路径并经过 `requireAdmin`。

Context Center 接入现有“记忆与知识”区域，展示 Source/Collection、最后同步、水位延迟、覆盖范围、截断/拒绝状态、权威历史学习与实时监听范围，以及 Evidence Drawer。聊天页 Context Citation Drawer 展示来源、原文时间、freshness、derived/degraded、作者与 Evidence；原系统链接仅允许 HTTP(S)，并使用安全外链属性。

## 验证

Phase 1 当前验证结果：

- Server/Web/Shared typecheck 全部通过；
- Server 最终定向测试 11 个文件、94 项通过；Shared governance API 30 项通过，Web 组织治理/Context Center 23 项通过；
- Server 与 Shared 全量 coverage 通过；Web citation/策略 UI 定向测试 3 个文件、15 项通过，Shared marker 5 项通过；Web 全量 coverage 仅有未修改的 `TaskBoard/BoardDialog.test.tsx` 在高负载下 1 项 5 秒超时，隔离重跑 10/10 通过；
- Codex WebSocket 回归 14 项通过，确认用户在 `main` 的 Unicode tool schema / 多行 SSE 紧急修复仍在祖先链中；
- `check:ratchets`、`git diff --check`、Web API boundary、scenario lint/sanitize、Server build 与 OSS build 通过；
- Web startup budget 通过：startup JS 1 request / 304,952 gzip bytes，CSS 1 request / 33,107 gzip bytes；
- 本地没有 `TEST_DATABASE_URL`，因此本轮未执行 PostgreSQL contract/preflight；必须由 follow-up PR 的 PostgreSQL 16 CI 对当前精确 head 完成最终验收。

`server/src/context/store.pg.test.ts` 覆盖 migration v24、Collection tenant 唯一约束、FK、原子 ingest 与超安全整数 Outbox cursor。未执行生产数据库 migration。

## 当前边界

- 检索尚未加入 embedding/vector/rerank；
- Context Center 只读，Collection 授权编辑复用现有资源治理；聊天采集范围在 Agent 钉钉成员账号页配置；
- Consumer 状态没有独立持久化来源时返回空数组，不注入演示数据；
- DWS 聊天接口不提供可权威对账的删除 inventory，听记接口也没有删除 feed；Phase 1 对 Wiki 缺失执行 `revoked` 对账，并通过采集范围与 Assignment 撤权立即阻断聊天/听记旧记录检索，不伪称能观察上游未暴露的删除事件；
- 不采通讯录，不全量下载附件；
- PR #133 已由用户合并到 `main`；本说明中的 Phase 1 补齐改动位于 follow-up 分支，尚未部署、未执行生产 migration，需等待当前精确 head 的 CI。
