# Karazhan 多用户记忆方案分析

日期：2026-04-14  
作者：Codex

## 一、结论先行

对 Karazhan 这类 15 人规模、单维护者的平台，**不建议把当前 Markdown 记忆体系直接升级为“完整知识图谱系统”**。更合理的路线是：

1. **保留现有个人记忆架构**，继续服务用户偏好、个人工作脉络、私人上下文。
2. **在个人记忆之上增加“共享知识空间（Knowledge Spaces）”**，把公司级、团队级、项目级、客户级知识从“某个人的 MEMORY.md”里解耦出来。
3. **采用“文档为主、结构化元数据为辅”的混合方案**，而不是上 Neo4j/图数据库。
4. **默认 Pull，关键知识做小规模 Push**，避免把所有公司信息塞进每个 Agent 的 prompt。
5. **权限控制不要绑定到 auth 角色本身**，继续保留 `admin/user` 两档登录权限，在其上增加轻量的 `team / knowledgeGroups / space ACL` 即可。

一句话概括目标架构：

> 个人记忆继续私有化；公司知识改为多层共享空间；共享空间沿用现有 Markdown + SQLite 检索能力；通过轻量元数据、空间 ACL 和定时整理机制，形成“可共享、可检索、可控权”的企业记忆层。

---

## 二、基于现有代码的诊断

你现在的系统并不是“完全没有共享知识能力”，而是**共享知识只存在于静态模板和管理员个人记忆中，没有形成运行时共享层**。

### 1. 当前实现的真实边界

从代码看，当前记忆链路大致是：

- `server/src/workspace/resolver.ts`
  - 每个用户首次登录时创建独立 workspace。
  - 会创建 `MEMORY.md`、`memory/`、`memory/topics/`、`memory/questions.md`。
  - `workspace-shared/MEMORY.template.md` 会在创建用户时复制到用户目录。
- `server/src/agent/memory.ts`
  - 会话开始时只读取**当前用户 workspace** 下的 `MEMORY.md`。
- `server/src/agent/runner.ts`
  - 会把这份个人 `MEMORY.md` 作为 `<memory-context>` 注入对话。
- `server/src/engine/memoryHook.ts`
  - 记忆维护 hook 只会写回**当前用户自己的** `memory/YYYY-MM-DD.md`。
- `server/src/memory/index/service.ts`
  - 索引器按 `workspaceDir` 维度管理，本质上已经支持“多个知识空间”，只是当前只用于 per-user workspace。
- `server/src/data/agents/types.ts`
  - `infoBoundary` 字段已经存在，但注释表明仍是预留状态，尚未真正进入运行时授权链。

### 2. 当前方案的问题不是“记忆不够强”，而是“知识边界错了”

你们现在的问题不在于：

- SQLite FTS5 不够强
- 向量检索不够强
- Markdown 不够强

真正问题在于：

- **公司级知识被错误地存放在个人空间**
- **共享知识没有独立生命周期**
- **写入路径只有个人记忆，没有共享记忆 promotion 机制**
- **读取路径只有当前用户，没有 company/team/project/client 这些共享维度**

### 3. 现有代码里已经有两个可直接利用的“半成品”

#### 半成品 A：初始化模板

`workspace-shared/MEMORY.template.md` 里已经包含了组织与人员信息。这说明你已经意识到“新用户需要基础公司背景”。但它的问题是：

- 它是**copy-on-create**，不是共享源。
- 用户创建以后，公司信息更新不会自动传播。
- 这类模板更像 onboarding seed，不是运行时知识层。

#### 半成品 B：按 workspace 管理索引器

`MemoryIndexService` 以 `workspaceDir -> MemoryIndexer` 的形式管理实例，这意味着你完全可以把：

- `admin/`
- `alice/`
- `bob/`
- `_spaces/company-all/`
- `_spaces/team-sales/`
- `_spaces/project-hippin/`

都视为“同构 workspace”，复用现有索引能力，而不用重写检索基础设施。

这也是我建议“共享知识空间沿用现有 MEMORY 目录规范”的核心原因。

---

## 三、建议的目标架构

## 3.1 多层知识模型

建议把 Karazhan 的知识拆成 5 层：

| 层级 | 作用 | 谁可见 | 是否注入会话开头 | 默认写入方式 |
|---|---|---|---|---|
| L0 系统层 | system prompt、通用行为规则 | 全员 | 是 | 平台维护者 |
| L1 公司共享层 | 组织、产品、流程、标准政策 | 全员或指定范围 | 是，少量精选 | Admin/指定 owner |
| L2 团队共享层 | 销售/开发/PM/运营等团队知识 | 对应团队 | 是，少量精选 | 团队 owner |
| L3 项目/客户层 | 项目状态、客户背景、交付细节 | 项目/客户成员 | 通常按需检索 | PM/销售/项目 owner |
| L4 个人层 | 偏好、个人待办、私有工作轨迹 | 本人 | 是 | 用户本人 + memory hook |

核心变化不是“取消个人记忆”，而是：

> 把原来塞在 CEO 个人记忆里的公司知识，上移到 L1/L2/L3；把个人偏好和私人上下文继续留在 L4。

## 3.2 共享知识空间（Knowledge Space）

最适合你现有代码的抽象，不是 graph node，而是 **space**。

每个共享 space 都沿用你当前用户 workspace 的目录习惯，只多一个元数据文件：

```text
WORKSPACE_ROOT/
  admin/
  alice/
  bob/
  _spaces/
    company-all/
      space.json
      MEMORY.md
      memory/
        2026-04-14.md
        topics/
          org.md
          products.md
          policies.md
    team-sales/
      space.json
      MEMORY.md
      memory/
        2026-04-14.md
        topics/
          pitch.md
          pricing.md
          crm-playbook.md
    team-engineering/
      space.json
      MEMORY.md
      memory/
        topics/
          repos.md
          coding-standards.md
          deploy.md
    projects/
      hippin/
        space.json
        MEMORY.md
        memory/
          topics/
            roadmap.md
            release-plan.md
            open-issues.md
    clients/
      xxx-group/
        space.json
        MEMORY.md
        memory/
          topics/
            account-plan.md
            meeting-notes.md
    exec-confidential/
      space.json
      MEMORY.md
      memory/
        topics/
          strategy.md
          commission-plan.md
  _registry/
    spaces.json
    users.json
    knowledge.db
```

### `space.json` 建议字段

```json
{
  "id": "team-sales",
  "name": "销售团队知识空间",
  "type": "team",
  "owners": ["admin"],
  "audience": ["team:sales", "role:admin"],
  "autoInject": {
    "enabled": true,
    "maxLines": 60,
    "priority": 80
  },
  "writePolicy": "owner_or_curator",
  "sourceOfTruth": true,
  "freshnessSlaMinutes": 60,
  "tags": ["sales", "pricing", "crm"]
}
```

这套设计的好处是：

- 复用你现在的目录结构和索引器。
- 共享空间和个人空间同构，运维简单。
- 访问控制在 space 层完成，不必做复杂对象级权限系统。

---

## 四、行业对标

以下结论以 **2026-04-14** 可公开查到的官方信息为准。

### 4.1 Glean：强项是“企业图 + 权限继承 + 连接器”

Glean 当前最值得借鉴的，不是“图数据库”本身，而是它的企业知识组织方式：

- 用连接器从 Google Drive / Notion / Confluence / GitHub 等系统拉数据。
- 构建 **Enterprise Graph + Personal Graph**，把“人、团队、项目、流程、客户、产品”连起来。
- 检索与展示严格继承原系统权限。
- 面向 Agent 的核心不是单篇文档，而是“企业上下文关系网”。

值得借鉴的点：

- **知识源不放在个人头脑里，而是放在共享上下文层。**
- **企业级知识和个人级知识并存。**
- **权限从源系统继承，而不是让 AI 自己判断谁该看什么。**

不适合你们直接照搬的点：

- 完整 enterprise graph 推理链条太重。
- 单组织隔离、连接器矩阵、复杂治理，对 15 人团队明显过度。
- 你们当前没有那么多异构系统和权限复杂度。

结论：

> 对你们来说，要学的是“company graph mindset”，不是上 Glean 级产品架构。

### 4.2 Dust：强项是“Workspace / Company Data / Spaces”

Dust 的企业知识共享模式对你们更有借鉴价值。

它的核心做法是：

- 外部系统数据通过 Connections 自动同步。
- 同步后的数据可以挂到 **Company Data**（全员可见）或者 **Spaces**（指定人群可见）。
- 文档更新通常几分钟内可见。
- 角色上区分 Member / Builder / Admin，但真正的知识边界更多体现在 Space 和 Data Access 上。

这跟你们的理想状态非常接近：

- `company-all` ≈ Company Data
- `team-sales` / `team-engineering` / `exec-confidential` ≈ Spaces
- 用户不是靠主动维护个人 MEMORY 获取上下文，而是默认继承共享空间

值得借鉴的点：

- **“共享给所有人”和“共享给特定群体”是两个明确层次。**
- **知识同步与访问授权是两步，不要混在一起。**
- **连接器是输入手段，Space 才是 Agent 消费边界。**

### 4.3 LangChain / LangGraph：强项是“namespace 化的长期记忆原语”

LangChain / LangGraph 不提供现成企业知识平台，但它在 memory 设计上很清楚：

- 长期记忆存成 JSON 文档。
- 以 `namespace + key` 组织。
- namespace 常包含 `user_id`、`org_id`、业务上下文标签。
- 既支持 hot path 写入，也支持 background 异步写入。

对你们的启发非常直接：

- 你们不需要把一切都并入一个“总记忆库”。
- 只要把 `workspaceDir` 扩展成：
  - `user:{username}`
  - `space:company-all`
  - `space:team-sales`
  - `space:project-hippin`
- 检索时做多 namespace 聚合即可。

换句话说：

> 你们现有的 per-user workspace，本质上已经是 LangGraph namespace 思想的一个落地版本，只是现在只有 `user:*`，没有 `space:*`。

### 4.4 Fixie：截至 2026-04-14 已不适合作为你们的主对标对象

截至 2026-04-14，Fixie 官方主站已跳转到 Ultravox，重点放在实时语音 AI 平台，不再是企业内部知识共享 / 多用户记忆架构的代表性案例。

因此：

- 可以把它作为“语音 Agent 平台”的参考。
- 但不建议再把它列为 Karazhan 多用户知识架构的主 benchmark。

### 4.5 对 15 人团队值得借鉴的模式

值得借鉴：

- 连接器 / 导入器把外部知识变成 AI 可检索上下文。
- Company Data / Space 分层。
- 个人图 + 企业图共存。
- namespace 化记忆，不搞单库大杂烩。
- background memory update，不把记忆维护全部放到主对话热路径。

过度工程化：

- Neo4j / JanusGraph / Neptune 这类专用图数据库。
- 复杂事件总线、Kafka、CDC 流水线。
- 细粒度 ABAC + IdP + SCIM 一上来全做。
- 自动把所有对话都写入共享知识库。
- 给每个员工单独训练“企业画像”或独立知识图谱。

### 4.6 与 Confluence / Notion 的关系

企业知识管理工具在你们这里更适合扮演 **source of truth**，而不是被 Agent 平台替代。

推荐模式：

- Confluence / Notion / CRM / GitHub 是原始知识源。
- Karazhan 只做两件事：
  - 连接、同步、索引这些来源。
  - 产出面向 Agent 的“精简摘要层”和“运行时检索层”。

不推荐的模式：

- 在 Agent 平台里复制一份完整的 Notion / Confluence 内容树并长期双写。

推荐的现实做法：

- 让外部系统继续做人类编辑入口。
- 让 Karazhan 负责消费、汇总、提炼、分发给 Agent。

---

## 五、知识图谱 vs 文档记忆

### 5.1 是否应该升级为结构化知识图谱

我的建议是：

> **不要升级成“完整知识图谱系统”，但应该从“纯 Markdown 文档”升级成“Markdown + 结构化元数据 + 轻关系索引”的混合体系。**

原因很简单：

- 15 人团队的信息规模并不大。
- 共享知识的主要痛点是“分发和权限”，不是“关系推理能力不足”。
- 真正难维护的是 ontology，而不是检索。
- 你们只有一位平台维护者，知识建模成本必须非常低。

### 5.2 对 15 人团队，完整知识图谱的 ROI 不合理

完整知识图谱通常需要长期维护：

- 实体类型定义
- 关系类型定义
- 实体去重
- 版本更新
- 冲突合并
- 权限继承
- 图查询 / 图检索调优

这些事情对 15 人团队的收益并不高，因为：

- 实体数量不够大，靠文档 + 标签 + metadata 已可覆盖绝大多数需求。
- 组织结构变化、客户阶段变化、项目阶段变化都很频繁，图谱维护容易比知识本身更贵。
- 最终大多数问题仍然是“找对那几篇文档并按权限给对人”，不是做复杂图遍历。

### 5.3 最适合你们的混合方案

建议采用三层数据模型：

#### 第一层：Markdown 正文

继续作为主要知识载体，适合：

- 产品描述
- 销售话术
- 项目背景
- 客户纪要
- 技术规范
- 决策记录

#### 第二层：结构化元数据

不要把元数据埋在正文里，建议单独落到 `space.json` / `knowledge.db`。

每篇文档至少有这些元数据：

- `space_id`
- `doc_type`：policy / playbook / decision / client-brief / project-status / spec
- `owner`
- `updated_at`
- `visibility`
- `source_of_truth`
- `confidence`
- `tags`
- `entity_refs`

#### 第三层：轻量关系索引

不做 full graph，只做“足够回答业务问题”的连接表：

- 人 -> 团队
- 人 -> 项目
- 客户 -> 销售负责人
- 客户 -> 项目
- 项目 -> 产品
- 项目 -> 代码仓库
- 策略 / 制度 -> 生效日期 -> 适用范围

可以放在一个轻量 SQLite 里：

```text
knowledge.db
  spaces
  documents
  entities
  entity_links
  access_grants
  change_log
```

### 5.4 为什么这是正确的折中

因为你们真正需要的不是“图谱问答炫技”，而是：

- 销售问产品和客户时能拿到对的材料
- 开发问项目和规范时能拿到对的材料
- PM 问项目状态时能拉到项目空间和相关客户空间
- CEO 的公司级知识不再只存在他个人记忆里

这些目标靠“文档 + metadata + ACL + 检索路由”就足够。

### 5.5 什么时候再考虑更强的图谱化

只有出现以下信号，才值得进入 Phase 3 以后更强的 graph 化：

- 员工规模 > 50
- 项目和客户数量显著增多
- 频繁出现跨实体查询，例如：
  - “哪些客户正在推进嗨聘，且过去 30 天提过招聘流程自动化需求？”
  - “哪些项目由 PM A 管理、销售 B 跟进、代码在 repo C，且本周有上线风险？”
- 需要更强审计和溯源

---

## 六、信息同步策略

### 6.1 Pull vs Push：建议采用混合策略，但以 Pull 为主

#### Pull 的优点

- prompt 不膨胀
- 权限更容易控制
- 公司知识变更后，不需要重写所有用户个人记忆
- 适合项目/客户这类上下文相关性很强的知识

#### Push 的优点

- 重要共识不用每次都查
- 对高频知识（产品定位、组织结构、团队规则）响应更快
- 能覆盖“员工不主动灌输背景信息”的问题

#### 建议方案

- **默认 Pull**
  - 项目知识、客户知识、较长规范、会议纪要等，通过工具按需检索。
- **精选 Push**
  - 只把少量高频、稳定、强共识的信息放进会话开头：
    - `company-all/MEMORY.md` 精选摘要
    - 用户所属团队 `MEMORY.md` 精选摘要
    - 当前用户个人 `MEMORY.md`

结论：

> 不要 Push 全公司知识；只 Push “稳定、高频、低争议”的头部知识。

### 6.2 推荐的注入策略

建议把新会话的注入顺序改成：

```text
<shared-memory scope="company-all">
公司长期知识精选
</shared-memory>

<shared-memory scope="team-sales|team-engineering|...">
团队长期知识精选
</shared-memory>

<memory-context>
个人长期记忆
</memory-context>
```

建议行数控制：

- 公司共享层：40-60 行
- 团队层：30-60 行
- 个人层：60-100 行

总量控制在 150-220 行内，避免 prompt 被共享信息吃满。

### 6.3 实时性应该做到什么程度

不是所有公司信息都要“秒级广播”。

建议按知识类型定义 SLA：

| 类型 | 例子 | 目标可见时延 |
|---|---|---|
| P0 立即生效 | 安全、法律、重大口径变更、系统事故 | 5-10 分钟，必要时主动 Push |
| P1 当天生效 | 产品价格、销售话术、流程调整、提成规则 | 30-60 分钟 |
| P2 常规背景 | 组织架构、项目阶段、普通决策记录 | 当天内 / 下次会话即可 |

对你们现在的系统来说，这个目标完全现实：

- 本地 Markdown 写入几乎实时。
- 当前索引器 watcher + debounce 已能做到几十秒到数分钟级刷新。
- 真正需要补的是“共享空间”和“跨空间检索”，不是实时基础设施。

### 6.4 冲突处理：公共知识与个人记忆矛盾怎么办

必须建立一个**真值优先级**，否则系统会越来越乱。

建议优先级：

1. `source_of_truth = true` 的共享空间文档
2. 对应团队 / 项目 / 客户空间中的最新文档
3. 个人记忆
4. 纯对话推断

同时再加两个维度：

- **更新时间**：同一权威级别下，更新更晚者优先
- **知识域**：不同类型由不同来源优先

建议按知识域定规则：

- 公司制度、价格、提成、组织口径
  - 共享空间优先，个人记忆只能作补充
- 项目状态、客户进展
  - 项目 / 客户空间优先，最新时间优先
- 个人偏好、个人待办
  - 个人空间优先

### 6.5 冲突时 Agent 的行为建议

当检索到冲突信息时，Agent 不应静默择一，而应：

1. 优先使用权威来源给出答案。
2. 明确指出存在较旧或较低权威的冲突记录。
3. 在高风险场景下提示用户确认。

例如：

> 当前检索到两条信息：  
> `team-sales/pricing.md` 在 2026-04-10 更新，标记为正式口径；  
> 某销售个人记忆在 2026-03-28 记录了旧报价。  
> 因此本次回答以团队正式口径为准。

---

## 七、安全与权限

### 7.1 不要把所有权限问题压到 `admin/user`

你们当前运行时身份里，`role` 只有：

- `admin`
- `user`

这用于登录权限和平台操作权限已经足够，但不适合直接承担知识权限。

推荐做法是分层：

- **认证角色（Auth Role）**
  - 继续保留 `admin/user`
- **知识归属（Team / Knowledge Groups）**
  - `sales`
  - `engineering`
  - `pm`
  - `ops`
  - `assistant`
  - `executive`
- **空间 ACL**
  - 哪些 group 可读
  - 哪些 user / owner 可写

也就是说：

> 登录权限仍然简单；知识权限放到 space ACL 解决。

### 7.2 对 15 人团队最省管理成本的权限模型

建议每个用户只维护少量附加字段：

- `team`
- `knowledgeGroups[]`
- `isExecutive` 或直接通过 group 表示

例如：

| 用户 | team | knowledgeGroups |
|---|---|---|
| CEO/Admin | admin | `["all","executive","sales","engineering","pm","ops"]` |
| 销售 | sales | `["all","sales"]` |
| 开发 | engineering | `["all","engineering"]` |
| PM | pm | `["all","pm","project-core"]` |
| 运营 | ops | `["all","ops"]` |
| 总经理助理 | assistant | `["all","assistant","executive-lite"]` |

这已经足够表达你们现阶段 90% 的需求。

### 7.3 推荐的共享空间可见性设计

建议初始只建立 6 类空间：

1. `company-all`
   - 全员可读
2. `team-sales`
   - 销售、CEO、必要时 PM 可读
3. `team-engineering`
   - 开发、CEO、PM 可读
4. `projects/{project}`
   - 项目成员可读
5. `clients/{client}`
   - 负责销售 + PM + 相关交付成员可读
6. `exec-confidential`
   - CEO / 特定高管 / 必要助理可读

不要一开始就建 20 个空间。空间数量控制在 4-8 个即可。

### 7.4 运行时怎么实现权限控制

最小改动路径下，权限链建议如下：

1. 登录鉴权仍使用现有 `admin/user`。
2. 在用户资料里增加 `team` 与 `knowledgeGroups`。
3. 会话开始时，先解析当前用户可见的 spaces。
4. `knowledge_search` 只搜索可见 spaces。
5. 共享空间目录对普通用户默认只读。
6. 写共享空间必须由 owner / curator / admin 发起。

### 7.5 不增加管理负担的关键点

如果 CEO 是唯一维护者，权限系统一定要遵守这三条：

1. **空间数量少**
   - 不要按“每个人”“每个小话题”建空间。
2. **权限以 group 继承为主**
   - 不要维护大量 user-level ACL。
3. **共享空间写权限收敛**
   - 少数 owner 写，多数成员读。

### 7.6 员工离职时的知识保留和清理

你们现有代码已经有用户资源软删除能力，这是很好的基础。

建议离职流程分三步：

1. **先禁用账号**
   - 阻断新访问
2. **保留并归档个人 workspace**
   - 用现有 soft delete 思路归档，不立即物理删除
3. **提取工作相关知识到共享空间**
   - 客户纪要、项目状态、交付文档、常用流程迁移到 team / project / client spaces

离职后的保留策略建议：

- 个人偏好、私人上下文：归档，不再被检索
- 工作知识：迁移到共享空间继续保留
- 客户 / 项目相关事项：必须在离职前做 promotion

不建议：

- 直接删除原 workspace
- 也不建议让离职员工的个人 workspace 永久参与全局搜索

---

## 八、建议的数据流

### 8.1 读路径

```text
用户发起会话
  -> 解析用户身份（admin/user）
  -> 解析 team / knowledgeGroups
  -> 计算可见 spaces
  -> 注入 company + team + personal 的精选 MEMORY
  -> 对涉及公司/团队/项目/客户的问题调用 knowledge_search
  -> 只在可见 spaces + personal workspace 中检索
  -> 根据 source_of_truth / recency / role relevance 排序
  -> 生成答案
```

### 8.2 写路径

```text
对话产生新信息
  -> 现有 memory hook 继续写入个人 daily memory
  -> 若信息属于共享知识，进入 promotion 流程
      -> 指定目标 space（company / team / project / client / exec）
      -> owner 或 admin 审核
      -> 写入目标 space 的 daily / topics / MEMORY
  -> 对应 space 索引刷新
  -> 后续用户按权限可见
```

### 8.3 外部知识源路径

```text
Notion / Confluence / CRM / GitHub / 本地文件
  -> 定时同步或人工导入
  -> 落入目标共享 space
  -> 生成摘要 / 更新 topics
  -> 建立 metadata
  -> 索引刷新
  -> Agent 检索可用
```

### 8.4 为什么一定要有 promotion 流程

因为你们当前最大的问题就是：

- CEO 的个人记忆里有很多公司级知识
- 但不是所有 CEO 说过的话都应该自动广播给所有人

所以正确机制不是“自动共享一切”，而是：

> 先写入个人空间，再把应共享的内容 promotion 到共享空间。

这既防泄漏，也能保留管理边界。

---

## 九、对现有代码的最小改动路径

这一部分是最关键的。

目标不是重构平台，而是在现有架构上加一层共享知识能力。

### 9.1 第一步：新增共享空间目录，不动个人空间

新增一个保留前缀目录，例如：

```text
WORKSPACE_ROOT/_spaces/
```

优点：

- 不与用户名冲突
- 可以复用现有 workspace / indexer 模型
- 不影响已有用户目录和历史数据

### 9.2 第二步：增加轻量 registry

新增：

```text
WORKSPACE_ROOT/_registry/spaces.json
WORKSPACE_ROOT/_registry/users.json
```

用来解决两件事：

- 哪些 space 存在、类型是什么、谁可见
- 某个用户属于哪个 team / knowledgeGroups

Phase 1 完全可以用 JSON 文件，不必先上数据库。

### 9.3 第三步：扩展用户资料

建议修改用户数据结构，增加：

- `team?: string`
- `knowledgeGroups?: string[]`

涉及位置大致包括：

- `server/src/data/users/types.ts`
- `server/src/data/users/store.ts`
- `shared/src/types/user.ts`
- 用户管理 API / 前端表单

这一步工作量不大，但能把“谁该看什么”正式接入运行时。

### 9.4 第四步：扩展共享记忆加载

当前 `server/src/agent/memory.ts` 只加载个人 `MEMORY.md`。

建议新增：

- `loadSharedMemoryContexts(userContext)`

其职责：

- 根据用户 team / knowledgeGroups 解析可自动注入的 spaces
- 读取这些 space 的 `MEMORY.md`
- 按优先级和行数限制拼接

`runner.ts` 中的注入逻辑可扩展为：

- 个人记忆
- 公司共享记忆
- 团队共享记忆

而不是只注入个人记忆。

### 9.5 第五步：扩展检索工具为跨空间检索

当前 `memory_search` / `memorySearchIndexed` 本质上还是按当前用户 workspace 走。

建议改为二选一：

#### 方案 A：新增 `knowledge_search`

优势：

- 与现有 `memory_search` 语义清晰分离
- 便于逐步迁移

检索范围：

- 当前用户个人 workspace
- 可见共享 spaces

#### 方案 B：扩展现有 `memory_search`

新增参数：

- `scope = personal | shared | all`
- 可选 `spaces[]`

对现有 Prompt 改动更少，但语义略脏。

我更建议方案 A，因为：

- 个人记忆和企业知识检索最终会有不同排序逻辑
- 后续更容易加 ACL、source_of_truth、space filters

### 9.6 第六步：把共享空间接入索引服务

这一步其实最容易，因为 `MemoryIndexService` 已经支持多 `workspaceDir`。

只需要：

- 在需要时对 `_spaces/company-all`、`_spaces/team-sales` 等创建 indexer
- 检索时聚合多个 indexer 结果
- 做一次 ACL + rerank

不需要：

- 重写 FTS
- 重写 embedding
- 重写 chunker

### 9.7 第七步：利用现有 cron 和 memory hook 做共享整理

建议不要让现有 memory hook 直接写共享空间。

更合理的方式：

- 现有 hook 继续写个人空间
- 再新增一个“共享知识整理” cron：
  - 扫描 admin / PM / 销售 owner 的新增 daily memory
  - 生成 promotion 建议
  - 写入对应共享 space

原因：

- 主对话链路保持简单
- 避免一次对话就污染共享知识库
- 更适合单维护者审核

### 9.8 第八步：真正启用 `infoBoundary`

当前 `infoBoundary` 已经在 Agent profile 中存在，但没有形成闭环。

建议把它从“展示属性”升级成“运行时裁剪条件”：

- `sharedKnowledge=false`
  - 不给该 Agent 注入共享知识，也不允许搜共享空间
- `codeRepos=false`
  - 不给开发仓库目录访问权
- `otherWorkspaces=false`
  - 不允许跨个人 workspace 检索

这能让不同 Agent profile 对知识边界有显式约束。

---

## 十、推荐的 starter spaces

如果只做第一批，建议只建这 5 个：

### 1. `company-all`

内容建议：

- 组织架构
- 产品矩阵
- 业务方向
- 对外统一口径
- 基础流程

### 2. `team-sales`

内容建议：

- 产品卖点
- 目标客户画像
- 报价边界
- CRM 规范
- 客户跟进模板

### 3. `team-engineering`

内容建议：

- 代码仓库索引
- 技术规范
- 部署环境
- 分支/发布策略
- 常见排障知识

### 4. `projects/hippin`

内容建议：

- 项目目标
- 当前阶段
- 负责人
- 关键里程碑
- 相关客户 / 需求 / repo

### 5. `exec-confidential`

内容建议：

- 提成制度
- 战略方向
- 财务口径
- 高敏决策

这 5 个空间已经能解决你描述里的大部分核心问题。

---

## 十一、渐进式实施路线图

## Phase 1：共享知识层上线（1-2 周）

目标：

- 让所有 Agent 至少知道基础公司知识
- 让销售和开发开始拥有团队级共享上下文

核心交付物：

1. `_spaces/` 目录和 `space.json` 规范
2. `company-all`、`team-sales`、`team-engineering` 三个共享空间
3. 用户 `team / knowledgeGroups` 字段
4. 会话启动时自动注入 company + team + personal 三层 MEMORY
5. `knowledge_search` 初版，只读共享空间
6. 从 CEO 当前记忆中拆分出首批共享内容

最小改动原则：

- 不动现有个人 memory hook
- 不动现有 per-user workspace
- 不做复杂 UI，先用文件 + JSON 配置即可

这一阶段就能明显解决：

- 公司信息只在 CEO 记忆里
- 员工 MEMORY.md 空导致 Agent 无背景
- 销售 / 开发缺少角色相关上下文

## Phase 2：项目/客户空间 + promotion 流程（2-4 周）

目标：

- 让共享知识真正流转起来
- 让项目和客户信息不再依附在个人记忆

核心交付物：

1. `projects/*`、`clients/*` 空间
2. promotion 机制
   - 从个人记忆提升到共享空间
3. 共享知识整理 cron
4. source_of_truth / updated_at / visibility 等 metadata
5. 简单冲突处理规则

建议流程：

- Admin / PM / 销售 owner 的对话先入个人 memory
- 夜间 cron 汇总并生成共享更新
- owner 审阅后进入 team/project/client spaces

这一阶段解决：

- 信息孤岛
- 项目/客户知识断层
- 新信息无法稳定共享

## Phase 3：轻结构化层 + 外部系统接入（4-8 周）

目标：

- 让检索更稳定
- 让共享知识从“文件集合”进化为“带结构的企业上下文”

核心交付物：

1. `knowledge.db`
   - `spaces`
   - `documents`
   - `entities`
   - `entity_links`
2. Notion / Confluence / GitHub / CRM 的定时同步入口
3. 更稳定的 rerank
   - source_of_truth
   - recency
   - role relevance
4. 离职归档与知识迁移流程固化

注意：

- 到 Phase 3 也仍然不需要上重型图数据库
- 只有当团队和知识量明显增长，再考虑更强 graph 化

---

## 十二、针对你们组织角色的具体建议

### CEO / Admin

建议拥有：

- `company-all`
- `exec-confidential`
- 所有 team / project / client spaces 的 owner 权限

但 CEO 不应继续做“唯一知识容器”。

建议把 CEO 记忆中现有 200 行内容拆成：

- `company-all/MEMORY.md`
- `team-sales/MEMORY.md`
- `exec-confidential/MEMORY.md`

CEO 个人 `MEMORY.md` 只保留其个人偏好、个人决策风格、私人上下文。

### 销售团队

默认可见：

- `company-all`
- `team-sales`
- 自己负责的 `clients/*`
- 相关 `projects/*`

销售 Agent 不应依赖个人 MEMORY 才知道产品怎么卖。

### 开发团队

默认可见：

- `company-all`
- `team-engineering`
- 相关 `projects/*`
- 必要时只读部分客户背景

开发 Agent 应通过团队 / 项目空间拿到规范、repo、上线背景，而不是问一次记一次。

### PM

默认可见：

- `company-all`
- `projects/*`
- 相关 `clients/*`
- 视情况读取销售/开发空间摘要

PM 最适合做项目空间 owner。

### 运营

默认可见：

- `company-all`
- 可选 `team-marketing` 或 `ops-content`
- 与内容相关的产品资料空间

### 总经理助理

默认可见：

- `company-all`
- `assistant-office`
- 视需要给 `executive-lite`

建议不要直接给完整 `exec-confidential`，而是拆出必要子空间或 group。

---

## 十三、实施时应避免的坑

1. 不要把所有共享知识都塞进每个用户的 `MEMORY.md`
2. 不要把 CEO 个人 memory 直接复制到所有用户 workspace
3. 不要自动把所有对话写入共享空间
4. 不要用“图谱化”掩盖其实只是“权限和空间边界”没设计好的问题
5. 不要一开始就接太多外部系统
6. 不要让每个员工都承担共享知识维护责任

正确的维护责任应该是：

- 个人层：用户本人 + 当前 memory hook
- 公司层：CEO / Admin
- 团队层：团队 owner
- 项目层：PM
- 客户层：销售 owner

---

## 十四、最终建议

如果只给一个最务实的方案，我的建议是：

### 你现在就应该做的事

1. 新增 `_spaces/company-all`、`_spaces/team-sales`、`_spaces/team-engineering`
2. 把 CEO 现有 200 行记忆拆分迁移到这 3 个共享空间
3. 给用户增加 `team / knowledgeGroups`
4. 会话开始时自动注入 company + team + personal 三层精选记忆
5. 增加 `knowledge_search`，允许在可见共享空间中检索

### 你现在不该做的事

1. 不要上完整知识图谱
2. 不要重写记忆架构
3. 不要做复杂实时广播
4. 不要做细粒度到文档段落级的权限系统

### 判断标准

如果改完之后出现下面这些现象，就说明方向是对的：

- 新员工几乎不写个人 MEMORY，也能获得足够公司背景
- 销售问产品、客户、提成规则时，Agent 不再“失忆”
- 开发问项目、规范、仓库时，Agent 不必依赖个人历史对话
- CEO 的知识开始成为公司资产，而不是个人资产
- 新信息能从个人空间 promotion 到共享空间，而不是继续形成孤岛

---

## 参考信息（官方公开资料）

- Glean Enterprise Graph: https://www.glean.com/product/enterprise-graph
- Glean Google Drive Connector Overview: https://docs.glean.com/connectors/native/gdrive/about
- Dust Connections: https://docs.dust.tt/docs/connections
- Dust Memberships & Roles: https://docs.dust.tt/docs/setting-up-your-workspace
- LangGraph Memory Overview: https://docs.langchain.com/oss/javascript/langgraph/memory
- LangChain Long-term Memory: https://docs.langchain.com/oss/python/langchain/long-term-memory
- Fixie / Ultravox 官方站点（截至 2026-04-14 的产品定位参考）: https://fixie.ai/

