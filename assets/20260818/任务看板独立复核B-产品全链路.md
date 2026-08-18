# 任务看板独立复核 B：产品全链路

- 复核角色：独立复核工程师 B
- 基线：`ed7f65db82900c6a10ef804191bd544a872c20b3`
- 范围：共享类型、PostgreSQL schema/迁移、REST、Agent tool、repo/PR 门禁、RBAC、Execution/Resolution/Integration 状态机、Web、历史修复脚本与测试
- 方法：直接审阅当前工作树相对基线的源码与测试，并独立执行只读验证；未以实施报告结论作为依据
- **Verdict：`reject`**
- **问题计数：P0 0 / P1 3 / P2 6（合计 9）**

## 结论先行

核心方向基本正确：`advisory` 已进入共享 union、DB CHECK 迁移、REST/Agent schema、创建/查询/筛选、workflow contract 与 Web；普通用户通过公共 create 伪造 `integration/remediation` 被 store 拒绝；delivery 的 PR/subject 门禁仍在；remediation approved 的 decider 目标为 `done`；integration 评论新建 execution 固定为 `merge`；Task / Execution / Resolution 已分区展示；done/canceled/merged 的继续入口被隐藏或后端拒绝。

但当前仍有三项应阻断合并的产品/一致性问题：integration 恢复 UI 会无选择地恢复全部 `needs_human` 来源；取消批次后的交付任务被投影为永久 `claimed`，与服务端允许重新建批次冲突；execution claim 的幂等命中发生在可变状态校验之后，终态重放会失败。另有旧数据 Resolution 空白、跨任务来源数据残留、修复脚本定向过滤、关系导航、创建状态契约和真实 PG 验证等缺口。

---

## P0

无。

## P1

### P1-1 integration 阻塞恢复 UI 会一次性恢复所有 `needs_human` 来源，无法做 source-level 决策

- **位置**：`web/src/components/TaskBoard/TaskDetail.tsx:355-379`；按钮文案见 `web/src/components/TaskBoard/TaskDetail.tsx:533-545`
- **证据**：`resumeBlocked()` 直接将 `integrationSourcesState.sources.filter(state === "needs_human")` 的全部 ID 传给 `POST /resume`。用户只能填写一段通用 decision，不能勾选/逐项确认来源。
- **用户可见后果**：一个批次中若仅准备恢复部分 PR，点击“显式恢复阻塞来源”仍会把全部人工阻塞来源改为 `pending`，后续 merge execution 会重新处理所有来源。API 虽要求显式 `sourceIds`，但 Web 将“显式”退化成“全选”。
- **修复建议**：在来源卡片上提供仅对 `needs_human` 可选的复选框，恢复弹窗明确列出 PR/交付任务/错误原因；默认不选或要求二次确认，不得自动全选。提交后只刷新并展示选中来源。
- **对应测试**：新增 TaskDetail 集成恢复测试：2 个 `needs_human` + 1 个 merged，选择其中 1 个后断言 API 仅收到该 sourceId；取消弹窗不得发请求；done/canceled 不展示入口。

### P1-2 取消集成批次后，交付任务仍被投影成 `claimed`，Web 无法重新选择；与服务端语义矛盾

- **位置**：`server/src/taskboard/storeTaskAccess.ts:65-80`、`server/src/taskboard/storeSearch.ts:22-53`、`server/src/taskboard/storeHelpers.ts:72-78`；对照 `server/src/taskboard/v2Store.ts:210-224`
- **证据**：任务关系查询不排除 `canceled` source；`taskMergeEligibility()` 只要存在 `integration_source_id/integration_task_id` 就返回 `claimed`。但新建批次的重复校验明确排除 `merged,canceled`，说明 canceled source 本应允许再次入批。
- **用户可见后果**：取消批次后，delivery 仍显示“已进入集成…不可重复选择”，卡片没有选择框，维护者无法从 Web 重新建立人工集成批次；同一任务在直接 API 与 UI 中的候选资格不一致。
- **修复建议**：统一候选定义。若 canceled 后允许重试，关系投影应保留历史关系但 `mergeEligibility` 不得因 canceled 变成 claimed，并应明确显示“上次批次已取消，可重新选择”；自动候选查询也应采用同一 active-source predicate。若产品决定 canceled 永不重试，则反向收紧 `createIntegrationBatch`，不要让 API 与 UI 分裂。
- **对应测试**：PG/store 测试创建并取消 integration 后，断言 list/get/search 三条路径的 `mergeEligibility` 一致；Web 测试断言任务可重新勾选；API 测试验证同 PR 是否允许/禁止重建与产品决策一致。

### P1-3 Execution claim 的幂等 early return 位于终态/状态机校验之后，合法重放会失败

- **位置**：`server/src/taskboard/storeExecutionLifecycle.ts:47-75`
- **证据**：`assertExecutionRequestAllowed()` 在查询重复 `executionId/runId` 之前执行。原请求已成功且任务后来进入 done/canceled/merged/blocked 时，同一个幂等键重试会先抛 `TASKBOARD_TERMINAL_EXECUTION_FORBIDDEN` 或状态错误，无法返回已有 Execution。直接创建+执行使用稳定的 `direct-${taskId}`，因此丢失首次 HTTP 响应后重放尤其容易触发。
- **用户可见后果**：网络超时后的安全重试可能从“已创建/已执行”变成 400；调用方无法判断首次请求是否成功，破坏幂等契约并可能显示错误状态。
- **修复建议**：保留 tenant/board 可见性、角色与请求身份校验在前；随后先按 id/runId 查重并校验 taskId、purpose、配置身份等不可变字段，一致则返回已有记录；仅新建路径再执行当前 Task 状态、版本和 active execution 校验。
- **对应测试**：同一 `executionId/runId` 在任务依次变为 in_progress、blocked、done、merged 后重放均返回同一 execution；不同 task/purpose/identity 仍拒绝；无重复键时终态仍拒绝。

## P2

### P2-1 切换 integration 任务或加载失败时会保留上一任务的来源数据

- **位置**：`web/src/components/TaskBoard/IntegrationSources.tsx:8-35`
- **证据**：taskId 变化后只 `setLoading(true)`，没有清空或按 taskId 缓存 sources；catch 也只写 error，不清空旧 sources。
- **用户可见后果**：从一个集成任务切到另一个时，会短暂显示前一个任务的 PR、错误和 merged commit；若新请求失败，旧数据会与错误并存。阻塞恢复逻辑还会读取这份旧 sourceIds，虽然后端通常会拒绝，但交互会产生误导和无效请求。
- **修复建议**：状态绑定 taskId/request token；taskId 变化立即清空或展示 skeleton，忽略过期响应；失败时不展示旧任务数据，并禁用恢复按钮。
- **对应测试**：延迟 A 请求后切换 B，确保 A 的晚响应不能覆盖 B；B 失败时来源为空且有 alert；恢复按钮不使用 A 的 sourceIds。

### P2-2 旧 Execution/旧 resolution change 没有回填 canonical Resolution，三层 UI 会显示“尚未提交”

- **位置**：`server/src/taskboard/v2Schema.ts:194-275`、`server/src/taskboard/storeExecutions.ts:27-43`、`web/src/components/TaskBoard/TaskDetail.tsx:620-629`、`server/scripts/repairTaskboardWorkflow.ts:88-97,166-169`
- **证据**：迁移只新建 resolutions 表；Execution 列表只 LEFT JOIN 该表。修复脚本检测 `execution.resolved(.v2)` 重复项，但把 `duplicate_legacy_resolution` 全部跳过，也没有把唯一历史 change 投影成 Resolution。
- **用户可见后果**：升级前已经完成且有结构化 change/评论的任务，在新“业务结论（Resolution）”区显示“尚未提交结构化业务结论”，历史审计体验退化。
- **修复建议**：设计一次性、可审计的历史投影：对可唯一绑定 execution/runId 的 v2 change 生成 synthetic/canonical historical Resolution；无法可靠绑定的记录显示“历史结论（未迁移）”，不要显示“尚未提交”。
- **对应测试**：迁移前 fixture 含单条/重复/残缺 legacy resolved change；迁移后单条可展示，重复/残缺进入明确异常态且不伪造 applied。

### P2-3 修复脚本的 `--task-id` 在关联查询中绑定了错误任务别名

- **位置**：`server/scripts/repairTaskboardWorkflow.ts:51-55,116-149`
- **证据**：全局过滤固定为 `t.id=$n`；`mergedRemediations` 中 `t` 是 root delivery，而 finding 的 `taskId` 是 remediation `r.id`。因此对 remediation ID 执行 `--task-id` 会漏掉其 merged-remediation 收敛问题。duplicate source 查询也只按 delivery 过滤，不能按 integration/remediation 定向审计。
- **用户可见后果**：运维人员以报告中的 remediation taskId 定向 dry-run/apply 时可能得到 0 finding，误以为已修复；全库模式才可能命中。
- **修复建议**：每类查询显式定义 scope predicate（当前任务、root delivery、integration、remediation 任一关联 ID）；审计输出记录 scope 命中方式。禁止用字符串 `replaceAll('t.','i.')` 复用 SQL alias。
- **对应测试**：为 delivery/integration/remediation 三类 ID 分别运行 dry-run，断言同一 incident 可被关联 ID 找到；无关 board/task 不得被修改。

### P2-4 原任务、remediation、integration 的关系有字段但页面不可导航，历史信息不足

- **位置**：`web/src/components/TaskBoard/TaskDetail.tsx:549-551`、`web/src/components/TaskBoard/IntegrationSources.tsx:84-101`
- **证据**：delivery 仅显示 integration UUID 文本；remediation 不展示 root delivery/integration 链接；integration 的修复历史只显示 `R{round} · state`，没有 remediation identifier/title/link，`remediationTaskId` 与 `rootDeliveryTaskId` 没有转成可操作关系。
- **用户可见后果**：用户无法从原任务追到批次、从批次打开修复任务、从修复任务返回原交付；同 PR 多轮修复只能看到轮次与英文 state，难以理解当前/历史责任链。
- **修复建议**：API 返回关联任务 identifier/title（或提供批量解析）；三类详情页展示面包屑/链接和“当前轮/历史轮/已 superseded”中文状态。
- **对应测试**：三类任务 fixture 验证双向导航、多个 remediation attempt、移动端不溢出、关联任务无权限/已归档时有降级文案。

### P2-5 创建弹窗提供后端明确拒绝的初始状态

- **位置**：`web/src/components/TaskBoard/TaskDialog.tsx:200-216`；对照 `server/src/routes/taskboard.ts:151-160`
- **证据**：弹窗枚举全部八态；未 dispatch 时后端只接受 backlog/todo，dispatch 时必须是 in_progress。用户可选择 in_review/ready_to_merge/blocked/done/canceled 并提交，必然收到 400。
- **用户可见后果**：新建 advisory/delivery 时出现看似合法但永远无法成功的选项；错误只在提交后暴露。
- **修复建议**：创建态只展示 backlog/todo，另以“直接执行”作为明确动作；若保留 in_progress，则强制 dispatch 且解释含义，其余工作流状态不应出现在创建控件。
- **对应测试**：逐一断言 UI 不提供非法状态；请求 payload 与 REST superRefine 完全一致；键盘操作与移动端选择同样受限。

### P2-6 关键 PostgreSQL 与负向权限/恢复场景没有形成可执行门禁

- **位置**：`server/src/__tests__/taskboardWorkflow.pg.test.ts:17-24,140-208`；`web/src/components/TaskBoard/TaskDetail.test.tsx:418-510`
- **证据**：本环境 4/4 PG tests 全部 skip；现有 PG 收敛用例把 source 人工设为 `pending` 后直接测试“merge 先到”，没有覆盖 remediation `approved -> done + waiting_remediation source -> pending`；Web 只测普通 blocked 恢复，没有测多来源选择；也未见 claim terminal replay、canceled source 候选、viewer/editor 伪造 internal kind 的端到端负向用例。
- **用户可见后果**：schema/CHECK/事务/CAS/partial unique index/repair apply 的真实行为没有在本次环境被证明，上述回归可在全绿测试下进入发布。
- **修复建议**：CI 提供隔离 `TEST_DATABASE_URL` 并禁止核心 PG suite skip；补齐负向 RBAC、幂等重放、多 source 恢复、remediation approved、旧数据迁移和 canceled 候选测试。
- **对应测试**：将上述场景纳入 required job；若无数据库应 fail-fast，而不是成功退出并显示 skipped。

---

## 重点链路复核结果

### Advisory

- 通过：shared union、REST create/list/search kind、Agent schema、DB CHECK 动态迁移、create/get/list/search 映射、repository 字段禁用、contract capabilities、`completed -> done` / `blocked -> blocked`、Web 创建与详情标签。
- 兼容：缺失 kind 的旧行在 `rowToTask` 回退为 delivery；旧客户端不传 kind 仍创建 delivery。
- 风险：旧历史 Resolution 未迁移，见 P2-2；真实 PostgreSQL schema/回放未执行，见 P2-6。

### Delivery PR / 权限 / 伪造

- 通过：work `ready_for_review` 要求 PR；review `approved` 要求 reviewed subject；attach/record 仅 delivery/remediation 且目的匹配；公共 create 在 store 层拒绝 integration/remediation；advisory 禁 branch/PR；integration 批次与恢复要求 maintainer，执行触发至少 editor。
- 通过：merge 操作只能绑定 active integration merge execution、authorization、lane 与 provider subject/check。
- 风险：claim 幂等 early return 顺序不正确，见 P1-3。

### Integration / remediation 收敛

- 通过：无 active integration execution 时评论创建 `merge`；terminal/merged/blocked 评论继续被拒绝；active formal execution 只 steering；remediation approved decider 为 done；merge fact 优先并 fence 活跃 execution；done/canceled UI 不展示恢复/继续入口。
- 风险：source-level 恢复 UI 全选，见 P1-1；canceled source 候选不一致，见 P1-2；关系 UI 与历史迁移不足，见 P2-2/P2-4。

### Task / Execution / Resolution UI

- 通过：三个区块语义分开；Execution 成功文案明确“只表示已提交结构化结果，不等于业务流程完成”，Task blocked 与 Resolution outcome 可同时展示；loading/empty/error 基本齐全；按钮有类型、label/aria-label，Sheet 移动端为全宽。
- 风险：跨 task source 残留见 P2-1；旧 Resolution 空白见 P2-2；关联关系不可导航见 P2-4；创建状态控件与 API 不一致见 P2-5。

## 独立验证

```text
pnpm typecheck
  PASS（server/shared/web）

pnpm -F server exec vitest run \
  src/taskboard/workflow/decider.test.ts \
  src/taskboard/workflow/commandService.test.ts \
  src/__tests__/taskboardContinuation.directExecution.test.ts \
  src/__tests__/taskboardRoutes.test.ts \
  src/taskboard/taskboardV2.test.ts
  PASS：5 files / 26 tests

pnpm -F web exec vitest run src/components/TaskBoard
  PASS：8 files / 61 tests

pnpm -F server exec vitest run src/__tests__/taskboardWorkflow.pg.test.ts
  SKIP：1 file / 4 tests（未设置 TEST_DATABASE_URL）

pnpm check:ratchets
  PASS：14 ratchet tests；max-lines/env-var budgets 通过

git diff --check ed7f65db82900c6a10ef804191bd544a872c20b3
  PASS
```

## 合并条件

至少修复并覆盖全部 P1；明确 canceled source 的产品语义并统一 API/UI/自动候选；在真实 PostgreSQL 上跑通 required incident playback 与 repair dry-run/apply；P2-2/P2-3 涉及历史可审计性，建议与 P1 同批完成后再重新复核。
