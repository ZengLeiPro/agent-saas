# 任务看板独立复核 A：状态一致性

- 复核角色：独立复核工程师 A
- 基线：`ed7f65db82900c6a10ef804191bd544a872c20b3`（当前 `HEAD` 与基线相同，审查对象为当前未提交变更及本次新增文件）
- 复核方式：独立阅读代码、SQL 与测试；未采信实施报告结论；未修改源码、配置、测试、数据库或外部系统
- **Verdict：reject**
- **问题计数：P0 0 / P1 7 / P2 4**

## 结论

本次变更建立了 Resolution 单行唯一性、execution/attempt/fence receipt 校验、merge projection 收敛、cancellation outbox、advisory 能力隔离和 repair dry-run 等重要基础，但尚不能证明 workflow decider/command service 已成为所有关键写路径的权威 guard。仍存在可绕过显式 resume 的人工状态写、merge fact 未覆盖 claim/continuation、provider 调用前 TOCTOU、TASK-69 路径反向锁序、remediation pointer/attempt 静默分叉、脏数据迁移后唯一约束缺失以及 repair 漏 fencing。上述问题可造成已合并任务再次派发、取消后仍执行真实 merge、运行时死锁/未知态，以及 D-R-S-I 无法可靠收敛，因此不建议合入。

---

## P0

无。

## P1

### P1-1：claim 与 continuation guard 只看 Task projection，不看权威 merge fact，仍可重复派发

- **位置**：`server/src/taskboard/storeExecutionLifecycle.ts:47-53`；`server/src/taskboard/continuationStore.ts:156-170`；对照 `server/src/taskboard/workflow/commandService.ts:20-41`
- **触发路径**：历史/部分写入状态为 integration source 已有 `state='merged'`、`merged_commit_oid` 或 `provider_receipt_id`，但 delivery task 的 `status/merged_commit_oid` projection 尚未修正。正式执行 claim 调用 `assertExecutionRequestAllowed` 时未加载 `loadWorkflowFacts`；评论续跑的 `markContinuationRunning` 同样只判断 `task.status/task.mergedCommitOid`。
- **实际后果**：已存在不可逆 merge fact 的 delivery 仍可创建正式 Execution 或把 continuation 置为运行态；新 run 可继续写评论、branch/PR 等字段。dispatcher 最终虽经过 `claimExecution`，但该 guard 也缺 merge fact，所以无法兜底重复派发。
- **建议修复**：在持有 Task 锁的事务中加载 merge facts，并把 facts 作为 `assertExecutionRequestAllowed` 的必需输入；continuation store host 增加 source/fact 查询，enqueue/mark-running/completion 均以同一 decider 判定。不要把 repair projection 当作在线 guard 的前置条件。
- **建议测试**：PG 事故回放：只写 source `provider_receipt_id`（Task 保持 `todo/in_progress`），分别调用 `claimExecution`、评论 direct execution、已有 continuation 的 `markContinuationRunning`，断言无 execution/outbox 派发且 continuation 被吸收完成；再并发 claim 两次验证都不能越过 merge fact。

### P1-2：普通 move 写路径可把 blocked 直接拖回 todo/backlog，绕过显式 Resume

- **位置**：`server/src/taskboard/store.ts:783-798`；对照 `server/src/taskboard/workflow/resumeService.ts:19-75`、`server/src/taskboard/workflow/decider.ts:65-69`
- **触发路径**：maintainer 对 blocked 的 delivery/remediation 调用普通 `moveTask`，目标为 `todo` 或 `backlog`。当前保护集合只覆盖 `in_progress/in_review/ready_to_merge/done`，blocked↔todo/backlog 不在其中。
- **实际后果**：无需 `decision` 即可恢复；`workflow_epoch` 不递增、open block episode 不关闭，integration source 也不会按 sourceIds 重置。随后 `claimExecution` 会把 todo 当作合法 work，形成“状态已恢复但审计/来源仍阻塞”的分叉。
- **建议修复**：普通 move 禁止所有进入/离开 `blocked` 的状态变更；恢复只能走 `resumeBlockedTask`。如需取消，应提供独立 command，而不是复用拖拽状态写。
- **建议测试**：store/route PG 测试覆盖 blocked→todo、blocked→backlog 均返回 `TASKBOARD_PROTECTED_TRANSITION`；resume command 成功后断言 epoch +1、block episode closed、integration source 仅重置显式 sourceIds。

### P1-3：stale_subject 与 merge finalizer 采用相反锁序，TASK-69 并发路径可死锁

- **位置**：`server/src/taskboard/integrationOperations.ts:523-545`（Task→Source）；`server/src/taskboard/integrationOperations.ts:703-723`（Source→Task）
- **触发路径**：一个 worker 在 `finalizeMergedSource` 中先锁 delivery/integration/remediation Tasks，再等 source；另一个 worker 在 `markSourceForRereview` 中先 UPDATE/锁 source，再 UPDATE/等 delivery Task。
- **实际后果**：PostgreSQL 可检测到死锁并回滚一方。若 provider merge 已成功但 finalizer 成为 victim，调用会退到 unknown/waiting_retry，必须依赖后续 reconcile 才可能 done；代码本身不能保证本次竞态确定性收敛，且用户会观察到错误/延迟状态。当前 TASK-69 PG 测试只是顺序直写，并未制造该竞态。
- **建议修复**：所有 source 状态变更统一执行“按 ID 排序锁 Task(s)→锁 Source→锁 Execution/Operation”；`markSourceForRereview` 先发现关联 ID，再显式按统一顺序 `SELECT ... FOR UPDATE`，之后才更新。
- **建议测试**：真实 PG 双连接 barrier 测试，同时执行 stale-subject 与 finalize/reconcile，设置短 `deadlock_timeout/lock_timeout`；断言无 `40P01`，最终 source/delivery/integration 为 merged/done，且 stale 写不回退终态。

### P1-4：provider merge 前未在 prepare 事务重新验证 execution/lane/authorization/task/source，存在取消后仍 merge 的 TOCTOU

- **位置**：`server/src/taskboard/integrationOperations.ts:72-153`；`server/src/taskboard/integrationOperations.ts:324-399`；`server/src/taskboard/integrationOperations.ts:404-468`
- **触发路径**：`loadOperationContext` 无锁读取 active execution/authorization/lane，随后调用 provider `getPullRequest`；在 `prepareOperation` 前，runtime completion 终止 execution，用户取消 integration 并把 source 置为 `canceled`。`prepareOperation` 只锁 source、校验 subject，不拒绝 canceled source，也不重新校验 execution、lane、authorization或 integration task，然后把 source 改成 `merging` 并调用真实 `mergePullRequest`。
- **实际后果**：已明确取消/已被 fence 的工作仍可产生不可逆 provider merge；本地 cancellation 被复活为 merging/merged，违反 provider side-effect 边界。
- **建议修复**：prepare 事务按统一锁序重新读取并锁定 task/source/execution/authorization/lane，要求 execution active 且未 resolved/superseded、source 处于明确可 merge 状态、lane/epoch/policy/authorization仍匹配；只有 durable operation 成功从 prepared→executing 后才允许 provider 调用。取消路径必须与该 operation 状态互斥。
- **建议测试**：可控 provider barrier：在 `getPullRequest` 返回前终止 execution 并取消 integration，放行后断言 `mergePullRequest` 从未调用、source 保持 canceled、无 merge operation；另测 authorization revoke/lane epoch 改变。

### P1-5：remediation pointer 先写、attempt INSERT 冲突却静默忽略，可造成 D-R-S-I 双写分叉

- **位置**：`server/src/taskboard/integrationOperations.ts:219-233`
- **触发路径**：把已由 source A 的 remediation_attempt 使用的 `remediationTaskId` 链接到 source B。source B 当前 pointer 为空，因此先被 UPDATE 为该 task；随后 attempt INSERT 命中 `UNIQUE(remediation_task_id)`，`ON CONFLICT ... DO NOTHING`，函数仍返回成功并写 change。
- **实际后果**：旧 pointer 显示 task 属于 source B，attempts 权威历史仍属于 source A。后续 resolution 使用“pointer OR attempts”恢复来源，finalize 又按 attempts 聚合，可能恢复/完成错误 source，或让 B 永久 waiting_remediation。该路径还未拒绝 done/canceled remediation task。
- **建议修复**：先插入/读取 canonical attempt；冲突时必须核对 `integration_source_id/round/remediation_task_id` 完全一致，否则返回 conflict。仅在 canonical attempt 成功后更新 source pointer；同时限制可链接 remediation task 的状态与未归属条件。
- **建议测试**：PG 测试覆盖同 task 同 source replay 成功、同 task 跨 source 冲突且 pointer 不变、同 source 同 round 不同 task 冲突回滚、多轮 round 递增及 terminal remediation 不可链接。

### P1-6：脏数据迁移会静默跳过 active PR 唯一索引，repair 又不修重复项

- **位置**：`server/src/taskboard/v2Schema.ts:259-272`；`server/scripts/repairTaskboardWorkflow.ts:141-149,167-169`
- **触发路径**：历史库存在“同 repository + PR、不同 delivery”的多个 active source。schema DO block 发现重复后直接不建 `${integrationSourcesTable}_active_pr_uidx`，初始化仍成功；repair 只报告 `duplicate_active_source`，apply 明确 continue。
- **实际后果**：数据库在该租户上长期缺少关键唯一约束，后续并发 batch 仍可插入同 PR 的多个 active source；应用层先查后插无法替代 DB 唯一性，重复派发/重复 merge 风险持续存在，且没有显式迁移失败或降级告警。
- **建议修复**：迁移应 fail closed（明确报出冲突及修复指引），或在同一受审迁移中确定性隔离/取消重复 source 后创建索引并验证 `to_regclass`；repair apply 必须有保守、可审计的重复消歧策略，不能静默跳过。
- **建议测试**：真实 PG 先植入跨 delivery 的同 PR active duplicates，运行 `init`/repair，断言最终唯一索引存在；并发创建两个 batch 时仅一个提交，另一个得到稳定业务冲突码。

### P1-7：repair 对 provider_receipt-only merge fact 会修 Task 却漏 fence active execution，并给出假阴性 post-check

- **位置**：`server/scripts/repairTaskboardWorkflow.ts:59-75,176-212,268-279`
- **触发路径**：source 只有 `provider_receipt_id`，但 `state` 尚非 merged、source/task 均无 merged OID，同时存在 active execution。projection 查询把 receipt 视为 merge fact并把 Task 改 done；active execution 查询和 post-check 却只看 `s.state='merged' OR t.merged_commit_oid IS NOT NULL`。
- **实际后果**：apply 后 Task 为 done，但 execution/run 未 fence、无 cancellation outbox；after 仍可能报告 `mergedActiveExecution=0`。active run 可继续写 execution comment/受 execution 保护的字段，repair 审计结论不可信。
- **建议修复**：抽出与 `loadWorkflowFacts` 完全一致的 SQL predicate，findings、apply 与 post-check 共用；projection 修复与 execution fencing 在同一事务内按 task 聚合执行；after 应验证所有三种 merge fact。
- **建议测试**：PG repair 测试植入 provider_receipt-only + active execution，dry-run 报两类 finding，apply 后 execution canceled/superseded、cancellation outbox 1 条、post-check 为 0，第二次 apply 为 0。

## P2

### P2-1：Resolution payload digest 不是 canonical JSON，语义相同 replay 可能冲突

- **位置**：`server/src/taskboard/workflow/commandService.ts:49-55`
- **触发路径**：同一 resolution replay 的 `receipt` 对象键顺序不同（或由不同 JSON client 反序列化/重组），内容语义相同但 `JSON.stringify` 字节序不同。
- **实际后果**：digest 不同并返回 `TASKBOARD_RESOLUTION_CONFLICT`，降低跨进程/客户端幂等性；当前单测复用了同一 JS 对象，未覆盖该情况。
- **建议修复**：对整个 digest payload 使用稳定递归 key sort/canonical JSON；明确数组（evidence）是否保持顺序语义。
- **建议测试**：用键顺序不同但语义相同的 receipt replay 应命中同一 Resolution；任何值变化仍冲突。

### P2-2：receipt schema 未携带/校验 runId，未达到显式 run/attempt/fence 三重绑定

- **位置**：`shared/src/types/taskboard.ts:279-292`；`server/src/taskboard/v2Store.ts:474-491`；`server/src/taskboard/workflow/commandService.ts:157-194`
- **触发路径**：context receipt 只包含 executionId/attemptId/purpose/epoch/fence；resolve endpoint 的 URL/runId 间接选择 execution，但 receipt 自身没有 runId 可审计或独立校验。
- **实际后果**：当前 executionId + DB 唯一 run_id 可提供间接绑定，未发现直接越权路径；但持久 receipt/Resolution 无法自证属于哪个 runtime run，达不到任务要求的显式 run binding，迁移/审计时也更脆弱。
- **建议修复**：V2 receipt 增加必填 `runId`，生成时写 execution.runId，identity/current 两种校验都要求精确相等；必要时升级 schemaVersion。
- **建议测试**：正确 executionId/attemptId 但错误 runId 必须拒绝；late merged receipt同样只能接受原 runId。

### P2-3：repair 的 `--task-id` 语义在 merged remediation 查询中错绑 delivery，且 prefix 上限与 Store 不一致

- **位置**：`server/scripts/repairTaskboardWorkflow.ts:22-23,52-55,116-125`；对照 `server/src/taskboard/storeHelpers.ts:231-245`
- **触发路径**：对某 remediation task 使用 `--task-id=<remediation-id>`；该查询的 alias `t` 实际是 delivery，因此过滤不到 finding。另，repair 接受最长 41 字符 prefix，而 Store 只接受最多 23 bytes，PostgreSQL 还会截断超长 identifier。
- **实际后果**：定向 repair 可漏修目标；超长 prefix apply 可能查询截断后的意外对象或产生难以诊断的表名碰撞风险。
- **建议修复**：各 finding 明确定义 scope alias，remediation finding 同时按 `r.id`/root delivery 显式处理并在报告中注明；直接复用 `sanitizeIdentifier` 与 `TASKBOARD_TABLE_PREFIX_MAX_LENGTH`。
- **建议测试**：分别以 delivery/remediation/integration task-id 定向扫描，断言只命中预期聚合；24+ byte prefix 必须在连接 DB 前拒绝。

### P2-4：新增测试未覆盖关键事故并发与迁移，且 4 个 PG 测试全部被环境跳过

- **位置**：`server/src/__tests__/taskboardWorkflow.pg.test.ts:17-24,79-120,120-209,211-282`；`server/src/taskboard/workflow/decider.test.ts:27-77`；`server/src/taskboard/workflow/commandService.test.ts:42-100`
- **触发路径**：无 `TEST_DATABASE_URL` 时整套 4 个 workflow PG 测试 `describe.skip`；TASK-69 用顺序 SQL 人工置 done/fence，不运行 stale 与 finalize 的并发代码；D-R-S-I 直接插入 attempt，仅测单轮 happy path；command service 通过 mock SQL 测 helper。
- **实际后果**：本轮实际未验证 PostgreSQL DDL/约束/规则、真实事务锁序、deadlock、TOCTOU、唯一索引、cancellation outbox worker、unknown reconcile、重复/late resolution 并发以及 repair SQL。33 个定向非 PG 测试通过不能证明这些风险已关闭。
- **建议修复**：CI 将 workflow PG suite 设为必跑，缺少 URL 时 fail 而非 skip（本地可保留显式 opt-out）；新增双连接 barrier/可控 provider 的事故测试及 schema migration-from-dirty-data 测试。
- **建议测试**：至少覆盖 P1-1 至 P1-7 中列出的 PG 场景，并验证 deadlock SQLSTATE、最终状态、outbox 条数和 provider 调用次数。

---

## 亲自核对的关键不变量与证据

1. **Resolution 单行唯一性已具备 DB 基础**：`server/src/taskboard/v2Schema.ts:208-225` 以 `execution_id` 为 PK、`resolution_id` UNIQUE；`resolveExecutionV2` 按 Task→Execution 加锁（`server/src/taskboard/v2Store.ts:555-570`），并在同事务写 Resolution/Task/comment/change。
2. **正常 current receipt 的 execution/attempt/purpose/workflow/fence 精确校验成立**：`server/src/taskboard/workflow/commandService.ts:157-194`；late merged audit 只允许 receipt fence 不大于当前 fence，且仍绑定 execution/attempt/purpose。
3. **runtime completion 不再为 protocol V2 自行推进 Task**：`server/src/taskboard/executionCompletion.ts:21-24`；无 Resolution 的成功 run 会转为 protocol incomplete failed，merge fact 存在时不会执行 retry 状态回退（`server/src/taskboard/storeExecutionLifecycle.ts:305-357`）。
4. **正常 merge finalize 的 D-R-S-I 主事务覆盖较完整**：`server/src/taskboard/integrationOperations.ts:523-683` 同事务更新 source、delivery、remediation tasks/attempts、integration task、authorization/lane并 fence 相关 executions；当前 merge execution被保留以提交 ignored canonical Resolution。
5. **provider merge 调用不持有长数据库事务**：operation 先 prepared/executing，再在事务外调用 provider（`server/src/taskboard/integrationOperations.ts:122-170,404-480`），未知结果进入 reconcile；但 P1-4 的调用前重验证仍缺失。
6. **cancellation outbox 是持久化的**：fence 与 outbox/change 同事务（`server/src/taskboard/workflow/commandService.ts:117-153`），reconcile worker 会投递 runtime cancellation（`server/src/taskboard/executionService.ts:412-443`）。
7. **advisory 主要能力隔离已落实**：decider 仅允许 work completed/blocked；claim 不要求 repository；branch/PR/create follow-up/legacy move 的 Agent 路径均有拒绝逻辑。
8. **repair 默认 dry-run、参数化 scope、repair-log 幂等基础成立**：`--apply` 才开写事务，task/board 值均走参数，prefix 有字符白名单，command hash + repair log 防止同一 finding 重放；但 P1-7/P2-3 使其作用域和审计结果仍不完整。
9. **唯一允许的本地验证结果**：定向 Vitest 33 passed、4 PG skipped；`pnpm -F server typecheck` 通过；`git diff --check` 通过。没有连接或修改任何数据库/外部系统。

## 未验证风险（由 PG 跳过直接导致）

- 所有新增 DDL 在真实 PostgreSQL 上的执行、重复 init 幂等、脏库升级与索引是否真实存在。
- Task/Source/Execution/Operation 的锁等待与死锁行为，尤其 TASK-69 stale×merge 和 cancellation×prepare。
- Resolution 的并发唯一冲突、late/duplicate write、fence/outbox 原子性。
- unknown merge reconcile 与 cancellation outbox 的多 worker claim/重试行为。
- repair dry-run/apply 的真实 SQL 作用域、事务回滚、provider_receipt-only 与重复 active source 场景。
