# Tools / Skills / MCP 注入 LLM API 的具体模式横向对比

> 这是工作流 Research 阶段（discover + adversarial verify）的完整原始调研报告。已经被合成进 `../01-04` 系列文档，这里保留全文便于深入考据。

---

I now have everything needed. Let me write the expanded report.

# 把"能力清单"传给 LLM 的六种模式：横向对比与实战取舍

> 调研截止 2026-06-20，涵盖 Anthropic / OpenAI 官方文档、BFCL V4 / MCPVerse / RAG-MCP / LiveMCPBench / MCPMark 基准、Cline / Roo Code / smolagents 源码与社区讨论。
> **[补充] 本轮核验后大幅修订**：补入 Anthropic 2025-11-20 发布的 *Advanced Tool Use*（Tool Search Tool / Programmatic Tool Calling / Tool Use Examples）、Skills 在 2025-10-16 的正式发布与 2025-12-18 升级为 *Open Standard*（agentskills.io）、OpenAI 在 Codex CLI 中跟进 skills 的事实，以及 2025 下半年的 *Code Execution with MCP*（98% token reduction）模式。

## 0. 为什么这是个值得严肃对待的问题

"把能力清单交给模型"看似只是 API 调用细节，实际上是 Agent 系统设计中最重要的**架构分叉点**之一。它牵动四条主线：

1. **精度** — 工具越多，模型选错率越高。RAG-MCP 基准显示，候选工具池放大到数千量级时，Top-1 准确率从 87.4% 降至 65% 左右（[RAG-MCP, arXiv:2505.03275](https://arxiv.org/abs/2505.03275)）。**[修正]** arXiv 摘要中可被直接核实的数字是 *"more than triples tool selection accuracy (43.13% vs 13.62% baseline)"* 以及 *">50% prompt token reduction"*；500/1000/2000 三档曲线是论文正文中的"stress test"数据，引用时应注明出自正文而非摘要。MCPVerse 进一步指出弱模型对工具规模极其敏感，而强 agentic 模型（Claude-4-Sonnet、o3、gpt-5）相对稳定；并且 **Anthropic 官方 [Tool Search Tool 文档](https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool) 直接给出经验阈值："Claude 在超过 30–50 个工具后，选择准确率显著下降"**（[MCPVerse, arXiv:2508.16260](https://arxiv.org/html/2508.16260v1)）。
2. **Token 成本** — GitHub MCP 单独就吃掉 46K tokens；**[补充] Anthropic 官方数据**：典型五服务器（GitHub / Slack / Sentry / Grafana / Splunk）组合在用户尚未输入第一个字符前就要烧掉 ~55K tokens；Jira MCP 单独 ~17K tokens；他们见过的极端案例是 134K tokens 全部用于工具定义（[Advanced tool use, Anthropic](https://www.anthropic.com/engineering/advanced-tool-use)）。
3. **Prompt cache 命中率** — Anthropic 缓存层级是 `tools → system → messages`。**[补充/核验] 官方最新表格** 明确：修改 *tool definitions* 会一次性废掉 tools / system / messages 三层；切换 *web_search / citations / speed* 只废 tools；切换 *tool_choice / images* 废 tools + system 但保留 messages 缓存（[Prompt caching docs](https://platform.claude.com/docs/en/docs/build-with-claude/prompt-caching)）。1 小时 TTL 的 cache write 溢价是 **2×**（而 5 分钟版本只有 1.25×），cache hit 都是 0.1×。
4. **可观测 / 可治理** — 原生 function call 有结构化日志、可在网关层 RBAC；纯 prompt 描述的工具调用要靠自家解析器，鉴权和追踪都得自己造。

下面六种模式，本质是在"上下文成本 / 精度 / 表达力 / 工程治理"这四维空间里选不同的点。**[补充] 新增模式 G**：Code Execution with MCP（Anthropic 2025-11 主推），在文末第 6.5 节单列。

---

## 1. 六种模式总览

### 模式 A — Function Calling tools 数组（原生最小描述）

把工具名 + JSON Schema 通过 API 的 `tools` 字段传入，描述精简到几句话。OpenAI / Anthropic 都把它当作"快乐路径"。

```python
# OpenAI / Anthropic 通用结构
tools = [{
    "name": "get_weather",
    "description": "Get current weather for a city.",
    "input_schema": {
        "type": "object",
        "properties": {"city": {"type": "string"}},
        "required": ["city"]
    }
}]
client.messages.create(model="claude-opus-4-7", tools=tools, ...)
```

**特点**：模型走训练过的 `tool_use` 通路，参数有 JSON Schema 校验，流式 partial JSON 解析有 SDK 支持。**[补充]** Anthropic 在 2025-11 加入 *strict tool use* 模式：传 `strict: true` 后参数生成走语法约束解码，schema 不符的输出在模型侧就被截断。Tool Search Tool 文档特别说明：strict mode 与 `defer_loading` 可组合，因为约束语法基于完整 toolset 编译，不需重新编译。

### 模式 B — System Prompt 文本描述（自然语言 / XML / Markdown）

不使用 API 的 tools 字段，把工具清单写进 system prompt。Cline 2023-2025 主线、早期 Roo Code、AutoGPT、BabyAGI、绝大多数自研 Agent 用的都是这种。

```xml
<!-- Cline / 早期 Roo Code 风格（节选） -->
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
...
```

模型在回复中直接输出 `<read_file>...</read_file>`，宿主程序用正则/状态机解析。

**[补充] BFCL V4 Format Sensitivity 新发现**（Berkeley 2025）：相同函数调用任务，按 Python / JSON / XML 三种语法分别 prompt，**强模型在三种格式间差异 ≤ 2pp，弱模型 (≤ 14B) 可以差 15-25pp**，且 XML 在 ≤ 7B 模型上反而是最差的语法，颠覆了"XML 对小模型友好"的旧经验（[BFCL V4 Format Sensitivity blog](https://gorilla.cs.berkeley.edu/blogs/17_bfcl_v4_prompt_variation.html)）。

### 模式 C — 混合：单一统一入口 tool + system prompt 名单（Claude Code Skills）

API 层只暴露极少数底层工具（Read / Write / Bash / Skill / WebSearch …），高层"能力"（Skill / Subagent / Slash Command）只通过 system prompt 露出 `name + description` 两行 frontmatter，正文按需用 Read 工具拉取。这是 Claude Code 的当家做法。

```markdown
<!-- skills/pdf-form-fill/SKILL.md 仅 frontmatter 进入上下文 -->
---
name: pdf-form-fill
description: Fill PDF AcroForm fields from structured data. Triggers when
  user uploads PDF + asks "fill this form".
---
# 正文：调用方法、字段映射、错误处理（不会进上下文，直到 Skill 被激活）
For complex field mapping see ./forms.md
...
```

上下文成本：每 Skill 启动期只占几十 tokens（**[修正] 官方原文是 ~100 tokens / skill 用于元数据扫描，激活后整 SKILL.md 加载控制在 <5K tokens**，引自 [Cookbook: Skills introduction](https://platform.claude.com/cookbook/skills-notebooks-01-skills-introduction)）；激活后模型用现有的 Read 工具按需展开。Anthropic 官方说法是 *"metadata is the first level of progressive disclosure"*（[Equipping agents with Agent Skills, 2025-10-16](https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills)）。

**[补充] 关键时间线**：
- **2025-10-16** Anthropic 正式发布 Agent Skills，附带 `claude-skills` SDK
- **2025-12-18** Skills 升级为 *open standard*，在 [agentskills.io](https://agentskills.io) 公开规范
- **2025-12-12** OpenAI 在 Codex CLI 中加入实验性 `skills.md` 支持，扫描 `~/.codex/skills/`（[Simon Willison 报道](https://simonwillison.net/2025/Dec/12/openai-skills/)）
- 这是 MCP 之后第二个被三大厂同时采纳的 agent 跨平台标准

### 模式 D — tools 数组 + 详细 description（"胖" function calling）

仍然走 API `tools` 字段，但每个 description 写成迷你说明书：用法、例子、错误处理、参数语义。GitHub MCP、典型企业 RPC 网关、Bedrock Agents 默认走这条。

```json
{
  "name": "create_issue",
  "description": "Create a new GitHub issue in a repository. Use when user explicitly asks to file a bug / track work.\n\nExamples:\n  - 'open an issue about the auth bug' -> repo=current, title='Auth bug'\n\nErrors:\n  - 403: caller lacks issues:write -> ask user to install GitHub App\n  - 422: title empty -> retry with non-empty title\n...",
  "input_schema": { ...20 properties... }
}
```

单工具 description 常常 500-2000 tokens，91 个工具的 GitHub MCP 整体 46K tokens。**[补充] Anthropic 在 2025-11 给出的标准缓解方案是 *Tool Use Examples***：把例子从 description 文本里剥离到结构化的 `input_examples` 字段，模型选择期不读，只在被调用时拉取——复杂参数场景准确率从 72% 提升到 90%（[Advanced tool use](https://www.anthropic.com/engineering/advanced-tool-use)）。

```jsonc
// Tool Use Examples（2025-11 beta）— 推荐替代"在 description 里塞例子"的旧做法
{
  "name": "create_issue",
  "description": "Create a GitHub issue. See examples for parameter shape.",
  "input_schema": { ... },
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

### 模式 E — MCP Server 集中代理（mcp__server__tool 命名空间或 flatten）

工具实现在远端 MCP server，宿主把列出的工具按 `mcp__<server>__<tool>` 命名空间挂入 tools 数组（Claude Code、Cursor、VS Code Copilot Chat 的做法）；或者用 RAG-MCP / Tool Search Tool 之类的检索层做动态加载。

```jsonc
// settings.json
{
  "mcpServers": {
    "github": { "command": "npx", "args": ["@modelcontextprotocol/server-github"] },
    "linear": { "command": "uvx", "args": ["mcp-linear"] }
  }
}
// runtime: tools = [...native, ...mcp_github_*, ...mcp_linear_*]
```

**[补充] 2025 下半年新基准全景**：
| 基准 | 规模 | 主要结论 |
|---|---|---|
| LiveMCPBench (arXiv:2508.01780) | 持续注入真实 MCP server，~2000 工具 | 即使顶级模型也存在 *retriever 命中率瓶颈* |
| MCP-Bench (arXiv:2508.20453) | 跨服务器复杂任务 | 多步骤跨服务编排是真实弱点，非单工具选择 |
| MCPToolBench++ (arXiv:2508.07575) | 大规模 | 工具描述质量比工具数量更关键 |
| MCPMark (arXiv:2509.24002) | 真实世界压力测试 | 长尾错误恢复是落地最大坑 |

### 模式 F — Code Agent（smolagents、Open Interpreter、CodeAct）

模型不输出 JSON，输出**Python 代码**。工具是 Python 函数，函数签名通过 system prompt 注入；执行器在沙箱里 exec 模型生成的代码。

```python
# smolagents
from smolagents import CodeAgent, Tool

class SearchTool(Tool):
    name = "web_search"
    description = "Search the web."
    inputs = {"query": {"type": "string", "description": "..."}}
    output_type = "string"
    def forward(self, query): ...

agent = CodeAgent(tools=[SearchTool(), ...], model=...)
agent.run("find 3 sources about X and summarize")
# 模型可能生成：
#   results = [web_search(q) for q in ["X site:a", "X site:b", "X review"]]
#   return summarize("\n".join(results))
```

CodeAct 论文 & smolagents 数据：相同任务**步数减少 ~30%**，难基准准确率更高（[smolagents code agents](https://huggingface.co/learn/agents-course/en/unit2/smolagents/code_agents)）。**[补充] 2025 末新发现**：HuggingFace 团队后续博客 [CodeAgents + Structure](https://huggingface.co/blog/structured-codeagent) 指出 *纯自由文本代码 + 结构化 JSON action 字段* 的混合形态比纯代码再增一截，这是对原始 CodeAct 范式的小修正。

---

## 2. 关键定量证据

### 2.1 BFCL / MCPVerse / RAG-MCP / Tool Search Tool 给出的硬数据

**[修正/补充] 加入 2025-11 Anthropic 官方数据 + BFCL V4 (memory / format sensitivity) 数据**：

| 来源 | 设置 | 结论 |
|---|---|---|
| BFCL V4 ([Berkeley 2025](https://gorilla.cs.berkeley.edu/leaderboard.html)) | 三部曲：Agentic Web Search、Memory、Format Sensitivity；不再只是单 turn | 强模型在 Python/JSON/XML 三种语法间差异 ≤ 2pp；≤ 14B 模型可差 15-25pp |
| MCPVerse | **552 真工具 / 65 MCP / 140K+ tokens 动作空间**（核验后修正） | Claude-4-Sonnet 在 prompt-based function call 下幻觉率 *exceeding 70%*；原因是 *"a substantial mismatch between the function-calling templates in our prompt and those from the model's original training"*（[MCPVerse §3](https://arxiv.org/html/2508.16260v1)） |
| RAG-MCP | 工具池压力测试 | Top-1 选择准确率 *43.13% vs 13.62% baseline*（>3×）；prompt tokens >50% 降 |
| Anthropic Tool Search Tool 官方 benchmark (2025-11) | 完整 MCP toolset → Tool Search | **Opus 4: 49% → 74%；Opus 4.5: 79.5% → 88.1%**；token 占用 -85%，相当于把可用 context 从 122,800 → 191,300 tokens |
| Programmatic Tool Calling | 复杂研究任务 | 平均 token 43,588 → 27,297（**-37%**）；GIA benchmarks 46.5% → 51.2% |
| Code Execution with MCP | 多工具数据处理 | 极端案例 **150K tokens → 2K tokens，~98.7% 降**（[Anthropic blog 转述](https://medium.com/ai-software-engineer/anthropic-just-solved-ai-agent-bloat-150k-tokens-down-to-2k-code-execution-with-mcp-8266b8e80301)） |
| 实测（Scott Spence 等） | GitHub MCP 全开 | 91 工具 = 46K tokens，对话框未输入一字即占 Sonnet/Opus 4 窗口 ~23% |

### 2.2 厂商官方的"工具数上限"

**[修正]** 加入 Anthropic Tool Search 文档明确给出的 30–50 阈值；OpenAI 部分保持不变。

| 厂商 | 硬上限 | 软建议 | 出处 |
|---|---|---|---|
| OpenAI | 128 tools / request | "**aim for < 20** at any one turn"；o3/o4-mini "in-distribution" < 100 tools 且每工具 < 20 args | [OpenAI Function Calling Guide](https://developers.openai.com/api/docs/guides/function-calling) |
| Anthropic | Tool Search 上限 **10,000 tools / catalog** | **30–50 是裸 tools 数组的选择精度断崖**；超过即推荐 Tool Search Tool + `defer_loading: true` | [Tool Search Tool docs](https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool) |
| 通用经验 | — | 单工具 description ≤ 500 tokens；总 tools < 8K tokens 时缓存收益最高 | [Tool calling best practices](https://medium.com/@laurentkubaski/tool-or-function-calling-best-practices-a5165a33d5f1) |

### 2.3 Prompt cache 的工具数组放大效应

**[补充/核验]** Anthropic 的 prefix cache 顺序固定：`tools → system → messages`。官方最新「失效矩阵」：

| 变更 | tools 缓存 | system 缓存 | messages 缓存 |
|---|---|---|---|
| Tool definitions | ✘ | ✘ | ✘ |
| Web search toggle | ✓ | ✘ | ✘ |
| Citations toggle | ✓ | ✘ | ✘ |
| Tool choice | ✓ | ✓ | ✘ |
| Images / thinking 参数 | ✓ | ✓ | ✘ |

这意味着：

- 模式 D / E（胖 tools 或 MCP flatten）每次新增/删除工具都付完整的 25%（5m TTL）或 100%（1h TTL）写入溢价；
- 模式 C（Skills）只把 frontmatter 写一次到 system，SKILL.md 正文经由 `Read` 工具按需加载到 messages 末段，messages 缓存命中率高、tools 数组稳定不变；
- **[补充] Tool Search Tool 的 `defer_loading: true`** 是这条规则的特殊豁免：官方文档原文 *"Deferred tools are not included in the system-prompt prefix… The prefix is untouched, so prompt caching is preserved."* 也就是说，模式 E 加 Tool Search 后能拿回模式 C 同等的缓存友好度。

这是 Claude Code 选 C 的最被低估的工程理由：**缓存友好**。

---

## 3. 横向对比表

**[补充] 第 G 列**：Code Execution with MCP（详见 §6.5）。

| 维度 | A 原生 tools 精简 | B System Prompt 文本 | C 混合（Skills） | D 胖 tools | E MCP 集中代理 | F Code Agent | **G Code Exec + MCP [补充]** |
|---|---|---|---|---|---|---|---|
| 推荐工具数上限 | ≤ 20 | 5-15 | 底层 ≤ 15；Skills 数千 | ≤ 50 | + Tool Search 可上万 | 5-30 函数 | 与 E 同，但调用聚合在沙箱里 |
| 单工具 token | 50-150 | 100-300 | 底层 100；Skill metadata ~100 | 500-2000 | 同 D，乘以 N server | 80-200 函数签名 | 同 E；运行时不进上下文 |
| Prompt cache 友好度 | 高 | 中 | **最高** | 低 | 最低（无 defer）/高（加 defer）| 高 | 高 |
| 结构化解析 | 原生 | 自家 XML/正则 | 原生 + 文件读取 | 原生 | 原生 | exec Python | exec + tool_result 双轨 |
| 表达力 | 中 | 中 | 高 | 中 | 中 | **最高** | **最高**（代码 + 异构 MCP）|
| 错误恢复 | tool_result 链路 | prompt 重试 | A + Skill 自带 fallback | A | 网络多一跳 | 异常自动捕获 | 沙箱异常 + tool_result |
| 鉴权 / 审计 | API 层 | 自家解析 | 顶层 tool 收口 + 文件系统权限 | API 层 | 网关 RBAC | 沙箱进程级 | 网关 + 沙箱双层 |
| 模型适配 | 强模型 | 弱模型 / XML 偏好 | 仅强 Claude 验证最佳 | 任意 | 任意 | 强代码模型 | Claude 4.5+ 专用 |
| 调试 / 可观测 | 中 | 差 | 好 | 中 | 好 | 好 | 好（代码 trace + MCP log）|
| 安全性 | 高 | 中 | 高 | 高 | 中 | **需重沙箱** | 同 F，沙箱必需 |
| 扩展到 1000+ 能力 | 不行 | 不行 | 适合 | 不行 | 配 Tool Search/RAG 适合 | 适合 | **最适合** |
| 典型代表 | OpenAI Assistants v1 | Cline、AutoGPT、Aider | **Claude Code**、Cursor Skills、Codex CLI | Bedrock Agents、GitHub MCP 默认 | Cursor MCP、VS Code Copilot Chat | smolagents、Open Interpreter | Claude Agent SDK 2025-11+ |

---

## 4. 为什么 Claude Code 选 C 而不是 D？

这是本调研的核心问题之一。综合官方博客 + Anthropic 工程师在 [HN/Reddit 上的解释](https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills) + Claude Code 源码可以归纳出五条理由：

**1. Token 经济学 — 1 个 Skill 启动期 ≈ 100 tokens；同一能力做成 tool 至少 500 tokens。** **[修正]** 不要再引用早期博客文里"30-60 tokens"的旧数字，官方 cookbook 给出的实测值是 *"each skill uses only ~100 tokens during metadata scanning to determine relevance"*。Dotzlaw 的实测："启动期 500 tokens 索引 vs 全量加载 ~70K tokens" 仍然成立。换成模式 D，500 个 Skill 直接把窗口塞满。

**2. Prefix Cache 不被破坏。** tools 数组是缓存最敏感的一层。Skill 列表写在 system prompt 里、内容写在文件里，**新增/修改 Skill 不会让 tools 段重写**，长会话的 message-prefix 缓存仍然命中。

**3. Tool selection 准度。** OpenAI 自己也说"实际 > 20 个就掉点"，Anthropic Tool Search 文档明示 30–50 是断崖。Anthropic 把 Claude Code 的"底层工具"压在 ~15 个（Read / Write / Edit / Bash / Grep / Glob / WebSearch / WebFetch / TodoWrite / Skill …），让模型在每一步面对的"硬选择"始终是个位数。Skill description 走的是**语义路由**，不是 tool_choice 的概率分布，本质是一次廉价的"软分类"，错了也可以靠模型继续推理。

**4. 渐进式披露 (Progressive Disclosure) 是上下文工程的核心范式。** Anthropic 在 [Effective context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents) 里把它和 CLAUDE.md / grep+glob "just-in-time" 并列为三大原则：**不把"可能需要"的信息预先塞满，而是给模型钥匙让它按需开门**。Skill 是这套范式的完美载体——frontmatter 是钥匙，正文是抽屉，reference 文件是档案柜。

**5. 治理与可移植性。** Skill 是普通 Markdown 文件，可以 git 管理、可以非工程师写、不需要重新部署 Agent。模式 D 要新增能力必须改 tools 注册，再跑 eval 检查它不打架。Skills 的"加文件就生效"对企业内推广至关重要。

**[补充] 6. 跨平台标准化红利。** 2025-12 之后 Skills 成为 open standard，OpenAI Codex CLI、Cursor、GitHub Copilot 已经或正在跟进，意味着同一份 SKILL.md 可以零改动部署到多家 host。这对模式 D（每家厂商 tool schema 不兼容）是结构性优势。

反例校验：哪些场景 Claude Code 反而走 D？— Bash、Read、Edit 这类**高频、强参数、需要严格 schema 校验**的底层工具就是模式 D。可以看作：**"动词 = tool（少而硬），名词/工作流 = skill（多而软）"**。

---

## 5. 为什么 Cline / 早期 Roo Code 用 XML（模式 B）而不是 function calling？

这是另一个被反复讨论的设计取舍。综合 [Roo Code DeepWiki](https://deepwiki.com/RooCodeInc/Roo-Code/6.2-tool-protocols-(native-and-xml)) + [native_tool_call_adapter 仓库](https://github.com/irreg/native_tool_call_adapter) + RFC #4047 讨论：

**1. 历史原因 — 兼容性优先**。Cline 启动时（2023 末）GPT-3.5 / GPT-4 早期、Mistral、Llama-2、Deepseek-Coder 等大量模型要么没 function calling，要么实现不稳。XML 标签是预训练语料的"母语"，**任意模型几乎都能模仿**。这让 Cline 一份 prompt 跑遍所有 provider。

**2. 流式可逐步执行**。XML 标签可以**边解析边执行**：解析到 `</read_file>` 立刻执行，不等响应结束。早期 function calling SDK 的 partial JSON 支持很差，必须等响应结束才能拿到完整 JSON。

**3. 多工具交错与可读性**。XML 文本能和自然语言推理交错，模型能在同一段输出里"想 → 调用 → 想 → 调用"，对人也好读、好审查。

**4. 失败代价**。Roo Code 工程师后来在 RFC #4047 中承认："**XML calling 在强模型上仍有约 10% 失败率**——多嵌套标签、转义错误、调用嵌在 markdown code fence 里之类的边缘 case。" 这是为什么 Roo Code 3.35 起改成原生 tool_use。

**5. 当前共识（2026 年中）**：
- 强模型（Claude 4+、GPT-5、Gemini 2.5+）— 走原生 `tool_use`，失败率 < 1%；
- 弱模型、开源小模型 — **[修正]** BFCL V4 Format Sensitivity 推翻了"小模型用 XML 更稳"的旧经验：≤ 7B 模型上 XML 反而是三种语法里最差的，应优先 Python 语法或 JSON；
- Cline 主线已经引入 [native_tool_call_adapter](https://github.com/irreg/native_tool_call_adapter)，在 Claude/Claude Code 后端把 XML 转译成原生 tool_use。

回到 MCPVerse 的发现："Claude-4-Sonnet 在 prompt-based function call 下幻觉率 > 70%"——这恰好印证强模型应**走原生通路**，弱模型才应"将就 XML"。

---

## 6. Smol Agents / CodeAct 为什么单独成派？

模式 F 的关键洞察来自 [Executable Code Actions Elicit Better LLM Agents](https://huggingface.co/learn/agents-course/en/unit2/smolagents/code_agents)：**LLM 的训练语料里 Python 远多于 JSON tool-call 协议**，让模型"用代码思考"反而是顺势而为。

数据：相同任务步数**省 ~30%**，难基准更高分。原因：

- **控制流**：JSON tool calling 表达不了 `for / if / try`；要循环 10 次只能让模型发起 10 次往返。代码一次 exec 完事。
- **变量复用**：JSON 模式每次工具返回必须进上下文才能再用；代码模式中间变量留在解释器里。
- **组合性**：嵌套调用 `summarize(web_search(translate(q)))` 一行写完。

代价：**任意代码执行就是任意代码执行**。沙箱必须重，企业部署常常因合规否决。

### 6.5 [补充] 模式 G — Code Execution with MCP（Anthropic 2025-11 主推）

这是 Anthropic 在 2025 年下半年正面回应"MCP 工具定义吃光上下文"问题给出的"官方推荐答案"，可以理解为 **模式 F 套在模式 E 上的合规化版本**。核心思路：

1. MCP server 的工具不进入 LLM 上下文，**而是导出为代码执行容器里的 Python/TypeScript SDK 函数**；
2. Claude 接到任务后，写一段调用这些 SDK 的代码，扔到 `code_execution_20260120` 容器里跑；
3. 中间结果（可能是 100MB 的 JSON）**留在沙箱**，只把最终摘要 / 必要字段 return 回 model；
4. 工具元数据 + 代码模板用上面的 Tool Search Tool 按需检索。

```python
# Claude 生成的代码片段示例（在沙箱里执行，model 看不到原始 100K tokens 输出）
issues = await github.list_issues(repo="kaiyan-tech/agent-saas", state="open", per_page=100)
recent = [i for i in issues if i.updated_at > "2026-06-01"]
labels = collections.Counter(l for i in recent for l in i.labels)
return {"open_count": len(recent), "top_labels": labels.most_common(5)}
```

实测数据：极端案例 **150K → 2K tokens（~98.7% 降）**，复杂研究任务平均 43,588 → 27,297（[Anthropic Advanced tool use blog](https://www.anthropic.com/engineering/advanced-tool-use)）。这是为什么 Claude Code 把"代码执行"包进一个**单一受控工具**（Bash + 可选 sandbox 容器），而不是把整个 Agent 改成 CodeAct 形态——既享受"代码即动作"的表达力，又保留 tool-use 协议的可观测与权限边界。

---

## 7. 选型决策树

**[修正]** 在原决策树中明确补入 Tool Search / Code Execution 分支：

```
是否单一垂直场景、工具 ≤ 20？
├─ 是 → 模式 A（OpenAI / Anthropic 原生 tools，精简 description）
└─ 否
   ├─ 工具数 20-50，描述需详细？
   │   └─ 模式 D + Tool Use Examples 字段（关 cache_control 在末尾，evals 跑足）
   ├─ 工具数 50-500，需要可扩展、非工程师可维护？
   │   └─ 模式 C（Claude Code Skills：少量底层 tool + filesystem skill 索引）
   ├─ 工具数 500-10,000 或多 MCP server？
   │   └─ 模式 E + Anthropic Tool Search Tool (defer_loading: true)
   │       beta header: advanced-tool-use-2025-11-20
   │       tool type: tool_search_tool_regex_20251119 / _bm25_20251119
   ├─ 需要在多工具间做数据 pipeline / 减少 model 来回？
   │   └─ 模式 G（Code Execution with MCP），合规要求高场景的首选
   ├─ 需要复杂控制流 / 重计算 / 数据处理 pipeline 且可自建沙箱？
   │   └─ 模式 F（smolagents / Open Interpreter）
   └─ 模型偏弱 / 多 provider / 不能依赖 function calling？
       └─ 模式 B：≤7B 模型优先 Python 语法，避免 XML；接受 ~10% 失败率
```

---

## 8. 给 KY Agent（本项目）的具体建议

基于 CLAUDE.md 描述的现状（Express + Claude Code agent 子进程、`workspace-shared/.claude/skills-pool/` 已存在）：

1. **顶层架构维持 C 模式**。底层工具集（Read / Write / Edit / Bash / WebSearch / Skill / TodoWrite / 业务专属 API）控制在 ≤ 20。已有的 skills-pool 是正确方向，继续做 SKILL.md frontmatter + 正文分离。
2. **钉钉/Cron/Per-user workspace 等业务能力做成 Skill，不要做成 tool**。原因：tools 数组改一次，全部 per-user 会话的 tools 段缓存失效；Skill 改文件不破坏 tools 段。
3. **[修正] MCP server 谨慎放进来，超过两个就必接 Tool Search Tool**。每接一个 MCP server 先量 token 占用，>3K tokens 的考虑用 Tool Search Tool + `defer_loading: true` 包一层。把 GitHub / 钉钉 / Linear / DB 这类大工具集统一走 BM25 变体（更适合中文自然语言查询）：

```jsonc
// server/agent/tools.ts 建议增加的配置示例
{
  "anthropic_beta": ["advanced-tool-use-2025-11-20"],
  "tools": [
    { "type": "tool_search_tool_bm25_20251119", "name": "tool_search" },
    // 高频工具不 defer
    { "name": "Read", ...},
    { "name": "Bash", ...},
    { "name": "Skill", ...},
    // 低频 MCP 全部 defer
    { "name": "github_create_issue", ..., "defer_loading": true },
    { "name": "dingtalk_send_group", ..., "defer_loading": true },
    // ... 数百个 MCP 工具
  ]
}
```

4. **针对长会话写 evals**。Anthropic 官方建议生成"几十组 prompt/response 对"，跑 held-out 测试集。建议放在 `server/evals/`，每次新增 Skill 跑一遍 tool-selection 准度。
5. **[修正] 配置 prompt cache，1h TTL 是 per-user 长会话的关键**。在 system prompt 末尾、tools 数组最后一个工具加 `cache_control: {type: "ephemeral", ttl: "1h"}`。注意：1h TTL 的 write 溢价是 **2×（不是 1.25×）**，所以只对 *单用户会话长度 > 5min* 的场景开启。
6. **[补充] 关注 Skills 跨平台标准**。2025-12 升级 open standard 之后，把 `workspace-shared/.claude/skills-pool/` 的内容做成 `agentskills.io` 规范兼容格式，未来切换 Codex CLI / Cursor 作为执行器时零迁移成本。
7. **[补充] 长期：考虑模式 G**。如果业务侧出现"取 1000 条钉钉消息然后做统计"这类场景，把数据处理移到 `code_execution_20260120` 沙箱里，model 只看摘要——可省 90%+ tokens。

---

## Sources

**[补充]** 标注新增 (★) 与核验通过 (✓) 的链接。

### 一手官方
- ✓ [Anthropic — Writing effective tools for AI agents](https://www.anthropic.com/engineering/writing-tools-for-agents)
- ✓ [Anthropic — Effective context engineering for AI agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
- ✓ [Anthropic — Equipping agents for the real world with Agent Skills (2025-10-16)](https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills)
- ★ [Anthropic — Introducing advanced tool use on the Claude Developer Platform (2025-11-24)](https://www.anthropic.com/engineering/advanced-tool-use)
- ★ [Anthropic Docs — Tool Search Tool (regex + BM25 + defer_loading)](https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool)
- ★ [Anthropic Docs — Programmatic Tool Calling](https://platform.claude.com/docs/en/agents-and-tools/tool-use/programmatic-tool-calling)
- ★ [Anthropic Cookbook — Programmatic Tool Calling (PTC)](https://platform.claude.com/cookbook/tool-use-programmatic-tool-calling-ptc)
- ★ [Anthropic Cookbook — Skills introduction](https://platform.claude.com/cookbook/skills-notebooks-01-skills-introduction)
- ✓ [Anthropic — Tool use overview](https://docs.anthropic.com/en/docs/agents-and-tools/tool-use/overview)
- ✓ [Anthropic — Prompt caching (cache invalidation matrix)](https://platform.claude.com/docs/en/docs/build-with-claude/prompt-caching)
- ✓ [Anthropic — Skill authoring best practices](https://docs.claude.com/en/docs/agents-and-tools/agent-skills/best-practices)
- ✓ [OpenAI — Function calling guide](https://developers.openai.com/api/docs/guides/function-calling)
- ✓ [OpenAI Cookbook — o3 / o4-mini function calling guide](https://developers.openai.com/cookbook/examples/o-series/o3o4-mini_prompting_guide)
- ★ [agentskills.io — Open standard (2025-12)](https://agentskills.io)

### 基准与论文
- ✓ [BFCL V4 leaderboard](https://gorilla.cs.berkeley.edu/leaderboard.html)
- ★ [BFCL V4 — Memory (blog)](https://gorilla.cs.berkeley.edu/blogs/16_bfcl_v4_memory.html)
- ★ [BFCL V4 — Format Sensitivity (blog)](https://gorilla.cs.berkeley.edu/blogs/17_bfcl_v4_prompt_variation.html)
- ✓ [BFCL paper (PMLR 2025)](https://proceedings.mlr.press/v267/patil25a.html)
- ✓ [MCPVerse benchmark (arXiv 2508.16260)](https://arxiv.org/html/2508.16260v1)
- ✓ [RAG-MCP paper (arXiv 2505.03275)](https://arxiv.org/abs/2505.03275)
- ★ [LiveMCPBench (arXiv 2508.01780)](https://arxiv.org/pdf/2508.01780)
- ★ [MCP-Bench (arXiv 2508.20453)](https://arxiv.org/pdf/2508.20453)
- ★ [MCPToolBench++ (arXiv 2508.07575)](https://arxiv.org/pdf/2508.07575)
- ★ [MCPMark (arXiv 2509.24002)](https://arxiv.org/pdf/2509.24002)
- ✓ [LongFuncEval (arXiv 2505.10570)](https://arxiv.org/pdf/2505.10570)
- ✓ [MCP-Zero: Active tool discovery (arXiv 2506.01056)](https://arxiv.org/pdf/2506.01056)

### 社区 / 实战博客（高质量被广泛引用）
- ★ [Simon Willison — OpenAI are quietly adopting skills (2025-12-12)](https://simonwillison.net/2025/Dec/12/openai-skills/) — **强烈推荐**，Simon 是 LLM 圈最早注意到 OpenAI 跟进 SKILL.md 的人，本文是该跨平台事件的权威记录
- ★ [SwirlAI Newsletter — Agent Skills: Progressive Disclosure as a System Design Pattern](https://www.newsletter.swirlai.com/p/agent-skills-progressive-disclosure) — 把 progressive disclosure 抽象成通用系统设计模式，引用量很高
- ★ [Waleed Kadous — The Evolution of AI Tool Use: MCP Went Sideways](https://waleedk.medium.com/the-evolution-of-ai-tool-use-mcp-went-sideways-8ef4b1268126) — Anyscale CTO 视角，对"MCP 工具爆炸"问题的犀利反思
- ★ [Stacklok — MCP Optimizer vs Anthropic's Tool Search Tool head-to-head](https://stacklok.com/blog/stackloks-mcp-optimizer-vs-anthropics-tool-search-tool-a-head-to-head-comparison/) — 第三方独立对比，含真实 latency / accuracy 数据
- ★ [HuggingFace — CodeAgents + Structure: A Better Way to Execute Actions](https://huggingface.co/blog/structured-codeagent) — CodeAct 的 2025 末进化版本
- ✓ [Stop polluting context — let users disable individual MCP tools (smcleod.net)](https://smcleod.net/2025/08/stop-polluting-context-let-users-disable-individual-mcp-tools/)
- ✓ [Too many MCP tools make agents worse (dev.to)](https://dev.to/deathsaber/too-many-mcp-tools-make-agents-worse-heres-how-i-fixed-it-44n2)
- ✓ [MCP and the "too many tools" problem (demiliani.com)](https://demiliani.com/2025/09/04/model-context-protocol-and-the-too-many-tools-problem/)
- ✓ [Anthropic ships fix for tool definition bloat (Deb Acharjee, Medium)](https://medium.com/@DebaA/anthropic-just-shipped-the-fix-for-tool-definition-bloat-77464c8dbec9)
- ✓ [Tool calling best practices (Laurent Kubaski, Medium)](https://medium.com/@laurentkubaski/tool-or-function-calling-best-practices-a5165a33d5f1)
- ✓ [How many tools can an AI agent have (Allen Chan, Medium)](https://achan2013.medium.com/how-many-tools-functions-can-an-ai-agent-has-21e0a82b7847)
- ✓ [Roo Code — Native vs XML tool protocols (DeepWiki)](https://deepwiki.com/RooCodeInc/Roo-Code/6.2-tool-protocols-(native-and-xml))
- ✓ [RFC: Native tool use for top-tier AI models (Roo Code #4047)](https://github.com/RooCodeInc/Roo-Code/issues/4047)
- ✓ [native_tool_call_adapter (GitHub)](https://github.com/irreg/native_tool_call_adapter)
- ✓ [VS Code issue #282699 — MCP tool loading causes context pollution](https://github.com/microsoft/vscode/issues/282699)
- ✓ [smolagents — Code agents (HF Agents Course)](https://huggingface.co/learn/agents-course/en/unit2/smolagents/code_agents)
- ✓ [smolagents GitHub](https://github.com/huggingface/smolagents)
- ✓ [Claude Code Skills: Progressive Disclosure (Daniel Avila, Medium)](https://medium.com/@dan.avila7/claude-code-skills-progressive-disclosure-step-by-step-3ca02a4a9f60)
- ✓ [Claude Code Skills (Dotzlaw Consulting)](https://dotzlaw.com/insights/claude-skills/)
- ✓ [Skills aren't about prompts, they're about context design (dev.to)](https://dev.to/akdevcraft/skills-in-claude-arent-about-prompts-theyre-about-context-design-46hf)
- ★ [Anthropic Just Solved AI Agent Bloat — 150K tokens to 2K (Joe Njenga, Medium)](https://medium.com/ai-software-engineer/anthropic-just-solved-ai-agent-bloat-150k-tokens-down-to-2k-code-execution-with-mcp-8266b8e80301) — Code Execution with MCP 模式的最详细实战拆解
