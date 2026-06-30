# 企业级 Agent 提示语框架：Memory、公司知识与 Persona 的嵌入与持续更新

> 作者视角：资深 AI 工程师 / KY Agent 架构组
> 调研截止：2026-06-20
> 适用对象：开沿科技 KY Agent 产品线，及任何基于 Claude / GPT 系列构建企业级 Agent SaaS 的团队

---

## 1. 引言：企业 Agent 与消费级 Agent 的本质差异

ChatGPT 给个人用户用了三年，Claude.ai 也已成熟。对 C 端 Agent 而言，"个性化记忆"几乎只是"我叫 Alex、我喜欢简洁回复"这种轻量画像；上下文边界是单个账号，失败的代价是体验下降。**但企业 Agent 完全是另一种生物。**

差异主要体现在六个维度：

| 维度 | 消费级 Agent | 企业级 Agent |
|---|---|---|
| 上下文主体 | 单一用户 | 公司 + 团队 + 角色 + 个人 四层叠加 |
| 知识来源 | 模型预训练 + 用户对话 | 内部 Wiki / Notion / 飞书 / SVN / 业务库 / SOP / 合规红线 |
| 数据敏感度 | 偏好级 PII | 客户名单、合同条款、源代码、HRIS — 全是法务红线 |
| 失败代价 | 用户体验差 | **业务事故 / 合规事件 / 法律纠纷** |
| 更新机制 | 模型升级即可 | 必须 ≤ 分钟级反映 Notion / Confluence 更新 |
| 隔离要求 | 账号即边界 | tenant × team × user × document 四级 ACL |

把这些差异翻译成提示语工程的约束就是：**企业 Agent 的 system prompt 不能"写完就完事"，它必须是一套有版本、有层级、有失效机制、可观测、可治理的"上下文流水线"**。本份文档围绕这个流水线展开。

我们采用一个被 Andrej Karpathy 公开背书、Anthropic 2025 年正式提出的术语——**Context Engineering**：

> *"Context engineering refers to the set of strategies for curating and maintaining the optimal set of tokens (information) during LLM inference."* — Anthropic, *Effective Context Engineering for AI Agents* (2025)

它和"prompt engineering"的区别是：prompt engineering 关注"写好一段话"，context engineering 关注"在 200K 上下文窗口里，每一个 token 是否值得占据它的位置"。本份文档的所有设计建议都基于这一更高维的目标。

---

## 2. 上下文层级模型：System / Org / Team / User / Session

任何企业 Agent 的上下文都可以被解构为 **五层**。层次越靠上越稳定、越适合静态注入与缓存；越靠下越动态、越适合 RAG 与工具按需取。

```
┌─────────────────────────────────────────────────────────────────────┐
│  Layer 1: SYSTEM (Anthropic 出厂 Harness)                           │
│  └─ 内置工具规范、tool_use 协议、安全准则                            │
│  └─ 不可编辑，由模型 provider 维护                                   │
├─────────────────────────────────────────────────────────────────────┤
│  Layer 2: ORG (公司层 — workspace-shared/COMPANY.md)                │
│  └─ 公司身份、价值观、业务范围、整体合规红线                          │
│  └─ 变更频率: 季度 — 高度稳定 — 适合 1h prompt cache                 │
├─────────────────────────────────────────────────────────────────────┤
│  Layer 3: TEAM (团队/角色层 — TEAM.md / role:legal/sales/eng)       │
│  └─ 团队 SOP、工具集裁剪、命名规范、领域术语                         │
│  └─ 变更频率: 月 — 适合 1h cache                                    │
├─────────────────────────────────────────────────────────────────────┤
│  Layer 4: USER (用户层 — ~/workspace/{username}/MEMORY.md)          │
│  └─ 个人偏好、历史项目路径、过敏症、上一次中断的上下文                │
│  └─ 变更频率: 日 — 适合 5min cache 或不缓存                          │
├─────────────────────────────────────────────────────────────────────┤
│  Layer 5: SESSION (本轮对话)                                        │
│  └─ 用户当前问题、附件、RAG 命中片段、当前时间戳                     │
│  └─ 不缓存                                                          │
└─────────────────────────────────────────────────────────────────────┘
                          ▲
                          │
       ┌──────────────────┴───────────────────┐
       │     辅助维度（横切所有层）            │
       │  • Procedural Memory  Agent 自学经验  │
       │  • Knowledge Corpus   RAG 检索结果    │
       │  • Tools / Skills     按需调用        │
       └──────────────────────────────────────┘
```

按 Anthropic 的 prompt cache 失效矩阵 `tools → system → messages`，**层次结构必须按上图顺序拼接进 API 调用**，把变化最少的内容放最前面，才能拿到最高 cache 命中率。

### 2.1 各层职责的非重叠原则

层与层之间最容易踩的坑是**职责混淆**：把"公司允许使用的工具列表"写到 USER 层，每个用户一份冗余拷贝；或者把"用户偏好用 TypeScript"写到 ORG 层，污染所有人。一条铁律：

- ORG 层只回答 *"我们公司是干什么的、不允许做什么"*
- TEAM 层只回答 *"作为法务/销售/工程师，我应该怎么做"*
- USER 层只回答 *"这个具体的人 / 这个具体的项目有什么特殊情况"*
- SESSION 层只回答 *"我现在要解决什么问题"*

KY Agent 当前的 `CLAUDE.md` 其实承担了 ORG + TEAM 的混合职责，建议拆分（见第 12 节）。

---

## 3. 各层级的注入方式

三种注入路径，按"信息生命周期"来选：

| 路径 | 适用层 | 工作机制 | 何时选 |
|---|---|---|---|
| **静态文件** | ORG / TEAM / 部分 USER | 启动时一次性读入 system prompt | 总量 < 5K tokens、变化频率低于 cache TTL |
| **动态 RAG** | Corpus / 部分 USER | 查询时检索 → 拼到 user turn | 信息量大、半结构化、需要 ACL 过滤 |
| **工具按需取** | Operational data / Procedural | 模型主动调用 API/MCP | 实时性要求高、数据不宜入索引（密码、订单状态） |

**选择口诀**：*"每次任务都会用到 → 静态；可能用到 → RAG；只有特定问题用到 → 工具。"*

### 3.1 静态注入的硬约束

5000 条事实 × 13 token ≈ 65,000 tokens / 每次请求。若每天 10 万次调用，每天净沉没 65 亿 tokens——这笔钱不可能省。

哪些信息适合静态注入？必须**同时满足**五条：

1. 每次任务都会用到
2. 变更频率低于 cache TTL（5min 或 1h）
3. 总量 < 5K tokens（含 skill 索引后 < 15K）
4. 不含组织隔离信息（静态意味着所有用户可见）
5. 大于模型的"最小可缓存 token"阈值（Sonnet 4.5/4.6 是 1024 tokens，否则缓存不会生效）

不符合任何一条 → 走 RAG 或 Tool。

### 3.2 Prompt Cache 的精确价格（2026-06 核验）

Anthropic 官方文档明确：

- **Cache read（命中）**：0.1× base input price
- **Cache write（5 分钟 TTL）**：1.25× base input
- **Cache write（1 小时 TTL）**：2× base input
- **最小可缓存 token**：Sonnet 4.5/4.6/4.8、Opus 4.8 = 1024；Opus 4.7 = 2048;  Haiku 4.5 = 4096
- **缓存校验**：响应里看 `cache_creation_input_tokens` 与 `cache_read_input_tokens`，都为 0 表示**没缓存上但不会报错**——隐蔽的成本坑，必须监控

下面是 KY Agent 推荐的注入模板（TypeScript / Anthropic SDK）：

```ts
// server/agent/buildSystemPrompt.ts
import fs from "node:fs/promises";
import path from "node:path";

export async function buildSystemBlocks(userDir: string, role?: string) {
  const company = await fs.readFile(
    path.join(process.env.WORKSPACE_SHARED!, "COMPANY.md"), "utf8");
  const team = role
    ? await fs.readFile(path.join(process.env.WORKSPACE_SHARED!, "teams", `${role}.md`), "utf8")
    : "";
  const project = await fs.readFile(
    path.join(userDir, "CLAUDE.md"), "utf8").catch(() => "");
  const memory  = await fs.readFile(
    path.join(userDir, "MEMORY.md"), "utf8").catch(() => "");

  return [
    // ORG 层：跨用户共享，开 1h 缓存（前提是已超过 1024 token 最小门槛）
    { type: "text", text: company,
      cache_control: { type: "ephemeral", ttl: "1h" } },
    // TEAM 层：按角色裁剪，5min 缓存
    { type: "text", text: team,
      cache_control: { type: "ephemeral" } },
    // USER 项目层
    { type: "text", text: project,
      cache_control: { type: "ephemeral" } },
    // USER memory：高频变化，不缓存
    { type: "text", text: memory },
  ];
}
```

> 关键：`cache_control` 必须放在 block 末尾，Anthropic 从"最长前缀"匹配命中，上面的顺序保证最高缓存复用率。

---

## 4. Memory 系统深度对比

到了关键章节。我们对 7 个主流方案做横向对比——既覆盖学术 / 开源框架，也包含 Anthropic 自家"文件式" memory。

### 4.1 总览表

| 框架 | 数据结构 | 写入时机 | 读取时机 | Prompt 注入 | 多组织隔离 | 后端 |
|---|---|---|---|---|---|---|
| **mem0** | Vector + 可选 Graph + KV | LLM 自动 fact extraction → ADD/UPDATE/DELETE/NONE 四态 | 查询时 hybrid（向量 + BM25 + entity） | `m.search()` 返回 facts，拼 "User facts:" 段 | `user_id` / `agent_id` / `run_id` / `app_id` 四维 | Qdrant / pgvector / Chroma / Neo4j |
| **Letta (MemGPT)** | 三层：Core Block + Recall Log + Archival | Agent 自决工具调用；v0.7+ sleep-time agent 后台改写 | Core 常驻；Recall/Archival 按需检索 | Core blocks 直接拼 system；其余通过工具结果 | `Identity` + `agent_id` | Postgres |
| **Zep + Graphiti** | 时序知识图谱 (Episode / Entity / Community)，边带 `valid_at`/`invalid_at` | `thread.add_messages` 异步入图 | `thread.get_user_context` 返回拼好的字符串 | 直接放 system message | `User` / `Thread` first-class | Neo4j / FalkorDB + Postgres |
| **Cognee** | GraphRAG：KG + 向量 + 元数据 | `cognify()` 跑 ECL；v1.1 加 `remember()` / `recall()` 高阶 API | 14 种 retriever 自动路由 | 用户自组装 | dataset → 独立图库 | 7+ 向量库 / 4+ 图库 |
| **Claude Code MEMORY.md** | 纯 Markdown 分层 | 手工编辑 / `#` 快捷指令 / **v2.1.59+ auto-memory** | session 启动逐层加载，前 200 行 / 25 KB 进 context | 直接拼 system prompt | 物理目录隔离 | 本地文件系统 |
| **LangGraph BaseStore + LangMem** | KV + 向量，`namespace` 元组 | 双模式：hot path / background | `store.search(namespace, query)` | 开发者在 node 内组装 | namespace 嵌套 | InMemoryStore / Postgres / Mongo / Redis |
| **ChatGPT Memory** | saved memories + reference history（双层） | LLM 自动判定；后台 "dreaming" 整理 | saved 全注入；history 向量检索 | 闭源 "# Bio" 段 | 账号级 | OpenAI 自管 |

### 4.2 公开基准（LongMemEval / LoCoMo，GPT-4o 评估）

| 框架 | LongMemEval | LoCoMo | Token / 查询 |
|---|---|---|---|
| Mem0 v1 (2024) | 49.0% | — | ~9k |
| Mem0 multi-signal (2026-05) | **94.4%** | **92.5%** | ~6.8k |
| Zep / Graphiti (GPT-4o) | 63.8% | — | — |
| Letta MemGPT | DMR 93.4% | — | — |

> ⚠️ 这些数字大多是厂商自报。mem0 与 Zep 互相宣称领先，生产选型务必复跑自己的数据集。

### 4.3 记忆类型分层

记忆不是一种东西，而是四种生命周期完全不同的事物：

```
┌─────────────────────────────────────────────────────┐
│  Episodic 情景记忆 (短期、高保真、可丢)              │
│  └─ "用户上一句问了什么"、最近 10 轮对话             │
│  └─ 落地：messages 数组本身 + Anthropic Context Editing│
├─────────────────────────────────────────────────────┤
│  Semantic 语义记忆 (长期事实、需更新)                │
│  └─ "用户的产品偏好"、"客户的合同条款"               │
│  └─ 落地：mem0 / Zep / MEMORY.md                    │
├─────────────────────────────────────────────────────┤
│  Procedural 程序记忆 (复用技能、Agent 自学)          │
│  └─ "调钉钉 webhook 时 secret 用 HMAC-SHA256"        │
│  └─ 落地：Anthropic Memory Tool / Skills            │
├─────────────────────────────────────────────────────┤
│  Identity / Persona 身份记忆 (角色定义)              │
│  └─ "你是 KY Agent，专为开沿科技服务"                │
│  └─ 落地：system prompt 顶部 1 句话                  │
└─────────────────────────────────────────────────────┘
```

**KY Agent 当前的 `~/workspace/{username}/MEMORY.md` 是合格的 Semantic memory v0**，但没有承载 Procedural（Agent 学到的技巧）。建议在 `workspace-shared/agent-memory/` 单独划分，避免污染用户隔离。

### 4.4 记忆写入时机：三种范式

第一种 **LLM 自动 fact extraction**（mem0、ChatGPT、auto-memory）：每轮对话结束让 LLM 判断"哪些是值得记的事实"，跑一遍 Extract → Compare → Resolve 流水线得出 ADD/UPDATE/DELETE/NONE。优点是无感、覆盖广；缺点是有抽取错误，且每条记忆都要付 LLM 调用成本。

第二种 **Agent 自主调用工具写入**（Letta、Claude Code `#` 指令）：把记忆操作做成工具暴露给 Agent，Agent 在 reasoning 过程中自决调用 `core_memory_append` / `archival_memory_insert`。优点是 Agent 知道"什么时候该记"，可控性高；缺点是 Agent 可能完全忘记调用。

第三种 **Background extraction**（LangMem manager、Letta sleep-time agent）：把对话日志异步送给后台 worker 提取记忆，与主对话解耦。优点是不影响主对话延迟；缺点是延迟更新，且后台 worker 也会出错。

**KY Agent 推荐组合**：
- USER 层用 Background extraction（LangMem manager + PostgresStore），namespace = `("memories", username)`
- 同时保留 MEMORY.md 作为"人类可编辑层"
- 在 system prompt 中明确允许 Claude auto-memory 写入 MEMORY.md（增加约定，见第 12 节）

---

## 5. 记忆写入时机的细节决策

写入时机决定了"系统会不会被自己写的废话淹没"。以下是三类需要谨慎处理的边界场景：

1. **用户当面说"记住 X"**：必须立即写入，并在下次会话明确反馈"已记住 X"，建立信任。
2. **用户没说但 Agent 推断出长期事实**：例如对话中得知用户 1990 年生。需要 *延迟一轮* 再写入，让用户有机会反对。
3. **临时背景信息**：例如"我今天有点忙，先回这些"——不应写入长期记忆，但应该影响本次会话的 tone。

写入前 *必须* 检查的三类内容：
- 是否包含 **PII 超出业务允许范围**（身份证号、银行卡号、密码）
- 是否是 **临时情绪表达**（避免把"我今天心情不好"写成长期偏好）
- 是否与 **已有记忆冲突**（mem0 用 LLM 解决冲突；MEMORY.md 应保留"更新时间戳"作为人类裁决依据）

---

## 6. 多用户隔离设计

这是 SaaS Agent 产品的生死线。分三层考虑。

### 6.1 三种物理隔离模式

```
┌─── Silo ────┐  ┌─── Pool ────┐  ┌─── Bridge ───┐
│ tenant_A    │  │  shared     │  │ shared idx + │
│   index     │  │  index +    │  │ silo for VIP │
│ tenant_B    │  │  tenant_id  │  │              │
│   index     │  │  filter     │  │              │
└─────────────┘  └─────────────┘  └──────────────┘
  最强隔离          最低成本           折中
  Pinecone          pgvector RLS      混合
  namespace         单表(推荐起步)    Bridge 模式
  turbopuffer
  100M+ namespaces
```

**[2026 共识] turbopuffer 是 SaaS 友好首选**：object-storage-native（S3/GCS/Azure Blob）+ NVMe 热缓存，**最大可达 100M+ namespaces**，未访问的 namespace 几乎零存储成本——比 Pinecone 便宜 ~10×。

### 6.2 KY Agent 推荐：Postgres + RLS + 文件系统物理隔离

KY Agent 已经有了 `~/workspace/{username}/` 物理目录隔离（覆盖 USER 层 memory + uploads）。需要补的是 **数据库层的 tenant 隔离**。给出生产可用的 schema：

```sql
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE kb_chunks (
  id              BIGSERIAL PRIMARY KEY,
  tenant_id       UUID NOT NULL,
  source          TEXT NOT NULL,         -- 'feishu' | 'dingtalk' | 'manual'
  source_doc_id   TEXT NOT NULL,
  chunk_idx       INT  NOT NULL,
  content         TEXT NOT NULL,
  context_prefix  TEXT,                  -- Anthropic Contextual Retrieval
  content_hash    BYTEA NOT NULL,        -- xxhash64(content + context)
  embedding       vector(1024) NOT NULL,
  tsv             tsvector
                  GENERATED ALWAYS AS (to_tsvector('simple', content)) STORED,
  accessible_by   TEXT[] NOT NULL,       -- ['user:u1','group:eng','public']
  metadata        JSONB NOT NULL DEFAULT '{}',
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at      TIMESTAMPTZ,           -- tombstone, GC after 48h
  UNIQUE(tenant_id, source, source_doc_id, chunk_idx)
);

CREATE INDEX ON kb_chunks USING hnsw (embedding vector_cosine_ops);
CREATE INDEX ON kb_chunks USING gin (tsv);
CREATE INDEX ON kb_chunks (tenant_id, source_doc_id) WHERE deleted_at IS NULL;

ALTER TABLE kb_chunks ENABLE ROW LEVEL SECURITY;
ALTER TABLE kb_chunks FORCE ROW LEVEL SECURITY;   -- 必须 FORCE，否则 owner 绕过
CREATE POLICY kb_chunks_tenant_isolation ON kb_chunks
  USING (tenant_id = current_setting('app.tenant_id')::uuid);
```

**三个不可妥协的坑**：
1. **`FORCE ROW LEVEL SECURITY`** 必须开，否则 table owner 一律绕过 RLS
2. 连接池**必须用 Transaction Pooling，不能用 Statement Pooling**——后者会跨请求泄漏 `SET app.tenant_id`
3. PG15+ 创建 VIEW 必须显式 `WITH (security_invoker = true)`

Express 中间件强制注入：

```ts
// server/middleware/tenant.ts
export const withTenant: RequestHandler = async (req, res, next) => {
  const tenantId = req.user?.tenantId;
  if (!tenantId) return res.status(401).end();

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL app.tenant_id = $1", [tenantId]);  // SET LOCAL!
    (req as any).db = client;
    res.on("finish", async () => {
      try { await client.query("COMMIT"); } finally { client.release(); }
    });
    next();
  } catch (e) { client.release(); next(e); }
};
```

注意 `SET LOCAL`（事务级）而非 `SET`（session 级）——即使错误地用了 statement pooling，事务结束也会自动清除。

### 6.3 ACL 与 tenant 是正交的两件事

很多团队踩的坑：把"哪个公司可见"和"公司内哪些人可见"混在 `tenant_id` 一列里。正确做法：

- `tenant_id` → 决定 "哪个公司"（DB RLS 强制）
- `accessible_by` → 决定 "公司内哪些人 / 组"（查询时 filter）

```sql
-- 查询同时受 RLS（tenant_id）+ 应用层 ACL（accessible_by）双重过滤
SELECT content FROM kb_chunks
WHERE accessible_by && $1::text[]   -- ['user:alice', 'group:legal', 'public']
  AND embedding <=> $2 < 0.4
ORDER BY embedding <=> $2 LIMIT 10;
```

---

## 7. 公司总体情况嵌入：静态 vs RAG

### 7.1 决策矩阵

```
            HIGH  ▲
             ┌────┴──────────────────┐
   变更频率  │ Tool / MCP            │ Tool + 短缓存
             │ 订单、库存、HRIS      │ 价格表
             ├──────────────────────┤
             │ RAG (增量索引)        │ RAG + KG
             │ Wiki/Slack/Confluence │ 关系类问题
             ├──────────────────────┤
             │ 静态注入 (COMPANY.md) │ Skills 包
             │ 价值观/规范           │ 复杂操作流程
             └──────────────────────────►
              LOW       信息规模          HIGH
```

### 7.2 静态层应包含什么

模板 `workspace-shared/COMPANY.md` 推荐结构：

```markdown
# 开沿科技 (KY Agent 服务)

## 我们是谁
开沿科技是一家提供企业 Agent SaaS 的公司，KY Agent 服务于内部
办公自动化（钉钉 / 飞书集成）、客户支持、研发提效三个主要场景。

## 我们不做什么
- 不替用户做有法律或财务后果的不可逆决策（合同签订、转账、删库）
- 不提供医疗 / 法律 / 投资建议的"专业意见"，可以做信息整理
- 不在未授权情况下访问用户邮箱 / IM 私聊

## 通用行为准则
- 中文场景优先用中文回复
- 涉及代码改动遵循 `禁止擅自 git push` 的项目规范
- 对话风格：简洁、专业、不卑不亢；避免不必要的"我可以帮您..."等套话
```

### 7.3 RAG 层的契约

RAG 不是"塞一段文档进 system prompt"——它是一套契约：

1. **检索**：hybrid（向量 + BM25），rerank（bge-reranker-v2-m3 自托管）
2. **拼装**：放在 user turn 顶端，用 `<documents>` 包裹，引用必须可溯源
3. **回答约束**：让模型先 quote 再回答（Anthropic 经典模式）

```xml
<!-- user turn 顶部 -->
<documents>
  <document index="1">
    <source>飞书云文档: 销售合同标准条款 v3.2</source>
    <last_updated>2026-06-15</last_updated>
    <document_content>
      {{CHUNK_1_CONTENT}}
    </document_content>
  </document>
  <document index="2">
    ...
  </document>
</documents>

<task>
基于以上检索结果回答用户问题。

规则：
1. 只使用文档内的事实，禁止臆测；信息不足时直接回答"我不确定"。
2. 每条结论后用 [^1] 形式标注引用 source。
3. 若多个文档冲突，优先以 last_updated 更晚的为准。
</task>

<question>{{USER_QUESTION}}</question>
```

---

## 8. 持续更新机制

RAG 不是一次性的，是一条**流水线**。决定 RAG 系统是否"活着"的，是更新机制而非 embedding 模型选型。

### 8.1 四档触发器

```
┌────────────┬──────────────────┬──────────────┬──────────────┐
│ Trigger    │ 适用源            │ 延迟          │ 复杂度        │
├────────────┼──────────────────┼──────────────┼──────────────┤
│ Webhook    │ 飞书/钉钉/Notion/ │ < 5s         │ 中            │
│            │ Linear/GitHub     │              │              │
│ CDC        │ Postgres/MySQL/  │ < 1s         │ 高 (Debezium)│
│            │ MongoDB           │              │              │
│ 定时爬取    │ Confluence/SP/    │ 5min~1h      │ 低            │
│            │ Drive (无 webhook)│              │              │
│ 手动 / API │ 用户上传、补录    │ 立即          │ 极低          │
└────────────┴──────────────────┴──────────────┴──────────────┘
```

### 8.2 推荐管线

```
Source → Webhook/CDC → Kafka topic (per-source)
            │
            ├─► Hash check (Redis: xxHash64(content + meta))
            │       └─ skip if unchanged
            ├─► Chunker (semantic, ~800 token, 100 overlap)
            ├─► Contextualizer (Claude Haiku + prompt cache 全文)
            ├─► Embedder (Voyage-3 / bge-m3 自托管)
            ├─► ACL enricher (拉 IdP，写入 metadata)
            └─► Vector DB upsert + tombstone 删旧 chunk
```

**关键算法点**：
- **Change Detection**：每个文档存 `content_hash + last_modified`，xxHash 跳过未变 chunk，Notion 实测节省 70% embedding 调用
- **Chunk-level Diff**：只 re-embed 变化的 chunk
- **Soft Delete + Tombstone TTL**：删除事件先标记，48h 后清理，避免上游误删
- **Backfill Job**：周末全量 reconcile，纠正 webhook 漏单

### 8.3 Anthropic Contextual Retrieval（事实标准）

2024-09 Anthropic 发表的工程文章后，contextual retrieval 已成事实标准。**做法**：每个 chunk embedding 前，prepend 一句"这段是关于什么的"上下文（由 Haiku 配合全文 prompt cache 生成）。官方数据：

- 单独使用：失败率 5.7% → 3.7% (-35%)
- 叠加 contextual BM25：5.7% → 2.9% (-49%)
- 再加 rerank：5.7% → 1.9% (-67%)

成本控制：全文走 prompt cache，几百 chunk 共享同一个 cache write；否则 contextualize 单步就能把账打爆。

---

## 9. 知识库选型

| 方案 | 优点 | 缺点 | 适合 |
|---|---|---|---|
| **Pinecone** | 早期最成熟、托管省心 | 贵、单 tenant 一个 index 难扩展 | 已 PoC 完想直接上线 |
| **Weaviate** | 自带 hybrid、模块化 | 运维相对重 | 自建多模态 |
| **Qdrant** | 开源、Rust 性能强 | 中文社区比 pg 小 | 自托管、对吞吐有要求 |
| **pgvector** | 已在 Postgres 内、RLS / SQL JOIN 顺手 | 大规模 HNSW 仍弱于专用 | **KY Agent 首选** |
| **Chroma** | 轻量、原型快 | 不适合生产规模 | PoC / 开发环境 |
| **Elasticsearch** | BM25 + 向量、企业熟悉 | 资源消耗大 | 已有 ES 集群想复用 |
| **turbopuffer** | object-storage-native、100M+ namespaces、便宜 | 较新、生态弱 | **大客户 Bridge 模式** |

### 9.1 embedding 模型选型 2025–2026

| 模型 | 维度 | 价格/1M tokens | MTEB | 备注 |
|---|---|---|---|---|
| voyage-3-large | 1024 | $0.18 | 65.1 | 综合最强 |
| voyage-3 | 1024 | $0.06 | 高于 OpenAI small 7.6pp | 最佳性价比 |
| voyage-3-lite | 512 | $0.02 | 体积小 6-8× | 100M+ chunks |
| OpenAI text-embedding-3-small | 1536 | $0.02 | 62.3 | 默认起点 |
| **bge-m3** | 1024 | 自托管 0 | 弱于 voyage | **中文 + 境内数据首选** |

**KY Agent 推荐**：境内业务用 **bge-m3 自托管 + bge-reranker-v2-m3 rerank**，数据零出境且性价比最高。

---

## 10. 企业实战案例对比

| 产品 | 索引策略 | 更新机制 | 隔离 | 亮点 | 局限 |
|---|---|---|---|---|---|
| **Glean** | Hybrid + Enterprise Graph | 100+ 连接器实时爬虫 | 单组织环境 | Fall'25 推 Agentic Engine 2、agent vibe-coding、100+ actions | 价格贵、部署重 |
| **Notion AI** | Vector (turbopuffer) + 隐含 graph | Spark on EMR 批 + Kafka 流，子分钟 | workspace 级 | 工程极致优化：搜索 -60%、embedding -90%+ | 限 Notion 生态 |
| **MS Copilot Studio** | Graph Connector（仅索引 metadata）+ Power Platform Connector（运行时） | Graph 推送 + API 轮询 | tenant=M365 | 与 M365 深度整合 | 强绑 Azure |
| **Cursor 企业版** | 本地 + 云双索引，文件路径加密 | 文件变更增量 | Privacy Mode 不留存 | SOC 2 Type II / SAML / SCIM | 仅代码场景 |
| **Sana AI** | LLM-agnostic + 100+ 连接器 | 实时 + Zero-Day Retention | 企业级 | 知识发现 + 工作流 | 偏 HR |

**对 KY Agent 的启发**：

- 学 Glean 的 ACL-aware 检索（图与权限同源）
- 学 Notion 的 **turbopuffer namespace + 自托管 embedding** 控成本
- 学 Copilot 的"高频实体走索引 + 敏感数据走运行时 Tool"二分
- **避免与 Microsoft / Glean 正面拼"连接器深度"**，转而做**Claude-native + 钉钉/飞书优先 + per-team 高度可定制 + MCP server 对外分发**

---

## 11. 关键反模式清单

写报告不列反模式是不诚实的。下面是已经被多次踩过的坑：

1. **把整个 wiki 塞 system prompt**：cache 失效后单次成本爆炸
2. **依赖 LLM 自觉按 tenant 过滤**：业界共识的 "security theater"，必须 DB 层强制
3. **全量 reindex**：1M docs × 重 embed 一次烧光预算
4. **embedding 后丢 metadata**：后续 ACL / KG 都要回炉
5. **公司知识写入用户记忆**：新用户瞬间继承"幻觉历史"
6. **只做 vector，不做 BM25**：订单号、错误码、SKU 精确匹配大面积漏召
7. **忽略 tombstone**：上游删了文档，Agent 还在引用 → 法务事故
8. **webhook 直连 embedding API**：高峰打爆下游、无重试、丢数据。**中间必须有 Kafka 或同等队列**
9. **Statement Pooling + RLS**：`app.tenant_id` 跨请求泄漏，最严重的 multi-tenant 漏洞
10. **不监控 `cache_read_input_tokens`**：prompt cache 静默失效（顺序变化、cache_control 错位），账单暴涨但无报错
11. **不开 `FORCE ROW LEVEL SECURITY`**：DB owner / 迁移脚本绕过 RLS
12. **把 contextualize 放运行时**：必须 ingestion 时离线跑；运行时跑 retrieval p95 翻倍以上
13. **System prompt 内 XML 与 Markdown 混用**：Gemini 等模型分段误判（Google 官方明确要求 *单 prompt 内只用一种格式*）
14. **CRON 任务用同样 system prompt**：CRON 任务应叠加 *"Do not ask for confirmation. If you cannot determine the answer, write failure reason to MEMORY.md and exit."*

---

## 12. 对 KY Agent 的具体落地建议

基于项目当前状态（Express + Claude Code Harness + per-user workspace + 钉钉/Web/RN 三端 + cron）以及前面所有章节的讨论，给出可执行的路线图。

### 12.1 立刻可做（1 周内）

**(1) 拆分 CLAUDE.md 为分层架构**

```
workspace-shared/
  COMPANY.md                  # ORG 层：开沿科技身份、价值观、红线
  AGENTS.md                   # 软链到 COMPANY.md，兼容 Codex CLI / Copilot
  teams/
    engineering.md            # TEAM 层：工程师角色
    sales.md
    legal.md
  agent-memory/               # Procedural memory，跨用户共享
    MEMORY.md                 # Agent 自学经验的索引
    references/               # 详细参考资料
  .claude/
    settings.json
    skills-pool/              # 已存在，保留

~/workspace/{username}/
  CLAUDE.md                   # USER 项目层（如果用户工作在多个项目）
  MEMORY.md                   # USER 语义记忆
  uploads/
```

**(2) 在 system prompt 中明确 MEMORY.md 使用约定**

```markdown
# How to use MEMORY.md

You have a user-specific MEMORY.md at the workspace root.

WHEN TO READ:
- Once at session start (first 200 lines auto-injected).
- When the user references "as we discussed" or asks about past work.

WHEN TO WRITE:
- ONLY when the user explicitly says "记住 / remember / 保存",
  OR when a fact is clearly stable across sessions (allergies, project
  paths, long-term preferences).
- Each entry MUST be one line, prefixed with ISO date:
    `2026-06-20  prefers TypeScript strict mode; primary project: agent-saas`

WHEN NOT TO WRITE:
- Temporary emotional state ("我今天心情不好")
- Session-specific facts ("我现在在调 cron 那个 bug")
- PII beyond name/role (no ID numbers, passwords, financial info)

HOUSEKEEPING:
- If MEMORY.md exceeds 150 lines, summarize older entries into
  "## Archive (<= 2026-Q1)" section.
```

**(3) 开启 prompt cache + 监控**

- 在 system prompt 末尾、tools 末尾设 `cache_control: {type: "ephemeral", ttl: "1h"}`
- 后端记录每次响应的 `cache_read_input_tokens / total_input_tokens`，低于 0.5 触发告警
- Cron 任务保持长 prefix 不变（不要嵌时间戳）

### 12.2 第 2-4 周（RAG MVP）

- 起 `kb_chunks` 表（schema 见第 6.2 节），pgvector + bge-m3 自托管
- 选 **飞书或钉钉** 一个连接器（已自带 webhook 基建）
- Webhook → Express `/api/ingest/{source}` → Kafka → 分块 → contextualize（Claude Haiku + prompt cache）→ embed → upsert
- 增加 `search_company_kb` skill（不是 tool！），hybrid 检索 + rerank
- 监控：召回 top-5 命中率、p95 延迟、token 节省

### 12.3 第 5-12 周（多组织 + Memory 升级）

- 加 `tenant_id` 列，开 RLS（**FORCE + Transaction Pooling + SET LOCAL**）
- 大客户切 Bridge 模式：独立 turbopuffer namespace
- USER 层叠加 LangGraph PostgresStore + LangMem background manager，namespace = `("memories", username)`，与 MEMORY.md 共存
- ACL enricher：从飞书 / 钉钉 / 企微拉组织架构，写入 chunk metadata
- 加 Confluence / 飞书云文档连接器；引入 Debezium CDC 做内部 MySQL 业务库同步

### 12.4 第 13 周+（差异化竞争）

- **Skills 跨平台标准化**：把 `skills-pool/` 改造为 `agentskills.io` 规范兼容，将来可零迁移到 OpenAI Codex CLI / Cursor
- **暴露 KY Agent 为 MCP server**：让客户的 Claude Desktop / Cursor 直接接入企业知识——这是 2026 年的分发杠杆
- **隐私模式**：仿 Cursor，client 端分块 + 加密上传，embedding 算完即弃明文，针对金融/法务客户
- **Personal Graph 雏形**：从用户对话提取活跃项目，做主动 nudge（早会摘要、ddl 提醒）

### 12.5 工具数量膨胀的应对策略

用户痛点是"skill 数量未来会膨胀"。基于本文调研，给出三段式应对：

**第一阶段（< 30 个 skill）**：继续走 Skill 模式 C（描述常驻 system prompt），每 skill ~100 tokens 元数据。无需特殊设计。

**第二阶段（30-200 个 skill）**：引入 **关键词 trigger + lazy load**——参考 OpenHands 的 `KeywordTrigger`，只有用户输入匹配关键词时才把 skill 描述拼进 system prompt。

**第三阶段（200+ skill 或 MCP 工具池爆炸）**：上 **Anthropic Tool Search Tool**（`tool_search_tool_bm25_20251119`，BM25 变体更适合中文）+ `defer_loading: true`。官方实测 token 节省 85%，accuracy 不降反升。

```jsonc
// server/agent/tools.ts 推荐配置
{
  "anthropic_beta": ["advanced-tool-use-2025-11-20"],
  "tools": [
    { "type": "tool_search_tool_bm25_20251119", "name": "tool_search" },
    // 高频底层工具不 defer
    { "name": "Read", ... },
    { "name": "Bash", ... },
    { "name": "Skill", ... },
    // 低频 MCP / 业务工具 defer
    { "name": "dingtalk_send_group", ..., "defer_loading": true },
    { "name": "feishu_create_doc", ..., "defer_loading": true },
    // ... 数百个工具
  ]
}
```

### 12.6 可观测性

最后但同样关键——上线后必须有的指标看板：

1. **Cache 健康度**：`cache_read_input_tokens / total_input_tokens`，目标 > 0.6
2. **Tool selection 精度**：每周跑一次 eval set（10-50 个典型场景），用 Claude 当 judge
3. **RAG 命中率**：top-5 召回是否覆盖标注答案
4. **Memory 健康度**：每用户 MEMORY.md 行数分布、抽取错误率（采样人工标注）
5. **Cost per request**：按 tenant / per-user / per-skill 拆账
6. **Latency p50 / p95 / p99**：长尾通常来自 skill 误触发 + 多轮工具调用

---

## 13. 总结

把"公司情况 + 个人记忆 + Agent 经验"嵌入到一个企业 Agent，不是"加一段 system prompt"那么简单，而是一套 **静态 + RAG（contextual + hybrid + rerank） + Graph + Tool/MCP + Agent procedural memory + User semantic memory** 的协同。

对 KY Agent 这种 Claude Code Harness 形态的产品，优势在于天然具备 skills、CLAUDE.md、per-user workspace 三件套；劣势是缺少多组织企业级的 corpus 层与 Procedural memory 层。

战术上：先 `COMPANY.md + 1h prompt cache + context editing` 拿掉 80% 价值（1 周），再 pgvector + 飞书/钉钉 webhook + Anthropic Contextual Retrieval 拿掉再 80%（3-4 周）。战略上：对齐 Glean 的 ACL-aware 思路、对齐 Notion 的成本工程（turbopuffer + 自托管 embedding）、对齐 Cursor 的隐私模式；**避开 Microsoft / Glean 在"连接器深度"上的正面竞争**，转而做"per-team 高度可定制的 Claude-native Agent + 以 MCP server 形态对外分发"——这才是 KY Agent 在 2026 年的差异化护城河。

最后引用 Andrej Karpathy 对这一代 agent 工程师的判断：

> *"Context engineering, not prompt engineering, is the core skill of building production AI agents."*

每一个 token 都应该有理由占据它在 200K 窗口里的位置。把这个原则贯彻到底，KY Agent 就站稳了。

---

## 参考资料

### Anthropic 官方
- [Effective Context Engineering for AI Agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
- [Building Effective Agents](https://www.anthropic.com/research/building-effective-agents)
- [Introducing Contextual Retrieval](https://www.anthropic.com/news/contextual-retrieval)
- [Advanced tool use on the Claude Developer Platform](https://www.anthropic.com/engineering/advanced-tool-use)
- [Equipping agents for the real world with Agent Skills](https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills)
- [Prompt caching docs](https://platform.claude.com/docs/en/docs/build-with-claude/prompt-caching)
- [Memory tool docs](https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool)
- [Tool Search Tool docs](https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool)
- [Claude Code Memory docs](https://code.claude.com/docs/en/memory)

### 学术
- [Lost in the Middle (Liu et al., 2023) — arXiv 2307.03172](https://arxiv.org/abs/2307.03172)
- [RAG-MCP (arXiv 2505.03275)](https://arxiv.org/abs/2505.03275)
- [LongMemEval Benchmark](https://github.com/xiaowu0162/LongMemEval)

### Memory 框架
- [mem0 — State of AI Agent Memory 2026](https://mem0.ai/blog/state-of-ai-agent-memory-2026)
- [Letta v1 Agent Loop blog](https://www.letta.com/blog/letta-v1-agent)
- [Letta Sleep-time Compute](https://www.letta.com/blog/sleep-time-compute)
- [Zep — Concepts](https://help.getzep.com/concepts)
- [Cognee GitHub](https://github.com/topoteretes/cognee)
- [LangChain Long-term Memory](https://docs.langchain.com/oss/python/langchain/long-term-memory)
- [LangMem docs](https://github.com/langchain-ai/langmem)

### 企业 RAG 工程
- [Two years of vector search at Notion](https://www.notion.com/blog/two-years-of-vector-search-at-notion)
- [Glean Enterprise Graph](https://www.glean.com/product/enterprise-graph)
- [Building Multi-Tenant RAG with PostgreSQL — Tiger Data](https://www.tigerdata.com/blog/building-multi-tenant-rag-applications-with-postgresql-choosing-the-right-approach)
- [Secure multitenant RAG — Azure Architecture Center](https://learn.microsoft.com/en-us/azure/architecture/ai-ml/guide/secure-multitenant-rag)
- [Cursor — Secure codebase indexing](https://cursor.com/blog/secure-codebase-indexing)
- [TurboPuffer architecture — Jason Liu](https://jxnl.co/writing/2025/09/11/turbopuffer-object-storage-first-vector-database-architecture/)
- [Voyage-3 launch](https://blog.voyageai.com/2024/09/18/voyage-3/)

### 开放标准
- [AGENTS.md standard](https://agentsmd.net/)
- [agentskills.io — Open Skills standard](https://agentskills.io)
- [Model Context Protocol spec](https://modelcontextprotocol.io)

### 社区高质量分析
- [Simon Willison — Claude 4 system prompt analysis](https://simonwillison.net/2025/May/25/claude-4-system-prompt/)
- [Simon Willison — OpenAI quietly adopting skills](https://simonwillison.net/2025/Dec/12/openai-skills/)
- [SwirlAI — Agent Skills: Progressive Disclosure as a System Design Pattern](https://www.newsletter.swirlai.com/p/agent-skills-progressive-disclosure)
- [Particula Tech — Agent Memory Frameworks Tested 2026](https://particula.tech/blog/agent-memory-frameworks-tested-mem0-zep-letta-cognee-2026)
