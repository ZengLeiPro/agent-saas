# TaskBoard Integration Agent

## 目标

Integration task 只启动一个 durable **Integration Agent**。同一个 Session 读取本批次来源，自主完成代码组合、CI 处理、GitHub 合并、资源清理和任务收口；系统不再把过程拆成 Candidate、Revision、独立 Review、Merge Gateway 或专用恢复状态机。

## 运行流程

1. maintainer/owner 在一个已绑定仓库的看板中选择交付来源并创建 Integration。
2. 系统冻结本次 `deliveryTaskIds`，创建 `workflowVersion=3` Integration task 和一个 Agent rendezvous。
3. 调度器只派发 `purpose=work`，后续自动恢复仍复用同一个 durable Session。
4. Agent 读取任务、来源任务、评论、仓库与 GitHub 实际状态，自主决定是否使用分支、worktree、PR、直接 merge 或子 Agent。
5. Agent 处理冲突和 CI。外部操作结果不确定时先重新读取 GitHub/Git 状态，再决定是否重试。
6. GitHub 确认合并后，Agent 清理本批次拥有且可安全删除的本地/远程分支、worktree 和临时目录。
7. 全部完成后 `execution.finish({targetStatus: "done", body})`；确实需要人工决定或补充条件时才使用 `blocked`。

任务只有两种 Agent 终点：`done` 与 `blocked`。看板现有 `merge` 提示语/模型键仅作为这个单一 Agent 的配置入口，不代表独立 Merge Execution。

普通 Delivery 仍由独立的 Work / Review Agent 分阶段交付与复核，但 `execution.pull_request.inspect` 只提供当前 PR、head、check 与 workflow 观测，不输出平台准入结论。质量结论由 Work/Review Agent 基于代码差异、实际验证、CI 和日志证据自主作出；服务端只保留权限、事务与事实一致性约束，例如 active Execution、唯一 PR 绑定、CAS、终态不可逆和真实 merge 事实。

## 系统保留的边界

1. **仓库与来源范围**：Execution 只获得当前 Integration 指定仓库、本次 `deliveryTaskIds` 和相关上下文；这不授权处理其他仓库、任务或资源。
2. **安全清理**：Agent 只能删除可确认属于本批次的资源；分支或 worktree 存在未合并提交、归属不明或状态无法确认时必须保留。
3. **GitHub 原生保护**：push、PR 和 merge 继续受 GitHub 身份权限、branch protection 与 ruleset 约束，任务看板不另造一套审批协议。
4. **副作用对账**：push、PR、merge、删除等结果不确定时先读取远端和本地真实状态，避免重复操作。

除此之外，系统不强制 integration branch/worktree、PR 形态、合并方法、独立 Review、特定 CI 状态机、来源重试轮次或 Gateway receipt。

## 状态与恢复

- 新任务从 `in_progress` 进入唯一的 `work` Execution。
- Runtime 失败、调度器重启或瞬时基础设施异常由通用 durable Execution 机制恢复，仍回到 `in_progress`，不创建 Review/Merge Session。
- `blocked` 仅表示需要人工输入。用户提交恢复决策后，任务回到 `in_progress` 并复用 durable Session。
- `done` 由 Agent 在确认合并与安全清理完成后提交。系统更新 Integration task、来源投影和关联交付任务，并释放历史 lane 绑定（若存在）。

## 兼容策略

旧数据库中的 lane、authorization、merge operation、review head、receipt 和 remediation 表暂时保留，供历史记录和 workflow v2 读取；新 workflow v3 不创建也不依赖这些记录。启动扫描会把没有活动 Execution 的历史 `in_review` / `ready_to_merge` Integration 归一到单一 `in_progress` work 路径。

兼容范围仅覆盖仍承担历史 workflow v2 读取的 Integration 表和字段；新 workflow v3 不重新依赖这些记录。没有历史读取或事实审计用途的普通 Delivery 质量门禁列与协议可以随正式契约删除，不承诺无差别永久保留所有历史列。
