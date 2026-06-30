# KY Agent 改进建议（基于调研的可落地方案）

## 1. 引言：本文档定位

本文档是 KY Agent 系列调研报告（01 Claude Code 内部架构、02 主流 IDE prompt 泄漏、03 LangChain/Dify/MCP/Memory/新兴框架/Prompt 工程/Tool 注入模式）后的**收口建议**，回答一个问题：**KY Agent 当前的架构哪些应该保留、哪些应该改、用什么优先级改。**

读者假设：熟悉本仓库 `server/src/runtime/rawRuntimeRunDispatch.ts`、`server/src/agent/skillToolProvider.ts`、`workspace-shared/.claude/skills-pool/`、`~/workspace/{username}/` 的工程师。所有建议都标注文件路径，所有"参考实现"都给出可点击链接。**收益/成本以 1–5 级估算**（5 = 大），不是空泛形容词。

---

## 2. 当前架构优点（保留这些设计）

### 2.1 工具三分层：内置 / 单一 Skill 入口 / MCP — 与 Claude Code 同构

**位置**：`server/src/agent/builtinTools.ts`、`skillToolProvider.ts`、`server/src/runtime/clientManager.ts`

调研 §6 §7 已经定量证明：当 skill 数量未来膨胀到 50+ 时，把每个 skill 暴露成独立 tool（模式 D）会让 tools 段在 30–50 个工具后触及 Claude 选择精度断崖（Anthropic Tool Search 文档原话），且单工具 description 500–2000 tokens × N 会迅速吃光 cache prefix。KY Agent 当前用的"单一 Skill 工具 + SKILL.md 懒加载"是**模式 C**（Claude Code Skills），这是 Anthropic、OpenAI Codex CLI、Cursor 在 2025-12 后共同采纳的 open standard。**保留**。

### 2.2 Per-user workspace 物理隔离

**位置**：`server/src/runtime/resolver.ts` 的 `ensureUserWorkspace()`

物理目录隔离 + symlink 共享 skills 的设计，等价于 LangGraph `BaseStore` 的 namespace 模式（调研 §6.7 §6 LangChain 节），但走文件系统而非数据库——**部署门槛低、调试直观**。多组织 RAG 调研（§6 多组织隔离节）指出"绝不能依赖 LLM 自觉过滤 tenant"，物理隔离是最强的兜底。**保留。**

### 2.3 MEMORY.md per-user + workspace-shared 拆分

**位置**：`~/workspace/{username}/MEMORY.md`、`workspace-shared/`

调研 §0 §5 已经分类了"公司知识 / Agent procedural memory / 用户记忆"三类，KY Agent 用 MEMORY.md（用户层）+ workspace-shared/.claude/（共享层）天然映射到 Claude Code 的 CLAUDE.md 分层模型。**保留这个拆分**，但需要在 system prompt 里显式约定"何时写、何时不写"（见 §4.3）。

### 2.4 Prompt 拼接顺序符合学术最佳实践

**位置**：`server/src/runtime/rawRuntimeRunDispatch.ts:716-771` `buildInstructions`

当前顺序 `static.md → dynamic.md → <available-skills> → runtime-mcp.md → runtime-memory.md → availableHandsPrompt` 把**稳定 prefix 在前 / 动态信息在后**，与 Anthropic prompt caching 推荐（`tools → system → messages`）和 Lost-in-the-Middle 论文结论一致。**保留顺序**，但需要在末尾加 cache breakpoint（见 §4.2）。

### 2.5 Hand 路由系统作为 sub-agent 雏形

**位置**：`docs/managed-agents-roadmap.md` 及 hand 路由相关代码

调研 §11 给出了 Anthropic Building Effective Agents 的五大模式（prompt chaining / routing / parallelization / orchestrator-workers / evaluator-optimizer），Hand 路由对应 routing + orchestrator-workers 的雏形。**保留**这个抽象，未来扩展时优先做 evaluator-optimizer 而不是更复杂的多 agent 编排。

---

## 3. 当前架构潜在问题（基于调研发现）

### 3.1 Skill 注入方式：当前是合格 C 模式，但缺 progressive disclosure 中层

**证据**：调研 §3.3（Claude Code 三级 progressive disclosure：L1 metadata 常驻 ~100 tokens、L2 SKILL.md 正文按需、L3 supporting files 按需）。当前 `skillToolProvider.ts` 实现了 L1（`<available-skills>` 块注入 name+description）和 L2（Skill 工具调用拉 SKILL.md），但**没有 L3 子目录引用机制**——SKILL.md 里如果引用 `references/api-schema.json`，模型不知道这是个可读文件还是描述。

**证据**：`server/src/agent/skillToolProvider.ts` 中 skill 内容拉取后整段注入，未做 reference 文件按需展开。

### 3.2 Skill 数量膨胀的天花板未做工程准备

**证据**：调研 §0 §6（Anthropic Tool Search Tool 阈值 30–50；RAG-MCP 论文 Top-1 准确率 43.13% vs 13.62% baseline，当 pool 放大到数千时强模型也明显下降）。

当前 `<available-skills>` 块是**一次性全量**注入。若 skill 数量到 50+，每次请求 prefix 都会膨胀到 5K+ tokens，且不能动态裁剪。**[修正] 这个问题在 100 个 skill 之前不会爆发**，所以是中期问题（1-3 月）而非当下问题。

### 3.3 Prompt cache breakpoint 未显式声明

**证据**：检查 `rawAgentLoop.ts:222` `{ role: 'system', content: instructions }` 处，调用 Anthropic API 时未传 `cache_control: { type: "ephemeral" }`。

调研 §1.6 §10（Anthropic 官方失效矩阵）：tools 数组任何变更都会一次性废掉 tools/system/messages 三层；cache hit 是 0.1×、5min write 1.25×、1h write 2×。对**多机器人共享同一 system prefix + per-user 长会话**这种场景，不开 cache 直接损失 60-70% 的成本节约。

### 3.4 Memory 系统缺少自动写入触发器和容量管理

**证据**：`server/src/agent/memory.ts` 和 `memorySearchToolProvider.ts` 提供了索引与搜索，但**没有"何时该追加 memory、何时该 summarize 老条目"的策略**。

调研 §5（Claude Code 2.1.59+ 的 auto-memory）+ §0（mem0 single-pass extraction + multi-signal retrieval 让 LongMemEval 从 49% 涨到 94.4%）说明：**纯静态 MEMORY.md 已经不是 SOTA**，需要 LLM 自动决策何时写。当前 MEMORY.md 上限按 Claude Code 规则只有 200 行 / 25KB 进入 context，超出后需要归档策略，目前缺失。

### 3.5 没有 prompt cache 命中率监控

**证据**：未见 `cache_read_input_tokens / cache_creation_input_tokens` 的 metrics 上报。

调研 §10 反模式 #10："不监控 `cache_read_input_tokens`：prompt cache 静默失效（如 system prompt 顺序变化、cache_control 错位），账单暴涨但无报错"——这是生产环境最常见的隐性成本黑洞。

### 3.6 公司知识层只覆盖 L1（基本信息），缺 SOP / 红线 / 动态 RAG / 多组织隔离

**[修正 2026-06-20]** 原稿误判为"公司知识层缺失"。**实际情况**：`workspace-shared/company.md`（32 行：公司全称、团队花名册、业务线、业务系统 URL）已存在，并通过 `rawRuntimeRunDispatch.ts:758` 的 `loadCompanyInfo()` 以 `{{COMPANY_INFO}}` 变量注入 `dynamic.md` 第 3 行，位于 system prompt 非常靠前的位置——**L1 静态公司知识完全到位**。

真实缺口在更上层：

| 层级 | 现状 | 缺口 |
|---|---|---|
| L1 公司基本信息（业务、组织、产品 URL） | `workspace-shared/company.md` 静态注入 | ✅ 已有 |
| L2 SOP / 合规红线 / 服务话术 | 未见独立文件 | ⚠️ 缺 |
| L3 动态 RAG（接 Azeroth CRM / 钉钉 / Notion / Slack） | 未接入 | ⚠️ 缺 |
| L4 持续更新机制（人员变动自动同步） | 手动编辑 `company.md` | ⚠️ 缺自动同步 |
| L5 多组织隔离（外部客户使用时） | 当前单组织（开沿自用） | ⚠️ 客户化部署时需重设计 |

调研 §0 第五类（公司知识 vs 用户记忆 vs Agent procedural memory 必须分桶）+ §2（COMPANY.md / AGENTS.md 已经是 2026 跨工具共识）说明：L1 静态层是必备前置（已经做了），但 KY Agent 要走向"内部 + 外部客户共用"必须补 L2-L5。

### 3.7 没有多端输出格式差异化（钉钉 vs Web vs RN）

**证据**：CLAUDE.md 描述了三端，但 system prompt 看不到针对 markdown 渲染能力的分支。

调研 §1.3 §1（Anthropic 反复强调"prompt 风格影响输出风格"；GPT-5 在 API 中默认不 markdown，需显式开启）。钉钉对 markdown 渲染有限，Web/RN 完全支持——目前应该是同一份 prompt 喂三端。

### 3.8 没有 tool selection / skill routing 的 eval 集

**证据**：仓库内未见 `server/evals/` 目录。

调研 §7（Anthropic 官方推荐"生成几十组 prompt/response 对跑 held-out 测试集"）+ §0（MCPVerse 显示 Claude-4-Sonnet 在 prompt-based function call 下幻觉率 > 70%）：没有 eval 集就无法在新增 skill 时检测"上次能答对的现在答不对了"。这是中期最大的工程风险。

---

## 4. 短期可落地改进（1-2 周）

### 4.1 在 Anthropic API 调用处加 prompt cache breakpoint【收益 5 / 成本 1】

**文件**：`server/src/agent/rawAgentLoop.ts:222`

**改动**：把 `{ role: 'system', content: instructions }` 改成 `system` 参数（Anthropic API 支持 system 是 content block 数组），最后一个 block 加 `cache_control`：

```ts
const systemBlocks = [
  { type: "text", text: staticPrefix }, // static.md + dynamic.md
  { type: "text", text: skillsBlock },
  { type: "text", text: mcpBlock + memoryBlock + handsBlock,
    cache_control: { type: "ephemeral" } }, // 5min TTL 默认
];
```

并把 `username`、当前时间戳、conversationId 移到第一条 user message 顶部（避免污染 prefix）。

**参考实现**：调研 §10（Anthropic Prompt Caching 官方文档 + Notion 工程博客对 cache 命中的实战）。

**收益**：典型场景命中率 0.6+ 时，每次请求 input 成本降到 ~15%；KY Agent 多机器人共享 prefix 后效果更显著。**成本**：1-2 小时改造 + cache_creation 首次 1.25× 溢价。

### 4.2 加 prompt cache 命中率 metric【收益 3 / 成本 1】

**文件**：新增 `server/src/agent/cacheMetrics.ts`，在 `rawAgentLoop.ts` 接收 API response 处调用。

**实现**：从每次 response 的 `usage.cache_read_input_tokens` 与 `usage.cache_creation_input_tokens` 计算 hit_rate = `cache_read / (cache_read + cache_creation + input)`，上报 prom/datadog/日志。阈值告警 < 0.5。

**参考**：调研 §10 反模式 #10。

**收益**：避免 cache 静默失效。**成本**：半天。

### 4.3 在 dynamic.md 里加 MEMORY.md 使用约定【收益 4 / 成本 1】

**文件**：`workspace-shared/.claude/` 内对应的 dynamic.md 模板（或 `rawRuntimeRunDispatch.ts:716-771` 拼装的 memory 段）

**追加 prompt 片段**（参考调研 §5 Claude Code MEMORY.md 节 + §4 Anthropic Context Engineering structured note-taking）：

```markdown
# How to use MEMORY.md

You have a user-specific `MEMORY.md` at the workspace root.
- READ it at session start (auto-injected by harness, first 25KB).
- WRITE to it ONLY when:
  (a) user explicitly says "记住 / remember / 保存", OR
  (b) a fact is clearly stable across sessions
      (allergies, project paths, long-term preferences, role/title).
- Each entry MUST be one line, prefixed with ISO date:
    `2026-06-20  prefers TypeScript strict mode`
- Never write secrets (API keys, passwords, PII beyond name/role).
- If MEMORY.md exceeds 150 lines, summarize older entries into a
  single "## Archive (<= 2026-Q1)" section before adding new ones.

Your context window auto-compacts; do NOT stop tasks early due to
token budget. As you approach the limit, save progress to MEMORY.md
before context refreshes.
```

**参考**：调研 §1.12（Claude 4.5/4.6 context awareness）+ §5（Claude Code MEMORY.md 25KB 上限规则）。

**收益**：零成本拿下 auto-memory 行为，避免 MEMORY.md 静默膨胀。**成本**：1 小时。

### 4.4 在 static.md 加入 Anthropic 4.x/Opus 4.6+ 兼容性 prompt 片段【收益 3 / 成本 1】

**文件**：`workspace-shared/.claude/static.md`（或等价的项目级 system prompt 文件）

**追加内容**（直接引用调研 §1.7 §1.9 §1.13 的官方推荐片段）：

```markdown
<avoid_over_engineering>
Only make changes that are directly requested or clearly necessary.
A bug fix doesn't need surrounding code cleaned up. Don't add error
handling or fallbacks for scenarios that can't happen. Don't create
helpers, utilities, or abstractions for one-time operations.
</avoid_over_engineering>

<investigate_before_answering>
Never speculate about code you have not opened. If the user references
a specific file, you MUST read the file before answering. Give grounded
and hallucination-free answers.
</investigate_before_answering>

<cleanup_temp_files>
If you create any temporary new files, scripts, or helper files for
iteration, remove them at the end of the task.
</cleanup_temp_files>

<reversibility>
Take reversible local actions freely. For destructive operations
(rm -rf, dropping tables, force push), hard-to-reverse operations
(git reset --hard, amending published commits), or operations visible
to others (push, comment on PRs, send messages), confirm with the
user first. Never use destructive actions as a shortcut.
</reversibility>
```

**参考**：[Anthropic Prompting Claude Opus 4.8](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-opus-4-8)（调研 §1）。

**收益**：直接降低 Claude 4.6+ over-engineering、临时文件污染、误删等三类高频痛点。**成本**：1 小时。

### 4.5 抽出 dingtalk 输出格式约束【收益 3 / 成本 2】

**文件**：`server/src/runtime/rawRuntimeRunDispatch.ts:716-771` `buildInstructions`，根据触发源（dingtalk webhook / web / mobile）追加段落。

**实现**：dingtalk 场景追加 *"Respond with concise plain text suitable for DingTalk markdown rendering. Avoid nested code fences > 2 levels and table-heavy markdown."*；web/mobile 默认开启完整 markdown。

**参考**：调研 §1.3（Anthropic markdown 控制反向用法）+ §2.5（GPT-5 默认不 markdown）。

**收益**：钉钉输出可读性提升，避免乱码 markdown。**成本**：半天（含验证）。

### 4.6 新增 `server/evals/skills/` 最小 eval 集【收益 4 / 成本 3】

**文件**：新建 `server/evals/skills/cases.jsonl`，每条 case 含 `user_input` + `expected_skill_name`，配套 `npm run eval:skills` 跑批比对。

**实现**：从已有 skills-pool 抽 30 个高频 skill，每个写 2-3 个典型 user query。脚本调用 Claude 拿 `available-skills` 路由结果对比 expected。

**参考**：调研 §8（Anthropic 建议"几十组 prompt/response 对"作为 evals 起步）+ §11.7（Self-Consistency 论文：多次采样 + majority vote 提升鲁棒性）。

**收益**：新增 skill 时立即知道有没有打架；为下阶段引入 Tool Search Tool 提供 baseline。**成本**：2-3 天。

---

## 5. 中期演进方向（1-3 个月）

### 5.1 引入 Anthropic Tool Search Tool 应对 skill 增长【收益 5 / 成本 4】

**触发条件**：skill 数量超 50，或 `<available-skills>` 块 > 5K tokens。

**文件**：`server/src/agent/skillToolProvider.ts` 改造为发布"deferred skill 列表"模式。

**实现**：

```jsonc
{
  "anthropic_beta": ["advanced-tool-use-2025-11-20"],
  "tools": [
    { "type": "tool_search_tool_bm25_20251119", "name": "tool_search" },
    { "name": "Read", "...": "..." },
    { "name": "Bash", "...": "..." },
    { "name": "Skill", "...": "..." },
    // 数百个 skill 注册时全部加 defer_loading: true
    { "name": "skill_dingtalk_send_group", "defer_loading": true, "...": "..." }
  ]
}
```

**参考**：[Anthropic Tool Search Tool docs](https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool)（调研 §7 §1）。官方数据 Opus 4.5: 79.5% → 88.1%，token -85%。BM25 变体对中文自然语言友好。

**收益**：skill pool 可扩到 10000；prompt cache prefix 不被破坏（Tool Search 的 deferred tools 官方文档明确 *"prefix is untouched, so prompt caching is preserved"*）。**成本**：1 周改造 + 1 周 eval 回归 + 调 BM25 参数。

### 5.2 引入 LangGraph BaseStore + LangMem background manager 做用户记忆增强【收益 4 / 成本 4】

**触发条件**：发现 MEMORY.md 因 token 限制无法承载更多用户偏好，或客户反馈"agent 忘记我上周说过的事"。

**文件**：新增 `server/src/memory/langmem.ts`，与 MEMORY.md 共存（人写文件、机器写数据库）。

**实现**：见调研 §6.4 的完整代码片段。Postgres + pgvector + LangMem background manager，namespace = `("memories", username)`，对话结束后异步抽取/合并，不阻塞响应。

**参考**：[LangMem 官方文档](https://docs.langchain.com/oss/python/langchain/long-term-memory) + 调研 §0（mem0 multi-signal 让 LongMemEval 49% → 94.4%）。

**收益**：用户记忆从"靠人维护"升到"agent 自动写"。MEMORY.md 仍是人可编辑层，pgvector 是机器层，两者用 username 对齐。**成本**：2 周（含 Postgres schema、retrieval node 改造、eval 集扩充）。

### 5.3 扩展 company.md → 加 SOP/red-lines 层 + 简单 RAG【收益 5 / 成本 4】

**[修正 2026-06-20]** L1 `workspace-shared/company.md`（公司基本信息、团队花名册、业务线、业务系统 URL）**已经存在**并通过 `dynamic.md` 的 `{{COMPANY_INFO}}` 注入 system prompt，第一阶段已完成。本节聚焦 L2-L3 扩展。

**触发条件**：业务话术分歧、SOP 越来越多、首个外部客户私有化部署、SaaS 多 tenant 化。

**文件**：

- 保留 `workspace-shared/company.md`（L1 基本信息，已有）
- 新增 `workspace-shared/sop.md`（L2：服务话术 / 合规红线 / 不做什么 / 兜底应对）作为 dynamic.md 的额外段落
- 新增 `server/src/kb/` 目录（L3：pgvector + 飞书/钉钉/Azeroth 连接器）

**实现**：第一阶段先扩 SOP 静态段（< 5K tokens 拿掉 80% 价值，参考调研 §10 第一周方案）。第二阶段加增量 RAG：

```sql
CREATE TABLE kb_chunks (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL,
  source TEXT, source_doc_id TEXT, chunk_idx INT,
  content TEXT, context_prefix TEXT,
  embedding vector(1024),
  tsv tsvector GENERATED ALWAYS AS (to_tsvector('simple', content)) STORED,
  accessible_by TEXT[] NOT NULL,
  ...
);
ALTER TABLE kb_chunks ENABLE ROW LEVEL SECURITY;
ALTER TABLE kb_chunks FORCE ROW LEVEL SECURITY;
```

每次请求用 `SET LOCAL app.tenant_id` 注入（**事务级，不能用 session 级**）。embedding 用 bge-m3 自托管（境内合规），rerank 用 bge-reranker-v2-m3。

**参考**：调研 §0 §4 §10 多组织 RAG 节，[Anthropic Contextual Retrieval](https://www.anthropic.com/news/contextual-retrieval)（contextualize 让失败率从 5.7% 降到 1.9%）。

**收益**：企业部署刚需。**成本**：3-4 周（含连接器、ACL、ingestion pipeline、reranker 部署）。

### 5.4 Skill progressive disclosure L3：reference 文件按需展开【收益 3 / 成本 2】

**触发条件**：单个 SKILL.md 超过 3K tokens 时。

**文件**：`server/src/agent/skillToolProvider.ts`

**实现**：SKILL.md 里写 `See ./references/api-schema.json for full field list`，Skill 工具返回时只注入 SKILL.md 本体；模型用 Read 工具按需读 references。约定 skill 目录结构：`SKILL.md` + `references/` + `scripts/`。

**参考**：调研 §3.3（Claude Code L1/L2/L3 progressive disclosure）+ Anthropic 官方 Skills 标准。

**收益**：复杂 skill 不再吃光 context。**成本**：3-5 天（含目录约定、文档迁移）。

### 5.5 引入 Anthropic Memory Tool + context editing【收益 4 / 成本 3】

**文件**：`server/src/agent/rawAgentLoop.ts:222` 加入 `tools: [{type: "memory_20250919", ...}]` 与 `context_management: {edits: [{type: "clear_tool_uses_20250919"}]}`。

**参考**：[Anthropic Memory Tool docs](https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool) + [Context Editing](https://platform.claude.com/docs/en/build-with-claude/context-editing)。调研 §1 §4 提到 100 轮 web search benchmark 中 token -84%。

**收益**：长 cron 任务、长会话不再因 context 耗尽提前收尾；agent 自己学到的程序性经验落到独立 `workspace-shared/agent-memory/`（不污染用户 MEMORY.md，不污染公司 COMPANY.md）。**成本**：1 周。

---

## 6. 长期架构思考（半年以上）

### 6.1 暴露 KY Agent 自己为 MCP server

调研 §2（Dify v1.6 / FastGPT v4.9.6 / MaxKB v2 都已支持把内部 agent 发布为 MCP server）+ §0 § 10（"不暴露 MCP 的平台等同于不出现在未来 Agent 网络上"）。KY Agent 应规划在 server 侧加 `/mcp` Streamable HTTP 端点，让客户的 Claude Desktop / Cursor / Codex CLI 能把 KY Agent 当 backend 调。这是 2026 SaaS 的分发杠杆。

**核心难点**：OAuth 2.1 + RFC 9728 PRM + RFC 8707 Resource Indicators 的合规实现（调研 §1 §8）。

### 6.2 接入 Agent Client Protocol (ACP)

Zed 在 2025-08 推出、JetBrains 在 2025-10 跟进、OpenAI Codex 在 2025-10-06 接入（调研 §12.2）。把 KY Agent 做成 ACP-compatible server 后，VS Code / JetBrains / Zed 用户可以直接挂载，**长期看编辑器变 client、agent 变 server**——这是 Lever 级架构变化。

### 6.3 Skill 标准对齐 agentskills.io open standard

2025-12-18 Skills 升级为开放标准。当前 `workspace-shared/.claude/skills-pool/` 的格式应主动对齐 agentskills.io，未来切换执行器（Codex CLI、Cursor）时零迁移成本。同时考虑发布 KY 自家 skill 到公共 registry，做品牌曝光。

### 6.4 Code Execution with MCP 模式

当业务侧出现"取 1000 条钉钉消息然后做统计"这类场景，把数据处理移到 `code_execution_20260120` 沙箱里执行，model 只看摘要——调研 §6.5 数据：极端案例 150K → 2K tokens。这要求重沙箱（gVisor / Firecracker），是半年以上的工程投入。

### 6.5 评测 + SFT 闭环（对标 Bisheng）

调研 §2 指出 Bisheng 是国内唯一把 SFT + 评测 + 数据集做进同一控制台的平台。KY Agent 若走 ToB，长期需要"用客户私有语料微调小模型"的能力。Coze Loop（2025-07 开源，Apache 2.0）是低成本切入点——先做 trace + eval 回归，再扩到 SFT。

---

## 7. 不建议做什么（避免过度设计）

### 7.1 不要自己手写 connector / RAG ingestion

调研 §1（MCP 已 vendor-neutral、2025-12 捐赠给 Agentic AI Foundation、1000+ MCP server 上线）。飞书、钉钉、Notion、Slack 都有官方或社区 MCP server。**先用 MCP，跑通再考虑自研**。

### 7.2 不要急着引入 Zep / Letta / Cognee

调研 §0 §8 选型决策表：mem0 / LangMem 已经能覆盖 90% 个性化需求；Zep 时序 KG 只在"用户上周改主意了"这类时序推理出现时才上。Letta v1 自带 runtime 会和现有 rawAgentLoop 抢戏，**项目期不要同时上两套 agent runtime**。

### 7.3 不要做 multi-agent orchestration

调研 §11（Anthropic Building Effective Agents）反复强调 *"start simple"*：能 workflow 解决就别上 agent，能单次 LLM 解决就别上 workflow。Hand 路由够用，不要急着学 AutoGen / CrewAI。后者已在 2025-10 进入 maintenance mode（调研 §10）。

### 7.4 不要把整个 wiki 塞 system prompt

调研 §10 反模式 #1：cache 失效后单次成本爆炸。即使前期没有 RAG，也要做 COMPANY.md 5K tokens 硬上限，超出走文件 Read 按需读。

### 7.5 不要在 prompt 中用 "CRITICAL: You MUST ALWAYS"

调研 §10 反模式 #1 + Anthropic Opus 4.6 文档原话：*"dial back any aggressive language… Claude 4.6 models are significantly more proactive and may overtrigger"*。Claude 4.6+ 对强语气敏感、易 overtrigger，应改成 *"Use this tool when…"*。

### 7.6 不要重写 prompt 拼接顺序

当前 `rawRuntimeRunDispatch.ts:716-771` 的顺序符合 Anthropic、Gemini、学术（Lost in the Middle）的共同建议，不要为"看着更整洁"重排——重排一次 cache 全失效。

### 7.7 不要用 XML tool calling 强行兼容弱模型

调研 §6（BFCL V4 Format Sensitivity 推翻"XML 对小模型友好"的旧经验：≤ 7B 模型上 XML 反而是最差的）+ MCPVerse（Claude-4-Sonnet 在 prompt-based function call 下幻觉率 > 70%）。KY Agent 主力是 Claude 4.x，走原生 tool_use 即可，不要为"理论上兼容 Qwen / Llama"提前付代价。

---

## 8. ADR 模板

KY Agent 后续做架构决策时建议沿用这套 ADR（Architectural Decision Record）模板，单文件放 `docs/adr/NNNN-title.md`：

```markdown
# ADR-NNNN: <Decision Title>

- Status: Proposed | Accepted | Superseded by ADR-XXXX
- Date: YYYY-MM-DD
- Deciders: <names / roles>
- Related ADRs: ADR-XXX, ADR-YYY

## Context

What problem are we facing? What constraints (technical, business,
team, timeline) frame this decision? Quote concrete evidence
(file_path:line_number, benchmark number, customer ticket).

## Decision

State the decision in 1-3 sentences. Be unambiguous.

## Options Considered

### Option A: <name>
- Pros
- Cons
- Cost (eng-weeks)
- Risk

### Option B: <name>
- ...

### Option C: <name>
- ...

## Consequences

### Positive
- ...

### Negative / Trade-offs
- ...

### Neutral (need to monitor)
- ...

## Rollback Plan

How do we undo this if it's wrong? What signals tell us to roll back?
(e.g., "cache hit rate < 0.4 for 3 consecutive days", "skill routing
accuracy on eval set drops > 5pp").

## References

- Internal: file_path:line_number, related PRs, design docs
- External: papers, blog posts, official docs (with URLs)
- Research findings: link to relevant docs/agent-research/*.md
```

**首批建议沉淀的 ADR**（按优先级）：

1. **ADR-0001 Prompt cache breakpoint 与 cache_control 策略**（对应 §4.1）
2. **ADR-0002 MEMORY.md 自动写入约定与归档策略**（对应 §4.3）
3. **ADR-0003 Skill 注入坚持模式 C 与未来 Tool Search Tool 切换条件**（对应 §5.1）
4. **ADR-0004 COMPANY.md + multi-tenant RAG 的 ACL 模型**（对应 §5.3）
5. **ADR-0005 KY Agent 暴露为 MCP server 的 OAuth 与协议选择**（对应 §6.1）

---

## 附：与用户最关心问题的对应表

| 用户关心的问题 | 本文档章节 |
|---|---|
| Skill 注入方式：保持模式 C 还是切换？ | §2.1 §3.1 §5.1 §7.7（结论：保持 C，超过 50 skill 时引 Tool Search） |
| Skill 数量膨胀后的应对 | §3.2 §5.1 §5.4（Tool Search Tool BM25 + L3 progressive disclosure） |
| Prompt cache 优化 | §3.3 §3.5 §4.1 §4.2 |
| Memory 系统升级路径 | §3.4 §4.3 §5.2 §5.5 |
| 公司知识持续更新方案 | §3.6 §5.3 §6.1 |
| 多端上下文一致性 | §3.7 §4.5（差异化 markdown 约束）+ §6.1（统一暴露 MCP 之后客户端自渲染） |
