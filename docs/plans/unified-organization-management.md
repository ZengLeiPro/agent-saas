# 设置中心「组织管理」统一入口实施方案

> **状态**：待实施  
> **创建时间**：2026-09-02  
> **适用范围**：Web 桌面端、Web 移动端响应式页面  
> **产品决策**：全产品只保留头像菜单中的「设置」入口；组织治理能力全部并入设置中心的「组织管理」  
> **发布约束**：本方案不包含 Workflow、部署、发布或生产配置变更；如后续需要改动 Workflow，必须另行取得用户确认

---

## 一、结论先行

本次改造不是删除一个「进入组织治理」按钮，而是把当前两套组织后台收敛为一套产品信息架构、一套路由事实源和一组权威业务页面。

改造完成后：

1. 头像菜单只保留一个「设置」入口。
2. 设置工作区按权限展示「个人设置 / 组织管理 / 平台管理」。
3. 桌面端删除「进入组织治理」。
4. 移动端删除「组织控制台」。
5. 原组织治理的全部页面在「组织管理」中访问。
6. 同一业务能力只保留一个编辑页面、一个权威 API 和一个稳定深链。
7. 保留旧链接兼容，但旧链接最终进入新的统一设置工作区，不再维护第二套控制台壳。

一句话定义：

> 「治理」保留为底层权限、审计和变更协议，不再作为用户需要理解的第二个产品入口。

---

## 二、背景与现状

### 2.1 当前入口

桌面端当前链路：

```text
头像菜单
└─ 设置
   ├─ 个人设置
   ├─ 组织管理
   │  ├─ 成员、技能、组织智能体……
   │  └─ 进入组织治理  ← 第二套组织后台入口
   └─ 平台管理
```

移动端当前仍存在独立链路：

```text
头像菜单
├─ 个人设置
└─ 组织控制台  ← 独立入口
```

### 2.2 当前两套能力规模

- 设置中心已注册 11 个组织管理叶子。
- 组织治理已注册 23 个主页面，另有成员详情下钻页。
- 两套页面部分复用同一组件，部分使用不同组件或不同权威数据源。
- 当前设置菜单已经注册「工作流」，但 `TenantAdminShell` 的设置内容映射没有对应渲染节点，存在空白页面风险。

### 2.3 当前核心问题

| 编号 | 问题                           | 用户影响                             | 技术影响                                             |
| ---- | ------------------------------ | ------------------------------------ | ---------------------------------------------------- |
| P0-1 | 「组织管理」和「组织治理」并存 | 不知道从哪里管理成员、计费、连接器   | 两套壳、两套路由状态长期并存                         |
| P0-2 | 成员页面权威不一致             | 相同成员在两个入口看到的身份语义不同 | 设置侧旧 `UserManager` 与 Governance Membership 并存 |
| P0-3 | 工作流菜单有入口无内容         | 点击后可能出现空白内容区             | Registry 与 renderer 不一致                          |
| P1-1 | 组织设置重复编辑               | 品牌、安全、模型等能力存在多处入口   | 容易产生保存、脏状态和并发版本差异                   |
| P1-2 | 名称不一致                     | 用户难以理解能力边界                 | 菜单映射、埋点和测试名称不稳定                       |
| P1-3 | 桌面与移动端入口不一致         | 同一账号跨设备找不到相同入口         | 两端导航继续分叉                                     |

---

## 三、目标与非目标

### 3.1 产品目标

1. 建立唯一的组织管理入口和一致的用户心智。
2. 让组织管理员在设置中心内完成全部组织级管理工作。
3. 让平台管理员在明确选择目标组织后复用同一套组织管理页面。
4. 所有管理动作继续使用服务端权威身份、权限、版本和审计数据。
5. 保留旧深链、刷新、返回、分享和未保存保护能力。
6. 桌面端和移动端的能力、命名、权限与 URL 行为保持一致。

### 3.2 技术目标

1. 组织管理导航只保留一个事实源。
2. 组织页面优先复用现有 Governance 页面，不复制业务组件。
3. 移除设置侧旧业务页面与治理页面的双重挂载。
4. Registry、路由、页面 renderer 和测试之间建立穷举约束。
5. 旧 URL 只承担兼容，不再决定旧 UI 壳。

### 3.3 非目标

- 不修改后端治理模型的业务语义。
- 不改变 Membership、Assignment、Entitlement、Credential、Audit 等权威数据定义。
- 不重做平台管理的信息架构。
- 不重做个人设置的信息架构。
- 不新增新的前端状态管理框架。
- 不引入新的 UI 组件库。
- 不修改 GitHub Actions 或其他 Workflow。
- 不在本任务中执行部署或生产验证。

---

## 四、统一后的信息架构

### 4.1 一级结构

```text
设置
├─ 个人设置
│  ├─ 账户与安全
│  ├─ 我的 Agent
│  ├─ 对话与模型
│  ├─ 外观与布局
│  ├─ 我的权限
│  ├─ 连接与授权
│  ├─ 文件与存储
│  └─ 回收站
├─ 组织管理
│  ├─ 组织总览
│  ├─ 成员与权限
│  ├─ 智能体与资源
│  ├─ 用量与治理
│  └─ 组织设置
└─ 平台管理
   └─ 保持现有结构
```

### 4.2 组织管理二级结构

主设置侧栏只展示 5 个组织管理分类。进入分类后，内容区顶部使用局部 Tab 展示具体页面，避免把 27 个页面平铺到总侧栏。

| 一级分类     | 二级页面                                                                                                                 | 默认页          |
| ------------ | ------------------------------------------------------------------------------------------------------------------------ | --------------- |
| 组织总览     | 综合分析                                                                                                                 | 综合分析        |
| 成员与权限   | 成员、账号与登录、所有者与管理员、权限策略、部门/群组、离职撤权与资源交接                                                | 成员            |
| 智能体与资源 | 组织智能体、工作流、钉钉账号、技能、连接器与凭据、MCP 服务、连接器映射、记忆与知识、文件与数据、模型与工具、环境可用范围 | 组织智能体      |
| 用量与治理   | 自动化任务、用量/预算与计费、会话质检、操作记录                                                                          | 用量/预算与计费 |
| 组织设置     | 组织资料、智能体规则、功能与配额、品牌、登录与安全                                                                       | 组织资料        |

### 4.3 命名统一

| 当前名称              | 统一后名称       | 说明                                                 |
| --------------------- | ---------------- | ---------------------------------------------------- |
| 组织治理 / 组织控制台 | 组织管理         | 不再把「治理」作为第二套产品入口                     |
| 公司信息              | 组织资料         | 与组织作用域一致                                     |
| 自定义规则            | 智能体规则       | 明确规则影响对象                                     |
| 连接器                | 连接器与凭据     | 覆盖目录、共享凭据和健康状态                         |
| MCP Catalog           | MCP 服务         | 保留 Server Catalog、模板、密钥要求和诊断能力        |
| 连接器映射            | 连接器映射       | 作为独立二级页保留，不与凭据编辑混淆                 |
| 计费                  | 用量、预算与计费 | 覆盖真实页面范围                                     |
| 组织管理（旧叶子）    | 功能与配额       | 避免分组和叶子同名                                   |
| 审计 / 治理审计       | 操作记录         | 面向组织管理员使用业务语言；页面内可保留审计详情术语 |

---

## 五、页面能力迁移矩阵

### 5.1 成员与权限

| 统一页面           | 当前来源                               | 实施方式                   | 权威要求                                          |
| ------------------ | -------------------------------------- | -------------------------- | ------------------------------------------------- |
| 成员               | `OrganizationMembersPage`              | 替换设置侧旧 `UserManager` | 必须读取 Governance Membership                    |
| 账号与登录         | 旧 `UserManager`                       | 作为独立二级页复用         | 保留资料编辑、密码重置、禁用/启用、删除和登录日志 |
| 成员详情           | `OrganizationMemberDetails`            | 作为成员列表下钻页         | 保留资料、权限、资源指派、用量策略、安全记录 Tab  |
| 所有者与管理员     | `OrganizationMembersPage` owners route | 原样复用                   | 所有者/管理员变更继续走预览和服务端授权           |
| 权限策略           | `OrganizationPoliciesPage`             | 原样复用                   | 不在前端推导最终权限                              |
| 部门/群组          | `OrganizationGroupsPage`               | 原样复用                   | 本地不可变 groupId 继续作为绑定 ID                |
| 离职撤权与资源交接 | `OrganizationOffboardingPage`          | 原样复用                   | 必须先预览影响；存在 blocker 时禁止提交           |

禁止事项：

- 禁止设置侧继续用旧 `UserManager` 作为组织成员权威页面；仅允许在“账号与登录”页承担账号操作。
- 禁止把 `role === "admin"` 直接等价为最终 Governance persona。
- 禁止在前端自行计算所有者、管理员或 Assignment 最终结果。

### 5.2 智能体与资源

| 统一页面     | 当前来源                                    | 实施方式                                             |
| ------------ | ------------------------------------------- | ---------------------------------------------------- |
| 组织智能体   | 现有组织智能体管理组件                      | 复用现有 renderer                                    |
| 工作流       | `WorkflowDisplaySettingsPage`               | 接入统一设置内容区，修复当前空白入口                 |
| 钉钉账号     | `AgentDwsAccountsPage`                      | 原样复用                                             |
| 技能         | 现有组织技能管理组件                        | 复用现有 renderer                                    |
| 连接器与凭据 | `OrganizationCredentialsPage`               | 作为连接器权威管理页                                 |
| MCP 服务     | 现有 MCP Server Catalog 管理组件            | 保留创建、编辑、删除、模板、密钥要求与诊断能力       |
| 连接器映射   | `TenantConnectorDictionaryPanel`            | 新增独立稳定 routeId，不再与 connectors 共用同一路由 |
| 记忆与知识   | `OrganizationMemoryKnowledgePage`           | 原样复用，保留 Context Center 内部 Tab               |
| 文件与数据   | 现有组织文件 renderer                       | 原样复用                                             |
| 模型与工具   | `TenantSettingsPanel section="model-tools"` | 继续复用，但从旧总页面中拆出                         |
| 环境可用范围 | `OrganizationEnvironmentsPage`              | 原样复用，保留 preview → commit                      |

### 5.3 用量与治理

| 统一页面         | 当前来源                       | 实施方式                            |
| ---------------- | ------------------------------ | ----------------------------------- |
| 自动化任务       | 现有组织 Cron renderer         | 复用现有 renderer                   |
| 用量、预算与计费 | `OrganizationUsageBillingPage` | 保留“用量看板 / 预算与计费”内部 Tab |
| 会话质检         | `QaConsole`                    | 原样复用                            |
| 操作记录         | `GovernanceChangeAuditPage`    | 统一名称后复用                      |

### 5.4 组织设置

| 统一页面   | 当前来源                                           | 实施方式                                               |
| ---------- | -------------------------------------------------- | ------------------------------------------------------ |
| 组织资料   | CompanyInfo editor                                 | 复用现有 editor                                        |
| 智能体规则 | TenantInstructions editor                          | 复用现有 editor                                        |
| 功能与配额 | `TenantSettingsPanel` 当前 `all` 中的 general 部分 | 新增 `section="general"`，只渲染功能开关、配额和个性化 |
| 品牌       | `TenantSettingsPanel section="brand"`              | 原样复用                                               |
| 登录与安全 | `TenantSettingsPanel section="security"`           | 原样复用                                               |

`TenantSettingsPanel` 调整要求：

```ts
type TenantSettingsPanelSection = 'general' | 'model-tools' | 'brand' | 'security';
```

- 删除面向新导航的 `all` 总页面展示。
- 如需短期兼容旧测试，可保留内部 `all`，但不得再注册为用户可见菜单项。
- 四个 section 仍可读取和保存同一份版本化 TenantSettings；保存时必须继续携带 `expectedUpdatedAt`。

---

## 六、路由与历史记录设计

### 6.1 核心决策

现有 Governance V2 深链继续作为组织页面的稳定 URL，不为本次 UI 合并再发明第三套路由。

示例：

```text
/tenant-admin/overview
/tenant-admin/members/list
/tenant-admin/members/member/:userId/:tab
/tenant-admin/agents/workflows
/tenant-admin/agents/skills
/tenant-admin/governance/usage
/tenant-admin/settings/profile
```

这些 URL 打开后必须渲染在统一「设置」工作区中，而不是旧 `GovernanceConsole` 组织控制台壳中。

### 6.2 旧设置 URL 兼容

旧 URL 继续接受，但需要 canonical 到对应 Governance V2 页面：

| 旧 URL                                        | canonical routeId                                                        |
| --------------------------------------------- | ------------------------------------------------------------------------ |
| `/tenant-admin/settings/users`                | `organization.members.accounts`                                          |
| `/tenant-admin/settings/skills`               | `organization.agents.skills`                                             |
| `/tenant-admin/settings/org-agents`           | `organization.agents.org-agents`                                         |
| `/tenant-admin/settings/workflows`            | `organization.agents.workflows`                                          |
| `/tenant-admin/settings/mcp`                  | `organization.agents.mcp-catalog`                                        |
| `/tenant-admin/settings/connector-dictionary` | `organization.agents.connector-mappings`                                 |
| `/tenant-admin/settings/billing`              | `organization.governance.usage`，内部默认 billing Tab 可通过查询参数保留 |
| `/tenant-admin/settings/files`                | `organization.agents.files-data`                                         |
| `/tenant-admin/settings/company`              | `organization.settings.profile`                                          |
| `/tenant-admin/settings/instructions`         | `organization.settings.rules`                                            |
| `/tenant-admin/settings/settings`             | `organization.settings.general`                                          |

### 6.3 路由状态要求

统一设置工作区必须完整保留：

- `org`：平台管理员明确选择的目标组织。
- `entityId`：成员、智能体、技能等详情对象。
- `tab`：成员详情、用量计费、Context Center 等局部 Tab。
- 页面自身 query：筛选、时间范围、分页、搜索条件。
- history source/depth：从聊天页进入设置以及返回时的来源状态。

### 6.4 前端模式判断

改造前：

```ts
organization governance route -> analysisMode -> GovernanceConsole
tenant admin settings route    -> settingsMode -> UnifiedSettingsSidebar
```

改造后：

```ts
organization governance route -> settingsMode(target="tenant") -> UnifiedSettingsSidebar
platform governance route     -> 保持现有 Platform Governance/管理行为
personal settings route       -> settingsMode(target="personal")
```

组织 area 不再进入独立 analysis/console 展示模式。

---

## 七、布局与交互设计

### 7.1 桌面端

```text
┌─────────────────┬──────────────────────────────────────────────┐
│ 设置侧栏         │ 当前组织 / 页面标题 / 页面操作                │
│                 ├──────────────────────────────────────────────┤
│ 个人设置         │ 分类局部导航：成员｜管理员｜权限策略｜群组……   │
│                 ├──────────────────────────────────────────────┤
│ 组织管理         │                                              │
│  · 组织总览      │              业务页面内容                     │
│  · 成员与权限    │                                              │
│  · 智能体与资源  │                                              │
│  · 用量与治理    │                                              │
│  · 组织设置      │                                              │
│                 │                                              │
│ 平台管理         │                                              │
└─────────────────┴──────────────────────────────────────────────┘
```

交互规则：

- 点击一级分类进入该分类默认页。
- 用户在某分类内访问过二级页后，可在当前浏览器会话中记住最近页；深链优先于记忆值。
- 页面局部 Tab 使用 URL 驱动，不使用仅组件内部保存的不可分享状态。
- 点击返回主界面时回到打开设置前的聊天页或原业务页。
- 左侧不再出现「进入组织治理」按钮。

### 7.2 移动端

采用已有管理弹窗的两级导航模式：

```text
设置菜单页
  → 组织管理分类页
    → 二级页面内容
```

要求：

- 头像菜单只显示「设置」，不再显示「组织控制台」。
- 小屏先显示设置菜单，选择页面后进入内容页。
- 内容页顶部提供返回设置菜单和关闭设置操作。
- 二级页面超过一屏时允许横向滚动 Tab，但必须保留当前选中项可见。
- 移动端与桌面端共用路由、权限和业务组件，不维护第二套页面清单。

### 7.3 平台管理员组织切换

- 平台管理员进入任何组织管理页面前必须明确选择目标组织。
- 没有 `org` 时展示「请先选择目标组织」，不自动选择列表第一项。
- 切换组织前必须触发未保存内容保护。
- 切换后保留当前 routeId；如果目标组织无权访问或能力不可用，展示权威错误态。
- 普通组织管理员不展示组织切换器，并强制使用本人 Membership 所属组织。

---

## 八、权限、安全和状态规则

### 8.1 入口权限

继续使用管理权限快照：

- `settings.personal.view`
- `settings.tenant.view`
- `settings.platform.view`

`useManagementSettingsAccess` 只负责判断是否可进入个人、组织、平台工作区，不得被扩展为下游业务操作授权器。

### 8.2 页面与操作权限

- 一级组织管理入口允许后，具体页面继续调用各自服务端权威 API。
- 增删改动作继续由服务端 Governance action 和明确 tenant scope 授权。
- 前端不得因为显示了页面就假定用户拥有写权限。
- 高风险操作继续执行 preview → commit → receipt。
- API 返回 403 时展示权限原因或联系管理员指引，不能伪装为空数据。
- API 返回 503 时展示权威服务暂不可用和重试入口，不能回退到旧数据源。

### 8.3 通用页面状态

每个统一页面至少覆盖：

1. 加载中。
2. 刷新中，保留旧数据。
3. 空数据。
4. 无查看权限。
5. 可查看但只读。
6. 权威服务不可用。
7. 保存中。
8. 保存成功。
9. 并发版本冲突。
10. 高风险操作预览和回执。

### 8.4 未保存内容保护

以下动作必须统一走 `SettingsDirtyController.requestNavigation`：

- 切换个人/组织/平台设置范围。
- 切换组织管理一级分类。
- 切换会导致 editor 卸载的二级页面。
- 平台管理员切换目标组织。
- 关闭设置。
- 返回聊天或其他产品页面。
- 浏览器前进/后退。
- 旧 URL canonical 跳转。

---

## 九、技术实施方案

### 9.1 单一导航事实源

目标：组织管理的分类、叶子、routeId、默认页和旧设置 section 映射只能维护一份。

建议在 `web/src/lib/governanceNavigation.ts` 的组织定义上补充展示元数据，或新建只引用 routeId 的投影文件：

```ts
interface OrganizationSettingsWorkspaceDefinition {
  id: 'overview' | 'members' | 'agents' | 'governance' | 'settings';
  label: string;
  defaultRouteId: string;
  routeIds: readonly string[];
}
```

约束：

- `routeIds` 必须引用 `GOVERNANCE_ROUTES` 中已存在的组织 routeId。
- `organization.agents.connector-mappings` 和 `organization.settings.general` 需要新增为正式 route。
- 不允许在 `UnifiedSettingsSidebar`、`AdminShells` 和移动端分别手写第二份页面数组。
- 测试必须校验所有组织导航叶子唯一、可解析且存在 renderer。

### 9.2 设置侧栏改造

修改 `web/src/components/UnifiedSettingsSidebar.tsx`：

- 删除 `onOpenOrganizationGovernance` 属性。
- 删除「进入组织治理」按钮和 `ArrowRight`/治理入口图标依赖。
- 组织管理区域从 11 个旧设置叶子改为 5 个 workspace 分类。
- active 状态由当前 organization governance route 的 workspace 决定。
- 点击分类时导航到该分类的默认 routeId 或当前会话最近访问 routeId。

### 9.3 设置工作区状态改造

修改 `web/src/hooks/useUnifiedSettingsWorkspace.ts`：

- 删除 `openOrganizationGovernance`。
- 支持以 organization governance route 作为 `target="tenant"` 的当前状态。
- `navigate` 支持导航到 routeId，而不仅是旧 settings section 字符串。
- 所有导航继续经过 dirty controller。

修改 `web/src/layouts/DesktopLayout.tsx`：

- organization route 进入统一 settings mode。
- 组织页面内容使用 `TenantAdminShell governanceContentOnly governanceContentEmbedded` 或抽出的等价 content renderer。
- 不再为 organization route 包裹完整 `GovernanceConsole`。
- `GovernanceConsole` 继续服务平台控制台或其他仍需独立控制台的 area。

### 9.4 页面 renderer 收敛

当前 `TenantAdminShell` 同时承载：

- 旧设置内容。
- 旧组织分析。
- Governance content。

实施时建议抽出纯组织 route renderer：

```text
web/src/components/OrganizationManagement/
├─ OrganizationManagementContent.tsx
├─ OrganizationManagementLocalNav.tsx
├─ organizationManagementRegistry.ts
└─ organizationManagementRouting.ts
```

`OrganizationManagementContent` 输入：

```ts
interface OrganizationManagementContentProps {
  route: GovernanceRouteState;
  tenantId: string;
  tenantName?: string;
  dirtyController?: SettingsDirtyController;
}
```

职责：

- 按 routeId 穷举渲染唯一页面。
- 不包含外层设置侧栏。
- 不维护独立组织选择逻辑。
- 不回退旧页面或模拟数据。
- 未知 routeId 在开发测试中直接失败；生产展示明确不可用状态。

### 9.5 移动端 Web 布局收敛

修改：

- `web/src/components/MobileSessionList.tsx`
- `web/src/layouts/MobileLayout.tsx`

任务：

- 删除头像菜单「组织控制台」。
- 统一通过「设置」打开个人/组织/平台设置。
- 复用与桌面相同的组织管理 registry 和 route content。
- 保留现有移动端 menu/content 两级导航、focus trap 和 safe area。

### 9.6 旧代码清理条件

只有满足以下条件后才允许删除旧路径：

1. 所有旧设置 section 均有 canonical route 映射。
2. 所有 Governance organization route 均能在设置工作区渲染。
3. 桌面和移动端导航测试通过。
4. 深链、刷新和浏览器返回测试通过。
5. 旧 `UserManager` 不再作为组织成员设置页使用。
6. 线上兼容观察期结束，旧 URL 访问没有无法映射的路径。

---

## 十、文件级改动清单

### 10.1 必改文件

| 文件                                            | 改动                                                           |
| ----------------------------------------------- | -------------------------------------------------------------- |
| `web/src/lib/governanceNavigation.ts`           | 补充统一组织管理导航元数据、新增缺失 routeId、维护 legacy 映射 |
| `web/src/lib/unifiedSettingsRegistry.ts`        | 移除组织业务叶子的双重事实源，或降级为 legacy section 映射     |
| `web/src/lib/urlSync.ts`                        | 统一 organization route 与 settings mode，兼容旧设置 URL       |
| `web/src/components/UnifiedSettingsSidebar.tsx` | 展示 5 个组织分类，删除治理跳转入口                            |
| `web/src/hooks/useUnifiedSettingsWorkspace.ts`  | 支持 organization route 状态，删除独立治理跳转                 |
| `web/src/layouts/DesktopLayout.tsx`             | 组织 route 改由统一设置壳承载                                  |
| `web/src/layouts/MobileLayout.tsx`              | 移动端组织管理接入统一设置壳                                   |
| `web/src/components/MobileSessionList.tsx`      | 删除「组织控制台」，只保留「设置」                             |
| `web/src/components/AdminShells.tsx`            | 收敛旧 settings renderer 和 governance renderer                |
| `web/src/components/TenantSettingsPanel.tsx`    | 拆分 `general/model-tools/brand/security`                      |

### 10.2 建议新增文件

| 文件                                                                           | 作用                                                |
| ------------------------------------------------------------------------------ | --------------------------------------------------- |
| `web/src/components/OrganizationManagement/OrganizationManagementContent.tsx`  | 唯一 route renderer                                 |
| `web/src/components/OrganizationManagement/OrganizationManagementLocalNav.tsx` | 分类内二级导航                                      |
| `web/src/components/OrganizationManagement/organizationManagementRegistry.ts`  | 5 个 workspace 到 routeId 的投影                    |
| `web/src/components/OrganizationManagement/organizationManagementRouting.ts`   | 默认页、active workspace、legacy section 映射纯函数 |

### 10.3 需要同步调整的测试

- `web/src/components/UnifiedSettingsSidebar.test.tsx`
- `web/src/hooks/useUnifiedSettingsWorkspace.test.ts`
- `web/src/lib/governanceNavigation.test.ts`
- `web/src/lib/unifiedSettingsRegistry.test.ts`
- `web/src/lib/urlSync.tenantAdmin.test.ts`
- `web/src/components/AdminShells.governance.test.tsx`
- `web/src/components/OrganizationTextEditors.dirty.test.tsx`
- `web/src/components/DesktopSessionSidebar.test.tsx`
- `web/src/layouts/MobileLayout.adminWiring.test.ts`
- 新增 `OrganizationManagementContent.test.tsx`
- 新增 `organizationManagementRouting.test.ts`

---

## 十一、分阶段任务拆解

### Phase 0：建立防回归契约

目标：先证明当前差异，再开始移动页面。

- [ ] ORG-SET-001：为所有 organization route 建立 renderer 穷举测试。
- [ ] ORG-SET-002：增加“设置注册了工作流但 renderer 缺失”的失败测试。
- [ ] ORG-SET-003：增加桌面重复入口和移动端独立控制台入口的现状测试。
- [ ] ORG-SET-004：增加旧 settings section → Governance routeId 映射表测试。
- [ ] ORG-SET-005：记录当前 23 个主页面和成员详情页的基线清单。

完成标准：新增测试能够在改造前稳定暴露重复入口、缺失 renderer 和双路由问题。

### Phase 1：统一导航与路由状态

- [ ] ORG-SET-101：建立 5 个组织管理 workspace registry。
- [ ] ORG-SET-102：新增 `organization.agents.connector-mappings`。
- [ ] ORG-SET-103：新增 `organization.settings.general`。
- [ ] ORG-SET-104：将 organization governance route 识别为 settings mode。
- [ ] ORG-SET-105：旧 `/tenant-admin/settings/*` canonical 到权威 routeId。
- [ ] ORG-SET-106：保留 `org/entityId/tab/search/history`。
- [ ] ORG-SET-107：平台管理员无显式 org 时保持阻断态。

完成标准：任何 organization route 刷新后都进入统一设置工作区，且没有页面内容迁移前的 URL 丢失。

### Phase 2：迁移页面内容

- [ ] ORG-SET-201：建立 `OrganizationManagementContent` 唯一 renderer。
- [ ] ORG-SET-202：成员入口切换到 Governance Membership。
- [ ] ORG-SET-203：接入成员详情、管理员、权限策略、群组和离职交接。
- [ ] ORG-SET-204：接入组织智能体、工作流、钉钉账号和技能。
- [ ] ORG-SET-205：接入连接器与凭据、连接器映射。
- [ ] ORG-SET-206：接入记忆与知识、文件、模型工具和环境范围。
- [ ] ORG-SET-207：接入自动化、用量计费、质检和操作记录。
- [ ] ORG-SET-208：拆分组织资料、智能体规则、功能配额、品牌和安全。
- [ ] ORG-SET-209：为所有页面接入统一局部导航。

完成标准：原组织治理全部能力均可在组织管理中访问；无空白页、无旧数据回退、无双编辑页面。

### Phase 3：删除重复入口和旧挂载

- [ ] ORG-SET-301：删除桌面「进入组织治理」。
- [ ] ORG-SET-302：删除 `onOpenOrganizationGovernance` 全链路。
- [ ] ORG-SET-303：删除移动端「组织控制台」。
- [ ] ORG-SET-304：删除组织 area 的独立 `GovernanceConsole` 包裹。
- [ ] ORG-SET-305：删除设置侧旧 `UserManager` 成员挂载。
- [ ] ORG-SET-306：删除用户可见的旧「组织管理」总叶子。
- [ ] ORG-SET-307：清理不再使用的 imports、types、props 和测试夹具。

完成标准：UI 中只剩一个「设置」入口和一个「组织管理」工作区。

### Phase 4：跨端回归与交付

- [ ] ORG-SET-401：桌面端路由、权限、脏状态和组织切换回归。
- [ ] ORG-SET-402：移动端菜单/内容两级导航回归。
- [ ] ORG-SET-403：旧深链刷新、前进后退、分享回归。
- [ ] ORG-SET-404：运行 Web typecheck、相关单测和全量 Web build。
- [ ] ORG-SET-405：执行真实浏览器 E2E。
- [ ] ORG-SET-406：形成变更说明、已验证范围和未执行的线上验收清单。

---

## 十二、测试方案

### 12.1 单元测试

必须覆盖：

- 5 个 workspace 顺序和默认 routeId 固定。
- 所有 routeId 唯一且存在于 Governance route registry。
- 所有可导航 routeId 都有 renderer。
- 所有 legacy settings section 都能映射到 canonical route。
- 未知旧 section 不得静默映射到错误组织页面。
- organization route 能正确计算 active workspace 和 active local page。
- 普通组织管理员不能注入其他 `org`。
- 平台管理员缺少显式 `org` 时不能自动选择第一项。
- dirty controller 覆盖所有离开当前 editor 的行为。

### 12.2 组件测试

必须覆盖：

- 设置侧栏不再出现「进入组织治理」。
- 组织管理只展示 5 个分类。
- 点击分类进入默认二级页。
- 当前二级页面对应的一级分类保持 active。
- 工作流页面存在真实内容，不是空节点。
- 成员页面调用 Governance Membership，不渲染旧 UserManager；账号与登录页单独承载旧账号操作。
- 连接器与凭据、MCP 服务、连接器映射可分别访问。
- `TenantSettingsPanel` 四个 section 只展示各自字段。
- 移动头像菜单不再出现「组织控制台」。

### 12.3 路由测试矩阵

| 场景               | 输入                                      | 预期                               |
| ------------------ | ----------------------------------------- | ---------------------------------- |
| 新组织深链         | `/tenant-admin/members/list`              | 统一设置工作区 > 成员与权限 > 成员 |
| 成员详情           | `/tenant-admin/members/member/u1/profile` | 保留成员详情和 profile Tab         |
| 旧成员设置         | `/tenant-admin/settings/users`            | canonical 到账号与登录 route       |
| 旧 MCP 设置        | `/tenant-admin/settings/mcp`              | canonical 到 MCP 服务 route        |
| 旧计费设置         | `/tenant-admin/settings/billing`          | 进入用量与治理，并定位预算与计费   |
| 平台管理员带组织   | `...?org=acme`                            | 管理 acme，组织切换器显示 acme     |
| 平台管理员无组织   | 无 `org`                                  | 展示选择组织阻断态                 |
| 组织管理员伪造组织 | `...?org=other`                           | 忽略/拒绝 other，不能跨组织读取    |
| 浏览器返回         | 设置 → 成员详情 → 返回                    | 回到成员列表，不跳出设置工作区     |
| 关闭设置           | 从聊天打开后关闭                          | 返回原聊天和原会话                 |

### 12.4 浏览器 E2E

本任务的 E2E 不能只用单测、build 或 `/health` 代替，至少需要：

1. 组织管理员真实登录。
2. 从头像菜单打开设置。
3. 确认没有第二个组织治理/控制台入口。
4. 逐个访问 5 个一级分类和全部二级页面。
5. 打开成员详情并切换全部详情 Tab。
6. 修改一个可回滚的低风险设置，验证保存和服务端 readback。
7. 制造未保存内容，验证切页、关闭和返回保护。
8. 平台管理员选择目标组织并切换组织。
9. 验证普通组织管理员不能切换到其他组织。
10. 在移动视口验证菜单页、内容页和返回行为。
11. 直接打开至少 5 条旧 URL，验证 canonical 与内容正确。

### 12.5 本地验证命令

```bash
pnpm -F web typecheck
pnpm -F web test
pnpm -F web build
```

如果全量 Web 测试耗时过长，开发过程中可以先运行相关 Vitest 文件，但交付前必须执行全量 Web test 和 build。

---

## 十三、验收标准

### 13.1 产品验收

- [ ] 全产品只有一个「设置」入口。
- [ ] 桌面端不存在「进入组织治理」。
- [ ] 移动端不存在「组织控制台」。
- [ ] 设置内只有一个「组织管理」区域。
- [ ] 组织管理一级分类固定为 5 个。
- [ ] 原组织治理全部能力均可在组织管理内找到。
- [ ] 同一业务配置不存在两个可编辑页面。
- [ ] 名称统一，不再出现同义菜单并存。

### 13.2 功能验收

- [ ] 23 个组织主页面及成员详情均有真实 renderer。
- [ ] 工作流入口不再空白。
- [ ] 成员数据来自 Governance Membership。
- [ ] 高风险操作仍有影响预览、确认和回执。
- [ ] 组织资料、规则、功能配额、模型、品牌和安全保存正常。
- [ ] 权限失败不回退旧数据源。
- [ ] 权威服务不可用时不展示模拟数据或假成功。

### 13.3 路由验收

- [ ] 新深链刷新正常。
- [ ] 旧设置深链可以兼容并 canonical。
- [ ] 浏览器前进、后退和关闭设置行为正确。
- [ ] `org/entityId/tab/search` 不丢失。
- [ ] 从聊天进入设置后可以返回原会话。

### 13.4 权限验收

- [ ] 普通成员看不到组织管理入口。
- [ ] 组织管理员只能管理本人组织。
- [ ] 平台管理员必须明确选择目标组织。
- [ ] 只读和无权状态有明确说明。
- [ ] 所有写操作仍由服务端授权。

### 13.5 工程验收

- [ ] `pnpm -F web typecheck` 通过。
- [ ] `pnpm -F web test` 通过。
- [ ] `pnpm -F web build` 通过。
- [ ] 相关 E2E 通过并保存截图或 trace。
- [ ] 没有修改 Workflow。
- [ ] 没有推送或部署，除非用户另行明确授权。

---

## 十四、风险与控制措施

| 风险                                     | 影响 | 控制措施                                                   |
| ---------------------------------------- | ---- | ---------------------------------------------------------- |
| 路由优先级改变导致旧链接打开错误壳       | 高   | 先补 route matrix 单测，再改 mode 判断                     |
| 双 renderer 同时存在导致数据不一致       | 高   | 每迁移一个页面立即删除旧挂载或加禁止回退测试               |
| `TenantSettingsPanel` 拆分后并发版本冲突 | 中   | 继续使用整包 payload + `expectedUpdatedAt`，冲突时强制刷新 |
| 平台管理员误操作错误组织                 | 高   | 显式 org、常驻组织提示、切换前 dirty guard                 |
| 移动端导航层级过深                       | 中   | 固定“设置菜单 → 分类内容”两级，详情通过内容区下钻          |
| 27 个页面一次迁移范围过大                | 中   | 按 Phase 逐批迁移，每批保持 canonical route 可用           |
| 旧测试依赖旧文案                         | 低   | 先更新产品契约测试，再机械更新展示测试                     |

---

## 十五、回滚方案

本次改造应保持页面组件与后端 API 不变，回滚边界集中在前端导航和承载壳。

### 15.1 可回滚设计

- 保留现有 Governance routeId 和业务页面组件。
- 首批迁移期间不立即删除旧 URL parser。
- 每个 Phase 单独提交，避免一次 commit 混合路由、页面和样式大改。
- 不做数据库迁移，因此回滚不涉及业务数据恢复。

### 15.2 回滚触发条件

- 任一高风险管理页无法打开。
- 组织作用域错误或出现跨组织数据风险。
- 旧深链大面积失效。
- dirty guard 失效导致已编辑内容无提示丢失。
- 移动端无法进入组织管理。

### 15.3 回滚顺序

1. 恢复 organization route 的旧承载壳。
2. 恢复旧设置 section renderer。
3. 恢复旧入口仅作为临时兜底。
4. 保留已新增但未启用的 registry 和测试，定位问题后重新迁移。

回滚后不得让两套入口长期并存；临时恢复必须附带修复任务和明确下线时间。

---

## 十六、研发交付要求

每个实施 Phase 完成后，交付说明必须分别列出：

1. **代码完成情况**：修改文件和 commit。
2. **本地验证**：typecheck、test、build 结果。
3. **浏览器验证**：实际页面、账号角色、URL、关键截图或 trace。
4. **部署状态**：是否部署；未部署必须明确写“未部署”。
5. **线上 readback**：是否执行；未执行不得写成已验收。
6. **业务验收**：组织管理员、平台管理员、移动端是否真实走通。
7. **剩余风险**：未覆盖页面、旧链接或权限边界。

代码提交要求：

- 每个可独立验证的 Phase 至少一个清晰 Git commit。
- 禁止擅自 `git push`。
- 禁止顺手修改 Workflow。
- 禁止覆盖或提交与本任务无关的工作区改动。

---

## 十七、完成定义（Definition of Done）

只有同时满足以下条件，任务才能标记为完成：

1. 单一「设置」入口已在桌面和移动端生效。
2. 组织管理 5 个分类和全部二级页面已交付。
3. 旧组织治理入口与组织控制台入口已删除。
4. 所有组织 route 只有一个权威 renderer。
5. 旧 URL 兼容且 canonical 正确。
6. 权限、组织作用域、脏状态和高风险操作保护未退化。
7. Web typecheck、test、build 全部通过。
8. 真实浏览器 E2E 已完成。
9. 如进行了部署，已分别提供部署身份、在线健康、页面 readback 和业务验收证据。
