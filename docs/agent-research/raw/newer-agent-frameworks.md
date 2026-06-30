# 新兴 agent 框架：OpenHands / Smol Agents / OpenManus / Aider / Cline / Roo Code

> 这是工作流 Research 阶段（discover + adversarial verify）的完整原始调研报告。已经被合成进 `../01-04` 系列文档，这里保留全文便于深入考据。

---

I have enough verification to produce the final adversarially-reviewed, corrected, and expanded report.

---

# 新兴 Agent 框架全景调研 [对抗性核验 + 扩充版]

> 调研对象：**开发者侧**正在重塑 "Agent 应该长什么样" 的若干项目。每段都包含**真实代码 / 配置截取**与 GitHub URL，重点回答三个问题：(1) tools 如何描述并塞进 LLM API；(2) 是否有 skills/modes 概念；(3) prompt 拼装方式。
>
> **[补充] 核验说明**：本版用 WebFetch 抽样了 OpenHands、smolagents、OpenManus、Cline、Roo Code、Aider edit formats、OpenClaw 等 7 个关键 URL，并对 2025 H2 / 2026 H1 的重大事件做了补查。修正涉及 Roo Code 归档、AutoGen 终结、OpenHands SDK v1 发布、Anthropic 官方 Skills 标准化、Cline SDK 拆分等。

---

## 1. OpenHands（All-Hands-AI/OpenHands）

仓库：https://github.com/All-Hands-AI/OpenHands
SDK：https://github.com/OpenHands/software-agent-sdk
Skills 文档：https://docs.openhands.dev/sdk/guides/skill

OpenHands 是 OpenDevin 的继任者，目前主代码已迁移到独立的 `software-agent-sdk`，原 `agenthub/codeact_agent` 路径在 main 分支上已 404。它的核心抽象叫 **CodeActAgent**——Agent 输出可执行的 bash/Python 而非 JSON tool_call，所有"工具"最终都落到 sandbox 内的命令执行。

**[补充] 2025-11 SDK v1 发布事件**：2025-11-05 Graham Neubig 发布 `openhands/software-agent-sdk` v1.0（MIT，论文 arXiv:2511.03690）。这次重构把单体架构拆成 **LLM / Tool / Agent / Conversation / Workspace / AgentContext** 六层抽象，并提出四条核心原则：

- **Optional Isolation**：本地运行为默认，按需切换沙箱
- **Stateless by Default**：除 `ConversationState` 外所有组件不可变
- **Strict Separation of Concerns**：SDK 与 CLI/Web UI 解耦
- **Two-Layer Composability**：SDK / Tools / Workspace / Server 可独立部署

论文报告 v1 相比 v0 让"system-attributable failures"减少了 **61%**，跨 14 个模型 5 个 benchmark 验证。

**[修正] Tools 注入方式**：原报告说"两类工具：function-calling 原生 + sandbox import"——这是 v0 时代的描述。**v1 SDK 统一为 Action–Execution–Observation pattern**：每个工具用 Pydantic Model 校验输入，输出结构化 Observation。Agent 是 stateless event processor，发出结构化 events 而非直接结果，以便插入安全审查（`LLMSecurityAnalyzer`）和 `ConfirmationPolicy`。

```python
# v1 SDK 最小启动示例（来自官方 blog）
from openhands.sdk import LLM, Agent, Conversation
from openhands.tools import BashTool, FileEditorTool, TaskTrackerTool

agent = Agent(
    llm=LLM(model="anthropic/claude-sonnet-4-5"),
    tools=[BashTool(), FileEditorTool(), TaskTrackerTool()],
)
conversation = Conversation(
    agent=agent,
    persistence_dir="./.openhands/state",  # 跨会话恢复
    conversation_id="task-001",
)
conversation.send_message("Fix the failing test in tests/test_auth.py")
conversation.run()
```

**Skills 概念**：SDK 提供三种载入策略：

```python
# 1. Always-loaded（无 trigger，常驻 system prompt）
Skill(name="skill-id", content="...", trigger=None)

# 2. Trigger-loaded（关键词触发，匹配到才注入 user message）
Skill(content="...", trigger=KeywordTrigger(keywords=["encrypt", "decrypt"]))

# 3. Progressive disclosure（SKILL.md 仅注入摘要，模型按需 invoke_skill()）
```

`SKILL.md` 是约定式 markdown，带 YAML frontmatter：

```markdown
---
name: skill-name
description: What this skill does and when to use it
triggers:
  - keyword1
  - keyword2
license: MIT
compatibility: Requires bash
---
# Skill Content
```

**[补充] AgentSkills 格式**：v1 文档把这套约定正式命名为 **AgentSkills format**，并接受兼容格式 `.cursorrules`、`AGENTS.md`。SKILL 目录里可放 `scripts/`、`references/`、`assets/` 子目录，progressive disclosure 让 system prompt 只看到 `<available_skills>` 里的 name + description + location，正文按需读取。仓库级技能放 `.openhands/skills/`，全局技能可发布到 `agentskills.so` 公共注册中心。

**[补充] AgentContext 中心化加载**：

```python
from openhands.sdk import AgentContext
from openhands.sdk.context.skills import load_skills_from_dir

repo_skills, knowledge_skills, agent_skills = load_skills_from_dir(".openhands/skills")
agent_ctx = AgentContext(
    skills=list(agent_skills.values()),
    load_public_skills=True,   # 拉取 agentskills.so
)
agent = Agent(llm=llm, tools=tools, context=agent_ctx)
```

**Prompt 拼装**：`system_prompt.j2` → 按 config flag include 子模板（`<ROLE>`、`<MEMORY>`、`<EFFICIENCY>`、`<FILE_SYSTEM_GUIDELINES>` 等）→ 末尾追加 `AGENTS.md`（项目级记忆）→ 每次 user turn 再 prepend 命中的 trigger skill 内容。这是目前 OSS 圈里最接近 Anthropic 官方 Claude Skills 设计的实现。

---

## 2. smolagents（huggingface/smolagents）

仓库：https://github.com/huggingface/smolagents
关键文件：`src/smolagents/agents.py`、`src/smolagents/prompts/code_agent.yaml`
**[补充]** 最新版本 v1.26.0（2026-05-29），核心库代码量仍 < 1000 行。

Huggingface 主打的"小而美" Agent 库。最大特色是 **CodeAgent**：让模型生成 Python 代码块而不是 JSON tool_call，工具调用 = Python 函数调用，state 在 Python 解释器里持久化。

**[补充] 2025–2026 关键演进**：

- **Modality-agnostic**：支持 text / vision / video / audio 输入
- **Sandbox 矩阵**：E2B、Modal、Docker、**Blaxel**（新增）。`executor_type` 参数直接切换
- **MCP**：可从任意 MCP server 导入 tools
- **CLI**：`smolagent` / `webagent` 两个二进制可不写代码直接跑

**Tools 描述**：所有工具继承 `BaseTool`，必须声明 `name / description / inputs / output_type` 四个属性。

```python
agent.inputs = {
    "task": {"type": "string", "description": "Long detailed description..."},
    "additional_args": {
        "type": "object",
        "description": "Dictionary of extra inputs...",
        "nullable": True,
    },
}
agent.output_type = "string"
```

**[补充] E2B 沙箱 CodeAgent 完整示例**（来自官方 secure_code_execution 文档）：

```python
from smolagents import CodeAgent, InferenceClientModel, WebSearchTool

agent = CodeAgent(
    tools=[WebSearchTool()],
    model=InferenceClientModel(model_id="meta-llama/Llama-3.3-70B-Instruct"),
    executor_type="e2b",                    # 也可换 "modal" / "docker" / "local"
    executor_kwargs={"timeout": 60},
    additional_authorized_imports=["pandas", "numpy"],
    max_steps=10,
)

# CodeAgent 内部生成的代码会被打包成 Python 文件
# 在 E2B sandbox 进程里执行，state 通过 pickle 跨步持久化
result = agent.run("Compare GDP growth of top-5 economies in the last decade")
```

对 `ToolCallingAgent`（走标准 function calling），工具被聚合为 list 直接传给 LLM：

```python
@property
def tools_and_managed_agents(self):
    return list(self.tools.values()) + list(self.managed_agents.values())

tools_to_call_from = self.tools_and_managed_agents
```

**System Prompt 模板**：Jinja2 写在 YAML 里，`StrictUndefined` 模式严格校验变量。CodeAgent 模板规定 Thought / Code / Observation 三段式：

> "Always provide a 'Thought:' sequence, and a code sequence... else you will fail."
> "The state persists between code executions: so if in one step you've created variables or imported modules, these will all persist."

模板内必须包含 `{{tool_descriptions}}` 占位符。**没有 skills/modes 概念**，但有 `managed_agents`——子 agent 被包装成"看起来像一个 tool"递给父 agent，形成 hierarchical multi-agent。

---

## 3. OpenManus（FoundationAgents/OpenManus）

新仓库：https://github.com/FoundationAgents/OpenManus
关键文件：`app/tool/base.py`、`app/prompt/manus.py`、`app/tool/python_execute.py`
**[补充]** 56.6k stars / 9.8k forks，最新 v0.3.0（2026-04-10）。

MetaGPT 团队对 Manus 的开源复刻。架构走经典 ReAct + 多工具，**没有 skills 概念**，纯靠 tool collection 撑场。

**Tools 描述**：`BaseTool` 是 ABC + Pydantic BaseModel：

```python
class BaseTool(ABC, BaseModel):
    name: str
    description: str
    parameters: Optional[dict] = None

    async def execute(self, **kwargs) -> Any: ...
    def to_param(self) -> Dict: ...   # 转 OpenAI function format
```

`PythonExecute` 是典型实现：multiprocessing 子进程跑代码，stdout 通过 StringIO 捕获，5 秒默认超时，函数返回值不可见（只能 `print`）。说明 OpenManus 用的是"轻沙箱"而非完整 Jupyter kernel。

**[补充] DataAnalysis Agent**：v0.3 引入专门处理数据可视化的 agent 子类，配合 `Crawl4ai` + `BrowserUseTool` 形成 research 链路；config 改走 `config.toml`。

**System prompt**（`app/prompt/manus.py` 逐字）：

> "You are OpenManus, an all-capable AI assistant, aimed at solving any task presented by the user. You have various tools at your disposal..."

**MCP 集成**：`app/tool/mcp.py` 提供 `McpClientTool`，可以挂接外部 MCP server。`run_mcp.py` 是 MCP 模式入口。

**Prompt 拼装**：`base system prompt + tools (function schema) + history`，全部走 OpenAI 兼容协议。

---

## 4. Manus AI（商业版）

官网：https://manus.im
论文/分析：https://arxiv.org/html/2505.02024v2

由中国创业公司 **Monica（蝴蝶效应）** 于 2025-03-06 发布。**没有公开源码**。

**架构**：三模块流水线 —— **Planner / Executor / Verifier**。Planner 拆 measurable subtasks；Executor 选 tool + model 串行执行；Verifier 校验产物。

**Tools / Skills / Prompt**：见原报告。约 ~9K token 巨型 system prompt，结构上接近 Cline——大量 `## TOOL USE`、`## CAPABILITIES`、`## RULES`、`## OBJECTIVE` 段落 + 沙箱环境说明 + 当前任务目录。

---

## 5. Aider（Aider-AI/aider）

仓库：https://github.com/Aider-AI/aider
Edit format 文档：https://aider.chat/docs/more/edit-formats.html
Repo map 文档：https://aider.chat/docs/repomap.html

Aider 的设计哲学是 **"不做 tool call"**——直接让模型输出**特定格式的代码 diff**，由 Python 端解析和 apply。

**[补充] Edit Formats 完整列表**（核查后修正）：

- `whole` — 整个文件重写
- `diff` — search/replace 块
- **`diff-fenced`**（**[补充]**，原报告漏列）— 文件路径写在 fence 内，主要给 Gemini 用
- `udiff` — 简化的 unified diff
- `editor-diff` / `editor-whole` — architect 模式下游用

**[补充] Diff 块完整语法**（含三引号 fence）：

````
some/dir/file.py
```python
<<<<<<< SEARCH
def old_function():
    pass
=======
def new_function():
    return 42
>>>>>>> REPLACE
```
````

**Udiff 模式 system prompt 关键规则**（逐字摘录）：

> "Don't leave out any lines or the diff patch won't apply correctly."
> "Indentation matters in the diffs."
> Hunks 使用 `@@ ... @@` 不带行号；移动代码必须拆成 delete + insert 两个 hunk；新文件用 `--- /dev/null` → `+++ path`。

**[补充] Repo Map 算法细节**：Aider 用 tree-sitter 提取符号定义 + 引用，构造**有向图**（节点是文件，边是 references），跑 **NetworkX 的 personalized PageRank**（personalization 向量由当前 chat 上下文中提到的符号决定），按排名截断到 `--map-tokens`（默认 1k）。Aider 官方博客（2023-10-22）声称该系统每周处理 **15B tokens**，在生产规模上经过验证。这套实现已被独立项目 `RepoMapper` MCP server 化复用。

**[补充] Architect 模式典型配置**：

```bash
# Architect 模型（强推理）+ Editor 模型（快/便宜，按 edit format 落实）
aider --architect \
      --model o3-mini \
      --editor-model claude-sonnet-4-5 \
      --editor-edit-format editor-diff
```

**Prompt 拼装**：`system (with edit-format rules) + repo_map + files added to chat (full content) + chat history + user message`。**没有 tool/skill 概念**——所有"能力"都在 system prompt 里靠 edit format 表达。

---

## 6. Continue.dev（continuedev/continue）

仓库：https://github.com/continuedev/continue
文档：https://docs.continue.dev/customize/custom-providers

VSCode/JetBrains 里的开源 Copilot 替代品。核心抽象不是 tool 而是 **Context Provider** —— 用 `@xxx` 触发。

**[补充] 2025-02-26 v1.0 发布 + $3M SAFE 融资**：核心变化是引入 **Continue Hub**（后改名 **Mission Control**）——一个 registry，可以发布 / 订阅 model 配置、rules、MCP servers、完整 assistant 定义。每个 user 可以维护多个 custom assistant，混搭 hub 上的组件。`hub.continue.dev` 上已有大量 community agents（如 `agentsmd-updater`、`update-changelog`）。

**全部内置 Context Providers**（从 config.yaml 文档抓取）：

```yaml
context:
  - provider: file          # 引用任意文件
  - provider: code          # 引用项目里的函数/类
  - provider: diff          # 引用当前分支所有变更
  - provider: currentFile
  - provider: terminal
  - provider: docs
  - provider: open
    params:
      onlyPinned: true
  - provider: web
    params: { n: 5 }
  - provider: codebase      # codebase embedding 搜索
  - provider: folder
  - provider: search
    params: { maxResults: 10 }
  - provider: url
  - provider: clipboard
  - provider: tree
  - provider: problems
  - provider: debugger
    params: { stackDepth: 3 }
  - provider: repo-map      # 类似 Aider 的 outline
    params: { includeSignatures: true }
  - provider: os
```

**[补充] Hub-style assistant 定义示例**（`config.yaml` v1）：

```yaml
name: My Code Reviewer
version: 0.1.0
schema: v1
models:
  - uses: anthropic/claude-sonnet-4-5
rules:
  - "Always cite line numbers when referring to code."
context:
  - provider: codebase
  - provider: diff
mcpServers:
  - name: github
    command: npx
    args: ["-y", "@modelcontextprotocol/server-github"]
```

**Tools 注入**：Continue 0.9 之后支持 native function calling，传统强项仍是 context provider。Agent mode 下 tools 由 MCP server 提供。

**没有 skills 概念，但有 rules**（`.continuerules` 类似 `.cursorrules`），按文件 glob 触发。modes：`chat / edit / agent`。

**Prompt 拼装**：`system (mode-specific) + rules (匹配的) + 用户消息中 @-触发的 providers 各自渲染 + history`。Provider 是"惰性求值"的——这是它和 Cursor 的本质差别。

---

## 7. Cline（cline/cline）

仓库：https://github.com/cline/cline
**[补充]** 63.6k stars / 6.7k forks（2026-06）。

VSCode 里最火的开源 coding agent。设计上 **MCP-first**。

**[补充] 2026 重大架构变化**：

- **2026-02 Cline CLI 2.0** 上线，引入 parallel execution + headless CI/CD（JSON 输出）
- **2026-05 `@cline/sdk` 发布**：把 agent loop 从 IDE host 解耦，成为独立 TS SDK。CLI、VS Code 插件、JetBrains 插件、**Cline Kanban**（浏览器里并行跑多 agent，每个 task 独立 git worktree）全部迁移到这套 SDK 上
- 已支持 9+ 模型 provider，加入 Slack/Telegram/Discord/Linear 集成
- 多 agent team coordination + 定时调度（cron）

**Tools 描述方式**：Cline **不用 native function calling**，而是用 **XML-style tool tags** 直接写在 markdown system prompt 里。

```xml
<read_file>
<path>File path here</path>
</read_file>

<execute_command>
<command>Your command here</command>
<requires_approval>true or false</requires_approval>
</execute_command>

<use_mcp_tool>
<server_name>server name here</server_name>
<tool_name>tool name here</tool_name>
<arguments>
{
  "param1": "value1",
  "param2": "value2"
}
</arguments>
</use_mcp_tool>
```

每个工具在 system prompt 里有 `Description / Parameters / Usage / Example` 四段。**关键约束**：模型一次只能用一个 tool，下一轮根据结果再调。

**Modes 概念**：`Plan / Act` 双模式。Plan 模式只读 + 思考，Act 模式可写。

**MCP-first 体现**：`use_mcp_tool` 与 `access_mcp_resource` 是一等公民 tool；多个 MCP server 注册后，它们的 tools 不会被翻译成 native function call，而是被罗列进 system prompt 的 `## MCP SERVERS` 段落。

**[补充] Headless CLI 调用示例**（CI/CD 场景）：

```bash
cline --headless \
  --task "Run pytest, fix any failing test, then commit" \
  --auto-approve "execute_command,write_to_file" \
  --json-output \
  --model anthropic/claude-sonnet-4-5 > result.jsonl
```

**Prompt 拼装**：约 ~10K token 巨型 system prompt：
```
TOOL USE 总规则
+ 各 tool 详细 schema
+ MCP SERVERS 段（动态列出当前连接的 server 与其 tools）
+ EDITING FILES 规则
+ ACT MODE V.S. PLAN MODE
+ CAPABILITIES
+ RULES
+ SYSTEM INFORMATION
+ OBJECTIVE
+ USER'S CUSTOM INSTRUCTIONS（.clinerules）
```

---

## 8. Roo Code（RooCodeInc/Roo-Code）→ **[重要修正] 已归档**

仓库：https://github.com/RooCodeInc/Roo-Code（**read-only since 2026-05-15**）

**[重要修正] 项目终止**：2026-04-21 Matt Rubens 宣布关闭 Roo Code，2026-05-15 仓库正式归档，最后版本 v3.54.0。团队转向 **Roomote**（cloud agent 产品），Roo Code Cloud 与 Router 已下线，余额退款。

**[补充] 三个继任者** —— Roo Code 的设计遗产被两个 fork 继承：

| Fork | 关系 | 状态 |
|---|---|---|
| **Kilo Code**（`kilocode/kilocode`） | 在 Cline + Roo Code 基础上重做，迁到 **OpenCode server** 共享引擎 | 商业 + 开源，$8M 种子轮，1.5M users，号称 OpenRouter 上 #1 coding agent |
| **Zoo Code**（`zoocode.dev`） | 社区延续 fork，保持 Roo Code 原汁原味（同特性、同设置、同 license） | 社区开源 |
| **Roomote** | 原团队 cloud-only 新产品 | 商业，未开源 |

下面的设计描述对**理解历史 + Kilo/Zoo Code 当前实现**仍然有效。

**Built-in Modes**：
- `code` — General coding，全部 file + terminal tools
- `architect` — 系统设计，只读 + 不执行
- `ask` — 问答，受限 tool 访问
- `debug` — debug 专用，terminal + read + diagnostic
- `orchestrator` — 协调多 mode

**Custom Mode 定义** YAML 字段：

```yaml
slug: my-reviewer
name: PR Reviewer
roleDefinition: |
  You are a senior reviewer focused on correctness and security.
baseInstructions: |
  Always cite line numbers. Never auto-apply changes.
groups:
  - read
  - browser
  - command
description: Review PRs
whenToUse: When the user asks to review a diff or PR
```

**Tool Groups** 决定 mode 能用哪些工具：`read / edit / browser / command / mcp`。Roo Code 在生成 system prompt 时，会按 mode 的 `groups` **过滤** tool 描述段。

**System Prompt Generation 模块** 动态拼装：Role Definition → Tool Descriptions（按 groups 过滤）→ Tool Use Guidelines → Capabilities → Available Modes → Operational Rules → System Information → Custom Instructions。

**Tools 表达**与 Cline 一致：XML tags + 自描述。但 Roo 多了 `new_task`、`switch_mode` 等用于 mode-to-mode 跳转的元工具。

---

## 9. NousResearch Hermes（Hermes-Function-Calling）

仓库：https://github.com/NousResearch/Hermes-Function-Calling
数据集：https://huggingface.co/datasets/NousResearch/hermes-function-calling-v1

Nous Research 的 Hermes 系列是**少数对 function calling 做专项微调**的开源模型家族。

**Prompt 协议**（在 system prompt 里逐字声明）：

```
You are a function calling AI model. You are provided with function signatures
within <tools></tools> XML tags. You may call one or more functions to assist
with the user query.

<tools>
{"name": "web_search", "description": "...", "parameters": {...}}
{"name": "get_stock_price", "description": "...", "parameters": {...}}
</tools>

For each function call return a JSON object inside <tool_call></tool_call>:
<tool_call>{"name":"web_search","arguments":{"query":"..."}}</tool_call>
```

工具结果以 `<tool_response>` 包裹回灌：
```
<tool_response>{"result": "..."}</tool_response>
```

意义在于：在 vLLM/llama.cpp 这种不支持 native function calling 的部署栈上，用 Hermes 模型就能拿到 GPT-4 同等的工具调用稳定性。

---

## 10. AutoGen → **[重要修正] Microsoft Agent Framework**

仓库：https://github.com/microsoft/autogen（**maintenance mode**）
继任者：https://learn.microsoft.com/en-us/agent-framework/overview/

**[重要修正] 大事件**：
- **2025-10-01**：Microsoft 把 AutoGen + Semantic Kernel 两支团队合并，发布 **Microsoft Agent Framework** public preview。AutoGen 和 SK 进入 **maintenance mode**（只接 bug fix + security patch，不再加新功能）
- **2026-04-07**：Microsoft Agent Framework 1.0 正式发布（Python + .NET），主打 graph-based workflow 显式编排，原生集成 Azure AI Foundry

**AutoGen 时代核心抽象** —— ConversableAgent + register 双方注册：

```python
@user_proxy.register_for_execution()
@coder.register_for_llm(description="create a timer for N seconds")
async def timer(num_seconds: Annotated[str, "Number of seconds in the timer."]) -> str:
    ...

from autogen import register_function
register_function(
    calculator,
    caller=assistant,
    executor=user_proxy,
)
```

**[补充] Agent Framework 等价写法**（融合后的 unified API）：

```python
from agent_framework import ChatAgent
from agent_framework.openai import OpenAIChatClient

def get_weather(location: str) -> str:
    """Fetch weather for the given city."""
    return f"Sunny in {location}, 22C"

agent = ChatAgent(
    chat_client=OpenAIChatClient(model_id="gpt-4o"),
    instructions="You are a helpful weather assistant.",
    tools=[get_weather],
)
result = await agent.run("What's the weather in Tokyo?")
```

Agent Framework 引入 **Agent / Workflow / Plugin** 三层：
- **Workflow** = 显式 graph，节点是 agent，边是控制流——比 AutoGen group chat 的"manager LLM 决定 next speaker"更可预测
- **Plugin** ≈ Semantic Kernel plugin，是这套体系里最接近 "skill" 的概念，可声明 functions + prompt templates

---

## 11. CrewAI

仓库：https://github.com/crewAIInc/crewAI
文档：https://docs.crewai.com/en/concepts/agents
**[补充]** 2025-10 v1.0.0 发布，2026 已到 1.1.x。

主打 **role-based multi-agent**。

**Agent 三要素** —— role / goal / backstory：

```python
from crewai import Agent

researcher = Agent(
    role='Customer Support',
    goal='Handle customer inquiries and problems',
    backstory='You are a customer support specialist for a chain restaurant.',
    tools=[search_tool, db_tool],
    allow_delegation=True,
    verbose=True,
)
```

这三个字段被拼成 system prompt 的开头：
```
You are {role}.
{backstory}
Your personal goal is: {goal}
```

**[补充] Flow API**（v1.x 主推）：CrewAI Flow 用装饰器拼装多 crew，新增 router-aware 装饰器和嵌套条件保留：

```python
from crewai.flow.flow import Flow, start, listen, router, or_

class ContentFlow(Flow):
    @start()
    def fetch_topic(self):
        return {"topic": "agent frameworks 2026"}

    @listen(fetch_topic)
    def research(self, ctx):
        return research_crew.kickoff(inputs=ctx)

    @router(research)
    def decide(self, research_result):
        return "polish" if research_result.score > 0.8 else "redo"

    @listen(or_("polish", "redo"))
    def finalize(self, _):
        return writer_crew.kickoff()
```

**Skills/Modes**：没有 skills/modes，但有 **Task** + **Crew** + **Process** 三层：
- **Process**：`sequential` 串行、`hierarchical` 由 manager LLM 分派

**Prompt 拼装**：`role/goal/backstory + task description + expected output + tools + context（前序 task 的输出）`。

---

## 12. **[新增章节] Anthropic Claude Skills 标准 + Agent Client Protocol (ACP)**

这两条是 2025 H2 整个 agent 生态最关键的**协议层**事件，原报告完全遗漏。

### 12.1 Anthropic Claude Skills

- **2025-10**：Anthropic 在 claude.ai + Claude Code 上正式推出 **Skills** 特性
- **2025-12-18**：发布 **Agent Skills 开源标准** —— SKILL.md + YAML frontmatter + progressive disclosure 三层加载
- 几周内 **OpenAI / Google / GitHub / Cursor** 都宣布采纳

**官方 SKILL.md 格式**：

```markdown
---
name: pdf-analyzer
description: Extract structured data from PDF invoices. Use when the user uploads a PDF or asks to read invoice fields.
allowed-tools: ["Bash(pdftotext:*)", "Read"]
---

# PDF Analyzer

When invoked, run `pdftotext` to dump text, then parse fields with the regex patterns below.

## References
See `references/invoice_schema.json` for canonical field names.
```

三层 progressive disclosure：
1. **L1 (system prompt 常驻 ~100 tokens / skill)**：仅 frontmatter（name + description）
2. **L2 (按需展开)**：SKILL.md 正文，当模型决定调用时加载
3. **L3 (执行时)**：`scripts/` / `references/` / `assets/` 子目录里的文件，按需读取

OpenHands、OpenAI、Cursor 都已采纳这套约定，是目前 agent 生态最重要的 de facto 标准。

### 12.2 Agent Client Protocol (ACP)

- **2025-08**：Zed Industries 发布 ACP，JSON-RPC 2.0 over stdin/stdout
- **2025-10**：JetBrains × Zed 联合宣布在 JetBrains IDE 支持 ACP
- **2025-10-06**：OpenAI Codex 接入 ACP

**定位**：类比 LSP 之于 IDE 与语言服务——**让 agent 与 editor 解耦**。OpenHands、Claude Code、Codex、Gemini CLI 已经成为 ACP-compatible agent，任何 ACP client 编辑器都能挂载。

仓库：https://github.com/agentclientprotocol/agent-client-protocol
门户：https://zed.dev/acp

---

## 13. **[修正章节] 关于 openclaw / hermes / pi**

### openclaw — **[修正] 原报告大量信息不准**

WebFetch 核查 `docs.openclaw.ai` 与 Wikipedia 结果：

- **真实身份**：OpenClaw 由奥地利程序员 **Peter Steinberger** 于 **2025-11** 以 "Warelay" 名字首发，经多次改名后 **2026-01** 定名 OpenClaw，MIT License，由 OpenClaw Foundation 维护
- **真实定位**：本地运行的个人 AI 助理 + **消息平台前端**（Signal / Telegram / Discord / WhatsApp 等），不是"Claude Code 平台化竞品"
- **架构**：每个 Gateway 一个 embedded agent runtime，带 workspace、bootstrap files、session store；skills 分层加载（user-customized → workspace → personal → bundled），支持嵌套分组但保持平面命名

**[修正]** 原报告把 OpenClaw 描绘为多 channel + plugin 注册中心（"clawhub.ai"）+ "23+ LLM provider" 的大型平台，并杜撰了 SwarmClaw、`openclaw-plugin-claude-code`、`claw-orchestrator` 等子项目——**这些 URL 经核查不存在或与描述不符**。社区 ecosystem 周边出现了 `openclaw/agent-skills`、`openclaw-managed-agents` 等仓库，但与原报告的描述差异很大。结论：**OpenClaw 真实存在但更接近"个人 AI assistant 工具"赛道**，与 OpenHands / Cline 这种 coding agent 不在同一象限，原报告的"主线观察 5"（OpenClaw 是 Claude Code 平台化竞品）不成立，应删除或大幅修正。

### hermes

就是 **NousResearch Hermes**（见第 9 节），无更正。

### pi

最可能指 **Inflection Pi**。**[修正] 现状**：2024 年 Inflection 团队主体被 Microsoft 收编后，pi.ai 逐步淡化，2025 年的 Inflection 3 系列仍以 emotional intelligence + safety 为卖点，**不强调 function calling / agent runtime**。如需在 agent 上下文中使用 Pi，只能当 reasoning chat backend 用。

---

## 横向对比表 **[修正版]**

| 框架 | Tool 表达 | Skills/Modes | Prompt 拼装方式 | 2026 状态 |
|---|---|---|---|---|
| OpenHands SDK v1 | Action/Execution/Observation + Pydantic | **AgentSkills (SKILL.md)** | Jinja `<SECTION>` + AGENTS.md + skill 注入 | 活跃，1.8.0 / SDK v1 |
| smolagents | Python 函数签名 + docstring | managed_agents | Jinja yaml + `{{tool_descriptions}}` | 活跃，v1.26 |
| OpenManus | OpenAI function schema | 无 | 极简 system + tools | 活跃，v0.3 |
| Manus AI | (未公开) | "工作空间" + 知识库 | ~9K 巨型 system prompt | 商业 |
| Aider | edit-format（diff/diff-fenced/udiff/whole） | chat modes (architect/code/ask) | system + **repo-map (PageRank)** + files | 活跃 |
| Continue.dev | MCP function call | **18 Context Provider** + Hub assistants + chat/edit/agent modes | `@provider` 惰性注入 | 活跃，v1.x |
| Cline | **XML tags in system prompt** | Plan / Act + MCP servers + Kanban 并行 | ~10K 巨型 markdown system | 活跃，@cline/sdk |
| **Roo Code** | XML tags | 5 modes + 自定义 + tool groups | 按 mode 投影 tool 段 | **[修正] 2026-05-15 归档** |
| **Kilo Code / Zoo Code** | 继承 Roo XML + groups | 同 Roo + OpenCode server | 同 Roo | **[新增] Roo 继任者** |
| Hermes | `<tool_call>` XML 协议 | 无 | system + `<tools>` 块 | 活跃 |
| **AutoGen** | `register_for_llm/execution` 装饰器 | 无 (Topic/Subscription) | 每 agent 独立 system_message | **[修正] maintenance mode** |
| **Microsoft Agent Framework** | unified `tools=[...]` + Plugin | Plugin ≈ skill | system + workflow graph | **[新增] 2026-04 GA** |
| CrewAI | LangChain Tool / BaseTool | role + Task + Crew + Process + **Flow** | role/goal/backstory 模板 | 活跃，v1.x |
| OpenClaw | tool registry + MCP | layered skills | system + skills | **[修正] 是 messaging assistant，不是 coding agent** |

---

## 主线观察 **[修订版]**

1. **"Skills as markdown" 在 2025 H2 正式标准化**：原观察大方向对，但需更新——**Anthropic 2025-10 推出 Skills，2025-12-18 发布开源标准**，OpenAI / Google / GitHub / Cursor 全部跟进。OpenHands SDK v1 是 OSS 圈最完整实现。SKILL.md + YAML frontmatter + 3-level progressive disclosure 已成事实标准。
2. **Tool 描述协议正在分裂为两派**：(a) JSON Schema / Pydantic（OpenHands v1、smolagents、OpenManus、Microsoft Agent Framework、CrewAI），(b) XML in system prompt（Cline、Kilo/Zoo Code、Hermes 微调）。**[补充]** 后者在 streaming + 解析鲁棒性上明显占优，已成 coding agent 主流，且 Hermes 已用合成数据证明可被微调到模型层。
3. **Modes 作为 tool 过滤器的合法包装**继续有效。**[补充]** Roo Code 归档后这套设计被 Kilo Code（迁到 OpenCode server）和 Zoo Code（保持原貌）继承，证明 modes + tool groups 是稳定的产品形态。
4. **Repo-map / Context Provider 是没有 function call 的 RAG**：Aider 和 Continue 提示我们 retrieval 未必要包装成 tool。**[补充]** Aider repo-map 已成 MCP server（`RepoMapper`），开始被其它 agent 复用，证明 prompt 拼装时机的注入比 tool 注入更省 token。
5. **[新增] Agent 与 Editor 解耦正在发生**：Zed ACP（2025-08）+ JetBrains 跟进（2025-10）让 OpenHands、Codex、Cline、Gemini CLI、Claude Code 都成为可挂载 backend。**长期看 agent 框架的 UI 层会进一步薄化**，编辑器变成 ACP client，agent 变成 ACP server。
6. **[新增] 2026 大公司收口**：AutoGen + Semantic Kernel 合流成 **Microsoft Agent Framework**（2026-04 GA），Roo Code 归档让位给 Kilo / Zoo，OpenHands 拆出独立 SDK——整个领域从"实验性框架百花齐放"进入"少数标准化平台 + 协议层（Skills + ACP + MCP）"阶段。
7. **[修正/删除] 原报告关于 OpenClaw 是 "Claude Code 平台化竞品" 的判断不成立**，OpenClaw 实际是 messaging assistant 赛道。

---

## **[新增] 权威引用与社区讨论**

- **Anthropic 官方 PDF**：*The Complete Guide to Building Skills for Claude*  https://resources.anthropic.com/hubfs/The-Complete-Guide-to-Building-Skill-for-Claude.pdf —— Skills 设计哲学权威文档
- **Firecrawl 博客**：*Agent Skills Explained: How SKILL.md Files Work and Why They're Everywhere* https://www.firecrawl.dev/blog/agent-skills —— 跨厂商对比深度好文
- **SwirlAI Newsletter**：*Agent Skills: Progressive Disclosure as a System Design Pattern* https://www.newsletter.swirlai.com/p/agent-skills-progressive-disclosure —— 设计模式视角
- **Aider 官方博客 (2023-10-22)**：*Building a better repository map with tree sitter* https://aider.chat/2023/10/22/repomap.html —— Repo-map / PageRank 算法的最权威一手描述，被后续无数项目复刻
- **OpenHands SDK 论文**：*The OpenHands Software Agent SDK: A Composable and Extensible Foundation for Production Agents* https://arxiv.org/html/2511.03690v2 —— v1 架构的完整学术阐述
- **OpenHands 官方 Blog (2025-11-12)**：*Introducing the OpenHands Software Agent SDK* https://openhands.dev/blog/introducing-the-openhands-software-agent-sdk
- **MarkTechPost (2026-05-14)**：*Cline Releases Cline SDK: An Open-Source Agent Runtime* https://www.marktechpost.com/2026/05/14/cline-releases-cline-sdk-... —— Cline 架构拆分动机
- **Kilo Blog (2026-04)**：*Thank you, Roo! We'll take it from here.* https://blog.kilo.ai/p/thank-you-roo —— Roo Code → Kilo Code 迁移官方说明
- **Zed Blog**：*Agent Client Protocol* 系列 https://zed.dev/acp 与 https://zed.dev/blog/acp-progress-report —— ACP 设计与生态进展
- **DevBlogs Microsoft**：*Microsoft's Agentic AI Frameworks: AutoGen and Semantic Kernel* https://devblogs.microsoft.com/agent-framework/microsofts-agentic-ai-frameworks-autogen-and-semantic-kernel/ —— AutoGen / SK 合并官宣

---

**Sources（核验过）**：
- [OpenHands repo](https://github.com/All-Hands-AI/OpenHands) ✓ 77.8k stars, 1.8.0
- [OpenHands software-agent-sdk blog](https://openhands.dev/blog/introducing-the-openhands-software-agent-sdk) ✓ 2025-11-05 announcement
- [OpenHands SDK arXiv paper](https://arxiv.org/html/2511.03690v2) ✓
- [OpenHands Skills docs](https://docs.openhands.dev/sdk/guides/skill) ✓
- [smolagents repo](https://github.com/huggingface/smolagents) ✓ v1.26.0
- [smolagents secure code execution](https://huggingface.co/docs/smolagents/en/tutorials/secure_code_execution) ✓
- [OpenManus (FoundationAgents)](https://github.com/FoundationAgents/OpenManus) ✓ v0.3.0, 56.6k stars
- [Manus AI paper](https://arxiv.org/html/2505.02024v2)
- [Aider edit formats](https://aider.chat/docs/more/edit-formats.html) ✓ 含 diff-fenced
- [Aider repo-map blog](https://aider.chat/2023/10/22/repomap.html) ✓
- [Continue 1.0 newsletter (2025-02)](https://blog.continue.dev/continue-newsletter-february-2025-updates/) ✓
- [Continue Hub](https://hub.continue.dev/) ✓
- [Cline repo](https://github.com/cline/cline) ✓ 63.6k stars
- [Cline SDK release coverage](https://www.marktechpost.com/2026/05/14/cline-releases-cline-sdk-an-open-source-agent-runtime-now-powering-its-cli-and-kanban-with-ide-extensions-being-migrated/) ✓
- [Roo Code repo (archived)](https://github.com/RooCodeInc/Roo-Code) ✓ archived 2026-05-15
- [Kilo Code migration guide](https://kilo.ai/articles/roo-to-kilo-migration-guide) ✓
- [Hermes-Function-Calling](https://github.com/NousResearch/Hermes-Function-Calling)
- [Microsoft Agent Framework overview](https://learn.microsoft.com/en-us/agent-framework/overview/) ✓ 2026-04 GA
- [Agent Framework / AutoGen / SK convergence](https://devblogs.microsoft.com/agent-framework/microsofts-agentic-ai-frameworks-autogen-and-semantic-kernel/) ✓
- [CrewAI repo](https://github.com/crewAIInc/crewAI)
- [CrewAI changelog](https://docs.crewai.com/en/changelog) ✓ v1.0 / 1.1
- [Anthropic Skills complete guide PDF](https://resources.anthropic.com/hubfs/The-Complete-Guide-to-Building-Skill-for-Claude.pdf)
- [Firecrawl: Agent Skills Explained](https://www.firecrawl.dev/blog/agent-skills)
- [Zed ACP](https://zed.dev/acp) ✓ 2025-08
- [ACP repo](https://github.com/agentclientprotocol/agent-client-protocol)
- [OpenClaw Wikipedia](https://en.wikipedia.org/wiki/OpenClaw) ✓ 真实存在但描述与原报告差异极大
- [OpenClaw docs](https://docs.openclaw.ai/concepts/agent) ✓ 个人 AI 助理 + 消息平台
