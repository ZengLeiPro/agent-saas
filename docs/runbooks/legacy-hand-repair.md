# 存量 Hand 登记接管与修复操作说明

本修复只处理登记历史，不删除 Sandbox、工作区、文件或执行记录。生产操作需要获批的目标清单；以下命令是待执行说明。

## 自动接管

兼容代码发布后，旧会话下一次续聊会按现有流程注册、恢复新版 Hand。新版就绪后，系统核对同租户、用户、会话、提供方、endpoint、工作区与 Sandbox 范围；旧登记没有在途初始化、活跃 run 或工具调用时，写入 `supersededBy`、`supersededAt`、`supersededReason`。

历史 `status` 保持原值，但路由、健康扫描、状态更新、初始化完成回调和租约清理均排除退役记录。历史查询仍可读到它。后台会话环境列表按用户工作区、会话和租户匹配。

当前自动接管限定为可验证的用户工作区 `server-remote` 租户提供方登记；不处理 Client、组织 Agent 或运行隔离证明绑定的默认 Hand。不同环境、无法确认身份或旧任务仍活跃时保留记录并拒绝有歧义的路由，不能通过选“最新一条”绕过。

## 有限范围预览与修复

在具有项目依赖的维护工作区运行。配置文件必须为 JSON，包含正确的 `runtimeEventStore.backend=pg`、连接信息与 `tablePrefix`。脚本不启动应用，不调用外部 `/provision`，不执行 DDL。

默认预览事务为只读。每个 `--session` 指定一个已确认的会话，可重复传入；不支持默认扫描全库。

```bash
pnpm -F server exec tsx scripts/repair-legacy-hands.mts \
  --config /etc/agent-saas/config.json \
  --tenant kaiyan \
  --session cb1a3ad4-8971-5b01-9252-1f0cac7bd7f6 \
  --plan /var/tmp/hand-repair-plan.json
```

检查输出中的每条判定及 plan。plan 绑定数据库地址、库名、表前缀、租户、会话、新旧记录 ID 和版本；仅包含满足接管条件的条目。对于 `replacement_not_ready`、`environment_identity_mismatch`、`legacy_provision_in_flight`、`legacy_work_active` 等结果，先调查原因，不直接改状态。

确认清单且兼容版本已在线后，再执行：

```bash
pnpm -F server exec tsx scripts/repair-legacy-hands.mts \
  --config /etc/agent-saas/config.json \
  --tenant kaiyan \
  --plan /var/tmp/hand-repair-plan.json \
  --execute \
  --snapshot /var/tmp/hand-repair-before-and-results.jsonl
```

执行规则：

- plan 和 snapshot 均要求新建文件，不覆盖已有文件。
- snapshot 权限为 `0600`，写入并同步原始记录后才更新数据库；可能包含历史认证元数据，禁止提交仓库或粘贴到报告。
- 每对记录在事务中锁定、重新验证，条件变化立即停止。
- 单对更新后读回 `supersededBy`；每次运行最多执行 100 对。
- 批次是逐对提交。后续条目失败不会自动撤销已经成功的条目，应根据 snapshot 中的结果续查，不能宣称整批回滚。
- 原 plan 执行后会因版本变化拒绝再次写入；重新生成预览会识别 `already_superseded`，不重复接管。

## 验收

1. 核对旧记录的 `supersededBy` 指向正确新版记录，旧记录和原 Sandbox 均保留。
2. 原会话 `WaitForWorkspaceReady` 返回 `ready`，有效路由唯一。
3. 经授权，在专用验证文件上完成真实 Write → Read，确认内容一致。
4. 待正常空闲暂停后继续原会话，再验证恢复和读回；不要强制暂停用户正在使用的环境。
5. 核对至少一轮健康扫描没有重新激活旧登记，其他会话仍正常。

本地测试已覆盖 PostgreSQL 并发接管、注册完成后的自动接管、等待工具冲突/就绪、CLI 预览/快照/更新/读回、活跃引用与跨身份拒绝。这不替代生产真实读写与暂停恢复验收。

## 回滚边界

优先保留兼容代码并排查受阻条目。不要直接回滚到不识别 `supersededBy` 的版本，它会重新选择历史登记并可能触发重复恢复。

必须回滚数据时，先冻结该会话的新请求并核对活跃任务，按 snapshot 精确恢复；更新须匹配当前 `supersededBy` 和记录版本。恢复旧登记之前，应保证新版已退出有效路由，且双方仍对应同一真实环境。不得整体覆盖修复后产生的新 metadata，不得删除 Sandbox。具体回滚 SQL 需基于当时读回结果单独审核，本文不提供无条件清空标记的脚本。

## 发布门禁后续项

本 PR 不修改部署 Workflow。升级兼容性验证的强制门禁、迁移数据库后置条件和其他部署隐患见 `docs/reviews/deployment-workflow-audit-2026-09-07.md`，需单独确认并实施。当前 PostgreSQL 升级测试位于 `server/src/__tests__/handSupersession.pg.test.ts`，须配置 `TEST_DATABASE_URL` 才会实际执行。
