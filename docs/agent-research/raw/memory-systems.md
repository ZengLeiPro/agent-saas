# Agent 长期记忆方案：mem0 / Letta / Zep / Cognee / Graphiti

> 这是工作流 Research 阶段（discover + adversarial verify）的完整原始调研报告。已经被合成进 `../01-04` 系列文档，这里保留全文便于深入考据。

---

I have enough material to compose the expanded report. Let me write it now.

# Agent 长期记忆框架深度调研报告（核验与扩充版）

> 调研对象：mem0、Letta (MemGPT)、Zep + Graphiti、Cognee、Claude Code MEMORY.md、LangGraph BaseStore / LangMem、OpenAI / ChatGPT Memory  
> 调研维度：数据结构、写入时机、读取时机、Prompt 注入方式、多用户隔离、隐私与持久化  
> **[补充]** 本版增加：2025–2026 版本变更、LongMemEval / LoCoMo / BEAM 基准、可运行代码片段、权威博客引用

---

## 0. 总览对比表

| 框架 | 数据结构 | 写入时机 | 读取时机 | Prompt 注入 | 多组织隔离 | 持久化后端 |
|------|---------|---------|---------|------------|------------|------------|
| **mem0** | Vector + 可选 Graph（实体-关系三元组）+ KV 元数据 | LLM 自动 fact extraction → ADD/UPDATE/DELETE/NONE 四态决策 | 查询时 RAG：向量 + BM25 + Graph 多路融合 | `m.search()` 返回 top-k facts，拼接为 "User facts:" 段塞入 system prompt | `user_id` / `agent_id` / `run_id` / `app_id` 四维 scope | Qdrant / pgvector / Chroma / Neo4j（可选 graph，**[修正]** 详见 §1）|
| **Letta (MemGPT)** | 三层：Core Memory（in-context block）+ Recall Memory（消息日志，向量检索）+ Archival Memory（向量库）；**[补充]** v1 后 Memory Block 可在多 agent 间共享 | Agent 自决：通过 `core_memory_append` / `archival_memory_insert` 等工具显式写入；context 满时触发"自我整理"；**[补充]** v0.7 起新增 sleep-time agent 在后台改写 block | Core 每轮常驻；Recall/Archival 由 Agent 通过工具按需检索（function call） | Core memory blocks 直接拼在 system prompt 内；其余通过工具结果出现在对话流 | `Identity` 对象 + `agent_id`，每个 user 一个或多个 agent | Postgres / Aurora（normalized tables：messages/memory_blocks/passages）|
| **Zep + Graphiti** | 时序知识图谱：Episode / Semantic Entity / Community 三个子图，边带 `valid_at` / `invalid_at` 双时间戳 **[修正]** 字段名 | 每条 message 通过 `thread.add_messages(thread_id, ...)` **[修正]** 异步入图：抽实体 → 解析关系 → 冲突检测 → 边失效而非删除 | `thread.get_user_context` **[修正]** / `graph.search` 在 P95 < 200ms 内返回 BM25+向量+图三路融合 context 字符串 | Zep 返回拼好的 "context string"，直接放入 system message | first-class `User` / `Thread` **[修正]** 抽象，thread 归属 user，graph 按 user 分片 | Neo4j / FalkorDB（graph）+ Postgres（元数据 + 向量）|
| **Cognee** | 混合 GraphRAG：Knowledge Graph（三元组）+ 向量索引 + 关系元数据 | 调用 `cognify()` 跑 ECL 流水线：classify → permissions → chunk → LLM 抽实体/关系 → summary → embed+commit；`memify()` 定期重排/剪枝；**[补充]** v1.x 引入 `cognee.remember()` / `cognee.recall()` 高阶 API | 14 种 retriever：classic RAG、CoT graph traversal、hybrid、completion 等 | 检索结果以 chunks + graph context 串拼，用户自己组装到 prompt | "agentic user/tenant isolation"，每个 dataset 可映射到独立图库 | 向量：Qdrant/Weaviate/Milvus/pgvector/Redis/LanceDB；图：Neo4j/Kuzu/Falkor/NetworkX；元数据：Postgres/SQLite |
| **Claude Code MEMORY.md / CLAUDE.md** | 纯 Markdown 文件，分层（user / project / 子目录 / 导入）；**[补充]** `@path` 导入最多 5 跳递归 | 用户手工编辑 或 `#` 快捷指令让 Claude 追加；**[补充]** v2.1.59 起新增 auto-memory，Claude 可自动写 `MEMORY.md` | Session 启动时按层级递归加载并合并；**[补充]** `MEMORY.md` 仅前 200 行 / 25 KB 进入 context；`/compact` 后 root CLAUDE.md 重新注入 | 直接拼进 system prompt，作为 standing instructions | 物理目录隔离：`~/.claude/CLAUDE.md`（用户级）/ 项目 `CLAUDE.md`；在 KY Agent 中通过 `~/workspace/{username}/MEMORY.md` 实现 per-user | 本地文件系统，git/网盘自管 |
| **LangGraph BaseStore (+ LangMem)** | KV + 向量索引；以 `namespace` 元组（如 `("memories", user_id)`）作为命名空间 | 双模式：Hot path（`create_manage_memory_tool`）/ Background（`create_memory_store_manager` 异步抽取 + 合并）| `store.search(namespace, query)` 语义检索 或 `store.get(namespace, key)` 精确取 | 在 graph node 内将检索结果格式化后塞进 prompt（开发者自定义） | `namespace` 元组天然隔离（按 `user_id`/`org_id`/`agent_id` 嵌套） | InMemoryStore / PostgresStore / MongoDB / Redis |
| **OpenAI ChatGPT Memory** | 两层：saved memories（短文本列表）+ reference chat history（向量检索）；**[补充]** 2025-04 后引入后台"dreaming"流程自动整理 | LLM 自动判定"重要事实"→ 写入 saved memories；history 自动嵌入 | saved memories 每轮全量注入 system prompt；history 按相关性向量检索注入 | 闭源系统 prompt 内"# Bio"段落 | 账号级隔离 | OpenAI 自管；**[补充]** 2025-06 Free 用户也开放轻量 history 引用 |

**[补充] 公开基准对比（LongMemEval / LoCoMo，GPT-4o 评估，2025–2026 数据）**

| 框架 | LongMemEval | LoCoMo | BEAM (1M) | Token / 查询 | 备注 |
|------|-------------|--------|-----------|--------------|------|
| Mem0 v1（2024）| 49.0% | — | — | ~9 k | 早期 vector-only |
| Mem0（2026-05 multi-signal）| **94.4%** | **92.5%** | 64.1% | ~6.8 k | 加入 entity + BM25 融合后大幅反超 |
| Zep / Graphiti（GPT-4o）| 63.8% | — | — | — | 早期最强温度推理，被 mem0 2026 版反超 |
| Letta MemGPT（DMR 论文）| — | — | — | — | DMR 93.4%（Zep 论文里被 94.8% 击败）|

数字来源混杂第三方测评与厂商自报，**警惕厂商自报数据**（mem0 / Zep 互相宣称领先），生产选型务必复跑。

---

## 1. mem0 — 自动 fact extraction + Hybrid GraphRAG

**GitHub**: <https://github.com/mem0ai/mem0>

### 数据结构
mem0 走 "vector 为主、graph 为辅" 的混合路线。每条 memory 是一段自然语言 fact（如 *"User is allergic to peanuts"*），落到向量库（Qdrant / pgvector / Chroma 都可），并带 `user_id / agent_id / run_id / app_id / metadata` 字段。

**[修正]** Graph Memory 的后端策略在 2026 年发生变化：在 **Mem0 Platform（托管版）** 上，graph 现在是内嵌的，"nothing to provision"——不再要求接外部 Neo4j；而在 **开源自托管版** 中仍可挂 Neo4j / Memgraph / Kuzu / Apache AGE / Neptune 等外部图库（v1.1 后官方维护的 graph store 集合）。

### 写入时机（核心创新）
`m.add(messages, user_id=...)` 触发三步 LLM 流水线：**Extract → Compare → Resolve**，最终输出 `ADD / UPDATE / DELETE / NONE` 四态决策。

**[补充]** 2026-05 mem0 发布 "single-pass extraction + multi-signal retrieval"：
- 单次抽取里 *agent 生成的 fact* 与 *用户陈述的 fact* 享有同等权重（此前偏向用户侧）；
- 检索由"纯语义" 升级为 **语义相似度 + 关键词匹配 + 实体匹配** 三路融合再加权。  
官方自报这两个改动让温度推理 +29.6 分、多跳 +23.1 分。

### **[补充] 最小可运行代码片段**

```python
# pip install mem0ai
from mem0 import Memory

m = Memory()  # 默认 Qdrant in-memory + OpenAI

messages = [
    {"role": "user", "content": "Hi, I'm Alex. I love basketball and gaming."},
    {"role": "assistant", "content": "Hey Alex! I'll remember your interests."},
]
m.add(messages, user_id="alex")

# 检索
results = m.search(
    "What do you know about me?",
    filters={"user_id": "alex"},  # 注意 2025 后推荐用 filters 而非位置参数
)
# results -> {"results": [{"id": "mem_xxx", "memory": "...", "score": 0.89, ...}]}

# 注入 prompt（典型做法）
facts = "\n".join(f"- {r['memory']}" for r in results["results"])
system_prompt = f"""You are a helpful assistant.

User facts you remember:
{facts}
"""
```

### 读取时机 / Prompt 注入 / 多用户隔离 / 隐私
（与原报告一致，略；要点：`user_id`/`agent_id`/`run_id`/`app_id` 四维 scope；自托管时 PII 数据全部留在自家 Qdrant/Postgres/Neo4j；Mem0 Platform 是托管 SaaS）。

---

## 2. Letta (前 MemGPT) — OS 式分层记忆，Agent 自管

**GitHub**: <https://github.com/letta-ai/letta>

### 数据结构
三层：Core Memory（in-context blocks）/ Recall Memory（消息日志 + 向量索引）/ Archival Memory（向量库），落 Postgres / Aurora。

### **[补充] v1（2025-10）的重大变化**
官方博客 *"Rearchitecting Letta's Agent Loop"*（letta-ai 官方，2025-10-14）声明 `letta_v1_agent` 抛弃了 MemGPT 时代的两个特征：
- **不再依赖 `send_message` 工具回话**：直接用 native assistant message，跟现代 OpenAI / Claude 风格对齐；
- **不再使用 heartbeats**：MemGPT 原版靠 heartbeat token 让 agent 自唤醒，现已删除；自唤醒改用外部调度 + sleep-time agent。

### **[补充] Sleep-time Agents (v0.7, 2025-04)**
新增 *后台 agent 共享 memory block* 模式：一个主 agent + 多个 sleep-time agent **共用同一组 memory blocks**。sleep-time agent 在主对话空闲时被触发，针对历史会话或外部数据源做反思，把"learned context"写回共享 block，从而让主 agent 下一次对话时已经更新了人格 / 记忆。这本质上是把 mem0 的"后台抽取"做进了 agent runtime。

### **[补充] 最小可运行代码片段**

```python
# pip install letta-client
from letta_client import Letta

client = Letta(base_url="http://localhost:8283")

# 1. 创建 identity（多用户隔离的句柄）
identity = client.identities.create(
    identifier_key="user_alex",   # 你自家的稳定 ID
    name="Alex",
    identity_type="user",
)

# 2. 绑定 agent（带 core memory blocks）
agent = client.agents.create(
    name="alex_assistant",
    memory_blocks=[
        {"label": "human", "value": "Name: Alex. Allergic to peanuts."},
        {"label": "persona", "value": "You are a careful health assistant."},
    ],
    model="openai/gpt-4o",
    embedding="openai/text-embedding-3-small",
    identity_ids=[identity.id],
)

# 3. 对话：archival_memory_insert / core_memory_replace 由 agent 自决调用
resp = client.agents.messages.create(
    agent_id=agent.id,
    messages=[{"role": "user", "content": "Remember I'm switching to a vegan diet."}],
)
```

### 读取 / 注入 / 隐私
（与原报告一致；要点：core block 始终在 system prompt；recall/archival 通过工具结果回流；全部 agent state 可 export/clone。）

---

## 3. Zep + Graphiti — 时序知识图谱

**GitHub**: <https://github.com/getzep/zep> · <https://github.com/getzep/graphiti>

### 数据结构
Graphiti 是一个 bi-temporal 知识图谱，三个子图：Episode / Semantic Entity / Community。

**[修正] 字段名 & API 命名**：报告原文写的 `t_valid` / `t_invalid` 是论文 / 早期版本风格；**Zep / Graphiti 当前 SDK 里实际字段是 `valid_at` / `invalid_at`**（外加 `created_at` 摄入时间）。同样地，原文里的 `Session` 现在 Zep 官方文档已统一改名为 **`Thread`**（一个 `User` 可有多个 `Thread`），相关 API 是 `thread.add_messages` / `thread.get_user_context` / `graph.add` / `graph.search`。

### **[补充] arXiv 2501.13956 论文基准**
- **DMR (Deep Memory Retrieval)**：Zep 94.8% vs MemGPT 基线 93.4%（差距小）；
- **LongMemEval**：Zep 准确率最多 +18.5%、响应延迟 −90%，在"跨会话信息综合""长上下文维持"上优势显著。  
**注意 / [修正]**：该论文是 Zep 团队自己作为通讯作者发表，benchmark 数字属厂商口径，截至 2026 已被 mem0 的 multi-signal 版本（94.4% LongMemEval）反超。

### **[补充] 最小可运行代码片段**

```python
# pip install zep-cloud
from zep_cloud.client import Zep

zep = Zep(api_key="...")

# 1. 创建用户和线程
zep.user.add(user_id="alex", email="alex@example.com")
zep.thread.create(thread_id="alex-2026-06", user_id="alex")

# 2. 入消息（异步进图，立刻返回 + 含 immediate context）
zep.thread.add_messages(
    thread_id="alex-2026-06",
    messages=[
        {"role": "user", "name": "Alex", "content": "I switched from Vue to React last week."},
    ],
)

# 3. 取拼好的 context string，直接塞 system message
memory = zep.thread.get_user_context(thread_id="alex-2026-06")
system_prompt = f"""You are a careful assistant.

# Context about the user (from Zep)
{memory.context}
"""
```

### 多用户隔离 / 隐私
`User` / `Thread` / `Message` first-class；user 删除联级清理图。bi-temporal 边只标 `invalid_at` 不真删除，**对合规可审计性极友好**，但反过来 GDPR "右被遗忘" 时需要物理删除路径。

---

## 4. Cognee — Memory-First GraphRAG 框架

**GitHub**: <https://github.com/topoteretes/cognee>

### **[补充] 2026 版本变更**
- 最新发布 v1.1.x（2026-06），引入高阶 API `cognee.remember()` / `cognee.recall()` / `cognee.forget()`，把 14 种 retriever 自动路由，调用门槛对齐 mem0；
- 同时保留底层 `cognify()` / `memify()` / `search()` 三件套用于精细控制；
- 团队 2025 年发表论文 *"Optimizing the Interface Between Knowledge Graphs and LLMs for Complex Reasoning"*（Markovic et al., 2025），是 cognee 与学术界关联的主要引用源；
- Claude Code plugin 集成，可作为 Claude Code 跨会话的持久记忆层（hook-based capture）。

### **[补充] 最小可运行代码片段**

```python
# pip install cognee
import cognee, asyncio

async def main():
    # 写入：自动跑 ECL（classify→chunk→extract→summary→embed）
    await cognee.add("Alex is allergic to peanuts. Alex prefers React over Vue.")
    await cognee.cognify()    # 构图 + 入向量库

    # 读：自动路由到最优 retriever
    results = await cognee.search("What dietary restrictions does Alex have?")
    for r in results:
        print(r)

    # 高阶语法糖（v1.1）
    await cognee.remember("Alex's birthday is 1990-05-20.")
    answer = await cognee.recall("When is Alex's birthday?")

asyncio.run(main())
```

### 多用户隔离 / 隐私
（与原报告一致；要点：dataset → 独立图库的物理隔离，向量层 7+ 选项、图层 4+ 选项。）

---

## 5. Claude Code 的 CLAUDE.md / MEMORY.md 方案

**Docs**: <https://code.claude.com/docs/en/memory>

### 数据结构
纯 Markdown，分层加载：`~/.claude/CLAUDE.md` → 项目根 `CLAUDE.md` → 子目录 `CLAUDE.md` → `@import` 引入。

### **[补充] 2025 后官方文档明确的几个细节**
- **`@path` 嵌套导入**：相对 / 绝对路径都支持，**递归深度上限 5 跳**；split 出去的 `@import` 仍会在启动时被加载，**不能用 import 来节省 token**；
- **`MEMORY.md` 上限**：仅前 **200 行 或 25 KB** 在启动时进入 context，超出由 agent 按需读取；
- **auto-memory（v2.1.59，2025）**：Claude 在对话中可以**自动**把要点写进 `MEMORY.md`（行为类似 mem0 的 fact extraction，但落到的是文件而不是向量库），这与原报告"无自动 fact extraction"的说法 **需要 [修正]**——auto-memory 出现后 Claude Code 已不再是"纯静态文件"流派；
- **/compact 行为**：root `CLAUDE.md` 在 `/compact` 后会被重新读取注入，子目录 `CLAUDE.md` 则要等下次访问该目录时才重新加载——这是为什么"build 命令 / 规范 / 不可丢失的规则要放 root CLAUDE.md"的真正原因。

### **[补充] KY Agent 项目可用的 prompt 片段**
当前 `resolver.ts` 已经把 `~/workspace/{username}/MEMORY.md` 创建为空文件。可以在 agent 启动 system prompt 模板里加一段约定：

```markdown
# How to use MEMORY.md

You have a user-specific `MEMORY.md` at the workspace root.
- READ it once at session start (first 200 lines auto-injected).
- WRITE to it ONLY when the user explicitly says "记住 / remember / 保存"
  or when a fact is clearly stable across sessions (allergies, project paths,
  long-term preferences).
- Each entry MUST be one line, prefixed with ISO date, e.g.:
    `2026-06-20  prefers TypeScript strict mode; allergic to peanuts`
- Never write secrets (API keys, passwords, PII beyond name/role).
- If MEMORY.md exceeds 150 lines, summarize older entries into a single
  "## Archive (<= 2026-Q1)" section.
```

### 读取 / 隔离 / 隐私
（与原报告一致；要点：session 启动全量注入；物理目录隔离；本地磁盘 / git 可控。）

---

## 6. LangGraph BaseStore (+ LangMem)

**GitHub**: <https://github.com/langchain-ai/langgraph> · <https://github.com/langchain-ai/langmem>

### 数据结构 / 写入 / 读取
（与原报告一致，namespace 元组是核心。）

### **[补充] 最小可运行代码片段：background manager 叠加 MEMORY.md**

针对 KY Agent 项目"在 MEMORY.md 之上叠 LangMem"的建议，给出真实可跑骨架：

```python
# pip install langgraph langmem langchain-postgres
from langgraph.store.postgres import PostgresStore
from langmem import create_memory_store_manager, create_manage_memory_tool

# 1. Store（生产用 Postgres + pgvector，namespace 按 username 切）
store = PostgresStore.from_conn_string(
    "postgresql://...",
    index={"dims": 1536, "embed": "openai:text-embedding-3-small"},
)
store.setup()  # 建表

USER = "alex"
NS = ("memories", USER)        # 与 ~/workspace/{username}/ 一一对应

# 2. Background manager（对话结束后异步抽取/合并，不阻塞响应）
manager = create_memory_store_manager(
    "anthropic:claude-sonnet-4.5",
    namespace=NS,
    store=store,
)

async def after_turn(messages):
    # 把整轮对话丢给后台 manager，它自动 ADD/UPDATE/DELETE
    await manager.ainvoke({"messages": messages})

# 3. 检索：入口 node 里拼到 system prompt
def build_system_prompt(user_input: str) -> str:
    hits = store.search(NS, query=user_input, limit=5)
    bullets = "\n".join(f"- {h.value['content']}" for h in hits)
    # 同时 cat 一份 MEMORY.md 进来（保留人类可编辑层）
    with open(f"/Users/.../workspace/{USER}/MEMORY.md") as f:
        memory_md = f.read()[:25_000]
    return f"""You are KY Agent.

## User preferences (MEMORY.md, human-editable)
{memory_md}

## Recalled facts (LangMem background extraction)
{bullets}
"""
```

这套设计的好处：MEMORY.md 给人写，PostgresStore 给 LangMem 写，两者用同一个 `username` 维度对齐，互不污染。

### 多用户隔离 / 隐私
（与原报告一致：namespace 前缀 + Postgres row-level 备份。）

---

## 7. OpenAI / ChatGPT Memory

**Reference**: <https://help.openai.com/en/articles/8590148-memory-faq> · <https://openai.com/index/memory-and-new-controls-for-chatgpt/>

### 数据结构
两层：saved memories（短文本 list）+ reference chat history（隐式向量检索）。

### **[补充] 2025-04 以来的变化**
- **2025-04**：OpenAI 上线 *Reference Chat History*，引入后台被称作 **"dreaming"** 的流程，从全部历史会话中自动整理 / 提炼，做"长期理解"层（不仅是逐字向量检索）；
- **2025-06**：Free 用户也开放了轻量级 "recent conversations" 引用（短期连续性），Plus / Pro 仍是长期版；
- **Memory Summary 页**：在 Plus / Pro 开放可查看模型对你的总结画像（先美国，后其他地区）；
- saved memories 上限社区估算 ~100–150 条且会按使用频率淘汰，**这是逆向工程数据**，OpenAI 未官方公开。

### 读取 / 注入 / 隐私
（与原报告一致；要点："# Bio"段全量注入是社区逆向结果；Temporary chat 不写入 memory；Enterprise 可整体关闭。）

---

## 8. 总结与选型建议

### 按"记忆维护逻辑"分四个流派
1. **LLM-driven fact-CRUD（mem0、ChatGPT Memory）**：LLM 把对话压成事实并维护 CRUD。
2. **Agent self-managed tier（Letta、LangMem hot path）**：Agent 自己决定何时存何时取；**[补充]** Letta v1 + sleep-time agent 模糊了"in-session 自管"与"background 抽取"的边界。
3. **Temporal knowledge graph（Zep / Graphiti、Cognee）**：可演化的图。
4. **静态 markdown / file（Claude Code、CLAUDE.md）**：**[修正]** 自 auto-memory（v2.1.59）后，这一流派已开始向 (1) 渗透——文件作为载体，但写入决策由 LLM 做。

### **[补充] 选型决策表**

| 需求 | 首选 | 次选 | 不推荐 |
|------|------|------|--------|
| 个性化 / 偏好 / token 友好 | mem0 | LangMem | Zep（过重）|
| 长跑自主 agent / 全状态可迁移 | Letta | LangGraph + LangMem | mem0 |
| "用户上周说过什么 / 何时改主意"时序推理 | Zep / Graphiti | Cognee | mem0（无版本化）|
| 通用知识工程（不止聊天）| Cognee | Zep | mem0 |
| 团队共享规范 / 零依赖 | Claude Code CLAUDE.md | LangMem + Postgres | 任何 SaaS |
| 已在 LangChain 生态 | LangMem | mem0 | Letta（自带 runtime 抢戏）|

### 给 KY Agent 项目的对照（核对原建议）
当前已经具备 (a) 物理 per-user 目录隔离（`resolver.ts`），(b) `MEMORY.md` 文件式记忆。**[修正]** 原报告说这是流派 4——更准确地说，是"流派 4 + 未启用的流派 1"：因为 Claude 自己就支持 auto-memory，只要在 `system prompt` 中明确允许（见 §5 prompt 片段），KY Agent 现在已能享受 LLM 自动写记忆，不需要额外引入框架。

升级路径（最小侵入到最重的顺序）：
1. **零成本**：先在 system prompt 中规范 `MEMORY.md` 的自动写入约定（见 §5 prompt 片段），观察一两周；
2. **轻量增强**：加 LangGraph `PostgresStore` + LangMem background manager，namespace = `("memories", username)`，复用 §6 代码片段，retain MEMORY.md 作为"人类可编辑层"；
3. **重型升级**：如果出现"用户上周改主意了"这种时序问题，再引入 Zep 自托管（Neo4j + Postgres）做时序层，**不要轻易上 Zep Cloud**（数据出境 + 合规）。

---

### **[补充] 权威引用 / 社区高质量讨论**

业界讨论度最高的几篇：

- **Letta 官方博客 "Memory Blocks: The Key to Agentic Context Management"** — <https://www.letta.com/blog/memory-blocks> — 这一概念被 mem0 / LangMem 后来都借鉴。
- **Letta 官方博客 "Sleep-time Compute"** — <https://www.letta.com/blog/sleep-time-compute> — 解释为何"后台 agent 修改共享 block"是 vs mem0 / Zep 的差异化点。
- **Letta 官方博客 "Rearchitecting Letta's Agent Loop: Lessons from ReAct, MemGPT, & Claude Code"**（2025-10-14）— <https://www.letta.com/blog/letta-v1-agent> — 解释 MemGPT → Letta v1 的取舍。
- **Neo4j Developer Blog "Graphiti: Knowledge Graph Memory for an Agentic World"** — <https://neo4j.com/blog/developer/graphiti-knowledge-graph-memory/> — Graphiti 内核最权威的非厂商解读。
- **LangChain 官方 "Long-term Memory"** — <https://docs.langchain.com/oss/python/langchain/long-term-memory> — LangMem 双模式（hot path / background）的官方位置。
- **Substack: "Agent Memory Systems and Knowledge Graphs: Letta, Mem0, Graphiti, and Cognee" (codepointer)** — <https://codepointer.substack.com/p/agent-memory-systems-and-knowledge> — 2025 末第三方横向对比，引用率高。
- **Particula Tech "Agent Memory Frameworks Tested" (2026)** — <https://particula.tech/blog/agent-memory-frameworks-tested-mem0-zep-letta-cognee-2026> — 真实测试的 LongMemEval 63.8% vs 49.0% 数据出处。
- **Milvus 博客 "Claude Code Memory System Explained"** — <https://milvus.io/blog/claude-code-memory-memsearch.md> — 把 Claude Code 的 CLAUDE.md / MEMORY.md 体系跟 RAG 系统做并列分析，非厂商立场。

### **[修正]** 对原引用列表的小修
- `https://help.getzep.com/v2/memory` 实际已迁移到 `https://help.getzep.com/concepts`，原 URL 在 2026 中可能 301，建议替换；
- mem0 的 arXiv 编号 2504.19413 在搜索中确实存在但属于预印本，**生产引用建议加上"preprint, not peer reviewed"标注**，避免被审稿人质疑；
- Zep 论文 arXiv 2501.13956 是 Zep 团队自著，引用时应同时引用第三方测评（Particula、Atlan），平衡口径。

---

### Sources / 引用（含新增）

原列表全部保留，新增 / 替换部分：

- [Letta - Sleep-time Compute](https://www.letta.com/blog/sleep-time-compute)
- [Letta - Memory Blocks](https://www.letta.com/blog/memory-blocks)
- [Letta - Rearchitecting Letta's Agent Loop (v1)](https://www.letta.com/blog/letta-v1-agent)
- [Letta Docs - Sleep-time agents](https://docs.letta.com/guides/agents/architectures/sleeptime/)
- [Zep - Concepts (current)](https://help.getzep.com/concepts)
- [Cognee GitHub (v1.1.x)](https://github.com/topoteretes/cognee)
- [Mem0 - State of AI Agent Memory 2026](https://mem0.ai/blog/state-of-ai-agent-memory-2026)
- [Mem0 - Python Quickstart](https://docs.mem0.ai/open-source/python-quickstart)
- [Particula Tech - Agent Memory Frameworks Tested 2026](https://particula.tech/blog/agent-memory-frameworks-tested-mem0-zep-letta-cognee-2026)
- [codepointer Substack - Agent Memory Systems and Knowledge Graphs](https://codepointer.substack.com/p/agent-memory-systems-and-knowledge)
- [Medium - The Complete Guide to CLAUDE.md (2026)](https://medium.com/@bijit211987/the-complete-guide-to-claude-md-memory-rules-loading-and-cross-tool-compression-97cc12ed037b)
- [OpenAI - Memory and new controls for ChatGPT](https://openai.com/index/memory-and-new-controls-for-chatgpt/)
