# Taskboard Integration — Agent-first 正式契约

本文描述当前唯一受支持的 integration 流程。它是 Agent-first 协调协议，不是平行的代码状态机。

## 1. 权威边界

- **GitHub PR 是唯一代码事实源**：当前 PR、head、base、checks、merge 状态和 provider receipt 必须从 GitHub 重读。数据库只保存调度绑定、执行收据和恢复检查点，不得用本地 revision、lease 或 outbox 推断代码事实。
- 一个 integration task 至多绑定一个 durable Integration Agent。Agent 跨越 work、merge 与 cleanup 多次执行持续存在；任务重启或进程切换不得创建第二个协调者。
- Agent 的稳定绑定是 integration task、repository、按顺序排列的 delivery source IDs，以及 `integration/<task-id>` branch。GitHub PR 建立后也属于该绑定。
- Agent 不拥有 GitHub 之外的第二份 PR、revision 或 subject 权威模型。

## 2. 执行与会话

1. **Work**：durable Agent 在绑定 worktree 中汇总来源，创建或更新唯一 integration branch 与 GitHub PR，并以 GitHub 返回的 head/checks 为准。
2. **Review Session**：Review 是独立执行、独立会话，不复用 Work 会话。批准必须明确绑定当前 Agent、当前 GitHub PR、当前 head、当前 subject 和对应的全绿检查收据。head 变化立即使旧批准失效。
3. **Merge**：仅 Agent 的受控 merge execution 可以调用 **Merge Gateway**。普通 Work、Review、客户端和通用 provider 工具都不能直接合并。
4. **Cleanup**：仅绑定该 Agent 的受控 cleanup 可以关闭来源 PR、删除已核对 head 的来源 branch、删除 integration branch 和任务 worktree。每一步写 durable receipt；失败后从 receipt 继续，cleanup 完成前任务不能收敛为 done。

Work、Review、Merge、Cleanup 可以由不同 execution 承载，但必须落在同一个 durable Agent rendezvous 上。execution retry 不是新 Agent，也不产生新的代码权威对象。

## 3. 仅有的三道硬门禁

当前协议只有以下三道硬门禁，不另设影子 admission、双 worker 路由或额外状态机：

1. **CI Gate**：GitHub 对当前 PR/current head 的 required checks 已知且全部成功；pending、failure、unknown 或 head 漂移一律关闭门禁。
2. **Review Gate**：独立 Review Session 对同一 current head 明确批准，且 review execution、subject 与检查收据绑定仍新鲜。
3. **Merge Gateway**：执行合并前重新读取 PR/head、CI 与 approval，并用 execution fence 记录 in-flight 绑定和 provider receipt。任何不一致拒绝合并；provider 结果 unknown 时只允许对账。

看板策略可以定义 GitHub 未声明 required checks 时的受控 fallback，但不能绕过上述三道门禁，也不能把 observed optional checks 自动提升为 required。

## 4. 状态模型

任务只保留业务阶段；Agent rendezvous 只保留最小流程状态：

| Agent 状态 | 含义 | 可派发动作 |
|---|---|---|
| `active` | 汇总、修复或刷新 PR | Work |
| `reviewing` | 当前 head 等待独立审查 | Review |
| `ready_to_merge` | 当前 head 已通过 CI 与 Review | Merge，然后 Cleanup |
| `merged` | merge receipt 与 cleanup 已收敛 | 无 |
| `canceled` | 受控取消完成 | 无 |

Review 退回把同一个 Agent 返回 `active`；它不是新的持久状态树。PR/head 漂移撤销批准并回到对账/Work。终态不得因迟到 execution 回执回退。

## 5. 恢复、幂等与副作用

- **恢复先对账**：任何 restart、timeout、unknown provider result 或部分 cleanup 都先重读 GitHub PR/head/state，再读取 durable merge/cleanup receipt；禁止先重发 provider 写操作。
- Merge Gateway 以绑定 execution、review execution 和 review head 建立 in-flight fence。相同 operation key 可安全重试；冲突绑定必须 fail closed。
- Cleanup 按 source 和 integration branch 分项 checkpoint。已完成步骤跳过；删除前核对 expected head，漂移时停止并交人工处理。
- 外部已合并只能在验证 merged PR 与已批准 subject 一致后吸收；仍需补齐 merge receipt 和 cleanup，不能直接把任务标为 done。
- cancel/archive/delete 不得绕过进行中的 merge，也不得丢失 provider receipt。

## 6. 历史 workflow version 2 自动迁移

历史 integration task 不再由旧协议执行，只允许 scanner 自动迁移到当前 Agent-first 路径：

1. task 必须是未归档、未删除、可工作的 integration，绑定 active repository lane，且没有活动 execution；
2. source 集合必须非空、同 repository，并形成确定顺序；
3. scanner 在一个数据库事务中先幂等插入唯一 Agent rendezvous，再把 `workflow_version` 从 `2` 更新为 `3`；任一步失败整笔回滚；
4. 数据库 immutable trigger 只放行该精确的 `2 → 3`：同事务内已存在与 task、active lane、repository、完整 source IDs 和固定 integration branch 一致的 Agent。其他所有版本修改继续抛出 `TASKBOARD_WORKFLOW_VERSION_IMMUTABLE`；
5. 重复扫描通过 Agent 主键与条件更新收敛，不创建重复 Agent。缺 source、跨 repository、错误 branch 或错误绑定保持 version 2，等待修复后重试；不恢复旧执行协议。

新建 integration task 直接以 version 3 和 Agent-first 绑定进入流程。

## 7. 退役数据结构

Candidate 聚合及其 revision、snapshot、provider-operation、request、heartbeat 与 migration 表均为退役结构，不是运行时能力。启动 schema 初始化按依赖顺序使用 `DROP TABLE IF EXISTS` / `DROP FUNCTION IF EXISTS` 幂等删除这些已知对象，不使用 `CASCADE`；若存在未知依赖则启动失败，避免误删活跃数据。

运行时不得重新创建、读取或双写这些表，也不存在启用旧 Candidate 协议的开关。integration source 行仅保留来源绑定与 cleanup 所需事实，不能执行另一套 merge 流程。

## 8. 运维约束

- schema 变更必须事务化、可重试；不可通过临时删除 immutable trigger 获得迁移窗口。
- 部署前在生产副本演练锁等待、执行时长、表膨胀和失败回滚。仓库测试不替代生产量级演练。
- GitHub 或 Merge Gateway 不可达、required checks 不可判定、review 过期、head 漂移、receipt 不完整时均 fail closed。
- Work/Review runtime 不持有可绕过 Merge Gateway 的合并或清理权限。
