# Taskboard Integration Workflow v3 — Candidate 正式规格

> **部署前数据库演练（强制）**：v3 schema 使用版本化、事务化 expand migrations，但仓库测试不代表生产量级验证。每次部署前必须在最新生产副本上演练并记录锁等待、执行时长、表膨胀与回滚步骤；未完成副本演练不得在生产执行。本文档不声称已取得生产量级结果。

## 1. 版本路由

`tasks.workflow_version` 是 integration task 的持久化、不可变单写者分流键。

- 迁移前和未显式指定的任务为 `2`；旧数据通过 `NOT NULL DEFAULT 2` 回填。
- 新 v3 批次必须在插入 integration task 的同一事务中写入 `workflow_version=3`。
- 创建后修改该字段由数据库 trigger 拒绝（`TASKBOARD_WORKFLOW_VERSION_IMMUTABLE`）。
- v2 worker 只处理 `workflow_version=2`；v3 worker 只处理 `workflow_version=3`。未知版本 fail closed。
- rollback 版本可读取、冻结、reconcile 或 cancel v3，不得把 v3 任务派给 v2 Merge Agent。

当前变更只提供 schema/模型/store 基础；批次创建器、decider、trigger、repair、API/UI 的完整路由接线属于后续接口（见第 8 节）。

## 2. 权威模型与计数语义

一个 v3 integration task 对应一个稳定 `candidate`、一个稳定 branch、至多一个稳定 Integration PR。Candidate 是流程权威；task/source 仅是投影。

- `candidate.current_revision`：candidate subject 每次变化后递增；revision 从 1 开始，永不覆盖。
- `candidate.work_round`：Review 退回或冲突处理触发的一轮语义工作；从 0 开始，仅 `beginNextWorkRound` 增加。
- execution retry：仍由 execution attempt/trigger 表达，绝不增加 revision 或 work round，除非重试实际产生了新 subject 并追加 revision。

三者不得互相推导或复用。

### 2.1 Candidate

`*_taskboard_integration_candidates` 保存稳定身份、当前 revision、状态、fence（workflow/lane epoch）、policy、批准和 merge 投影。`integration_task_id` 唯一，`(repository_id, branch)` 唯一，PR 在仓库内唯一。

### 2.2 Candidate Revision

`*_taskboard_integration_candidate_revisions` 是不可变 subject 快照，主键 `(candidate_id, revision)`。记录 base/head/tree、source-set、merge method、policy snapshot digest、work round 和可选 execution 关联。UPDATE/DELETE 由 trigger 拒绝。

### 2.3 Candidate Source Snapshot

`*_taskboard_integration_candidate_source_snapshots` 按 revision 冻结有序来源，至少包含：source/task/version、PR、frozen head/base、原 review execution/receipt digest、reviewed subject digest、需求摘要 digest。它同样不可变。

每个 revision 的来源顺序必须是从 0 开始的连续整数，来源 ID 不得重复，且全部属于 candidate repository。Store 在计算 digest 和写入前校验；数据库保证每 revision 的 order/source 唯一。

## 3. Digest 协议

所有 digest 使用 `sha256:<lowercase hex>`，输入采用递归 key 排序的 canonical JSON，并带 domain 与整数版本。当前唯一版本为 `1`；改变字段、规范化或相等语义必须新增版本，不得静默修改 v1。

- `taskboard.integration-source-set/v1`：覆盖有序 source snapshot 全字段（除 candidate/revision/createdAt）。
- `taskboard.integration-policy-snapshot/v1`：覆盖完整 policy snapshot。
- `taskboard.integration-candidate-subject/v1`：覆盖 repository ID、base branch、base OID、head OID、tree OID、source-set digest、merge method、policy revision、完整 policy snapshot 及其 digest。

数组顺序有意义；空 source set、重复 source、非连续 order、`undefined`、非有限数值均拒绝。Review receipt 必须绑定 `candidate_id + revision + subject_digest + source_set_digest`。最终 merge 前必须重新读取 provider 并核对 base/head/tree/source-set/policy/lane/workflow epoch；任一变化使批准失效。

## 4. 状态转移

所有 command 必须锁 candidate，并以 `(candidate.version, candidate.current_revision, from_state)` 做 CAS。失败返回 `TASKBOARD_CANDIDATE_CAS_MISMATCH`，不得盲重试远端副作用。

| From | Command / event | Guard | To | Side effect / compensation |
|---|---|---|---|---|
| preparing | start compose | v3 task、lane/workflow epoch 有效 | composing | prepare provider intent；unknown 仅 reconcile |
| preparing | block/cancel | 有原因或有效取消 fence | blocked / needs_human / canceled | revoke capability；取消不得删除审计快照 |
| composing | compose clean | revision 已追加 | waiting_checks | 等待 authoritative checks |
| composing | conflict | revision 已追加或冲突证据已保存 | needs_work | 不创建 remediation task |
| waiting_checks | checks green | required checks 已知且全绿 | in_review | 派发绑定当前 revision 的 Review |
| waiting_checks | checks failed | 可由 Work 修复 | needs_work | 保留 branch/PR |
| waiting_checks | unsupported/timeout | fail closed | blocked / needs_human | 保存事实和恢复条件 |
| needs_work | begin work round | CAS；无活动 canonical Work | working | `work_round += 1`；execution retry 不递增 |
| working | subject refreshed | 新 immutable revision 已追加 | waiting_checks / in_review | 旧批准自动清空 |
| in_review | approved | review execution 绑定当前 revision | approved | 保存 approved revision/execution |
| in_review | changes requested | canonical review receipt | needs_work | 这是事件，不是持久状态 |
| in_review | stale/blocked | subject/fence 不符或需人工 | needs_work / blocked / needs_human | 迟到回执记 ignored，不改权威状态 |
| approved | base/policy/source 漂移 | 新 compose 必需 | composing | 清空批准，追加新 revision 后重跑 CI/Review |
| approved | merge intent prepared | merge kill switch 开启；批准仍新鲜 | merging | provider ledger: prepare → execute |
| merging | provider receipt verified | merged tree 等于 approved tree | merged | 原子收敛 task/source/lane；cleanup 异步 |
| merging | unknown / unverifiable | 只能 reconcile | merging / needs_human | 禁止释放 lane 或标记 done |
| blocked | resume | decision + 新 workflow epoch；重新取得 lane | preparing / composing / needs_work / in_review | 强制刷新 base 与批准有效性 |
| needs_human | acknowledged/retry/cancel | 人工 decision 或有效取消 | blocked / composing / canceled | 不交回 v2 |
| merged / canceled | any workflow command | terminal | — | 拒绝 |

通用的 `blocked`、`needs_human`、`canceled` 转移仅允许表中及代码 transition matrix 明示的来源状态。

## 5. 核心不变量

1. workflow version 创建时确定且不可变；candidate 只能关联 v3 integration task。
2. branch、repository、integration task 和 provider PR 是 candidate 稳定身份；revision 不创建新 PR。
3. revision/source snapshot 只追加，不 UPDATE/DELETE；历史批准永不重写。
4. `approved_revision === current_revision` 且 approved review execution 同时存在；追加 revision 自动清空批准。
5. `merging` 只接受当前 approved revision；`merged` 必须带 provider merged commit OID，并验证 merged tree。
6. source set 有序、非空、同仓库、无重复；source task version 和原 review receipt 被冻结。
7. policy snapshot、merge method、base/head/tree 都是 subject digest 的一部分。
8. candidate revision、work round、execution retry 独立。
9. 迟到 execution receipt、过期 workflow/lane epoch 和 CAS 失败只能记 ignored。
10. provider `unknown` 只能 reconcile；不得重发、释放 lane或推断失败。
11. cancel/archive/delete 不得破坏 revision 审计；v3 integration task 应先走 cancel，再按保留策略归档。

## 6. Store 契约

`IntegrationCandidateStore` 提供最小接口：

- `create`：仅接受已以 v3 创建的 integration task。
- `appendRevision`：事务内写 revision + source snapshots，并 CAS 推进 current revision、撤销旧批准。
- `beginNextWorkRound`：只从 `needs_work` 进入 `working` 并独立递增 work round。
- `transition`：执行白名单状态转移与 approval/merge receipt guards。
- `getByIntegrationTask` / `listRevisions`：读取当前权威对象及完整历史。

所有写操作自带数据库事务；provider 写操作不应直接包在该事务中，而应由后续 operation ledger 按 prepare/execute/reconcile 协议衔接。

## 7. CI 门禁解析

门禁优先级固定为：GitHub branch protection / rulesets 声明的 required checks → 看板 `integrationPolicy.ciPolicy.requiredChecks` → 未配置。

- 看板 fallback 按看板与仓库配置隔离，可为每个 context 额外指定 GitHub App ID。
- 只有 GitHub 已权威确认 required checks 为空时才使用 fallback；GitHub 策略不可判定、存在不支持规则或要求 merge queue 时继续 fail closed。
- 任意 observed optional check 都不会自动成为 required check。
- 两层均为空时返回 `TASKBOARD_CI_UNCONFIGURED`，提示配置 GitHub 门禁或看板 fallback；它不是普通 pending。

## 8. v2 兼容

现有 integration source 状态、remediation、Merge Agent schema 和 execution purpose 均未删除或改义。现有批次创建路径未指定 v3，因此继续落为 workflow v2。新增表和索引采用 expand-only、`IF NOT EXISTS` / 可重复 trigger 安装，v2 读写路径不依赖 candidate 表。

## 9. 生产启用条件

v3 默认关闭；只有显式配置并通过全部激活探针后才承载批次：

- `integrationV3ControlPlane.enabled=true`，配置 server-owned `controlledMirrorRoot`。
- 配置固定 GitHub App installation ID，以及 App ID 和私钥的 Secret Vault 引用；v3 不接受用户 PAT 或通用 connector token。
- 正式 server 镜像必须包含受支持的 Git；所有 mirror/worktree 操作统一经过 safe Git runner。
- ACS runtime isolation attestation 必须通过真实 network-policy probe；配置布尔值不是证明。
- gateway、worker、mirror、GitHub App 或 attestation 任一不可用时，v3 admission 与 readiness 均 fail closed。
- Work/Review Runtime 不持有 GitHub、SSH 或控制面原始凭据；所有 provider 写操作由 Integration Engine 经 operation ledger 执行。

v2 路径不依赖上述配置；v3 未配置或显式关闭时健康状态为 `not_applicable`，不得影响全站 readiness。
