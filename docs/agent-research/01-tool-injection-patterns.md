# Tools / Skills / MCP 注入 LLM API 的模式对比

> 调研时间：2026-06
> 作用域：本文档作为 KY Agent 工程团队"能力注入层"长期参考资料，覆盖六种主流模式的具体实现、横向定量对比、真实框架选型理由与 KY Agent 项目落地建议。
> 关键参考：Anthropic *Advanced Tool Use* (2025-11-24)、Anthropic *Equipping Agents with Skills* (2025-10-16)、BFCL V4、MCPVerse、RAG-MCP、Cline / Roo Code / smolagents 源码、OpenAI Function Calling Guide。

---

## 1. 引言：为什么这是核心设计问题

"把能力清单交给模型"看似是 API 调用细节，实际上是 Agent 系统设计中**最重要的架构分叉点**之一。它在 Agent 启动的第一个 token 之前就已经决定了系统的成本曲线、能力上限和可治理性。这一决策同时牵动四条主线：

**1. Tool selection 精度。** 工具池越大，模型选错率越高。Anthropic 官方 [Tool Search Tool 文档](https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool) 给出经验阈值——**"Claude 在超过 30–50 个工具后选择准确率显著下降"**。RAG-MCP（[arXiv:2505.03275](https://arxiv.org/abs/2505.03275)）实验表明，候选池放大到数千量级时检索增强能把 Top-1 准确率从 13.62% 提升到 43.13%（>3 倍），同时 prompt token 节省 >50%。MCPVerse（[arXiv:2508.16260](https://arxiv.org/html/2508.16260v1)）规模到 552 真工具 / 140K+ tokens 动作空间时，发现 **Claude-4-Sonnet 在 prompt-based function call 下幻觉率超过 70%**，原因是 prompt 模板与训练时的 function-calling 模板不匹配——这从反面证明，**工具注入方式必须与模型训练分布对齐**。

**2. Token 成本。** Anthropic 在 *Advanced Tool Use* 博客中给出具体数据：典型五服务器组合（GitHub / Slack / Sentry / Grafana / Splunk）在用户尚未输入第一个字符前就吃掉 **~55K tokens**；他们见过的极端案例是 **134K tokens 全部用于工具定义**。社区实测 GitHub MCP 单独的 91 个工具占 **46K tokens**，对 200K 窗口的 Sonnet/Opus 4 来说，对话框未输入一字即占 ~23%。这些都是**沉没成本**——每次 API 调用都付，且乘以日活会话数。

**3. Prompt cache 命中率。** Anthropic 缓存层级是 `tools → system → messages` 严格前缀序。[Prompt caching 官方文档](https://platform.claude.com/docs/en/docs/build-with-claude/prompt-caching) 的失效矩阵明确：**修改 tool definitions 会一次性废掉 tools / system / messages 三层缓存**。1 小时 TTL 的 cache write 溢价是 **2×**（5 分钟版本 1.25×），cache hit 都是 0.1×。这意味着，**任何把"动态/可变"放进 tools 数组的设计都在持续付缓存税**。

**4. 可观测、安全、多用户隔离。** 原生 function calling 有结构化日志、可在网关层做 RBAC；纯 prompt 描述的工具调用要靠自家解析器，鉴权和追踪都得自己造。Agent 在 SaaS 多组织场景下，"哪些 skill 这个 user 可见"" 这次调用是否越权" 等问题，注入模式直接决定了实现复杂度。

下面六种模式（A–F）外加 2025 年下半年新出现的 **G：Code Execution with MCP**，本质是在"上下文成本 / 精度 / 表达力 / 工程治理"四维空间里选取不同的工作点。**对于 KY Agent 这种"未来 skill 数量必然膨胀"的企业通用 Agent SaaS，这一决策不可逆——一旦选错，重构成本极高**。

---

## 2. 主流模式枚举

### 模式 A — 独立 function tool（原生最小描述）

把工具名 + JSON Schema 通过 API 的 `tools` 字段传入，每条描述精简到 1–3 句话。OpenAI / Anthropic 都把它当作"happy path"。

### 模式 B — System prompt 文本描述（XML / Markdown）

不使用 API 的 tools 字段，把工具清单写进 system prompt，模型直接输出 XML 标签或自定义协议字符串，宿主解析后执行。**Cline 2023–2025 主线、早期 Roo Code、AutoGPT、BabyAGI** 都属于此派。

### 模式 C — 混合：统一入口 tool + system prompt 名单

API 层只暴露极少数底层工具（Read / Write / Bash / **Skill** / WebSearch …），高层"能力"（Skill / Slash Command）只通过 system prompt 暴露 `name + description` 两行 frontmatter，正文按需用 Read 工具拉取（progressive disclosure）。**Claude Code 的当家做法**。

### 模式 D — tools 数组 + 详细 description（"胖"function calling）

仍走 API `tools` 字段，但每个 description 写成迷你说明书：用法、例子、错误处理、参数语义。**GitHub MCP、Bedrock Agents 默认、典型企业 RPC 网关**。

### 模式 E — MCP server 集中代理

工具实现在远端 MCP server，宿主把列出的工具按 `mcp__<server>__<tool>` 命名空间挂入 tools 数组，或用 RAG-MCP / Tool Search Tool 做动态检索加载。**Claude Code、Cursor、VS Code Copilot Chat、Codex CLI** 都支持此模式。

### 模式 F — Code Agent（代码即动作）

模型不输出 JSON，输出 **Python 代码**。工具是 Python 函数，函数签名通过 system prompt 注入；执行器在沙箱里 `exec` 模型生成的代码。**smolagents、Open Interpreter、CodeAct 论文**。

### 模式 G — Code Execution with MCP（Anthropic 2025-11 新模式）

Anthropic 在 2025-11 主推的合规化 CodeAct：MCP 工具不进入 LLM 上下文，**而是导出为代码执行容器里的 SDK 函数**；Claude 写一段调用这些 SDK 的代码，扔到 `code_execution_20260120` 容器里跑；中间结果留在沙箱，只把摘要回流。极端案例 **150K → 2K tokens（~98.7% 降）**。

---

## 3. 每个模式的具体实现

### 3.1 模式 A：原生 function calling

OpenAI 和 Anthropic 协议略有差异，但 schema 完全一致：

```python
# Anthropic SDK
tools = [{
    "name": "get_weather",
    "description": "Get current weather for a city.",
    "input_schema": {
        "type": "object",
        "properties": {"city": {"type": "string"}},
        "required": ["city"]
    }
}]
client.messages.create(model="claude-opus-4-8", tools=tools, ...)
```

**特点**：模型走训练过的 `tool_use` 通路，参数有 JSON Schema 校验，流式 partial JSON 解析有 SDK 支持。Anthropic 在 2025-11 加入了 *strict tool use* 模式（传 `strict: true` 走语法约束解码，schema 不符的输出在模型侧就被截断），与 `defer_loading` 可组合。

**适用边界**：[OpenAI Function Calling Guide](https://developers.openai.com/api/docs/guides/function-calling) 明确"**aim for < 20** at any one turn"；o3/o4-mini "in-distribution" < 100 tools 且每工具 < 20 args；超过 128 tools 直接拒绝。

### 3.2 模式 B：System prompt 文本（Cline 经典实现）

```xml
<!-- Cline / 早期 Roo Code system prompt 节选 -->
# Tools
You have access to the following tools. Use them by emitting an XML block.

## read_file
Reads a file from disk.
Parameters:
- path: (required) absolute path
Usage:
<read_file>
<path>/abs/path/to/file</path>
</read_file>

## execute_command
Executes a shell command and returns stdout / stderr.
Parameters:
- command: (required) the shell command
- requires_approval: (required) true | false
...
```

模型回复中直接输出 `<read_file><path>...</path></read_file>`，宿主用正则/状态机解析。Cline 的 system prompt 全长 ~10K tokens，包含 `## TOOL USE`、`## CAPABILITIES`、`## RULES`、`## OBJECTIVE` 多个段落 + 当前任务目录与沙箱描述。

**BFCL V4 Format Sensitivity** 新发现颠覆了旧经验：相同函数调用任务，按 Python / JSON / XML 三种语法分别 prompt，**强模型在三种格式间差异 ≤ 2pp，弱模型 (≤ 14B) 可以差 15–25pp，且 XML 在 ≤ 7B 模型上反而是最差的语法**（[BFCL V4 Format Sensitivity blog](https://gorilla.cs.berkeley.edu/blogs/17_bfcl_v4_prompt_variation.html)）。

### 3.3 模式 C：Claude Code Skills（progressive disclosure）

每个 Skill 是一个目录，入口是 `SKILL.md`，仅 frontmatter 在启动期进入上下文：

```markdown
---
name: pdf-form-fill
description: Fill PDF AcroForm fields from structured data. Triggers when
  user uploads PDF + asks "fill this form".
allowed-tools: ["Read", "Bash(pdftotext:*)"]
---
# 正文：调用方法、字段映射、错误处理（不进上下文，直到被激活）
For complex field mapping see ./forms.md
For multi-page strategies see ./reference/multipage.md
```

**三级 progressive disclosure**：
- **L1**：仅 frontmatter（~100 tokens / skill）常驻 system prompt
- **L2**：模型决定调用 `Skill(skill="pdf-form-fill")` 后，整个 SKILL.md 正文（<5K tokens）加载到 messages
- **L3**：SKILL.md 引用的 `reference/*.md`、`scripts/*.sh` 等文件，模型通过现有的 `Read` / `Bash` 工具按需拉取

**关键时间线**：
- **2025-10-16** Anthropic 正式发布 Agent Skills（[官方博客](https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills)）
- **2025-12-18** Skills 升级为 *open standard*（[agentskills.io](https://agentskills.io)）
- **2025-12-12** OpenAI 在 Codex CLI 加入 `skills.md` 实验性支持（[Simon Willison 报道](https://simonwillison.net/2025/Dec/12/openai-skills/)）

这是 MCP 之后第二个被三大厂同时采纳的 agent 跨平台标准。

### 3.4 模式 D：胖 description + Tool Use Examples

```jsonc
// 老做法：把例子塞 description（每工具 500-2000 tokens）
{
  "name": "create_issue",
  "description": "Create a new GitHub issue in a repository. Use when user explicitly asks to file a bug / track work.\n\nExamples:\n  - 'open an issue about the auth bug' -> repo=current, title='Auth bug'\n\nErrors:\n  - 403: caller lacks issues:write -> ask user to install GitHub App\n  - 422: title empty -> retry with non-empty title\n...",
  "input_schema": { /* 20+ properties */ }
}
```

Anthropic 在 2025-11 给出的标准缓解方案是 **Tool Use Examples**：把例子从 description 文本里剥离到结构化字段 `input_examples`，模型选择期不读，只在被调用时按需拉取——复杂参数场景准确率从 72% 提升到 90%：

```jsonc
{
  "name": "create_issue",
  "description": "Create a GitHub issue. See examples for parameter shape.",
  "input_schema": { /* ... */ },
  "input_examples": [
    {
      "input": {"repo": "owner/name", "title": "Auth bug", "labels": ["bug"]},
      "comment": "Minimal call from natural-language ask"
    },
    {
      "input": {"repo": "owner/name", "title": "...", "assignees": ["alice"], "milestone": 12},
      "comment": "Full call with triage metadata"
    }
  ]
}
```

### 3.5 模式 E：MCP server + Tool Search Tool

```jsonc
// settings.json — Claude Code 或 Cursor 风格
{
  "mcpServers": {
    "github":  { "command": "npx",  "args": ["@modelcontextprotocol/server-github"] },
    "linear":  { "command": "uvx",  "args": ["mcp-linear"] },
    "dingtalk":{ "type": "http",    "url": "https://mcp.acme.com/dingtalk" }
  }
}
// runtime tools 数组 = [...native, ...mcp__github__*, ...mcp__linear__*, ...mcp__dingtalk__*]
```

Anthropic 在 2025-11-20 发布的 **Tool Search Tool** 是这一模式的官方扩展。配置如下：

```jsonc
{
  "anthropic_beta": ["advanced-tool-use-2025-11-20"],
  "tools": [
    // 检索器：bm25 适合中文自然语言查询，regex 适合精确名称
    { "type": "tool_search_tool_bm25_20251119", "name": "tool_search" },
    // 高频工具不 defer
    { "name": "Read", "input_schema": { /* ... */ } },
    { "name": "Bash", "input_schema": { /* ... */ } },
    // 低频 MCP 工具全部 defer，不进 system prefix
    { "name": "github_create_issue", "input_schema": { /* ... */ }, "defer_loading": true },
    { "name": "dingtalk_send_group", "input_schema": { /* ... */ }, "defer_loading": true }
    // ... 上百个 MCP 工具
  ]
}
```

**官方 benchmark**（Anthropic 自报）：
- **Opus 4: 49% → 74%**（MCP 评测准确率）
- **Opus 4.5: 79.5% → 88.1%**
- Token 占用 **-85%**，可用 context 从 122,800 → 191,300 tokens

关键性质：**Deferred tools are not included in the system-prompt prefix**，所以 prompt caching 完全保留。这是模式 E 拿回模式 C 缓存友好度的官方途径。

### 3.6 模式 F：smolagents code agent

```python
from smolagents import CodeAgent, Tool

class WebSearchTool(Tool):
    name = "web_search"
    description = "Search the web and return top-K snippets."
    inputs = {"query": {"type": "string", "description": "..."}}
    output_type = "string"
    def forward(self, query): ...

agent = CodeAgent(
    tools=[WebSearchTool()],
    model=InferenceClientModel("meta-llama/Llama-3.3-70B-Instruct"),
    executor_type="e2b",                    # 也可换 "modal" / "docker" / "local"
    additional_authorized_imports=["pandas", "numpy"],
)
# 模型可能生成的代码（在沙箱里执行）：
#   results = [web_search(q) for q in ["X site:a", "X site:b", "X review"]]
#   return summarize("\n".join(results))
agent.run("find 3 sources about X and summarize")
```

[CodeAct 论文](https://huggingface.co/learn/agents-course/en/unit2/smolagents/code_agents) 数据：相同任务**步数减少 ~30%**，难基准准确率更高。原因：JSON tool calling 表达不了 `for / if / try`；要循环 10 次只能让模型发起 10 次往返。代码一次 exec 完事，且中间变量留在解释器里，避免反复进上下文。

### 3.7 模式 G：Code Execution with MCP（Anthropic 2025-11）

```python
# Claude 生成的代码片段（在沙箱里执行，model 看不到原始 100K tokens 输出）
issues = await github.list_issues(repo="kaiyan-tech/agent-saas",
                                   state="open", per_page=100)
recent = [i for i in issues if i.updated_at > "2026-06-01"]
labels = collections.Counter(l for i in recent for l in i.labels)
return {"open_count": len(recent), "top_labels": labels.most_common(5)}
```

MCP 工具不进 LLM 上下文，而是导出成沙箱里的 SDK 函数。Model 写代码，沙箱执行，只把摘要 return。可以理解为 **F 套在 E 上的合规化版本**：享受"代码即动作"的表达力，同时保留 tool-use 协议的可观测与权限边界。Anthropic 官方实测复杂研究任务平均 token 从 43,588 → 27,297（**-37%**）；极端数据处理场景 150K → 2K（**~98.7% 降**）。

---

## 4. 横向对比表

| 维度 | A 原生 tools 精简 | B System prompt 文本 | C 混合（Skills） | D 胖 tools | E MCP 集中代理 | F Code Agent | G Code Exec + MCP |
|---|---|---|---|---|---|---|---|
| 推荐工具数上限 | ≤ 20 | 5–15 | 底层 ≤ 15；Skill 数千 | ≤ 50 | + Tool Search 可上万 | 5–30 函数 | 同 E，调用聚合于沙箱 |
| 单工具 token | 50–150 | 100–300 | 底层 100；Skill metadata ~100 | 500–2000 | 同 D × N server | 80–200 函数签名 | 同 E；运行时不进上下文 |
| **Prompt cache 友好度** | 高 | 中 | **最高** | 低 | 最低 / 加 Tool Search 后高 | 高 | 高 |
| Tool 选择精度（>30 工具时）| 中 | 差 | 高（语义路由）| 中 | 差 / Tool Search +25 pp | 中 | 高 |
| 表达力（控制流 / 组合）| 中 | 中 | 高 | 中 | 中 | **最高** | **最高** |
| 安全性 | 高 | 中 | 高 | 高 | 中（远端攻击面）| 需重沙箱 | 沙箱必需 |
| 可观测 / 鉴权 | API 层结构化日志 | 自家解析 | 顶层 tool 收口 + 文件权限 | API 层 | 网关 RBAC | 沙箱进程级 | 网关 + 沙箱双层 |
| 多用户隔离难度 | 易（API 层）| 难（prompt 注入风险）| 易（filesystem ACL）| 易 | 中（per-tenant MCP）| 中（per-user sandbox）| 中 |
| 扩展到 1000+ 能力 | 不行 | 不行 | **适合** | 不行 | 配 Tool Search 适合 | 适合 | **最适合** |
| 模型适配 | 强模型 | 任意（弱模型也凑合）| 仅强 Claude 验证最佳 | 任意 | 任意 | 强代码模型 | Claude 4.5+ 专用 beta |
| 典型代表 | OpenAI Assistants v1 | Cline、AutoGPT、Aider | **Claude Code**、Cursor Skills、Codex CLI | Bedrock Agents、GitHub MCP 默认 | Cursor MCP、VS Code Copilot Chat | smolagents、Open Interpreter | Claude Agent SDK 2025-11+ |

### 关键定量证据汇总

| 来源 | 设置 | 结论 |
|---|---|---|
| BFCL V4 ([leaderboard](https://gorilla.cs.berkeley.edu/leaderboard.html)) | 三部曲：Agentic Web Search / Memory / Format Sensitivity | 强模型对 Python/JSON/XML 三种语法差异 ≤ 2pp；≤ 14B 模型差 15–25pp |
| MCPVerse ([arXiv:2508.16260](https://arxiv.org/html/2508.16260v1)) | 552 真工具 / 65 MCP / 140K+ tokens 动作空间 | Claude-4-Sonnet 在 prompt-based function call 下幻觉率 *exceeding 70%* |
| RAG-MCP ([arXiv:2505.03275](https://arxiv.org/abs/2505.03275)) | 工具池压力测试 | Top-1 准确率 *43.13% vs 13.62% baseline*（>3×）；prompt tokens >50% 降 |
| Anthropic Tool Search Tool 官方 benchmark | 完整 MCP toolset → Tool Search | Opus 4: 49% → 74%；Opus 4.5: 79.5% → 88.1%；token -85% |
| Anthropic Programmatic Tool Calling | 复杂研究任务 | 平均 token 43,588 → 27,297（**-37%**）；GIA benchmark 46.5% → 51.2% |
| Anthropic Code Execution with MCP | 多工具数据处理 | 极端案例 **150K → 2K tokens（-98.7%）** |
| 社区实测（Scott Spence 等）| GitHub MCP 全开 | 91 工具 = 46K tokens |

**厂商官方的"工具数上限"**：

| 厂商 | 硬上限 | 软建议 | 出处 |
|---|---|---|---|
| OpenAI | 128 tools / request | "**aim for < 20** at any one turn"；o3/o4-mini "in-distribution" < 100 tools 且每工具 < 20 args | [OpenAI Function Calling Guide](https://developers.openai.com/api/docs/guides/function-calling) |
| Anthropic | Tool Search 上限 **10,000 tools / catalog** | **30–50 是裸 tools 数组的选择精度断崖**；超过即推荐 Tool Search Tool + `defer_loading: true` | [Tool Search Tool docs](https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool) |
| 通用经验 | — | 单工具 description ≤ 500 tokens；总 tools < 8K tokens 时缓存收益最高 | 社区经验 |

### Prompt cache 失效矩阵（Anthropic 官方）

`tools → system → messages` 严格前缀序，下列变更各自废掉哪几层缓存：

| 变更 | tools 缓存 | system 缓存 | messages 缓存 |
|---|---|---|---|
| Tool definitions（新增 / 修改 / 删除）| ✘ | ✘ | ✘ |
| Web search toggle | ✓ | ✘ | ✘ |
| Citations toggle | ✓ | ✘ | ✘ |
| Tool choice | ✓ | ✓ | ✘ |
| Images / thinking 参数 | ✓ | ✓ | ✘ |

这意味着：模式 D / E（胖 tools 或 MCP flatten）每次新增/删除工具都付完整的 25%（5m TTL）或 100%（1h TTL）写入溢价；模式 C（Skills）只把 frontmatter 写一次到 system，SKILL.md 正文经由 `Read` 工具按需加载到 messages 末段，**messages 缓存命中率高、tools 数组稳定不变**。这是 Claude Code 选 C 的最被低估的工程理由。

**Tool Search Tool 的 `defer_loading: true` 是这条规则的特殊豁免**：官方文档原文 *"Deferred tools are not included in the system-prompt prefix… The prefix is untouched, so prompt caching is preserved."*

---

## 5. 真实框架的选择与理由

### 5.1 Claude Code → 模式 C（Skills）

Claude Code 把底层工具压在 ~15 个（Read / Write / Edit / Bash / Grep / Glob / WebSearch / WebFetch / TodoWrite / Skill / AskUserQuestion / ArtifactCreate / NotebookEdit / Task / TaskCreate），高层能力全部走 Skill。理由综合官方博客 + 工程师在 HN/Reddit 的解释 + Claude Code 源码：

1. **Token 经济学**：1 个 Skill 启动期 ~100 tokens；同一能力做成 tool 至少 500 tokens（[Cookbook: Skills introduction](https://platform.claude.com/cookbook/skills-notebooks-01-skills-introduction)）。500 个 Skill 做成 tools 直接把窗口塞满。
2. **Prefix cache 不被破坏**：新增/修改 Skill 只动 system prompt 的 metadata 段，tools 数组稳定。
3. **Tool selection 精度**：OpenAI 自己也说"实际 > 20 个就掉点"，Anthropic 自己定义 30–50 是断崖。
4. **Progressive disclosure 是上下文工程的核心范式**：Anthropic 在 [Effective Context Engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents) 里把它和 CLAUDE.md / grep+glob "just-in-time" 并列为三大原则。
5. **治理与可移植**：Skill 是普通 Markdown，可 git 管理、可非工程师写、不需重新部署 Agent。
6. **跨平台标准化红利**：2025-12 升级 open standard 之后，Codex CLI、Cursor 已或正在跟进。

来源：[Equipping agents for the real world with Agent Skills](https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills)、[Effective context engineering for AI agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)、[Anthropic Cookbook — Skills introduction](https://platform.claude.com/cookbook/skills-notebooks-01-skills-introduction)。

### 5.2 Cursor → 模式 E 为主 + 2025 末跟进 C

Cursor 的 IDE 形态决定了 MCP-first：用户已经在用 GitHub / Linear / Notion 等外部系统，Cursor 通过 `~/.cursor/mcp.json` 让用户挂载。2025 下半年开始引入 Skills（"Cursor Rules" → "Cursor Skills" 演进），与 AGENTS.md 规范并行支持。来源：[Cursor MCP docs](https://cursor.com/docs/mcp)、Cursor 2.0 changelog。

### 5.3 Cline / 早期 Roo Code → 模式 B（XML）

综合 [Roo Code DeepWiki](https://deepwiki.com/RooCodeInc/Roo-Code/6.2-tool-protocols-(native-and-xml))、[native_tool_call_adapter](https://github.com/irreg/native_tool_call_adapter)、RFC #4047：

1. **历史兼容**：Cline 启动时（2023 末）大量模型 function calling 不稳，XML 是预训练语料的"母语"。
2. **流式可逐步执行**：解析到 `</read_file>` 立刻执行，不等响应结束。
3. **多工具交错可读**：XML 文本能和自然语言推理交错。
4. **失败代价**：Roo Code 工程师后来承认"XML calling 在强模型上仍有约 10% 失败率"，3.35 起改为原生 tool_use。
5. **2026 共识**：强模型走原生 tool_use；弱模型 ≤ 7B 优先 Python 语法（BFCL V4 推翻"小模型 XML 友好"的旧经验）。

### 5.4 LangChain / LangGraph → 模式 D 抹平协议差异

LangChain `bind_tools()` 对每个工具调用 `convert_to_openai_tool`，组成 list 塞进 `client.chat.completions.create(tools=...)`。Anthropic 走 `ChatAnthropic._format_tools_anthropic`，把同一份 JSON Schema 改写成 Anthropic 的 `{name, description, input_schema}` 形状。**跨厂商无感切换是 LangChain 的核心价值**。LangGraph 1.0（2025-10-22）推荐 `create_agent(model, tools, system_prompt=..., middleware=[...])` 入口，老的 `create_react_agent` 已 deprecated。来源：[LangChain & LangGraph 1.0 公告](https://www.langchain.com/blog/langchain-langgraph-1dot0)、[LangChain MCP 集成](https://docs.langchain.com/oss/python/langchain/mcp)。

### 5.5 Dify → 模式 D + 双向 MCP（v1.6.0 起）

Dify 自 v1.6.0（2025-07-10）正式内置"双向 MCP"：既能作为 MCP Client 调外部 MCP server，又能将 Dify 内的 Workflow/Agent 一键发布为 MCP Server。Agent Node 默认 `max_iterations = 5`，FC 与 ReAct 自动降级。Agent Strategy 本身已被插件化（社区已有 `mcp_sse_agent`、`mcp_agent`、UI-TARS-SDK 集成等）。来源：[Dify v1.6.0 Built-in Two-Way MCP](https://dify.ai/blog/v1-6-0-built-in-two-way-mcp-support)、[Dify Agent Node Introduction](https://dify.ai/blog/dify-agent-node-introduction-when-workflows-learn-autonomous-reasoning)。

### 5.6 OpenHands → 模式 C（AgentSkills 格式）

OpenHands SDK v1.0（2025-11-05 发布，[arXiv:2511.03690](https://arxiv.org/html/2511.03690v2)）把 Anthropic Skills 规范在 OSS 圈做了最完整实现。`AgentContext` 中心化加载，支持 always-loaded / keyword-triggered / progressive disclosure 三种策略；目录约定 `repo_skills / knowledge_skills / agent_skills`；接受 `.cursorrules`、`AGENTS.md` 等兼容格式。

```python
from openhands.sdk import LLM, Agent, AgentContext, Conversation
from openhands.sdk.context.skills import load_skills_from_dir
from openhands.tools import BashTool, FileEditorTool, TaskTrackerTool

repo_skills, knowledge_skills, agent_skills = load_skills_from_dir(".openhands/skills")
agent = Agent(
    llm=LLM(model="anthropic/claude-sonnet-4-5"),
    tools=[BashTool(), FileEditorTool(), TaskTrackerTool()],
    context=AgentContext(skills=list(agent_skills.values()), load_public_skills=True),
)
```

来源：[Introducing the OpenHands Software Agent SDK](https://openhands.dev/blog/introducing-the-openhands-software-agent-sdk)。

### 5.7 smolagents → 模式 F（CodeAct 教科书实现）

HuggingFace 主打"小而美"，核心库 < 1000 行。`CodeAgent` 让模型生成 Python 代码块而不是 JSON tool_call。Sandbox 矩阵：E2B、Modal、Docker、Blaxel。MCP 集成：可从任意 MCP server 导入 tools 当 Python 函数用。2025 末博客 [CodeAgents + Structure](https://huggingface.co/blog/structured-codeagent) 推出混合形态：自由文本代码 + 结构化 JSON action 字段，再增一截性能。

### 5.8 总览：哪些项目用哪些模式

| 项目 | 主模式 | 次模式 | 备注 |
|---|---|---|---|
| Claude Code | C | E（MCP 子集）| 模式 C 的旗舰实现 |
| Cursor | E | C（2025 末跟进）| MCP-first IDE |
| VS Code Copilot Chat | E + D | — | `.vscode/mcp.json` GA 自 v1.102 |
| Cline | B → 原生（@cline/sdk）| — | 历史包袱主因 |
| Roo Code | B + modes | — | 2026-05 归档；Kilo Code 继承 |
| LangChain / LangGraph | D（封装）| 任意（MCP 适配器）| 跨厂商抹平 |
| Dify | D | E（v1.6 双向 MCP）| 插件化 Agent Strategy |
| Coze / coze-studio | D | E（部分）| Multi-Agent 状态机 |
| FastGPT | D | E（v4.9.6+ 双向 MCP）| Workflow-as-Tool |
| Bisheng | D | E + 模式 C 类似 AGL | 企业级，含 SFT 评测一站式 |
| OpenHands | C | E | AgentSkills 标准最完整实现 |
| smolagents | F | E（MCP 导入）| CodeAct 旗舰 |
| OpenManus | D | E（`McpClientTool`）| 无 skills |
| Aider | — | — | 不用 tool，靠 edit format diff |
| Continue.dev | E + context provider | C（Hub assistants）| `@provider` 惰性注入 |
| Microsoft Agent Framework | D | — | AutoGen + SK 合并；Plugin ≈ skill |
| CrewAI | D | E（MCP）| Role/Goal/Backstory 模板 |

---

## 6. 各模式的适用场景

- **模式 A**：单一垂直场景，工具 ≤ 20，对原生 tool_use 协议有掌控权。代表：单一 SaaS 业务的客服/工单 Agent，OpenAI Assistants v1 风格。
- **模式 B**：必须跨大量小模型 / 开源模型 / 私有部署 LLM，无法依赖 function calling 通路。**注意 BFCL V4 已推翻"XML 对小模型友好"的旧经验，弱模型应优先 Python 语法**。
- **模式 C**：能力数量必然膨胀（数十到数千），且非工程师需要参与维护。**KY Agent 当前架构**。
- **模式 D**：能力数 20–50，每个工具参数复杂、需详细文档。Bedrock Agents 默认。**记得用 `input_examples` 字段替代在 description 里塞例子**。
- **模式 E**：能力实现在外部系统（GitHub / Linear / 钉钉），且其他 host（Claude Desktop / Cursor）也要复用。**超过两个 MCP server 必接 Tool Search Tool**。
- **模式 F**：需要复杂控制流 / 重计算 / 数据 pipeline，且能自建沙箱（合规、SOC2 可控）。
- **模式 G**：需要在多工具间做数据 pipeline，且合规要求高，单纯的 F 不可接受。**Claude 4.5+ 专用**。

---

## 7. 选型决策树

```
Skill 数量 N 与场景：

N < 10
├─ 单一垂直场景且工具描述简短 → 模式 A
└─ 工具参数复杂、需详细文档 → 模式 D + Tool Use Examples

10 ≤ N < 50
├─ 全部为内部业务能力、有非工程师维护需求 → 模式 C（Skills）
├─ 外部系统集成为主 → 模式 D（注意 cache_control 末尾置位）
└─ 多 MCP server → 模式 E + Tool Search Tool

N ≥ 50
├─ 能力可拆为"动词工具 + 名词工作流" → 模式 C 旗舰（Claude Code 范式）
├─ MCP 已有，工具数已超 50 → 模式 E + Tool Search Tool（defer_loading: true）
├─ 需要数据 pipeline / 多工具结果聚合 → 模式 G（Code Execution with MCP）
└─ 自建沙箱可控、强代码模型 → 模式 F（smolagents / CodeAct）

跨场景叠加规则：
- 模型偏弱 / 多 provider / 不能依赖 function calling → 退化到 B，但优先 Python 语法
- 严格合规 / 多组织隔离 → C 或 G 优先，避免 B 的 prompt-injection 攻击面
- 极致 token 优化 → 优先 C；其次 E + Tool Search
- 极致缓存命中 → 优先 C；其次 E + defer_loading
```

---

## 8. 对 KY Agent 项目的建议

基于 CLAUDE.md 描述的现状（Express + TypeScript 后端 + Claude Code harness、`workspace-shared/.claude/skills-pool/` 已存在 + `~/workspace/{username}/` per-user 隔离、Web / Mobile / 钉钉三端 + cron 子系统、`rawRuntimeRunDispatch.ts:716-771` 的 `buildInstructions` 拼接顺序），具体建议如下：

### 8.1 顶层架构：维持模式 C，把"能力膨胀"压在 Skill 上而非 tool 上

当前 `builtinTools.ts`（Edit / Glob / Grep / TodoWrite / AskUserQuestion / ArtifactCreate）+ `skillToolProvider.ts` 单一统一 Skill 工具的设计是**正确的方向**。继续维持底层工具 ≤ 20 的硬约束。具体规则：

- **新增业务能力默认做成 Skill**，不要做成 tool。Tools 数组改一次，全部 per-user 会话的 tools 段缓存失效；Skill 改文件不破坏 tools 段。
- 仅当能力满足三条全部条件时才升格为 tool：(a) 极高频（≥ 每会话 5 次调用），(b) 参数 schema 严格（必须 JSON Schema 校验），(c) 跨 Skill 共享（被多个 Skill 反复调用）。Bash、Read、Edit、WebSearch 是这类的典型。
- 钉钉机器人 / Cron / 业务 API / 报表生成等业务能力，**全部做 Skill**。

### 8.2 SKILL.md 写法标准化

参考 OpenHands SDK v1 的 AgentSkills 格式：

```markdown
---
name: dingtalk-broadcast
description: Send a broadcast message to a DingTalk group. Triggers when
  user asks "广播 / 群发 / send to group X". Requires robot_id and group_id.
allowed-tools: ["Bash(curl:*)", "Read"]
when_to_use: User explicitly references a DingTalk group OR cron job firing.
---
# 调用方式
…正文按需引用 ./reference/dingtalk-webhook-schema.md
```

Frontmatter 字段建议直接对齐 [agentskills.io](https://agentskills.io) 规范（`name` / `description` / `when_to_use` / `allowed-tools` / `disallowed-tools` / `model` / `effort`），未来无缝迁移到 Codex CLI / Cursor / GitHub Copilot。

### 8.3 MCP server 管控：超过两个必接 Tool Search Tool

当前 `clientManager.ts` 按 username lazy-connect、命名 `mcp__server__tool`。建议：

- **MCP server ≤ 2 个**：直接挂 tools 数组，注意每个 MCP 启动后量 token 占用，>3K tokens 的优先做 defer。
- **MCP server ≥ 3 个**：在 `rawAgentLoop.ts` 加入 Tool Search Tool 配置：

```typescript
// server/src/agent/rawAgentLoop.ts
const requestBody = {
  model: "claude-opus-4-8",
  anthropic_beta: ["advanced-tool-use-2025-11-20"],
  system: instructions,                  // 来自 buildInstructions
  tools: [
    // 检索器：BM25 适合中文自然语言查询
    { type: "tool_search_tool_bm25_20251119", name: "tool_search" },
    // 高频底层工具不 defer
    ...builtinTools,
    { ...skillTool },
    // MCP 工具全部 defer
    ...mcpTools.map(t => ({ ...t, defer_loading: true })),
  ],
  messages: [...]
};
```

预期效果：tools 段 token 从当前的 ~46K（假设全开 GitHub MCP 风格）降至 ~5K；Opus 4.5 tool selection 准确率从约 79% 提升到 88% 量级。

### 8.4 Prompt cache 配置：在 system 末尾设 1h breakpoint

参考第 4 节失效矩阵，KY Agent 的 system prompt 拼接（static.md → dynamic.md → `<available-skills>` → runtime-mcp.md → runtime-memory.md → availableHandsPrompt）存在严重的缓存失效风险——`runtime-memory.md` 和 `runtime-mcp.md` 因 user 维度变化导致整个 system 段每次重写。建议重排：

```
[稳定层 — 可缓存] static.md → dynamic.md → <available-skills>
                  ↑ 这里设 cache_control: {type: "ephemeral", ttl: "1h"}
[动态层 — 不缓存] runtime-mcp.md → runtime-memory.md → availableHandsPrompt
```

**注意 1h TTL 写溢价是 2×，仅对单用户会话长度 > 5min 的场景开启**（KY Agent 的对话型场景大多满足）。监控指标：响应里 `cache_read_input_tokens / total > 0.6` 为健康。

### 8.5 Skill 数量膨胀后的中长期路径

按 Skill 总数分阶段：

- **N ≤ 50**（当前）：维持 `<available-skills>` 块全量注入 frontmatter。Token 成本 ~5K，可接受。
- **50 < N ≤ 200**：引入 Skill 索引机制——把所有 Skill 的 frontmatter 做语义嵌入，按 user query 动态注入 Top-30 进 system prompt。这相当于 Tool Search Tool 的 Skill 版本。
- **N > 200**：引入"Skill of Skills"——一个 router Skill 负责调度其他 Skill，模型只看见 router。这是 Anthropic 在 [Building Effective Agents](https://www.anthropic.com/research/building-effective-agents) 中提到的 Orchestrator-Workers 模式。

### 8.6 多用户隔离层：Skill 可见性与 ACL

利用现有 `~/workspace/{username}/` 物理隔离，扩展 Skill 加载逻辑：

```
扫描顺序（按优先级）：
1. ~/workspace/{username}/.claude/skills/   ← user 专属
2. workspace-shared/.claude/skills-pool/    ← tenant 共享
3. ~/.claude/skills/                        ← 全局（管理员）
```

Skill frontmatter 加 `visible_to: ["role:admin"]` 字段，由 `buildInstructions` 时根据当前 user 的 role 过滤。这让"VIP 客户专属 Skill"成为零代码运维操作。

### 8.7 评测：建立 tool-selection 基线

参考 OpenAI cookbook 建议，**每次新增 Skill 必须跑 eval**。建议在 `server/evals/skill-selection/` 下维护：

- 真实用户 query → 期望调用的 Skill 名单（人工标注）
- 跑批：对每条 query 让 Agent 跑一遍，记录实际调用的 Skill
- 指标：Top-1 准确率、Top-3 召回率、平均 token 占用
- CI 接入：准确率回归 > 5pp 阻塞合并

**Skill 数 ≥ 100 后必须做**，否则膨胀失控。

### 8.8 不要做的事情

- **不要把 Cron / 钉钉 / WebSearch 等高频工具继续做成 Skill 后又试图"用 tool_choice 强制选 Skill"**——这把模式 C 退化成模式 D 的劣化版。
- **不要在 system prompt 里用"CRITICAL: You MUST ALWAYS use this Skill!!!"**——Anthropic 4.6 之后这种过激语气反而 overtrigger。
- **不要让多 MCP server 直接平铺**——单 server > 3K tokens 必接 Tool Search Tool。
- **不要在 tools 数组里加时间戳 / username / robotId**——任何一个变化就 100% 缓存失效，全部应在 user turn 注入。

### 8.9 长期：考虑模式 G

如果业务侧出现"取 1000 条钉钉消息然后做统计""分析整个工作区文件并生成报表"这类场景，把数据处理移到 `code_execution_20260120` 沙箱里，model 只看摘要——预计可省 90%+ tokens。这是 Anthropic 在 Sonnet 4.5+ / Opus 4.8 时代主推的方向。短期不必动，但要在路线图上留位置。

---

## 9. 参考资料

### Anthropic 官方
- [Advanced Tool Use — Tool Search / Programmatic Tool Calling / Tool Use Examples (2025-11-24)](https://www.anthropic.com/engineering/advanced-tool-use)
- [Tool Search Tool docs](https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool)
- [Programmatic Tool Calling docs](https://platform.claude.com/docs/en/agents-and-tools/tool-use/programmatic-tool-calling)
- [Equipping agents for the real world with Agent Skills (2025-10-16)](https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills)
- [Effective context engineering for AI agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
- [Building Effective Agents](https://www.anthropic.com/research/building-effective-agents)
- [Prompt caching (cache invalidation matrix)](https://platform.claude.com/docs/en/docs/build-with-claude/prompt-caching)
- [Skill authoring best practices](https://docs.claude.com/en/docs/agents-and-tools/agent-skills/best-practices)
- [Anthropic Cookbook — Skills introduction](https://platform.claude.com/cookbook/skills-notebooks-01-skills-introduction)

### OpenAI 官方
- [OpenAI Function Calling Guide](https://developers.openai.com/api/docs/guides/function-calling)
- [OpenAI o3 / o4-mini function calling guide](https://developers.openai.com/cookbook/examples/o-series/o3o4-mini_prompting_guide)
- [Simon Willison — OpenAI are quietly adopting skills (2025-12-12)](https://simonwillison.net/2025/Dec/12/openai-skills/)

### 跨平台标准
- [agentskills.io — Open standard (2025-12)](https://agentskills.io)
- [SwirlAI Newsletter — Agent Skills: Progressive Disclosure as a System Design Pattern](https://www.newsletter.swirlai.com/p/agent-skills-progressive-disclosure)
- [Firecrawl — Agent Skills Explained: How SKILL.md Files Work and Why They're Everywhere](https://www.firecrawl.dev/blog/agent-skills)

### 基准与论文
- [BFCL V4 leaderboard](https://gorilla.cs.berkeley.edu/leaderboard.html)
- [BFCL V4 — Format Sensitivity blog](https://gorilla.cs.berkeley.edu/blogs/17_bfcl_v4_prompt_variation.html)
- [MCPVerse (arXiv:2508.16260)](https://arxiv.org/html/2508.16260v1)
- [RAG-MCP (arXiv:2505.03275)](https://arxiv.org/abs/2505.03275)
- [LiveMCPBench (arXiv:2508.01780)](https://arxiv.org/pdf/2508.01780)
- [MCP-Bench (arXiv:2508.20453)](https://arxiv.org/pdf/2508.20453)
- [MCPMark (arXiv:2509.24002)](https://arxiv.org/pdf/2509.24002)
- [OpenHands SDK paper (arXiv:2511.03690)](https://arxiv.org/html/2511.03690v2)

### 框架源码与文档
- [LangChain & LangGraph 1.0 GA announcement](https://www.langchain.com/blog/langchain-langgraph-1dot0)
- [LangChain MCP adapters](https://github.com/langchain-ai/langchain-mcp-adapters)
- [Dify v1.6.0 Built-in Two-Way MCP](https://dify.ai/blog/v1-6-0-built-in-two-way-mcp-support)
- [Cline GitHub](https://github.com/cline/cline)
- [Roo Code Native vs XML tool protocols (DeepWiki)](https://deepwiki.com/RooCodeInc/Roo-Code/6.2-tool-protocols-(native-and-xml))
- [RFC: Native tool use for top-tier AI models (Roo Code #4047)](https://github.com/RooCodeInc/Roo-Code/issues/4047)
- [OpenHands SDK blog](https://openhands.dev/blog/introducing-the-openhands-software-agent-sdk)
- [smolagents — Code agents](https://huggingface.co/learn/agents-course/en/unit2/smolagents/code_agents)
- [HuggingFace — CodeAgents + Structure](https://huggingface.co/blog/structured-codeagent)

### 实战分析与社区
- [Waleed Kadous — The Evolution of AI Tool Use: MCP Went Sideways](https://waleedk.medium.com/the-evolution-of-ai-tool-use-mcp-went-sideways-8ef4b1268126)
- [Stacklok — MCP Optimizer vs Anthropic's Tool Search Tool head-to-head](https://stacklok.com/blog/stackloks-mcp-optimizer-vs-anthropics-tool-search-tool-a-head-to-head-comparison/)
- [Anthropic Just Solved AI Agent Bloat — 150K tokens to 2K (Code Execution with MCP)](https://medium.com/ai-software-engineer/anthropic-just-solved-ai-agent-bloat-150k-tokens-down-to-2k-code-execution-with-mcp-8266b8e80301)
- [Claude Code Skills: Progressive Disclosure (Daniel Avila)](https://medium.com/@dan.avila7/claude-code-skills-progressive-disclosure-step-by-step-3ca02a4a9f60)
- [Skills aren't about prompts, they're about context design](https://dev.to/akdevcraft/skills-in-claude-arent-about-prompts-theyre-about-context-design-46hf)
- [Too many MCP tools make agents worse](https://dev.to/deathsaber/too-many-mcp-tools-make-agents-worse-heres-how-i-fixed-it-44n2)
- [Stop polluting context — let users disable individual MCP tools](https://smcleod.net/2025/08/stop-polluting-context-let-users-disable-individual-mcp-tools/)
