# Taskboard 复核自动重派无结构变更审核

## 审核范围

- 基线：`5a47ada58e366450668e8ff415f5cda2fc8be1c4`（PR #693 相对 `origin/main` 的精确基线）。
- 查询谓词：`server/src/taskboard/integrationTriggers.ts`。

## 结论

上述文件分类为 `no-schema-change`。本批只收窄 `loadUnstartedIntegrationTasks` 对 `delivery + in_review + 已登记 PR` 的只读领取谓词：从未派过 review 才补派，或最近一次 review `failed` 且未超过 `maxTransientRetries`。`operator_cancelled` 与 `finish(in_review)` 成功停车后不再自动重捞。

没有新增、修改或删除表、列、索引、约束、启动建表、数据回填或数据删除。既有 `runtime_taskboard_tasks` / `runtime_taskboard_execs` 结构与写入路径不变。不需要 contract 或 expand 发布。

## 验证证据

- `server/src/taskboard/integrationTriggers.test.ts`：断言新 SQL 含未派过 review、failed-retry、`operator_cancelled` 约束。
- `server/src/__tests__/taskboardIntegrationRecovery.pg.test.ts`：取消不重派、成功停车不重派、失败可重试、超过上限停止；原归档出口仍要求从未派过 review 时补派一次。

源码摘要、基线摘要和本文摘要逐条绑定在 `config/release-migration-reviews.json`。任一受审源码或证据发生字节变化都必须重新审核。本文只记录源码与数据库结构判断，不代表生产已经发布。
