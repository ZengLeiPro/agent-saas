# Context Plane 第四阶段加固说明

本轮加固针对 Phase 1–4 集成后的真实权限、同步正确性、产品分页与运维闭环，不新增平行产品入口。

## 权限

- ContextSearch、citation 与 Context Product 共用实时授权解析。
- 每次内容读取/纠正都重新检查目标租户 active membership 与 `knowledge.org.enabled`。
- 平台管理员只能跨租户查看 metadata；内容仍需 active membership、Assignment、current record、Evidence 与 source-native ACL。
- entitlement 关闭后旧会话 pinned scope 不能继续命中。

## 同步与派生

- Azeroth 只有在 `total`、页数、页大小、跨页 ID 唯一性全部可证明完整时才执行 negative sweep；缺少权威总数时只 ingest 并标记 degraded。
- Directory、Taskboard、Azeroth 与派生投影按租户隔离失败，一个租户失败不阻断其他租户。
- Taskboard 运行库为可选依赖，不可用时 Directory/Azeroth/derived runtime 仍可启动。
- 组织冲突在 revoke/delete/supersede 后按 `subject_entity_id + item_type + semantic_key` 重算；收敛为单值时清除陈旧冲突，个人项不进入组织冲突统计。

## 产品

- exact item lookup 不再扫描固定前 200 项。
- 画像项与纠正记录各自提供 cursor API，详情 UI 会首屏加载、加载更多、按 ID 去重并透传 degraded。
- proposed/conflicted 项可见但不可作为纠正目标；只有 confirmed/current 项可纠正。
- Source 卡片展示陈旧 heartbeat、watermark lag、retrying 与 next retry；启动后未运行不会显示 healthy。

## 运维与验证

安全 replay、A/B/C 固定 dataset runner、失败阈值和 PostgreSQL 16 合并门槛见 [Context Plane 运维手册](./Context-Plane运维手册.md)。本轮不执行生产 migration、部署或生产数据操作。
