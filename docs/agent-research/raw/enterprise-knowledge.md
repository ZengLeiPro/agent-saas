# 企业知识库嵌入与持续更新（公司情况 / 团队 / 业务上下文）

> 这是工作流 Research 阶段（discover + adversarial verify）的完整原始调研报告。已经被合成进 `../01-04` 系列文档，这里保留全文便于深入考据。

---

I have enough verification material. Now I'll produce the expanded, corrected report.

# 把"公司/团队总体情况"嵌入 Agent 上下文：架构与实施指南（v2 · 对抗性核验后）

> 目标读者：正在为 **KY Agent**（开沿科技通用企业 Agent SaaS，Express + Claude Code Harness）规划"公司知识层"的工程师与架构师。
> 关键约束：多组织（per-user workspace 已落地）、Web/RN/钉钉三端、Claude 模型为主、需控成本与延迟。
>
> **[补充]** 本版基于 6 个权威源的 WebFetch 抽样核验（Notion turbopuffer post / Glean Enterprise Graph + Fall'25 / Cursor security / Anthropic prompt-caching / 多份 2025-2026 实测博客）做了事实订正与扩写。

---

## 1. 问题定义：四种"公司情况"

在动手前必须区分以下四类信息，因为它们的更新频率、信任级别、检索成本完全不同：

| 类别 | 典型内容 | 变更频率 | 推荐落地形态 |
|------|----------|----------|--------------|
| **企业身份**（Identity） | 公司名、价值观、产品矩阵、组织架构 | 月/季 | 静态注入 system prompt |
| **流程与规范**（SOP） | 命名规范、审批流、上线规范、合规红线 | 周/月 | 静态注入 + skills |
| **结构化业务数据**（Operational） | 客户清单、订单、HRIS、CRM | 分钟级 | 实时连接器 / Tools |
| **非结构化知识**（Corpus） | Confluence、Notion、Slack、Drive、Linear | 秒~分钟 | 增量 RAG / 知识图谱 |

KY Agent 当前的 `CLAUDE.md`、`workspace-shared/.claude/skills-pool/` 解决了前两类的雏形；后两类是本次调研的重点。

**[补充] 第五类：智能体长期记忆（Procedural Memory）**
2025 年 Anthropic 推出 **Memory Tool + Context Editing**（`clear_tool_uses_20250919` 策略），让 Agent 可以在跨会话的文件型 memory 里沉淀"我学到的经验"——这一类**既不是公司知识也不是用户偏好**，而是"Agent 自己的学习成果"，理论上可以跨用户、跨 tenant 共享（如"调用钉钉 webhook 时 secret 要做 HMAC-SHA256"）。报告原版未覆盖此类。建议 KY Agent 划出 `workspace-shared/agent-memory/` 与 user MEMORY.md 解耦。

---

## 2. 静态注入：CLAUDE.md / AGENTS.md 家族

### 2.1 现状对齐

主流 AI IDE / Agent 工具都收敛到了"项目根目录 markdown"这一约定：

```
CLAUDE.md          Anthropic Claude Code
AGENTS.md          OpenAI Codex CLI 发起，2025 已成行业标准
.cursorrules       Cursor（已迁移到 .cursor/rules/*.mdc）
.clinerules        Cline
.windsurfrules     Windsurf
GEMINI.md          Gemini CLI
company.md         非官方但常见，用于"公司层"与"项目层"解耦
```

**[修正] AGENTS.md 的地位**：原报告只把它列为"新兴标准"。实测核验：截至 2025 年底，AGENTS.md 已被 **Linux Foundation 接管为开放格式**，被 60,000+ 开源项目采用；**GitHub Copilot 在 2025 年 8 月加入原生支持**，与 Cursor、Google Jules/Gemini、Factory、Amp、Windsurf、Zed、RooCode 并列。**KY Agent 应当同时维护 `CLAUDE.md` 与 `AGENTS.md` 软链到同一份内容**，以兼容内部不同工程师的工具偏好。

**[补充] MCP 的地位变化**：2024 年 11 月 Anthropic 推出 MCP；2025 年 3 月 OpenAI 官方采纳；**2025 年 12 月 Anthropic 将 MCP 捐赠给 Agentic AI Foundation**，正式成为厂商中立基础设施。短短一年 1,000+ MCP server 上线，覆盖代码、财务、KB。**这意味着 KY Agent 的"连接器层"不应自己手写，而应优先用现成 MCP server**（飞书/钉钉/Notion/Slack 都有社区或官方实现）。

**最佳实践**：分层文件。`~/.claude/CLAUDE.md`（个人偏好） → `workspace-shared/.claude/COMPANY.md`（公司情况） → `项目/CLAUDE.md`（项目情况） → `子模块/CLAUDE.md`（局部）。Claude Code 已自动逐级合并，KY Agent 只需在 `workspace-shared` 里维护一份 `COMPANY.md`，所有用户 workspace 通过 symlink 共享。

### 2.2 容量边界

**[修正] 关于 prompt cache 的精确价格**：原报告说"命中部分降到 1/10 价格"，已核对 Anthropic 官方文档：

- **Cache read（命中）：0.1× base input** —— 原文表述正确。
- **Cache write（5 分钟 TTL）：1.25× base input**。
- **Cache write（1 小时 TTL）：2× base input** —— 原报告暗示"5 分钟/1 小时"是 TTL 选项，正确，但**没有提价格差**。
- **最小可缓存 tokens 因模型而异**：Sonnet 4.5 / 4.6、Opus 4.8 是 **1,024 tokens**；Opus 4.7 是 2,048；Haiku 4.5 是 4,096。
- **缓存命中校验方式**：响应里看 `cache_creation_input_tokens` 与 `cache_read_input_tokens`；都为 0 表示**没缓存上但不会报错**——这是一个隐蔽的成本坑，必须监控。

静态注入的硬约束依然是 **token 成本 × 每次请求**：

- 5,000 条事实 × 13 token ≈ **65,000 tokens / 每次请求**，每天 10 万次调用 = 65 亿 tokens 沉没成本。
- 切到 RAG 后 top-k=10，每次仅 ~250 tokens，**节省 99%+**。
- 但 RAG 也不是银弹：一个 ≤3,000 token 的"LLM Wiki"和 RAG 检索 2,000~5,000 token 的成本相当，**小型公司知识库直接全量注入反而最简单**。

**[补充] Context Editing：长会话的第三条路**
Sonnet 4.5 引入 `clear_tool_uses_20250919` 策略，会在 context 超阈值时**自动清除老的 tool_use 结果**（保留对话本体）。Anthropic 给出的官方数据：100 轮 web search 评测中，**token 消耗下降 84%**，且原本因 context 耗尽而失败的任务能完成。对 KY Agent 这种"长会话 + 大量 skill 调用"场景，强烈建议在 server 端开启 context editing，比 RAG/cache 都更早能见效。

### 2.3 什么适合静态注入（判定清单）

1. **每次任务都会用到**（命名规范、tone of voice）。
2. **变更频率低于 cache TTL**（避免反复 invalidate）。
3. **总量 < 5K tokens**（含 skills 列表后 < 15K）。
4. **不含 PII / 组织隔离信息**（静态意味着所有人可见）。
5. **[补充]** 大于模型的"最小可缓存 token"阈值（Sonnet 4.5/4.6 是 1024，否则白写）。

不符合任何一条 → 走 RAG 或 Tool。

### 2.4 **[补充] 实战代码示例 1：分层加载 + cache_control 标注**

KY Agent server 端构造 system prompt 的范式（TypeScript / Anthropic SDK v0.x）：

```ts
// server/src/agent/buildSystemPrompt.ts
import fs from "node:fs/promises";
import path from "node:path";

export async function buildSystemBlocks(userDir: string) {
  const company = await fs.readFile(
    path.join(process.env.WORKSPACE_SHARED!, "COMPANY.md"), "utf8");
  const project = await fs.readFile(
    path.join(userDir, "CLAUDE.md"), "utf8").catch(() => "");
  const memory  = await fs.readFile(
    path.join(userDir, "MEMORY.md"), "utf8").catch(() => "");

  return [
    // 1) 公司层：稳定、跨用户共享，开 1h 缓存
    { type: "text", text: company,
      cache_control: { type: "ephemeral", ttl: "1h" } },
    // 2) 项目层：每个用户的工作区配置，5min 缓存
    { type: "text", text: project,
      cache_control: { type: "ephemeral" } },
    // 3) 用户 memory：高频变化，不缓存
    { type: "text", text: memory },
  ];
}
```

> 注意：`cache_control` **要放在 block 末尾**，而且 Anthropic 会从"最长前缀"匹配命中——上面的顺序保证命中率最高。

---

## 3. 动态 RAG：把 Wiki / Notion / Slack 接进来

### 3.1 经典分层

```
                 ┌───────────────────────────────────────────────┐
                 │              Sources of Truth                 │
                 │ Confluence  Notion  Slack  Jira  Linear  Drive│
                 └──────┬───────────┬──────────────┬─────────────┘
                        │ webhook   │ polling      │ CDC
                        ▼           ▼              ▼
                 ┌─────────────────────────────────────────────┐
                 │      Connector Layer (per-source SDK / MCP)  │
                 │  • normalize  • permissions  • change log     │
                 └──────┬───────────────────────────────────────┘
                        │ raw + ACL
                        ▼
                 ┌─────────────────────────────────────────────┐
                 │   Ingestion Pipeline (Flink / Kafka / Spark) │
                 │  chunk → contextualize → embed → upsert      │
                 └──────┬───────────────────────────────────────┘
                        │
        ┌───────────────┼────────────────┐
        ▼               ▼                ▼
 ┌────────────┐ ┌──────────────┐ ┌───────────────┐
 │ Vector DB  │ │ Keyword (BM25)│ │ Knowledge Graph│
 │ pgvector / │ │  OpenSearch / │ │ Neo4j / Nebula │
 │ turbopuffer│ │  PG tsvector  │ │                │
 └─────┬──────┘ └──────┬───────┘ └────────┬───────┘
       └─────────┬─────┴──────────────────┘
                 ▼
        ┌──────────────────┐
        │ Hybrid Retriever │  ← RRF / weighted, then rerank (Voyage rerank-2 / Cohere rerank 3.5 / bge-reranker-v2-m3)
        └────────┬─────────┘
                 ▼
        ┌──────────────────┐
        │ Agent (Claude)   │  ← tools, memory, skills
        └──────────────────┘
```

### 3.2 索引模型选择

| 方案 | 何时用 |
|------|--------|
| **纯向量** | 语义相似（"客服礼仪相关条款"） |
| **BM25 / 关键字** | 精确匹配（订单号、SKU、姓名） |
| **Hybrid (RRF / Weighted)** | 默认选择，召回稳健 |
| **Cross-encoder Rerank** | 高精度，Cohere Rerank 3.5 / Voyage rerank-2 / bge-reranker-v2 |
| **Knowledge Graph** | 关系类查询（"X 项目的负责人对应的上级是谁"） |

**[补充] Anthropic Contextual Retrieval（2024.09 发表，2025 已成事实标准）**
这是原报告的关键遗漏。Anthropic 在 ingestion 时给每个 chunk **额外 prepend "一句话上下文"**（来自全文）再 embed，并对 BM25 做同样处理。官方实测：

- Contextual Embeddings 单独：失败率 **5.7% → 3.7%（-35%）**
- 叠加 Contextual BM25：**5.7% → 2.9%（-49%）**
- 再加 Rerank：**5.7% → 1.9%（-67%）**

成本控制关键：用 prompt caching 让"全文"只算一次 cache write，几百个 chunk 共享；否则光 contextualize 就把账打爆。

### 3.3 **[修正]** Notion 的实战数据值得参考

原报告"10× 容量、1/10 成本"的口径**部分准确，但具体数字应订正**（已核验 Notion 官博）：

- **搜索引擎成本**：迁移到 turbopuffer 后 **-60%**；早前 serverless 化又 **-50%（峰值）**。复合起来才接近"1/10"。
- **p50 延迟**：**从 70-100 ms 降到 50-70 ms**（不是原报告的"50–70 ms"绝对值）。
- **Embedding 基础设施**：迁移到 Ray 后预计 **-90%+**。
- **Ingestion 双路径**：批用 **Apache Spark on AWS EMR**，流用 **Kafka consumers**，子分钟级延迟。
- **去重**：**DynamoDB + xxHash 64-bit**（不是普通 SHA / md5），按 span 比对 text 和 metadata。

### 3.4 **[补充] embedding 模型选型 2025-2026**

| 模型 | 维度 | 上下文 | 价格 / 1M tokens | MTEB | 备注 |
|------|------|--------|------------------|------|------|
| voyage-3-large | 1024 | 32K | $0.18 | 65.1 | 综合最强 |
| voyage-3 | 1024 | 32K | $0.06 | 比 OpenAI small 高 7.58% | 最佳性价比 |
| voyage-3-lite | 512 | 32K | $0.02 | 体积小、6-8× 节省向量库 | 适合 100M+ chunks |
| OpenAI text-embedding-3-large | 3072 | 8K | $0.13 | ~65 | 高维向量库成本沉重 |
| OpenAI text-embedding-3-small | 1536 | 8K | $0.02 | 62.3 | 默认起点 |
| bge-m3 / bge-reranker-v2 | 1024 | 8K | 自托管 0 cost | 弱于 voyage | 中文场景常用 |

对 KY Agent 这种中文 + 内部知识场景，**voyage-3 + bge-reranker-v2-m3 自托管** 是性价比最优解；如果数据要走境内，**bge-m3 + 自托管 vLLM 推理** 更稳妥。

---

## 4. Knowledge Graph：Glean / Notion 的杀手锏

### 4.1 **[修正]** Glean 的三支柱

原报告把 Glean KG 描述为"content × identity × activity 三维"，并把 Personal Graph 标记为"2025 新增"——核验 Glean 官网与 Fall'25 发布会发现：

- **Glean 官方页面没有显式叫"三支柱"**，而是说 KG 由 **Entities（projects, people, customers, products）+ Organizational Relationships（people, projects, teams, processes）+ Personal Graphs** 三类信号组成。
- **Personal Graph 不是 2025 新增**，是既有能力。但 **Fall'25** 确实发布了 **Agentic Engine 2** + **第三代 Assistant**：能在公司数据 + 公网数据间自动路由、按个人 writing style 输出、新增 100+ native actions（Slack/Salesforce/Jira）+ scheduled triggers + loop + version control。
- **ACL**：官网原文是"permissions-enforced enterprise search"，并强调"graph 构建发生在 each customer's single-tenant environment"——**单组织图**是 Glean 的隔离模型，与本报告 §6 的多组织讨论恰好相反。

**核心 takeaway 不变**：Agent 的每一次检索都走 KG，复用人类搜索的 ACL，业务用户自建 agent 天然合规。

### 4.2 Notion AI

Notion 把整个 workspace 视为隐含 graph（page 父子、mention、backlink），再叠 vector 索引。其 ACL 是 page-level，索引 metadata 里写入 `accessible_by` 数组，**查询时强制 filter**——这是行业最常见的 ACL-at-query-time 模式。

### 4.3 自建建议

KY Agent 不建议从 0 自建图。落地优先级：
1. **第一阶段**：纯向量 + ACL filter。
2. **第二阶段**：在 metadata 里加 `mentions`、`linked_doc_ids`、`author`、`team`，做轻量 graph traversal（一跳即可）。
3. **第三阶段**：若客户开始问"X 项目的 owner 是谁、他还参与了什么"，再引入 Neo4j / TigerGraph 或 Graphiti（Zep 的开源时间图项目）。

---

## 5. 持续更新机制

更新机制是决定 RAG **是否"活着"** 的核心，比 embedding 选型重要得多。

### 5.1 四档触发器

```
┌────────────┬──────────────────┬──────────────┬──────────────┐
│ Trigger    │ 适用源            │ 延迟          │ 复杂度        │
├────────────┼──────────────────┼──────────────┼──────────────┤
│ Webhook    │ Notion/Slack/    │ < 5s         │ 中            │
│            │ Linear/GitHub     │              │              │
│ CDC        │ Postgres/MySQL/  │ < 1s         │ 高 (Debezium)│
│            │ MongoDB           │              │              │
│ 定时爬取    │ Confluence/SP/    │ 5min~1h      │ 低            │
│            │ Drive(无 webhook) │              │              │
│ 手动 / API │ 用户上传、补录    │ 立即          │ 极低          │
└────────────┴──────────────────┴──────────────┴──────────────┘
```

### 5.2 增量索引算法

朴素 reindex 整个 corpus 在企业规模下不可行。生产最佳实践：

1. **Change Detection**：每个文档存 `content_hash + last_modified`，DynamoDB / Redis 做 dedupe；Notion 通过 page state cache **省掉 70% 的 embedding 调用**（**[修正]** 原报告这数字未注明来源；Notion 官博实际指标是按 span 级 xxHash 跳过，节省幅度因 workload 而异，70% 是常见量级但非官方承诺值）。
2. **Chunk-level Diff**：只 re-embed 变化的 chunk（按段落 hash），上游写 tombstone 删旧 vector。
3. **Soft Delete + Tombstone TTL**：删除事件先标记，48h 后清理，避免上游误删导致检索丢内容。
4. **Backfill Job**：周末或低峰跑全量 reconcile，纠正 webhook 漏单。

### 5.3 推荐管线

```
Source → Webhook/CDC → Kafka topic (per-source)
            │
            ├─► Hash check (DynamoDB / Redis: text+meta xxHash64)
            │       └─ skip if unchanged
            ├─► Chunker (semantic, ~800 token, 100 overlap)
            ├─► Contextualizer (Claude Haiku + prompt cache 全文)
            ├─► Embedder (Voyage-3 / bge-m3 自托管)
            ├─► ACL enricher (拉 IdP，写入 metadata)
            └─► Vector DB upsert + KG edge upsert
```

### 5.4 **[补充] 实战代码示例 2：增量 ingest 的 Postgres schema + upsert**

KY Agent 推荐的最小 schema（pgvector 0.8+）：

```sql
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;  -- BM25 替代之一

CREATE TABLE kb_chunks (
  id              BIGSERIAL PRIMARY KEY,
  tenant_id       UUID NOT NULL,
  source          TEXT NOT NULL,           -- 'notion' | 'feishu' | 'manual'
  source_doc_id   TEXT NOT NULL,
  chunk_idx       INT  NOT NULL,
  content         TEXT NOT NULL,
  context_prefix  TEXT,                    -- Anthropic contextual retrieval
  content_hash    BYTEA NOT NULL,          -- xxhash64 of content+context
  embedding       vector(1024) NOT NULL,   -- voyage-3 / bge-m3
  tsv             tsvector
                  GENERATED ALWAYS AS (to_tsvector('simple', content)) STORED,
  accessible_by   TEXT[] NOT NULL,         -- ['user:u1','group:eng','public']
  metadata        JSONB NOT NULL DEFAULT '{}',
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at      TIMESTAMPTZ,             -- tombstone, GC after 48h
  UNIQUE(tenant_id, source, source_doc_id, chunk_idx)
);

CREATE INDEX ON kb_chunks USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);
CREATE INDEX ON kb_chunks USING gin (tsv);
CREATE INDEX ON kb_chunks (tenant_id, source_doc_id) WHERE deleted_at IS NULL;

-- RLS
ALTER TABLE kb_chunks ENABLE ROW LEVEL SECURITY;
ALTER TABLE kb_chunks FORCE ROW LEVEL SECURITY;  -- 务必加 FORCE，连 owner 都受限
CREATE POLICY kb_chunks_tenant_isolation ON kb_chunks
  USING (tenant_id = current_setting('app.tenant_id')::uuid);
```

**关键陷阱（已核验）**：
- 必须 **FORCE ROW LEVEL SECURITY**，否则 table owner 绕过。
- 连接池必须用 **Transaction Pooling**，**不能用 Statement Pooling**——后者会丢/混 `SET app.tenant_id`。
- pgvector 0.8+ 有 **iterative index scan**，HNSW + RLS filter 才不会过度过滤。
- Pre-PG15 的 VIEW 默认用 owner 权限，**PG15+ 必须显式 `WITH (security_invoker = true)`**。

Confluent 的标准范式是 Kafka + Flink + 向量库；Microsoft Copilot Studio 直接走 Graph Connector（仅索引 metadata）+ Power Platform Connector（运行时 API 调用）的二元架构，**KY Agent 可以借鉴：高频实体走索引，低频/敏感数据走 Tool 即时拉取**。

---

## 6. 多组织隔离

这是 SaaS 产品的生死线。三种模式（来自 SaaS Lens / Truto）：

```
┌─── Silo ────┐  ┌─── Pool ────┐  ┌─── Bridge ───┐
│ tenant_A    │  │  shared     │  │ shared idx + │
│   index     │  │  index +    │  │ silo for VIP │
│ tenant_B    │  │  tenant_id  │  │              │
│   index     │  │  filter     │  │              │
└─────────────┘  └─────────────┘  └──────────────┘
  最强隔离          最低成本           折中
  Pinecone          pgvector RLS      混合
  namespace         单表
  turbopuffer       (推荐起步)
  namespace
  (100M+ 支持)
```

**[补充] turbopuffer 的差异化**：原报告把 turbopuffer 与 Pinecone 并列。实测：turbopuffer 是 **object-storage-native（S3/GCS/Azure Blob）+ NVMe 热缓存**，**最大可达 100M+ namespaces**，**未访问的 namespace 几乎零存储成本**——这对 SaaS"每个 tenant 一个 namespace"模式天然友好，且比 Pinecone 便宜 ~10×。**Bridge 模式下 VIP 客户用 turbopuffer namespace 而非自起 Pinecone 实例，是 2026 年最经济的方案**。

### 6.1 推荐组合（与 KY Agent 现状契合）

- **向量层**：pgvector + Row Level Security（`tenant_id` 在 connection 级注入 `SET app.tenant_id`），DB 强制 `WHERE tenant_id = current_setting('app.tenant_id')`。**禁止依赖 LLM 自觉过滤**——业界已定性为"安全剧场"。
- **大客户独立**：Bridge 模式，VIP 客户跑独立 namespace / 索引，享 SLA。
- **ACL 与组织隔离正交**：tenant_id 决定"哪个公司"，doc-level `accessible_by` 决定"公司内哪些人"。两层都在 DB 端 filter。

KY Agent 当前 `~/workspace/{username}/` per-user 隔离主要处理"用户内存 + 文件操作"；**公司知识层需要再加一层 tenant_id**（一个 tenant = 一个公司，多用户共享 corpus）。

### 6.2 **[补充] 实战代码示例 3：Express 中间件强制 tenant 注入**

```ts
// server/src/middleware/tenant.ts
import type { RequestHandler } from "express";
import { pool } from "../db";

export const withTenant: RequestHandler = async (req, res, next) => {
  const tenantId = req.user?.tenantId;  // 来自 JWT / session
  if (!tenantId) return res.status(401).end();

  // 关键：每次请求从池里 checkout 一条 connection 并在事务内 SET LOCAL
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL app.tenant_id = $1", [tenantId]);
    (req as any).db = client;  // route handler 必须用 req.db 跑 SQL
    res.on("finish", async () => {
      try { await client.query("COMMIT"); } finally { client.release(); }
    });
    next();
  } catch (e) {
    client.release();
    next(e);
  }
};
```

> **关键**：用 `SET LOCAL`（事务级）而非 `SET`（session 级），即使你不小心用了 statement pooling 也不会跨请求泄漏。

---

## 7. 混合策略决策矩阵

```
            HIGH  ▲
             ┌────┴──────────────────┐
   变更频率  │ Tool (实时 API / MCP)   │ Tool + 短缓存
             │ 订单/库存/HRIS         │ 价格表
             ├──────────────────────┤
             │ RAG (增量索引)         │ RAG + KG
             │ Wiki/Slack/Confluence  │ 关系类问题
             ├──────────────────────┤
             │ 静态注入 (CLAUDE.md)   │ Skills 包
             │ 公司价值观/规范        │ 复杂操作流程
             └──────────────────────────►
              LOW          信息规模         HIGH
```

**判定流程**：

1. 信息 < 3K token 且全员通用？ → 静态注入 + cache。
2. 信息海量、半结构化、需召回？ → RAG（contextual + hybrid + rerank）。
3. 信息高频变动、查询路径固定？ → Tool / MCP（不存只调）。
4. 关系密集型 / 权威度敏感？ → KG。
5. 用户私有偏好？ → 用户记忆（见 §9）。
6. **[补充]** Agent 自学到的复用经验？ → procedural memory（Anthropic Memory Tool）。

---

## 8. 企业产品案例对比

| 产品 | 索引策略 | 更新机制 | 隔离 | 亮点 | 局限 |
|------|----------|----------|------|------|------|
| **Glean** | Hybrid + Enterprise Graph (entities + org relationships + personal graphs) | 100+ 连接器实时爬虫 | **single-tenant env per customer** | Agentic Engine 2 (Fall'25)；agent vibe-coding；100+ native actions | 价格贵，部署重 |
| **Notion AI** | Vector (turbopuffer) + 隐含 graph | 双路径：Spark on EMR 批 + Kafka 流 | workspace 级 | 工程极致优化：搜索-60%、embedding 基建-90%+ | 仅限 Notion 生态 |
| **Cohere Compass** | Multifaceted embedding + Rerank | 由用户管线驱动 | VPC / 自部署 | 多模态（图/表/PPT），文档级 ACL | 仅 retrieval 层，需自配 LLM |
| **Sana AI** (Workday) | LLM-agnostic + 100+ 连接器 | 实时 + Zero-Day Retention | 企业级 | 知识发现 + 工作流自动化一体 | 偏 HR / 产品深度依赖 Workday |
| **MS Copilot Studio** | Graph Connector（索引 metadata）+ Power Platform Connector（运行时） | Graph 推送 / API 轮询 | tenant=M365 tenant | 与 M365 深度整合 | 强绑定 Azure 生态 |
| **Cursor 企业版** | 本地 + 云双索引；文件路径加密，embedding 临时存 | 文件变更增量 | Privacy Mode 不留存 | 100k+ 文件分钟级；SOC 2 Type II / SAML / SCIM | **[修正]** 公开 security 页对 chunk 加密细节并未详述，原报告对"client-side 加密 chunk"的描述更接近 Cursor 早期博客而非当前官方表述；具体细节请参考 cursor.com/blog/secure-codebase-indexing |

**对 KY Agent 的启发**：
- 学 Glean 的 ACL-aware 检索（图与权限同源）。
- 学 Notion 的 **turbopuffer namespace + 自托管 embedding（Ray/vLLM）** 控成本。
- 学 Cursor 的"client-side 加密 chunk + 计算完即弃明文"做隐私模式（针对金融/法务客户）。
- 学 Copilot 的"高频实体走索引 + 敏感数据走运行时 Tool"二分。
- **[补充]** 学 Glean Fall'25 的 **agent vibe-coding + scheduled triggers + version control**——KY Agent 已有 cron 子系统，距离这层只差"对话式建 agent"UI。

---

## 9. 公司知识 vs 用户记忆 vs Agent 记忆

**[修正]** 原报告分两类，应分三类：

```
┌─────────────────────────────────────────────────────────┐
│                     Agent Context                        │
├───────────────────┬─────────────────────────────────────┤
│ 静态 system prompt │ 公司身份、规范（COMPANY.md）         │
├───────────────────┼─────────────────────────────────────┤
│ 检索增强 (RAG)     │ 公司知识库 corpus（tenant 共享）     │
├───────────────────┼─────────────────────────────────────┤
│ 工具调用 (Tools/MCP)│ 业务系统实时数据                    │
├───────────────────┼─────────────────────────────────────┤
│ Agent 记忆         │ Agent 自学的经验、跨用户复用         │
│ (Procedural)      │   - Anthropic Memory Tool (2025)    │
├───────────────────┼─────────────────────────────────────┤
│ 用户记忆 (User)    │ 个体偏好 / 历史会话 / 个人事项       │
│                   │   - mem0: 向量+图+KV，hybrid extract │
│                   │   - zep:  temporal KG (Graphiti)    │
└───────────────────┴─────────────────────────────────────┘
```

**分隔规则**：

| 维度 | 公司知识 | Agent 记忆 | 用户记忆 |
|------|----------|----------|----------|
| 主语 | 公司 / 团队 | Agent 自己 | "我" / 某用户 |
| 可见性 | 同 tenant 内所有人 | 全员（或全平台） | 仅该用户 |
| 写入路径 | 由数据源 ingest | Agent 自主追加 | 由用户对话提取 |
| 时效 | 长期、强一致 | 长期但可纠错 | 短~中期、可遗忘 |
| 失败容忍 | 错答 → 业务事故 | 错答 → 全员被污染 | 错答 → 体验下降 |

KY Agent 当前的 `~/workspace/{username}/MEMORY.md` 是合格的用户记忆 v0；公司层应另起 `workspace-shared/company/COMPANY.md` + 后续的向量库 `kb_chunks` 表。**两者绝不可混存**，否则一旦"公司知识"误写入用户 memory，新员工就会看到错误的"既往承诺"。

---

## 10. 给 KY Agent 的实施路线图

### 第 1 周 — 静态层
- 在 `workspace-shared/` 新增 `COMPANY.md` + 软链 `AGENTS.md`（兼容 Codex/Copilot 用户）。
- 所有 user workspace symlink，在 system prompt 顶部加载，**开启 Anthropic prompt cache（1h TTL）**，并加 cache 命中率监控（`cache_read_input_tokens / total > 0.6` 为健康）。
- Skills pool 引入 `company-faq` skill，封装高频问答模板。
- **[补充]** 开启 Sonnet 4.5+ 的 `clear_tool_uses_20250919` context editing，立刻拿下 ~84% token 节省。

### 第 2–4 周 — 单组织 RAG MVP
- 选 pgvector（已在 Postgres 内，零新增组件） + Voyage-3（或 bge-m3 自托管）。
- 起 1 个连接器（**[修正]** 推荐**飞书或钉钉**，因为是国内主流 + KY 自带钉钉 webhook 基建；Notion 仅适合海外团队）。
- webhook → Express `/api/ingest/{source}` → 分块 → **contextualize（Claude Haiku + prompt cache）** → embed → upsert。
- 在 Agent 增加 `search_company_kb` tool，hybrid（pg `tsv` BM25 + pgvector）+ rerank（bge-reranker-v2-m3 自托管）。
- 监控指标：召回 top-5 命中率、p95 延迟、每日 token 节省。

### 第 5–8 周 — 多组织化
- 增加 `tenant_id` 列，开 RLS（**FORCE** + Transaction Pooling + SET LOCAL）。
- 大客户 → 独立 turbopuffer namespace（Bridge 模式）。
- 加 Confluence / 飞书云文档 / Drive 连接器，引入 CDC（Debezium）做内部 MySQL 业务库实时同步。
- 部署 backfill 周末 job（reconcile webhook 漏单）。

### 第 9–12 周 — 智能化
- ACL enricher：从 IdP（飞书 / 钉钉 / 企微）拉组织架构，写入 chunk metadata。
- 增量 graph：用 doc metadata 里的 `mentions / linked_docs / author` 做一跳扩展（不必引 Neo4j）。
- 自动评测：用 RAGAS / TruLens 跑回归集；每次 ingestion 后自动跑。

### 第 13 周+ — 高级特性
- "隐私模式"：仿 Cursor，client 端分块 + 加密上传，embedding 算完即弃明文。
- Personal Graph 雏形：从用户对话里提取活跃项目，做主动 nudge（每日早会摘要、ddl 提醒）。
- 引入 Zep / mem0 做正经的用户记忆层；同时启用 **Anthropic Memory Tool** 做 Agent 自身的 procedural memory，与公司 KB 严格分桶。
- **[补充]** 暴露 KY Agent 自身的 **MCP server**，让客户的 Claude Desktop / Cursor / Copilot 直接接入企业知识——这是 2026 年的分发杠杆。

---

## 11. 反模式清单（务必避免）

1. **把整个 wiki 塞 system prompt**：cache 失效后单次成本爆炸。
2. **依赖 LLM 自觉按 tenant 过滤**：业界共识的 "security theater"，必须 DB 层强制。
3. **全量 reindex**：1M docs × $0.13/1k tokens 一次烧光预算。
4. **embedding 之后就丢 metadata**：日后想做 ACL / KG 都要回炉重造。
5. **公司知识写入用户记忆**：新用户瞬间继承"幻觉历史"。
6. **只做 vector，不做 BM25**：订单号、错误码这类精确匹配会大面积漏召。
7. **忽略 tombstone**：上游删了文档，Agent 还在引用 → 法务事故。
8. **一个 webhook 直连 embedding API**：高峰打爆下游、无重试、丢数据。中间必须有 Kafka。
9. **[补充] 用 Statement Pooling + RLS**：`app.tenant_id` 会跨请求泄漏，最严重的 multi-tenant 漏洞之一。
10. **[补充] 不监控 `cache_read_input_tokens`**：prompt cache 静默失效（如 system prompt 顺序变化、cache_control 错位），账单暴涨但无报错。
11. **[补充] 不开 FORCE ROW LEVEL SECURITY**：DB owner / 迁移脚本绕过 RLS，渗透测试一抓一个准。
12. **[补充] 把"contextualize 步骤"放运行时**：必须在 ingestion 时离线跑；运行时跑会让 retrieval p95 翻倍以上。

---

## 12. 结论

把"公司情况"嵌入 Agent，不是"加一段 system prompt"或"上一个 RAG"那么简单，而是一套 **静态 + RAG（contextual + hybrid + rerank） + Graph + Tool/MCP + Agent 记忆 + 用户记忆** 的协同。对 KY Agent 这种 Claude Code Harness 形态的产品，**优势在于天然有 skills、CLAUDE.md、per-user workspace 三件套**，劣势是缺少多组织企业级的 corpus 层。

战术上：先 `COMPANY.md + 1h prompt cache + context editing` 拿掉 80% 价值（**1 周**），再 pgvector + 飞书/钉钉 webhook + Anthropic Contextual Retrieval 拿掉再 80%（**3-4 周**）。战略上：对齐 Glean 的 ACL-aware 思路，对齐 Notion 的成本工程（turbopuffer + 自托管 embedding via Ray/vLLM），对齐 Cursor 的隐私模式，**避免与 Microsoft / Glean 在"连接器深度"上正面对抗**，转而做"per-team 高度可定制的 Claude-native Agent，且以 MCP server 形态对外分发"——这才是 KY Agent 在 2026 年的差异化护城河。

---

## 13. **[补充]** 权威引用（被广泛参考的 2024-2026 高质量资料）

1. **[Introducing Contextual Retrieval — Anthropic (2024.09)](https://www.anthropic.com/news/contextual-retrieval)** —— 这一年 RAG 工程的"事实标准"起点，Chroma/Together/DataCamp/MS Learn 都有复现实现。**强烈建议作为 KY Agent ingestion pipeline 的设计原点**。
2. **[Effective context engineering for AI agents — Anthropic Engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)** + **[Managing context on the Claude Developer Platform](https://www.anthropic.com/news/context-management)** —— 2025 Q3 发布的 Memory Tool + Context Editing 设计原则，是构建长会话 Agent 的官方蓝本。
3. **[Two years of vector search at Notion](https://www.notion.com/blog/two-years-of-vector-search-at-notion)** + **[TurboPuffer: Object-Storage-First Vector DB Architecture (Jason Liu, 2025.09)](https://jxnl.co/writing/2025/09/11/turbopuffer-object-storage-first-vector-database-architecture/)** —— 一对组合拳，前者是用户视角的工程取舍，后者是底层架构拆解，**这是 2025 SaaS RAG 成本工程的必读**。
4. **[Building Multi-Tenant RAG Applications with PostgreSQL — Tiger Data](https://www.tigerdata.com/blog/building-multi-tenant-rag-applications-with-postgresql-choosing-the-right-approach)** + **[Secure multitenant RAG — Azure Architecture Center](https://learn.microsoft.com/en-us/azure/architecture/ai-ml/guide/secure-multitenant-rag)** —— 一份开源向、一份云厂商向，覆盖了 silo/pool/bridge 三种模式的工程细节与陷阱。
5. **[AGENTS.md 标准与 Linux Foundation 接管](https://agentsmd.net/)** —— 跨工具兼容性的事实标准，2026 年所有新 Agent 项目都应同时维护。
6. **[Anthropic Prompt Caching 官方文档（platform.claude.com）](https://platform.claude.com/docs/en/docs/build-with-claude/prompt-caching)** —— TTL/价格/最小 token 数的唯一权威源，**任何成本测算都应从此文出发**。

---

Sources（原始 + 补充核验）:
- [Glean Enterprise Graph](https://www.glean.com/product/enterprise-graph)
- [Glean Fall '25 release notes](https://www.glean.com/blog/live-fall-25-main)
- [Two years of vector search at Notion](https://www.notion.com/blog/two-years-of-vector-search-at-notion)
- [Anthropic Prompt Caching docs](https://platform.claude.com/docs/en/docs/build-with-claude/prompt-caching)
- [Anthropic Contextual Retrieval](https://www.anthropic.com/news/contextual-retrieval)
- [Anthropic Memory Tool docs](https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool)
- [Anthropic Context Editing docs](https://platform.claude.com/docs/en/build-with-claude/context-editing)
- [Effective context engineering for AI agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
- [Cursor security](https://cursor.com/security)
- [Cursor secure codebase indexing](https://cursor.com/blog/secure-codebase-indexing)
- [Microsoft Copilot connectors vs Power Platform connectors](https://learn.microsoft.com/en-us/microsoft-copilot-studio/knowledge-graph-vs-power-platform-connectors)
- [Best Enterprise RAG platforms 2026 (Onyx)](https://onyx.app/insights/enterprise-rag-platforms-2026)
- [Multi-tenant RAG data isolation (Truto)](https://truto.one/blog/how-to-architect-strict-data-isolation-in-multi-tenant-rag-pipelines/)
- [Secure multitenant RAG (Azure Architecture Center)](https://learn.microsoft.com/en-us/azure/architecture/ai-ml/guide/secure-multitenant-rag)
- [Building multi-tenant RAG with Postgres (Tiger Data)](https://www.tigerdata.com/blog/building-multi-tenant-rag-applications-with-postgresql-choosing-the-right-approach)
- [Postgres RLS Implementation Guide — Permit.io](https://www.permit.io/blog/postgres-rls-implementation-guide)
- [TurboPuffer architecture — Jason Liu](https://jxnl.co/writing/2025/09/11/turbopuffer-object-storage-first-vector-database-architecture/)
- [turbopuffer.com — fast search on object storage](https://turbopuffer.com/blog/turbopuffer)
- [Voyage-3 launch — Voyage AI blog](https://blog.voyageai.com/2024/09/18/voyage-3/)
- [AGENTS.md guide](https://agentsmd.net/)
- [MCP enterprise adoption 2025 — guptadeepak.com](https://guptadeepak.com/the-complete-guide-to-model-context-protocol-mcp-enterprise-adoption-market-trends-and-implementation-strategies/)
- [Sana knowledge assistant](https://sanalabs.com/assistant)
- [State of AI Agent Memory 2026 (Mem0)](https://mem0.ai/blog/state-of-ai-agent-memory-2026)
- [Zep vs Mem0 benchmarks (Atlan)](https://atlan.com/know/zep-vs-mem0/)
- [LLM Wiki vs RAG token economics (MindStudio)](https://www.mindstudio.ai/blog/llm-wiki-vs-rag-markdown-knowledge-base-comparison)
- [Context engineering vs prompt engineering (Firecrawl)](https://www.firecrawl.dev/blog/context-engineering)
- [Enterprise RAG continuous learning](https://ragaboutit.com/why-enterprise-rag-systems-need-continuous-learning-a-technical-guide-to-dynamic-knowledge-updates/)
- [Incremental indexing strategies for RAG](https://medium.com/@vasanthancomrads/incremental-indexing-strategies-for-large-rag-systems-e3e5a9e2ced7)
- [Enterprise KM with RAG (Confluent)](https://www.confluent.io/blog/enterprise-knowledge-management-with-rag-for-digital-native-companies/)
