# 组织管理与平台管理生产问题修复实施方案

> **状态**：待实施
>
> **创建时间**：2026-09-04
>
> **问题来源**：生产环境页面反馈、生产版本代码审计、相关单元测试合同复核
>
> **审计基线**：生产版本 `8d58d7bba3a44b53580984963ae080b92621ec34`
>
> **适用范围**：设置中心「组织管理」「平台管理」、Governance API、Context Product、Entitlement、MCP、组织文件和自动化
>
> **与既有方案关系**：本文件是 `docs/plans/unified-organization-management.md` 的修复补充；涉及平台管理员授权、资源范围、组织隔离的规则以本文件为准
>
> **发布边界**：本文不授权修改 Workflow、推送、部署或修改生产数据；这些动作必须分别获得人工确认

---

## 一、目标与结论

本次不是修补单个报错，而是同时收口四类根因：

1. 平台管理员管理目标组织时，被错误要求具备目标组织 Membership 或 `org_admin`。
2. 存量和新建组织没有完整的六类资源范围基线。
3. 已退出平台目录的旧资源仍保留在组织范围中，但页面不提供移除入口。
4. 部分组织页面、请求和写接口没有真正绑定当前选择的目标组织。

修复完成后应满足：

- 平台管理员显式选择目标组织后，可以管理该组织的组织级资源，不需要加入目标组织，也不需要目标组织 `org_admin`。
- 组织管理员仍只能管理自己的组织。
- 平台管理员的组织管理权不会扩展为成员个人文件、个人记忆、个人凭证等私有数据访问权。
- 每个客户组织都有 `model`、`tool`、`connector`、`agent_template`、`skill`、`environment_template` 六类范围基线。
- `ark-agents/glm-5.2` 等已退出目录资源会显示为历史项，可通过正式预览、提交和审计流程移除。
- 文件、自动化、MCP、技能、Context/Timeline 等页面始终绑定当前目标组织，快速切换组织不会显示上一个组织的响应。
- 用户可以从错误提示中区分权限不足、缺基线、旧目录资源、版本冲突、预览过期和依赖不可用。

---

## 二、已确认问题与代码证据

| 编号        | 优先级 | 问题                                   | 已确认根因                                                                                                     | 用户影响                                         |
| ----------- | ------ | -------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| GOV-FIX-001 | P0     | 平台管理员读取 Context/Timeline 被拒绝 | `runtimeContextAdmin.ts` 查询目标组织 Membership，并要求有效 `org_admin`                                       | 平台管理员明明已选择目标组织，仍收到 403         |
| GOV-FIX-002 | P0     | 多个组织级写接口拒绝平台管理员         | Assignment、Policy、Memory、Agent、Credential 等路由分别硬编码 `org_admin`                                     | 页面可以打开或读取，但预览、保存失败             |
| GOV-FIX-003 | P0     | 智能体模板、技能、环境缺少范围基线     | `legacyScopes()` 只生成 `tool/model/connector`；组织创建流程不创建 Entitlement 基线                            | 页面提示“当前组织没有该资源范围基线，已禁止写入” |
| GOV-FIX-004 | P0     | 旧模型无法取消                         | 编辑器只渲染当前目录，旧 ID 不可见；检测到旧 ID 后又禁用预览                                                   | `ark-agents/glm-5.2` 永久阻断保存                |
| GOV-FIX-005 | P0     | 文件与自动化没有绑定目标组织           | `renderFiles()`、`renderAutomation()` 不接收 `tenantId`，布局复用当前用户 FileBrowser 和无组织参数 CronManager | 可能展示或修改错误作用域的数据                   |
| GOV-FIX-006 | P1     | 快速切换组织发生旧响应覆盖             | MCP、Skill 请求没有 generation、AbortController 或 tenant snapshot                                             | A 组织慢响应可能覆盖 B 组织页面                  |
| GOV-FIX-007 | P1     | 组织入口可迁移其他范围的 MCP           | 平台管理员 PUT 已有 Server 时可以改变 `tenantId`，服务端没有目标组织入口冲突校验                               | UI 只读约束可被绕过                              |
| GOV-FIX-008 | P1     | 页面吞掉权威错误码                     | 多处 `catch` 使用统一文案；Context 任意 403 均映射为 Context Center 无权查看                                   | 无法判断应修权限、数据还是依赖                   |
| GOV-FIX-009 | P2     | 平台页存在明确未交付写能力             | 多个路由固定返回 503，部分页面明确只读                                                                         | 用户把“尚未交付”误认为运行故障                   |

关键代码范围：

- `server/src/app/runtimeContextAdmin.ts`
- `server/src/context/product/service.ts`
- `server/src/routes/contextAdmin.ts`
- `server/src/routes/governanceAccess.ts`
- `server/src/routes/governanceAssignmentBatchRoutes.ts`
- `server/src/routes/governanceOrganizationAccessRoutes.ts`
- `server/src/routes/governanceMemoryRoutes.ts`
- `server/src/routes/governanceEntitlementRoutes.ts`
- `server/src/routes/governanceResources.ts`
- `server/src/routes/governanceAgentResourceRoutes.ts`
- `server/src/routes/governanceCredentialRoutes.ts`
- `server/src/routes/mcp.ts`
- `server/src/data/entitlements/store.ts`
- `server/src/data/tenants/provision.ts`
- `web/src/components/OrganizationGovernance/ResourceAccessEditors.tsx`
- `web/src/components/PlatformGovernance/PlatformGovernancePage.tsx`
- `web/src/components/OrganizationManagement/OrganizationManagementContent.tsx`
- `web/src/components/McpManager/index.tsx`
- `web/src/components/SkillManager/index.tsx`
- `web/src/layouts/DesktopLayout.tsx`
- `web/src/layouts/MobileLayout.tsx`
- `shared/src/lib/governanceApi.ts`

---

## 三、统一授权合同

### 3.1 服务端唯一事实源

新增共享的目标组织授权解析器，建议放在：

```text
server/src/governance/auth/targetOrganizationAccess.ts
```

建议接口：

```ts
interface TargetOrganizationAccess {
  actorUserId: string;
  actorTenantId: string;
  actorPersona: 'platform_admin' | 'org_admin' | 'member';
  targetTenantId: string;
  accessMode: 'platform_manage' | 'organization_manage' | 'effective_only';
}

async function resolveTargetOrganizationAccess(
  req: Request,
  targetTenantId: string | undefined,
  required: 'read' | 'manage',
): Promise<TargetOrganizationAccess>;
```

判定规则：

| 调用者     | 目标组织               | 组织级读取 | 组织级写入 | 是否查询目标组织 Membership |
| ---------- | ---------------------- | ---------- | ---------- | --------------------------- |
| 平台管理员 | 显式选择的有效客户组织 | 允许       | 允许       | 否                          |
| 平台管理员 | 未显式选择             | 拒绝       | 拒绝       | 否                          |
| 组织管理员 | 自己的组织             | 允许       | 允许       | 是，必须是有效 `org_admin`  |
| 组织管理员 | 其他组织               | 拒绝       | 拒绝       | 不得通过                    |
| 普通成员   | 自己的组织             | 仅有效结果 | 拒绝       | 是                          |
| 未登录用户 | 任意组织               | 拒绝       | 拒绝       | 否                          |

强制要求：

- 不得为了让平台管理员通过校验而给其伪造目标组织 Membership。
- 平台管理员请求必须显式携带目标 `tenantId`；禁止无目标时回退到平台自身组织。
- 所有写入命令、预览摘要、审计记录必须同时绑定调用者和目标组织。
- 前端不得通过角色字符串自行推导最终可执行动作；按钮状态以服务端 `allowedActions` 为准。

### 3.2 组织级管理与个人数据边界

平台管理员可以管理：

- 组织成员关系、组织管理员和所有者配置。
- 组织策略、资源范围、成员和群组资源指派。
- 组织智能体、组织技能、环境模板范围、组织级 MCP。
- 组织共享凭证的创建、轮换和托管人变更。
- 组织级 Context/Timeline、实体和待审核内容。
- 组织级文件清单、自动化任务和审计记录。

平台管理员不能因为上述权限而直接访问：

- 成员个人文件内容。
- 成员个人记忆正文。
- 成员个人凭证明文。
- 成员个人工作区和私人 Agent 内容。

个人数据只允许在既有、明确、可审计的支持或离职流程中处理，并继续遵守脱敏、预览和审批合同。

### 3.3 高风险操作

以下操作不要求平台管理员成为目标组织 `org_admin`，但必须保留增强保护：

- 所有者变更和最后一个有效所有者保护。
- 成员离职、跨成员资源交接。
- 组织暂停、恢复和删除。
- 内容访问授权及撤销。
- 共享凭证轮换、撤销和托管人变更。
- 跨作用域资源迁移。

统一使用：

```text
读取当前基线 → 影响预览 → 原因/二次确认 → 基线校验提交 → 审计回执 → 投影状态回读
```

预览签名至少绑定：

```text
actorUserId
actorTenantId
actorPersona
targetTenantId
commandDigest
baselineDigest
expiresAt
```

---

## 四、实施拆分

### PR 1：统一目标组织授权

#### 4.1 后端授权基础设施

任务：

- [ ] GOV-FIX-010：新增 `targetOrganizationAccess.ts` 和单元测试。
- [ ] GOV-FIX-011：Context Product subject 增加调用者身份和访问模式，平台管理员路径不再查询目标 Membership。
- [ ] GOV-FIX-012：组织管理员路径继续校验自身组织的有效 `org_admin`。
- [ ] GOV-FIX-013：平台管理员访问个人作用域时继续拒绝，补充负向测试。
- [ ] GOV-FIX-014：所有目标组织写入审计记录增加调用者组织、目标组织和平台管理模式。

Context 修改点：

- `server/src/routes/contextAdmin.ts`
- `server/src/app/runtimeContextAdmin.ts`
- `server/src/context/product/service.ts`
- `server/src/context/product/service.test.ts`
- `server/src/app/runtimeContextAdmin.test.ts`

现有测试中“平台管理员没有目标 Membership 时拒绝”的用例必须改为：

- 平台管理员没有目标 Membership，组织级 Context 读取成功。
- 平台管理员没有目标 Membership，组织级更正/审核在具备对应 `allowedAction` 时成功。
- 平台管理员访问个人 Scope 仍然失败。

#### 4.2 治理路由授权收口

逐个删除本地硬编码的 `persona === 'org_admin'`、`persona !== 'org_admin'` 和仅限当前用户 `tenantId` 的重复判断，改为调用统一解析器。

必须覆盖：

- [ ] GOV-FIX-020：单项 Assignment 预览和提交。
- [ ] GOV-FIX-021：批量 Assignment 预览和提交。
- [ ] GOV-FIX-022：组织策略预览和提交。
- [ ] GOV-FIX-023：组织记忆/知识策略预览和提交。
- [ ] GOV-FIX-024：组织智能体创建、更新、发布和状态变更。
- [ ] GOV-FIX-025：组织技能上传、更新、删除和提升。
- [ ] GOV-FIX-026：组织共享凭证创建、轮换、转移和健康检查。
- [ ] GOV-FIX-027：成员身份、所有者和离职流程。
- [ ] GOV-FIX-028：Entitlement API 返回与真实权限一致的 `allowedActions`。

不得改变：

- Entitlement 状态、组织生命周期等平台专属能力仍只允许平台管理员。
- 组织管理员仍只能操作自身组织。
- 个人资源仍按资源所有者和既有支持授权判断。

#### 4.3 PR 1 验收

- [ ] 平台管理员不在目标组织 Membership 中，仍能读取组织级 Context/Timeline。
- [ ] 平台管理员不在目标组织 Membership 中，仍能完成普通组织配置的预览和提交。
- [ ] 组织管理员跨组织读写均返回 403。
- [ ] 普通成员不能获得管理动作。
- [ ] 平台管理员不能读取成员个人 Context、文件、凭证明文和个人记忆。
- [ ] `allowedActions` 与相同请求的服务端写权限保持一致。
- [ ] 预览不能跨调用者、跨目标组织或过期复用。

---

### PR 2：范围基线、旧目录资源和生产修复工具

#### 4.4 六类资源范围常量

在 `server/src/data/entitlements/types.ts` 定义唯一常量并导出类型：

```ts
export const ENTITLEMENT_RESOURCE_TYPES = [
  'model',
  'tool',
  'connector',
  'agent_template',
  'skill',
  'environment_template',
] as const;
```

后端 Store、API schema、前端标签和测试都引用该事实源或共享派生类型，不再分别维护字符串集合。

#### 4.5 新组织初始化

调整 `server/src/data/tenants/provision.ts`：

- [ ] GOV-FIX-030：`TenantProvisioningOptions` 接入 Entitlement 初始化能力。
- [ ] GOV-FIX-031：创建组织时初始化 Entitlement Set、默认策略和六类范围。
- [ ] GOV-FIX-032：范围初始版本为 `1`，来源清楚记录为 provisioning/system。
- [ ] GOV-FIX-033：初始化失败不得被仅记录日志后忽略；组织创建回执必须反映失败并执行补偿回滚。
- [ ] GOV-FIX-034：`rollbackProvisionedTenant()` 同步清理已创建的治理数据。

安全默认值：

- 既有 `model/tool/connector` 延续当前旧配置投影值。
- 新增的 `agent_template/skill/environment_template` 默认使用 `selected: []`。
- 不得因为补基线自动切换为 `all`。

#### 4.6 存量组织幂等回填

调整：

- `server/src/data/entitlements/store.ts`
- `server/src/data/governance-schema/migrations.ts` 或新增下一版本 Governance migration
- `server/src/app/runtimeGovernanceStores.ts`
- `server/src/__tests__/entitlementStore.test.ts`
- `server/src/__tests__/governanceSchemaMigration.pg.test.ts`

要求：

- [ ] GOV-FIX-040：为每个非平台租户检查六类范围是否完整。
- [ ] GOV-FIX-041：仅插入缺失行，不覆盖任何已有行。
- [ ] GOV-FIX-042：不得提高已有范围版本，不得改写 `source = 'governance'` 的记录。
- [ ] GOV-FIX-043：记录扫描组织数、补齐行数、跳过行数和异常组织数。
- [ ] GOV-FIX-044：异常写入 Governance Migration Issue，支持后续人工处理。
- [ ] GOV-FIX-045：迁移可重复执行，第二次执行必须为零变更。

禁止在 GET API 或前端临时伪造不存在的范围记录；基线必须真实落入：

```text
*_tenant_entitlement_sets
*_entitlement_resource_scopes
*_entitlement_resource_items
```

#### 4.7 旧目录资源清理交互

组织页和平台页必须复用同一个范围编辑内核，避免两套行为继续分叉。

推荐新增：

```text
web/src/components/Governance/EntitlementScopeEditor.tsx
```

编辑器行为：

1. 当前目录资源按正常选项展示。
2. `scope.resourceIds - catalog.resourceIds` 作为“已退出目录”分组展示。
3. 历史项默认保持勾选，显示稳定 ID、危险提示和“移除”动作。
4. 提供“清理全部旧引用”，但不得自动执行。
5. 移除历史项后清空旧 preview/receipt，允许重新预览。
6. `mode = all` 时不提交资源 ID。
7. 目录为空不等于目录不可用；两种状态必须使用不同提示。

后端校验调整：

- 预览使用“提交后的目标集合”校验当前目录。
- 允许从现有基线中移除已经退出目录的 ID。
- 不允许新加入已退出目录或不存在的 ID。
- `baselineDigest` 必须绑定包含历史 ID 的旧基线，避免并发清理覆盖其他人的变更。
- 预览后目录再次变化时，提交返回明确冲突并要求重新预览。

必须覆盖：

- [ ] GOV-FIX-050：组织范围编辑器可移除一个旧 ID。
- [ ] GOV-FIX-051：平台组织详情范围编辑器具有相同行为。
- [ ] GOV-FIX-052：执行环境范围也使用相同编辑内核。
- [ ] GOV-FIX-053：旧 ID 未移除时允许用户继续编辑，但不能把旧 ID作为新授权重新提交。
- [ ] GOV-FIX-054：清理后刷新页面，旧 ID 不再出现，版本加一并展示审计回执。

#### 4.8 生产只读审计与修复脚本

新增脚本建议：

```text
server/scripts/audit-entitlement-resource-scopes.mts
server/scripts/repair-entitlement-resource-scopes.mts
```

审计脚本默认只读，输出：

- 组织 ID。
- 缺失的资源类型。
- 当前目录不存在的资源 ID。
- 当前范围版本、来源和更新时间。
- 计划补齐或清理的变更摘要。

修复脚本必须满足：

- 默认 `--dry-run`。
- 实际执行要求显式 `--apply`、目标组织和变更原因。
- 支持只补缺失基线、只清理指定旧 ID，不允许无边界全量写入。
- 使用事务、版本条件和 advisory lock。
- 执行前输出备份；执行后回读并输出审计/变更 ID。
- `ark-agents/glm-5.2` 不能写死为全局删除目标，应从审计结果或显式参数传入。

---

### PR 3：组织页面作用域、请求竞态、MCP 和错误治理

#### 4.9 文件与自动化作用域

修改 renderer 合同：

```ts
renderFiles: (tenantId: string, tenantName?: string) => ReactNode;
renderAutomation: (tenantId: string, tenantName?: string) => ReactNode;
```

任务：

- [ ] GOV-FIX-060：`OrganizationManagementContent` 始终传递目标 `tenantId`。
- [ ] GOV-FIX-061：桌面和移动布局不得把当前平台管理员用户名当作目标组织文件 Owner。
- [ ] GOV-FIX-062：实现组织级文件列表或只读汇总 API；只返回组织所有资源或脱敏元数据。
- [ ] GOV-FIX-063：CronManager 增加显式目标组织参数，列表和写入均绑定目标组织。
- [ ] GOV-FIX-064：后端拒绝平台管理员无显式目标组织的组织文件和自动化请求。
- [ ] GOV-FIX-065：不存在安全的组织级 API 时，页面必须显示“能力尚未交付”，不得回退到个人组件。

#### 4.10 目标组织请求竞态

为所有目标组织请求建立统一规则：

- 每次 `tenantId` 变化增加 generation，或取消上一次请求。
- 响应落状态前比较请求创建时的 `tenantId` 与当前 `tenantId`。
- 旧请求不得清除新请求的 loading、error 或 data。
- 写入过程切换组织时应阻止导航或明确取消，不得把旧组织回执显示在新组织页面。

至少修改：

- `web/src/components/McpManager/index.tsx`
- `web/src/components/SkillManager/index.tsx`
- 新的组织文件组件。
- `CronManager` 的目标组织模式。

新增 A 慢、B 快测试，最终页面只能出现 B 数据。

#### 4.11 MCP 服务端作用域保护

组织入口更新和删除 MCP 时必须显式携带目标组织作用域。

服务端规则：

- 新建：资源创建在请求声明的目标组织。
- 更新：已有资源必须属于目标组织，否则返回 409 `MCP_SCOPE_CONFLICT`。
- 删除：已有资源必须属于目标组织，否则返回 409。
- 全局 MCP 在组织入口只读。
- 其他组织 MCP 不得出现在当前组织的可编辑结果中。
- 修改资源归属只能走独立的高风险迁移合同，不能通过普通 PUT 隐式完成。

补充 `server/src/__tests__/mcpRouterTenantIsolation.test.ts`：

- 平台管理员在组织 A 入口不能更新全局 MCP。
- 平台管理员在组织 A 入口不能更新或删除组织 B MCP。
- 平台管理员在组织 A 入口可以创建、更新和删除组织 A MCP。
- 组织管理员仍只能管理自身组织 MCP。

#### 4.12 错误码和页面提示

保留 `GovernanceApiError` 的服务端 `code`、HTTP status、request/correlation ID，并建立集中映射。

至少覆盖：

| 错误类别         | 建议错误码                           | 用户提示与动作                             |
| ---------------- | ------------------------------------ | ------------------------------------------ |
| 未选择目标组织   | `TARGET_TENANT_REQUIRED`             | 请先选择目标组织                           |
| 组织管理权限不足 | `TARGET_ORGANIZATION_FORBIDDEN`      | 当前账号无权管理该组织                     |
| 缺少范围基线     | `ENTITLEMENT_SCOPE_NOT_FOUND`        | 该组织缺少范围基线，请联系平台管理员初始化 |
| 目录不可用       | `RESOURCE_CATALOG_UNAVAILABLE`       | 权威目录暂不可用，禁止编辑                 |
| 旧目录资源       | `RESOURCE_SCOPE_STALE_ITEMS`         | 显示旧 ID 并提供移除入口                   |
| 基线冲突         | `ENTITLEMENT_SCOPE_VERSION_CONFLICT` | 数据已变化，请刷新后重新预览               |
| 预览过期         | `GOVERNANCE_PREVIEW_EXPIRED`         | 预览已过期，请重新预览                     |
| 作用域冲突       | `MCP_SCOPE_CONFLICT`                 | 资源属于其他作用域，不能从当前入口修改     |
| 依赖不可用       | `*_AUTHORITY_UNAVAILABLE`            | 明确是哪项权威依赖不可用                   |
| 部分写入         | `GOVERNANCE_PARTIAL_CHANGE`          | 禁止盲目重试，展示变更 ID 并引导查看审计   |

禁止事项：

- 禁止把所有 403 映射成“无权查看 Context Center”。
- 禁止丢弃后端错误码后统一显示“请刷新重试”。
- 禁止对可能已经发生部分写入的请求提示用户直接重试。

#### 4.13 未交付能力处置

本修复不要求一次性实现所有当前固定返回 503 的平台能力，但必须完成能力盘点和 UI 收口。

第一步：

- [ ] GOV-FIX-070：建立前后端能力清单，标明 `available/read_only/unavailable`。
- [ ] GOV-FIX-071：未交付写能力不展示可点击保存按钮。
- [ ] GOV-FIX-072：页面明确显示“尚未交付”，不得伪装成偶发服务错误。

后续独立任务：

- 平台管理员新增、移除和恢复。
- 环境 Provider、环境模板发布和退役。
- Agent/Connector 发布、状态和退役。
- Content Access Grant 创建和撤销。
- 组织删除影响清单与安全删除。
- Credential 签名吊销。

这些能力必须分别补齐预览、提交、审计和回滚合同，不得用临时直写接口绕过。

---

## 五、测试方案

### 5.1 单元与路由测试

必须修改当前错误语义测试：

- `server/src/context/product/service.test.ts` 中平台管理员无目标 Membership 被拒绝的断言。
- `web/src/components/PlatformGovernance/PlatformGovernancePage.test.tsx` 中旧资源直接阻断预览的断言。

新增或扩展：

- `server/src/app/runtimeContextAdmin.test.ts`
- `server/src/__tests__/governanceAccessRoutes.test.ts`
- `server/src/routes/governanceAssignmentBatchRoutes.test.ts`
- `server/src/__tests__/governanceOrganizationAccessRoutes.test.ts`
- `server/src/routes/governanceMemoryRoutes.test.ts`
- `server/src/__tests__/governanceResourcesRoutes.authorization.test.ts`
- `server/src/__tests__/governanceAgentResourceRoutes.test.ts`
- `server/src/__tests__/governanceCredentialSafety.test.ts`
- `server/src/__tests__/entitlementStore.test.ts`
- `server/src/__tests__/governanceSchemaMigration.pg.test.ts`
- `server/src/__tests__/mcpRouterTenantIsolation.test.ts`
- `web/src/components/OrganizationGovernance/ResourceAccessEditors.test.tsx`
- `web/src/components/PlatformGovernance/PlatformGovernancePage.test.tsx`
- `web/src/components/McpManager/index.test.tsx`
- `web/src/components/SkillManager/index.test.tsx`
- 新增组织文件和自动化作用域测试。

### 5.2 授权矩阵

每个可写页面至少使用以下五类身份验证：

| 身份                   | 目标 A 读取 | 目标 A 写入 | 目标 B 读取/写入  | 个人数据             |
| ---------------------- | ----------- | ----------- | ----------------- | -------------------- |
| 平台管理员，不属于 A/B | 允许        | 允许        | 显式选择 B 后允许 | 拒绝                 |
| A 的组织所有者         | 允许        | 允许        | 拒绝              | 仅本人或既有合同允许 |
| A 的组织管理员         | 允许        | 允许        | 拒绝              | 仅本人或既有合同允许 |
| A 的普通成员           | 有效结果    | 拒绝        | 拒绝              | 仅本人               |
| 未登录                 | 拒绝        | 拒绝        | 拒绝              | 拒绝                 |

至少覆盖这些组织级页面：

```text
成员
权限策略
智能体
技能
连接器与凭证
MCP
记忆与知识
Context Center
Timeline
文件与数据
模型与工具
环境范围
自动化任务
操作记录
```

### 5.3 范围场景

- 六类基线全部存在。
- 新组织创建后立即可读取和配置六类范围。
- 存量组织缺一类、缺三类、缺全部范围时均可幂等补齐。
- 当前范围包含一个和多个旧目录 ID 时均可逐个或全部移除。
- `ark-agents/glm-5.2` 移除后版本加一、刷新不再出现。
- 用户 A 预览后用户 B 修改范围，A 提交必须冲突。
- 预览后目录变化，提交必须要求重新预览。
- 目录服务 503 时禁止写入，但保留当前基线只读展示。

### 5.4 浏览器 E2E

真实浏览器验收必须覆盖桌面端和移动端：

1. 平台管理员登录。
2. 选择没有平台管理员 Membership 的目标组织 A。
3. 依次打开所有组织管理叶子页面，确认没有错误红框和错误作用域数据。
4. 在 Context Center、Timeline、模型范围、技能范围执行真实读取。
5. 移除 `ark-agents/glm-5.2`，完成预览、提交、刷新和审计回读。
6. 快速切换 A→B，使用慢请求模拟验证旧响应不能覆盖。
7. 验证文件与自动化均显示 B 的组织作用域，而不是平台管理员个人作用域。
8. 使用 A 的组织管理员重复关键动作，并验证其不能切换到 B。
9. 使用普通成员验证所有写按钮和写 API 均被拒绝。
10. 验证深链、刷新、前进后退、未保存离开保护。

仅有单元测试、CI、健康检查或构建成功，不能视为该 E2E 完成。

### 5.5 分层验证命令

开发过程中先运行受影响测试，再运行模块门禁，最后执行一次完整 PR preflight。

示例：

```bash
pnpm -F server exec vitest run \
  src/context/product/service.test.ts \
  src/app/runtimeContextAdmin.test.ts \
  src/__tests__/governanceAccessRoutes.test.ts \
  src/__tests__/entitlementStore.test.ts \
  src/__tests__/mcpRouterTenantIsolation.test.ts

pnpm -F web exec vitest run \
  src/components/OrganizationGovernance/ResourceAccessEditors.test.tsx \
  src/components/PlatformGovernance/PlatformGovernancePage.test.tsx \
  src/components/McpManager/index.test.tsx \
  src/components/SkillManager/index.test.tsx

pnpm -F shared typecheck
pnpm -F server typecheck
pnpm -F web typecheck
pnpm -F web check:api-boundary
pnpm check:ratchets
pnpm preflight:pr
```

PostgreSQL 集成测试按项目约定使用共享 `local-postgres`，不得通过提高阈值或新增环境变量绕过 ratchet。

---

## 六、生产发布与数据治理顺序

本节是执行顺序，不代表已授权执行。

### 6.1 发布前

- [ ] 三个 PR 已合并且完整 preflight 通过。
- [ ] Migration 在生产副本或等价数据集完成 dry-run。
- [ ] 输出所有组织的缺失基线和旧资源清单。
- [ ] 确认迁移只插入缺失行，不覆盖现有治理记录。
- [ ] 确认没有 Workflow 变更；如确需改 Workflow，先单独征得用户确认。

### 6.2 发布

1. 先发布支持新授权合同、完整基线和旧资源清理的代码。
2. 回读部署版本和服务健康状态。
3. 执行只读生产审计脚本。
4. 人工确认审计输出和目标组织。
5. 执行缺失基线补齐。
6. 对指定组织移除 `ark-agents/glm-5.2` 等已确认旧引用。
7. 回读数据库版本、API 范围、审计事件和浏览器页面。

禁止先清理生产数据再发布可正确处理旧资源的新代码。

### 6.3 生产回读证据

必须保存：

- 部署 commit SHA。
- 目标组织 ID。
- 修复前后六类范围快照。
- 每类范围版本号。
- 清理的旧资源 ID。
- changeId、auditId、effectiveAt、projectionStatus。
- 平台管理员无目标 Membership 时的真实浏览器成功证据。
- 组织管理员跨组织被拒绝、个人数据仍受保护的负向证据。

---

## 七、回滚方案

### 7.1 代码回滚

- 授权解析器和路由切换作为独立 PR，出现问题时可回滚到上一版本。
- 回滚代码不能删除新增的范围基线；新增空范围记录对旧版本应保持兼容。
- 前端回滚后旧目录资源可能再次不可编辑，因此执行旧 ID 清理前必须确保新后端和新前端均已稳定。

### 7.2 数据回滚

- 缺失基线补齐属于新增记录；回滚时通常保留，不应删除后造成页面再次失效。
- 旧资源清理前保存原始 `resourceIds`、版本和来源。
- 如必须恢复旧 ID，只能通过带原因、版本校验和审计的修复命令恢复，不允许直接无记录写库。
- 任一事务失败必须整体回滚；发现部分写入时停止批处理，按 changeId 排查，禁止盲目重跑。

### 7.3 权限回滚

若平台管理员组织级写入出现越界风险，可临时关闭统一管理动作并保持只读，但不得重新引入“给平台管理员伪造目标 Membership”的做法。

---

## 八、完成定义（Definition of Done）

只有同时满足以下条件才可宣告完成：

- [ ] 平台管理员管理目标组织不再依赖目标组织 Membership 或 `org_admin`。
- [ ] 组织管理员仍被严格限制在自身组织。
- [ ] 平台管理员不能访问成员个人敏感数据。
- [ ] 所有相关路由使用统一授权解析器，不再存在散落的冲突判断。
- [ ] 所有客户组织具有六类真实范围基线。
- [ ] 新组织创建不会产生缺失基线。
- [ ] `ark-agents/glm-5.2` 等历史资源可见、可移除、可审计。
- [ ] 组织页和平台页使用同一范围编辑行为。
- [ ] 文件与自动化明确绑定目标组织，不再复用平台管理员个人作用域。
- [ ] MCP 组织入口不能修改全局或其他组织 Server。
- [ ] 快速切换组织不存在旧响应覆盖。
- [ ] 页面保留并展示可行动的权威错误码。
- [ ] 当前固定 503 的未交付能力已明确标注或隐藏写入口。
- [ ] 受影响测试、三包 typecheck、API boundary、ratchets 和完整 preflight 全部通过。
- [ ] 真实浏览器完成平台管理员、组织管理员、普通成员三类身份 E2E。
- [ ] 生产 API、数据库、审计和页面四层回读一致。
- [ ] 没有未经授权的 Workflow、推送、部署或生产数据修改。

---

## 九、建议提交顺序

```text
PR 1 统一目标组织授权合同
  ↓
PR 2 六类范围基线、旧目录资源编辑和审计/修复脚本
  ↓
PR 3 文件与自动化作用域、请求竞态、MCP 隔离和错误治理
  ↓
人工授权后部署
  ↓
生产只读审计
  ↓
人工确认后补基线和清理指定旧资源
  ↓
生产浏览器/API/数据库/审计回读
```

每个 PR 均应只包含对应范围的代码和测试，避免把尚未交付的 P2 平台能力混入 P0 修复。未经用户明确要求，不创建 PR、不推送、不部署、不执行生产数据修复。
