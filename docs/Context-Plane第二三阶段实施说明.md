# Context Plane 第二、三阶段实施说明

> 分支：`feat/context-plane-phase2-3`  
> 基线：`origin/main@0352dfd4`  
> 状态：Phase 2/3 后端实施完成，待独立 PR 与 PostgreSQL 16 CI；本文只记录仓库中真实实现，不把未部署能力写成已上线。

## 1. 目标与硬边界

Phase 2 把业务系统中的原生业务对象接入 Context Plane，保留稳定 native ID、source locator、ACL、版本、删除/撤权和事件时间。Phase 3 在 PostgreSQL 中建立可重建的确定性实体、结构化派生项、证据、有效期、冲突/替代、用户纠正和工作画像。

持续遵守以下边界：

- 主 Agent 只有检索与证据读取能力；同步、投影、纠正 reducer 由后台 worker/受控 API 写入。
- `tenantId/userId/collection scope` 只由认证与治理 Assignment 在服务端计算；客户端或模型参数不得扩大。
- 原生系统授权与治理 Assignment 取交集，未知 source authorizer 或授权服务异常时 fail closed。
- 原始业务证据不写入个人 `MEMORY.md`；企业派生事实仍以 PostgreSQL 为权威。
- 不用图数据库，不按姓名、手机号或公司名自动合并实体，不直接复用 MyContext prompt/代码。
- 自然语言抽取只能产生 `proposed` item；没有有效 Evidence 或未经确认时不进入默认 Recall。
- 本 PR 不包含 Phase 4、部署或生产 migration 执行。

## 2. 已核验的真实数据源

### 2.1 Agent-SaaS 内部源

- Taskboard Board / Task / append-only change seq：真实 PostgreSQL 数据，可分别映射为 Project、Task 和 event。
- 组织成员目录：真实 User + governance membership，可映射 Person；仅投影 userId、展示名、岗位、角色、状态等白名单字段。

### 2.2 Azeroth 业务源

2026-08-23 使用当前登录用户权限只读执行线上 `azeroth describe`，确认以下实体均具有稳定原生 ID，CRM/项目类对象具备 `version/updatedAt/deletedAt`：

- `customers`、`contacts`、`opportunities`、`keep-records`；
- `projects`、`project-tickets`、`effort-records`；
- `employees`、`dingtalk-logs`、`dingtalk-calendar-events`；
- `sales-action-items`、`web-events`。

`approval-flows` 也有只读合同，但其对象是审批流定义，不是钉钉审批实例，因此不能用它冒充“审批持续同步”。

线上 query 暂无 `updatedAfter/cursor`，因此适配器只能做稳定分页的完整 inventory，并且必须等所有页面成功后才传播“缺失即 revoked”；不能把半页结果当权威删除清单。租户同步只使用服务端明确标记为 ADMIN 的 Azeroth binding；PAT 不进入 Context 内容、Evidence、日志或模型可见面。

钉钉审批与待办仍没有已核验的持续同步合同，本阶段不以 CLI 词典冒充 Connector。

## 3. Phase 2 数据合同

统一定位器只统一“如何定位”，不统一不同系统 ID 的值：

```ts
interface ContextEntityLocatorV1 {
  tenantId: string;      // 服务端注入
  sourceId: string;
  collectionId: string;
  entityType?: 'customer' | 'project' | 'person' | 'meeting' | 'task';
  nativeId: string;      // 上游稳定 ID，原样保留
}
```

typed envelope 由 `entityType / recordKind / nativeId / occurredAt / sourceEventId / ownerPrincipal / aclPrincipals` 组成。ACL/owner/业务时间变化也属于新 revision；ACL principals 规范化去重排序，避免顺序变化产生虚假 revision。

删除语义：

- 上游 `deletedAt` 或明确 delete change：`deleted=true` tombstone；
- 授权撤销、成员停用、完整 inventory 中确认缺失：`revoked=true`；
- archive/status 变更仍是普通 snapshot revision；
- 不 hard-delete record/revision/evidence/outbox 审计链。

## 4. Phase 3 数据合同

实体类型为 Person / Customer / Project / Meeting / Task，只能由上游稳定 ID 确定性创建。跨源 `same_as` 必须有 Evidence 和明确审核，禁止名称或手机号自动融合。

派生项类型为 Decision / Status / Task / Risk / Commitment，记录：

- subject entity、semantic key、结构化 value 与 search text；
- `valid_from / valid_to / occurred_at / observed_at`；
- derivation method、authority rank、review state、lifecycle state；
- conflict group、supersedes/conflicts/corrects links；
- 完整 source revision/evidence 复合定位。

用户纠正采用 append-only review：不篡改源事实。个人 correction 只对本人 scope 生效；组织 correction 需要服务端 role gate。相同语义键的新源 revision 替代旧项，跨源同时有效但值不同时并存为 conflict，不用“最后写入”猜真相。

工作画像 facet 固定为 role / tasks / workflow / artifacts / knowhow；每条 facet 独立绑定 Evidence，可局部撤权和重建，不生成不可解释的大段 persona。

## 5. 运行时与产品接线

### 5.1 持续同步

仅 scheduler worker 启动 Phase 2/3 supervisor；Web 进程不重复采集。Taskboard、Directory 和确定性 projector 默认每 60 秒运行一轮，Azeroth 完整 inventory 默认每小时一轮，进程退出时停止定时器并等待在途轮次 settle。

首次发现 Collection 时只创建空 Assignment set，不自动授权任何用户：

- Taskboard：Board → Project snapshot，Task → Task snapshot，append-only change → event；
- Directory：membership 是成员状态的权限事实，User 只补安全展示字段；
- Azeroth：12 类已核验实体做完整分页 inventory；`web-events` 仅接入销售意向 allowlist，pageview、阅读进度、bot 和浏览器标识不进入 Context。

完整 inventory 任一页失败时不传播缺失撤权；401/403 会把 partition 标为 refused，Recall 对 refused Collection 直接返回零 payload，而不是只标“数据可能过期”。

### 5.2 派生消费与 Recall

`context-deterministic-projector-v1` 使用 durable cursor、lease owner 和单调 fence 消费 Context outbox。Consumer 的后台状态进入现有 Context Center 管理快照；界面显示 sequence lag 数量，不把 seq 差伪造成秒数。

默认 Agent Recall 已读取 confirmed、active、有效期内且精确绑定当前 source revision 的派生项。它继续先执行 Assignment、DWS policy 或原生 source authorizer；派生项只作为已授权原始 hit 的 Evidence-bound 增强，不能单独扩大命中范围。proposed、rejected、已过期、Evidence 撤权、多记录混合证据项均不进入该路径。

Timeline service 基于 revision/event time、稳定签名 cursor 和 `sourceEventId` 去重；查询同时检查当前 record 未删除/未撤权，避免历史 revision 绕过当前撤权。DWS 暂不进入 Timeline，直到能够复用完整 DWS policy。

### 5.3 当前刻意不开放的面

本 PR 不提供独立的 Timeline UI/API、实体浏览器、画像 UI 或 correction 表单。`appendReview`、profile reducer 和 proposed validator 是 PostgreSQL 领域能力；在专用 API 能同时执行 Assignment 与原生 ACL 之前，不直接暴露这些 Store 方法。当前也没有自动 LLM distill worker，因此不会凭空产生 proposed item。

## 6. 安全验收矩阵

- cross-tenant、other-owner personal board、unknown source、authorizer error：零 payload 泄漏；
- assignment deny 覆盖原生 allow；session assignment version 漂移拒绝；
- Taskboard organization board 同租户可见，personal board 仅 owner；成员 role 不扩大 personal board 读取；
- 被删除 snapshot 不出现在 Recall，原本有权用户仍可查看 delete event；
- Azeroth employee ACL 仅由服务端 credential binding 解析，不接受模型提交 employeeId；
- LLM candidate 引用不存在、跨租户、撤权 evidence 或 quote 不能精确回原文时拒绝；
- proposed/rejected item 不进入默认 Agent Recall；
- Person 通用投影不包含手机号、password hash、权限明细或 connector secret。

## 7. 验证、运维与发布

所有新表通过官方 governance migration ledger 的 v25 additive migration 注册。当前工作区已通过 server/shared/web typecheck、全量测试与 coverage、server/web build、ratchet、API boundary、scenario lint/sanitize、OSS build 和 Web startup budget。Web coverage 在默认 5 秒用例上限下两次出现不同 UI 交互用例假红，均可单测复现通过；coverage 命令现显式使用 15 秒上限，完整 coverage 已转绿。

当前环境没有 `TEST_DATABASE_URL`，因此 PostgreSQL integration tests 被明确 skip，完整 `preflight:pr` 也无法在本地执行。PostgreSQL 16 CI 仍必须验证 tenant-first FK、v25 幂等 migration、lease/fence、重放、删除/撤权、冲突/纠正、派生 Recall SQL 和跨租户拒绝；CI 未绿不得合并。

本分支只创建 schema 与代码；未经单独确认不执行生产 migration、不部署、不合并。
