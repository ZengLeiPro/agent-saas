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
- 文档发现：`dws doc +search`
- 文档正文：`dws doc read`
- 听记发现：`dws minutes +list-all`
- 听记摘要/转写：`dws minutes get summary/transcription`

运行策略：

- 首次默认回填 30 天；
- 聊天每 2 分钟、听记每 30 分钟、Wiki 每 60 分钟进入调度；
- 失败窗口、分页 cursor、退避时间持久化，worker 优先精确重放；
- 上游 page/item/detail 截断时落当前证据但不保存下一页 cursor、不推进水位；
- 本地内容上限裁剪可完成，但显式记录 `content_limit`；
- Wiki 因 DWS 暂无更新时间 feed，采用完整分页 inventory，避免旧文档更新遗漏；
- 完整 Wiki inventory 后执行撤权对账，缺失文档写入 `revoked` 修订；失败或不可解析条目禁止执行 partial inventory sweep；
- 大批量撤权按 500 条分批写入。

每个 Collection provision 时同步创建空的 `org_knowledge` Assignment Set：默认无人可读，管理员可在现有“记忆与知识 → 资源治理”中分配。

## 检索与 ACL

新增 Agent 工具：

- `ContextSearch`：PostgreSQL exact/`ILIKE` 检索，支持来源、类型和时间过滤；
- `ContextGet`：按 opaque hit id 获取单条结果。

两者返回 Evidence、freshness、route、derived/degraded 状态。工具输入不包含 `tenantId` 或 `userId`。

组织 Agent 新会话首次固定 Collection assignment snapshot；已有会话不因后续扩权刷新。每次调用都重新读取当前 Assignment：任何新增、删除或版本漂移均使整次查询 fail-closed。迁移前没有 Collection pin 的旧会话继续使用当前授权。

## 管理 API 与 UI

管理 API：

- `GET /api/admin/context-plane/snapshot`
- `GET /api/admin/context-plane/evidence`

Context Center 接入现有“记忆与知识”区域，展示 Source/Collection、最后同步、水位延迟、覆盖范围、截断/拒绝状态、历史学习与实时监听范围，以及 Evidence Drawer。原系统链接仅允许 HTTP(S)，并使用安全外链属性。

## 验证

当前分支验证结果：

- Server typecheck、build 通过；
- Server 全量测试分为 2 个 shard：471 个测试文件通过，4822 项测试通过；另有 28 个文件按环境条件跳过、157 项跳过、3 项 todo；
- Web typecheck、build、API boundary 通过；210 个测试文件、1558 项测试通过；
- Shared typecheck 通过；56 个测试文件、822 项测试通过；
- `git diff --check` 通过；最终只读审查未发现 P0/P1。

`server/src/context/store.pg.test.ts` 已覆盖 migration v24、Collection tenant 唯一约束、FK、原子 ingest 与超安全整数 Outbox cursor；当前执行环境未配置 `TEST_DATABASE_URL`，因此其中 2 项真实 PostgreSQL 用例被条件跳过，未执行生产数据库 migration。

## 当前边界

- 检索尚未加入 embedding/vector/rerank；
- Context Center 只读，授权编辑复用现有资源治理；
- Consumer 状态没有独立持久化来源时返回空数组，不注入演示数据；
- 未部署、未执行生产 migration、未 push 或创建 PR。
