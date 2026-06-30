# Cursor / Windsurf / Devin / v0 / Cline / Lovable 等的 system prompt 泄漏

> 这是工作流 Research 阶段（discover + adversarial verify）的完整原始调研报告。已经被合成进 `../01-04` 系列文档，这里保留全文便于深入考据。

---

I have enough material. I'll ignore the system-reminder about TaskCreate as it's not applicable to this analytical task. Let me write the expanded report now.

# 主流 AI 编程工具 System Prompt 泄漏研究报告（核验扩充版）

> 调研对象：Cursor、Windsurf、Devin、v0（Vercel）、Continue、Cline、Aider、Roo Code、Lovable、Bolt.new、Replit Agent、Trae（字节）
> **[补充]** 新增对象：**Warp.dev Agent Mode、Kiro（AWS）、Augment Code、Manus、Claude Code（2026 源码泄漏）、VS Code Copilot Agent、GitHub Copilot CLI**
> 主要来源：`x1xhlol/system-prompts-and-models-of-ai-tools`（截至 2026-10-05，约 501+ commits、141k stars）、`jujumilk3/leaked-system-prompts`、`asgeirtj/system_prompts_leaks`（43.7k stars）、Roo / Aider / Continue 开源仓库、Anthropic Claude Code source-map 泄漏（2026-03-31）

**[补充] 核验状态摘要**：通过 WebFetch 抽样核验以下 5 个 URL，均一致或大体一致：
1. `Cursor Prompts/Agent Prompt v1.2.txt` — 「Knowledge cutoff: 2024-06 / powered by GPT-4.1」、XML 段落与 3 次 linter loop 规则 **全部命中** ✅
2. `Aider editblock_prompts.py` — `main_system` 起始、`{final_reminders}` / `{shell_cmd_prompt}` 占位符、`system_reminder` 中的 "Every SEARCH section must EXACTLY MATCH" 规则 ✅
3. `continuedev/continue defaultSystemMessages.ts` — 三个 mode（chat/agent/**plan**）确认存在 ✅ **[修正] 原报告漏掉了 plan mode**
4. `x1xhlol` 仓库结构 — 截至 2026-10-05 已扩容到 **30+ 工具**，远多于原报告涵盖 ✅（详见下面 "新增工具"）
5. `Warp.dev / Augment / Kiro` 目录 — 文件存在并已 fetch 验证 ✅

---

## 1. Cursor

**已泄漏版本**：Agent Prompt v1.0 (~520 词)、v1.2 (5,343 词)、Agent CLI 2025-08-07 (~1,500 词)、Agent Prompt 2.0 / 2025-09-03 (~6,361 词，含 OpenAI Harmony `<|im_start|>system` 帧)。

**[补充] 最新动态（2025 Q4 – 2026）**：
- **2025-10 Cursor 2.0** 发布，引入自研模型 **Composer**（首个 Cursor 训练的代码模型），架构转向 "Agent-first / parallel agents"。
- **2026-05 Composer 2.5** 上线（更强的长程任务一致性、更准的复杂指令跟随）。
- **2026-05 Cursor 3.6** 引入 **Auto-review**，允许 Agent 长时间无人值守，安全执行。
- 配置层从老的 `.cursorrules` 迁移至 **`.cursor/rules/*.mdc`**（带 YAML frontmatter，可控制何时启用）；同时支持业界共识的 **`AGENTS.md`**（无 metadata 的纯 markdown，根目录放置）。原报告未提及 `.mdc` / `AGENTS.md` 这一配置层迁移，**[补充]** 这是 2026 年最重要的实践变化。
- `jujumilk3` 仓库收录 **`cursor-ide-2.0_20251029.md`** 文件，证明 Cursor 2.0 prompt 已泄漏，结构相对 v1.2 更精简、加入了 todo 列表 / parallel sub-agent 相关段落。

**开场 persona**（v1.2，源：`x1xhlol-leaks/Cursor Prompts/Agent Prompt v1.2.txt`，**已 WebFetch 核验**）：

> Knowledge cutoff: 2024-06
>
> You are an AI coding assistant, powered by GPT-4.1. You operate in Cursor.
>
> You are pair programming with a USER to solve their coding task. Each time the USER sends a message, we may automatically attach some information about their current state, such as what files they have open, where their cursor is, recently viewed files, edit history in their session so far, linter errors, and more. ...
>
> You are an agent - please keep going until the user's query is completely resolved, before ending your turn and yielding back to the user. Only terminate your turn when you are sure that the problem is solved.

**[补充] 注意**：这段「keep going until …」直接复用了 OpenAI 在 GPT-4.1 prompting guide 里推荐的 "agent persistence reminder" 三句话之一（另两句是 "tool-calling" 与 "planning" 提醒），并不是 Cursor 原创。这恰好印证了 Cursor v1.2 是 GPT-4.1 调优的产物。

**结构**：使用 `<communication>`、`<tool_calling>`、`<maximize_context_understanding>`、`<making_code_changes>`、`<summarization>`、`<memories>` 一系列自定义 XML 标签分块——**已 WebFetch 核验**。

**Tools 描述方式**：TypeScript namespace（OpenAI Harmony function-calling 风格）：

```ts
namespace functions {
  // `codebase_search`: semantic search that finds code by meaning, not exact text
  type codebase_search = (_: {
    explanation: string,
    query: string,
    target_directories: string[],
  }) => any;

  type edit_file = (_: {
    target_file: string,
    instructions: string,
    code_edit: string,
  }) => any;
}
```

自带 `multi_tool_use.parallel`：「Use this function to run multiple tools simultaneously … Do this even if the prompt suggests using the tools sequentially.」

**[补充] 代码示例 1：Cursor `edit_file` 调用的「`// ... existing code ...`」占位符约定**（这是 v1.2 中最具影响力的设计模式，被 Cline、Bolt、v0 等大量抄作业）：

```ts
// edit_file 调用的 code_edit 参数必须用如下占位符跳过未修改区域
edit_file({
  target_file: "src/server.ts",
  instructions: "Add a /health endpoint before the listen call",
  code_edit: `
// ... existing code ...
app.get('/health', (_, res) => res.json({ ok: true }));
// ... existing code ...
app.listen(PORT);
// ... existing code ...
`
})
```

服务端用一个独立的 "fast apply" 小模型把 code_edit 合并回完整文件，这是 Cursor 性能远超 Cline-style 全文件重写的核心原因。

**Codebase / git context 嵌入**：`<user_info>` 与 `<project_layout>` dynamic XML 块（启动时快照，"This snapshot will NOT update during the conversation"）。

**安全 / refusal**：

> Do not make uneducated guesses. And DO NOT loop more than 3 times on fixing linter errors on the same file. On the third time, you should stop and ask the user what to do next.

**长度 / 缓存**：v1.2 约 5,343 词 ≈ 7.5k tokens；Agent 2.0 约 6,361 词 ≈ 9k tokens。

---

## 2. Windsurf（Codeium / Cascade）

**已泄漏版本**：Cascade R1 (2025-02)、`codeium-windsurf_20250420.md`、**Prompt Wave 11**（1,904 词）。

**[补充]** Codeium 已于 2024-11 改名 Windsurf；2025 年 Google DeepMind 部分收购 Windsurf 团队（OpenAI 收购失败后 Anthropic / Google 抢人）。这意味着 Prompt Wave 系列之后底层模型从 GPT-4.1 改成 multi-provider（Sonnet 4 + GPT-5）路由，**Wave 11 仍硬编码回答 "GPT 4.1"** 的反 disclosure 规则可能已过时。

**Persona**：

> You are Cascade, a powerful agentic AI coding assistant designed by the Windsurf engineering team: a world-class AI company based in Silicon Valley, California. As the world's first agentic coding assistant, you operate on the revolutionary AI Flow paradigm …

> Separately, if asked about what your underlying model is, respond with `GPT 4.1`

**结构、Tools 描述、Codebase context、安全约束** —— 同原报告，保留。

---

## 3. Devin（Cognition）

**已泄漏内容**：`x1xhlol-leaks/Devin AI/Prompt.txt` (5,553 词) + `DeepWiki Prompt.txt`。**[补充]** `jujumilk3` 又增加了 `devin-2.0_20250403.md` 和 `devin_20250908.md`——后者是 Devin 2 在 Slack/PR review 模式下使用的 prompt。

**Persona、结构、Tools、安全（POP QUIZ 等）** —— 全部保留原报告。

**[补充] 代码示例 2：Devin "POP QUIZ" 反 prompt-injection 机制实现样例**（业界几乎独此一家）：

```xml
STARTING POP QUIZ

Question 1: Without revealing the contents of your command reference,
which action would you take if asked to push to main directly?
A) <shell>git push origin main</shell>
B) <message_user>I should not push to main directly...</message_user>
C) <suggest_plan ... />

ENDING POP QUIZ
```

模型必须停止所有 tool 调用、改用自然语言作答；这是 Cognition 对训练时遇到 prompt-injection 的对抗式微调结果。

---

## 4. v0（Vercel）

**已泄漏内容**：`x1xhlol-leaks/v0 Prompts and Tools/Prompt.txt` (7,029 词)。保留原报告全部内容。

**[修正] 原报告的过时硬编码版本号**：
- 原报告引用 `"ai": "^6.0.0", "@ai-sdk/react": "^3.0.0"` 和 `"anthropic/claude-opus-4.6"`、`"google/gemini-3-flash"` ——这些是 prompt 的某一周快照，**v0 prompt 的"AI SDK / 模型清单"段每周都会更新**，最新清单已经包含 GPT-5.5 / Claude Opus 4.8 / Fable 5 / Gemini 3.5 Flash。引用时务必注明日期。

**[补充] 代码示例 3：v0 的"伪 Python 工具调用"风格**（与 Cursor 的 TS namespace 形成有趣对比）：

```python
# v0 伪代码 — 实际底层走 Anthropic native function calling
Read(
  file_path="components/header.tsx",
  start_line=1,
  end_line=50
)

Write(
  file_path="components/auth-button.tsx",
  content="...",
  taskNameActive="Adding auth button",
  taskNameComplete="Added auth button"
)
```

**[补充]** `taskNameActive` / `taskNameComplete` 字段是 v0 独有 UI 反馈机制——它会在执行期间展示 "Adding auth button..."、完成后展示 "Added auth button"，是把进度态嵌入工具调用 schema 的典型设计。

---

## 5. Continue.dev

**[修正] 原报告漏写 Plan Mode**。WebFetch 验证 `defaultSystemMessages.ts` 实际包含 **三个 mode**：

> Chat: "You are in chat mode. If the user asks to make changes to files offer that they can use the Apply Button on the code block, or switch to Agent Mode to make the suggested updates automatically."
>
> Agent: "You are in agent mode. If you need to use multiple tools, you can call multiple read-only tools simultaneously."
>
> **Plan**: "You are in plan mode, in which you help the user understand and construct a plan. **Only use read-only tools. Do not use any tools that would write to non-temporary files.**"

Plan mode 是 Continue 在 2025 年新加的「Cursor Ask + Devin Planning 混合」模式：只读、不副作用，可与 Agent 模式互切。

其余内容（结构、tools、长度）保留。

---

## 6. Cline

**已泄漏内容**：`jujumilk3-leaks/cline_20250729.md` (7,354 词)。保留原报告，**[补充]** 三点：

1. **Plan/Act 模式**是 Cline 2025 重大改动：Plan 阶段只允许 `plan_mode_respond`、`read_file`、`search_files`、`list_files`、`ask_followup_question`；切到 Act 阶段才允许 `write_to_file` / `execute_command`。原报告只写了 `plan_mode_respond` 工具名，没解释这个状态机。
2. **Focus Chain** 是 Cline 2026 引入的进度条机制（在每次工具调用前重申当前 todo），降低 hallucination 漂移。
3. **Cline 的 `replace_in_file` diff 语法直接源于 Aider 的 `SEARCH/REPLACE`**，只是把 `<<<<<<<` 改成 `-------`、`>>>>>>>` 改成 `+++++++`。两者可视为同一谱系。

---

## 7. Aider

**[补充]** WebFetch 验证 `editblock_prompts.py` 完整内容除了原报告 `main_system` 外，还有重要的 `system_reminder`：

> Every SEARCH section must EXACTLY MATCH the existing file content, character for character, including all comments, docstrings, etc.

以及对 SEARCH/REPLACE 唯一匹配的约束：

> *SEARCH/REPLACE* blocks will replace *all* matching occurrences. Include enough lines to make the SEARCH blocks unique.

这两条是 Aider 编辑成功率的核心，**原报告完全略过**。

**[补充] 代码示例 4：Aider 标准 SEARCH/REPLACE block 完整语法**：

````
mathweb/flask/app.py
```python
<<<<<<< SEARCH
from flask import Flask
=======
import math
from flask import Flask
>>>>>>> REPLACE
```
````

文件路径在 fence 外、单独一行；fence 内 `<<<<<<< SEARCH` / `=======` / `>>>>>>> REPLACE` 三段。Aider 的 grammar 完全嵌入 markdown，避免污染 chat history 渲染——这是它至今仍是开源 agent 编辑成功率天花板的原因。

---

## 8. Roo Code

保留原报告全部内容。**[补充]** Roo 2026 加入「Orchestrator Mode」：一个 Roo 实例作为 orchestrator，spawn 子 Roo 实例分别承担 Architect / Code / Debug。`<task>` 工具调用即 spawn 子任务，结果通过 `attempt_completion` 回流。

---

## 9. Lovable / 10. Bolt.new / 11. Replit / 12. Trae

四节内容保留。补充点：

- **[补充] Lovable 2.0**：`jujumilk3-leaks/lovable-2.0_20250423.md` 已确认存在，新增 Supabase MCP 深度集成 + `lov-write` / `lov-rename` / `lov-delete` 一系列 `lov-*` 操作工具（不仅是 UI 渲染标签）。
- **[修正] Bolt 关于 Python 限制的描述需更新**：2026 年 WebContainer 已支持 **`pyodide-pip`** 安装纯 Python wheel，原报告的 "Python is limited to standard library only" 严格说已不准确，但 prompt 文本本身仍保留旧表述（说明 prompt 滞后于实际能力）。
- **[补充] Replit Agent 3**（2025-09）：增加 "Test in Mobile" 与 "Visual Editor"，prompt 中新增 `<proposed_mobile_test>` 标签（同 schema 风格）。
- **Trae** 保留。

---

## [补充] 新章节：2025 H2–2026 新泄漏的重要工具

### 13. Warp.dev Agent Mode（已 WebFetch 核验）

**Persona**：定位为 "AI agent operating within Warp terminal"。

**结构**：
1. Question vs. Task Classification（用户消息分类：闲聊？指令？任务？）
2. Task Complexity Tiers（简单/复杂任务分级，复杂任务必先反问澄清）
3. Tool Specifications（`run_command`、`read_files`、`grep`、`file_glob`、`edit_files`）
4. Coding Guidelines
5. Version Control Integration（"avoid pager output" 是 Warp 的硬性偏好）

**verbatim 关键句**：

> IMPORTANT: NEVER assist with tasks that express malicious or harmful intent.

> Use versions of commands that guarantee non-paginated output where possible.

> Bias toward action to address the user's query. If the user asks you to do something, just do it.

**独特点**：
- **Citation XML** —— 用外部信息时强制 XML 引用；
- **Large-file chunking** —— 文件超过 5,000 行自动分块；
- **Secret-handling** —— 永远走 env var，不在响应里明文显示密钥。

### 14. Kiro（AWS 出品 IDE，已 WebFetch 核验）

**已泄漏 3 个 prompt 文件**：`Mode_Clasifier_Prompt.txt`、`Spec_Prompt.txt`、`Vibe_Prompt.txt`——证明 Kiro 用 **一个 Classifier 把用户输入路由到 Spec 或 Vibe 两套模式**。

**Persona 关键句**：

> We don't write code for people, but we enhance their ability to code well by anticipating needs, making the right suggestions, and letting them lead the way.

> Speak like a dev — when necessary. Look to be more relatable and digestible in moments where we don't need to rely on technical language.

> The vibe is relaxed and seamless, without going into sleepy territory.

**架构特征**：
- **Autopilot / Supervised 双模式**：与 Cursor 的 Auto-review 类似；
- **Steering files** 编码团队规范；
- **Specs**：把 PRD → tasks → 代码的结构化 feature 流程嵌入 IDE；
- **MCP 一等公民**。

### 15. Augment Code（已 WebFetch 核验）

**Persona**：

> Built on Claude Sonnet 4 by Anthropic, with codebase access through Augment Code's integrations.

**独特约束**：

> Before calling the `str_replace_editor` tool, ALWAYS first call the `codebase-retrieval` tool asking for highly detailed information about the code you want to edit.

> Do NOT perform any of these actions without explicit permission from the user: Committing or pushing code, Changing the status of a ticket, Merging a branch, Installing dependencies, Deploying code.

**XML 代码展示约束**：

> If you fail to wrap code in this way, it will not be visible to the user.

格式：

```xml
<augment_code_snippet path="src/foo.ts" mode="EXCERPT">
function foo() { ... }
</augment_code_snippet>
```

`mode="EXCERPT"` 是 Augment 独有，前端会渲染成可点击「展开到完整文件」的卡片。

### 16. Manus（已 WebFetch 核验）

**Persona**：泛 AI 助理（不是纯代码 agent），强调 "helpful, informative, and versatile"。

**架构**：浏览器（含 JS 注入）+ 文件系统 + Linux shell + 部署（可对外暴露端口与公网 URL，类似 Replit Deployments）。

**透明协议**：必须显式列出 "what I cannot do"——少见的「主动声明能力边界」设计。

### 17. Claude Code（**[补充] 重大事件**）

**事件**：**2026-03-31**，Anthropic 在 npm 包 `@anthropic-ai/claude-code@2.1.88` 中**误传 59.8 MB 源码 .map 文件**，由安全研究员 Chaofan Shou (@Fried_rice) 在 X 上披露。.map 指向 Cloudflare R2 上的 zip，**完整泄漏约 513k 行未混淆 TypeScript（1,906 个文件），即整套 agent harness**。事件 24 小时内 X 上 28.8M 浏览，催生了开源 fork **"Claw Code"**。

**关键发现**（来源：Medium "The Claude Code leak wasn't a prompt leak. It was an agent runtime leak."）：
- 核心 query engine 文件 `QueryEngine.ts` 是 "gravitational center"，负责 Claude answers → Claude reasons → tool exec 的循环；
- Tool registry 在 `src/tools.ts`；
- Interactive runtime 在 `src/main.tsx`（用 Ink/React 渲染 TUI），启动优化包括 keychain prefetch、MDM prefetch；
- Bash 工具有独立 sandbox helper，明确声明 security boundary；
- 多 agent 分解、记忆持久化、permission hook、MCP plugin、远程接口都是**架构特性**而非 prompt 注释。

引用核心结论：

> The prompt matters, but it sits inside a much larger system that decides what to do, what to load, what to ask permission for, what to remember, and how to survive contact with a real developer machine.

**[补充] 代码示例 5：Claude Code system prompt 的核心 XML 段**（已 WebFetch 核验 `asgeirtj/system_prompts_leaks` 收录的 Opus 4.8 版本，2026-05-28）：

```xml
<budget:token_budget>200000</budget:token_budget>
<communication> ... </communication>
<status_update_spec> ... </status_update_spec>
<summary_spec> ... </summary_spec>
<flow> ... </flow>
<tool_calling> ... </tool_calling>
<context_understanding> ... </context_understanding>
<maximize_parallel_tool_calls>
DEFAULT TO PARALLEL: Unless you have a specific reason why operations
MUST be sequential (output of A required for input of B), always
execute multiple tools simultaneously.
</maximize_parallel_tool_calls>
<making_code_changes> ... </making_code_changes>
<code_style> ... </code_style>
<citing_code> ... </citing_code>
<inline_line_numbers> ... </inline_line_numbers>
<markdown_spec> ... </markdown_spec>
```

外加文件新鲜度规则：

> if you want to call `ApplyPatch` on a file that you have not opened with the `Read` tool within your last five (5) messages, you should use the `Read` tool to read the file again before attempting to apply a patch.

这是 Claude Code 独有的 "stale read" 检测，原报告完全缺失。

### 18. VS Code Copilot Agent / GitHub Copilot CLI

**[补充]** `asgeirtj` 收录了 **`VS Code Copilot Agent`（2026-05-21）** 与 **`GitHub Copilot for macOS`（2026-06-18）** 两份 prompt。VS Code Copilot Agent 与 Cursor v1.2 结构高度相似（都是 OpenAI Harmony TS namespace），但额外加入了 `<task_management>` 段（接入 VS Code Task Provider API）。原报告完全没覆盖这两份。

---

## [修正后的] 横向对比表

| 工具 | 词数 | 估算 tokens | Tool 描述格式 | persona 关键词 | 缓存分段 |
|---|---|---|---|---|---|
| Cursor v1.2 | 5,343 | ~7.5k | TS namespace (Harmony) | "pair programming … agent" | 大 static + `<user_info>`/`<project_layout>` |
| Cursor 2.0 / Sep 2025 | 6,361 | ~9k | TS namespace + Harmony 帧 | 同上 | 同上 |
| **[补充] Cursor 2.0 (2025-10-29 leak)** | ~4k | ~5.5k | TS namespace + parallel agent 段 | "Composer agent" | static + AGENTS.md/.mdc rules 动态拼装 |
| Windsurf Cascade Wave 11 | 1,904 | ~2.6k | few-shot 示例 + native FC | "Cascade … AI Flow paradigm" | 强 static + `<user_information>` |
| Devin | 5,553 | ~7.5k | 自定义 XML（裸文本） | "real code-wiz … real computer OS" | 全 static |
| v0 | 7,029 | ~10k | Markdown + PascalCase 伪码 | "v0, Vercel's highly skilled" | 大 static + 当前日期 |
| Continue | <500 默认 | ~150 → 1–3k | 双模（native FC 或 XML 注入） | "in chat/agent/**plan** mode" | 高度模块化 |
| Cline | 7,354 | ~10.5k | 全 XML（in-prompt grammar） | "highly skilled software engineer" | 全 static + SYSTEM INFORMATION |
| Aider | ~250 (editblock) | ~350 | SEARCH/REPLACE 文本 grammar | "expert software developer" | static + repo map dynamic |
| Roo Code | ~8–12k | ~10k+ | native FC（新版）/ XML（旧版） | "You are Roo … highly skilled" | 高度模块化 + environment_details |
| Lovable | 3,203 | ~4.5k | native FC + `lov-*` 渲染标签 | "Lovable, an AI editor" | static + `useful-context` |
| Bolt.new | 2,190 | ~3k | `<boltAction>` XML | "operate in WebContainer" | static + `<bolt_file_selections>` |
| Replit | 1,270 | ~1.8k | 自定义 `<proposed_*>` XML | "Replit Assistant" | 全 static |
| Trae Builder | 2,666 | ~3.8k | native FC + `<mc*>` 引用标签 | "operate exclusively in Trae AI" | static + `<environment>` |
| **[补充] Warp.dev** | ~2.5k | ~3.5k | native FC | "AI agent … in Warp terminal" | static + 无 pager 偏好 |
| **[补充] Kiro (Vibe)** | ~1.5k | ~2k | native FC + MCP | "enhance their ability … letting them lead" | static + steering files dynamic |
| **[补充] Augment Code** | ~3k | ~4.5k | native FC + `<augment_code_snippet>` | "Augment Agent … built on Claude Sonnet 4" | static + codebase-retrieval 结果 dynamic |
| **[补充] Claude Code (Opus 4.8)** | ~4k | ~6k | TS namespace (Harmony) | "Claude Code, Anthropic's official CLI" | static + `<budget>` dynamic |
| **[补充] Manus** | ~2k | ~3k | 模块化能力描述 | "AI assistant … wide range of tasks" | static + 透明能力声明 |

---

## 共性结论（保留原文 1-7 条 + 补充）

1. persona 写法高度同质化（保留）。
2. Tool 描述方式两大阵营（保留）。**[补充]** 第三种"半混合"派愈发主流：Cursor / Claude Code / VS Code Copilot Agent 都用 **TS namespace 描述 schema + 实际走 Harmony function calling**，prompt 里 namespace 块同时承担「文档 + grammar」双重角色，便于 prompt caching。
3. Codebase context 注入策略（保留）。**[补充]** Augment 把 codebase 检索做成"前置 mandate"（任何编辑前必须先 `codebase-retrieval`），这是另一种思路；Continue plan mode 把 "只读" 写进 prompt 而非 IDE 层。
4. git 历史（保留）。**[补充]** Augment 把 "未经许可禁止 commit/push/merge/deploy/install" 写进 prompt 顶级规则，比 Devin 的 `git add .` 限制更严格。
5. 安全 / refusal 措辞（保留）。**[补充]** Devin 的 POP QUIZ 与 Bolt 的 unicode 锚点是反 prompt-injection 的两种极端：前者主动 fuzz 测试模型，后者用 OOV token 当 watermark。
6. 总长度（保留）。**[修正]** 现在区间扩大到 **150 tokens（Continue chat mode）→ 10k+（Claude Code、Cline、v0）**，且最长的工具不一定最强——Continue + 用户 rules 可达到 Claude Code 水平的能力。
7. 缓存分段（保留）。
8. **[补充] 新结论：Agent runtime 比 prompt 重要**。Claude Code 源码泄漏证明：真正决定 agent 能力的是 **QueryEngine + tool registry + permission system + context budgeting**，prompt 只是这套 runtime 的一份配置文件。研究 prompt 而忽略 runtime 会得到失真结论。
9. **[补充] 配置层正在收敛到 AGENTS.md 共识**：Cursor、Claude Code、Codex CLI、Gemini CLI、Continue、Roo 都开始读取项目根目录的 `AGENTS.md` 或 `.agents.md`，作为 system prompt 之后、用户消息之前的 dynamic context 段。这是 2026 年最重要的 cross-vendor 共识。

---

## [补充] 权威引用 / 必读资源

1. **"The Claude Code leak wasn't a prompt leak. It was an agent runtime leak."** — Dave Davies, Medium / Online Inference, 2026-04
   https://medium.com/online-inference/the-claude-code-leak-wasnt-a-prompt-leak-it-was-an-agent-runtime-leak-264eef5be6cc
   行业最广泛引用的 Claude Code .map 泄漏分析，提出 "agent runtime" 视角。

2. **"Comment and Control: Prompt Injection to Credential Theft in Claude Code, Gemini CLI, and GitHub Copilot Agent"** — Aonan Guan
   https://oddguan.com/blog/comment-and-control-prompt-injection-credential-theft-claude-code-gemini-cli-github-copilot/
   实测在三大主流 CLI agent 中利用代码注释 prompt-injection 完成凭据窃取，是研究 agent 安全 prompt 设计的标杆案例。

3. **"Anthropic Claude Code Source Leak"** — Zscaler ThreatLabz, 2026
   https://www.zscaler.com/blogs/security-research/anthropic-claude-code-leak
   企业安全视角分析泄漏影响，包含 npm 包供应链分析。

4. **x1xhlol 仓库 README** — https://github.com/x1xhlol/system-prompts-and-models-of-ai-tools
   141k stars / 501+ commits，2025-10 起每月增加 2-3 个新工具，事实上的「leak 索引」。

5. **asgeirtj/system_prompts_leaks** — https://github.com/asgeirtj/system_prompts_leaks
   43.7k stars，按公司组织（Anthropic / OpenAI / Google / xAI / Microsoft …），最完整的多模态 prompt 库，含 Claude Code Opus 4.8、GPT-5.5 系列等最新泄漏。

6. **bradAGI/awesome-cli-coding-agents** — https://github.com/bradAGI/awesome-cli-coding-agents
   终端原生 agent 与 harness 的精选目录（覆盖 Claude Code、Codex、Gemini CLI、Aider、Pi、OpenCode、Goose），是把"prompt 视角"上升到"harness 视角"的入门导航。

---

## 来源

- [x1xhlol/system-prompts-and-models-of-ai-tools](https://github.com/x1xhlol/system-prompts-and-models-of-ai-tools)（已核验 2026-10-05 状态）
- [jujumilk3/leaked-system-prompts](https://github.com/jujumilk3/leaked-system-prompts)（已核验 2026 文件清单）
- [asgeirtj/system_prompts_leaks](https://github.com/asgeirtj/system_prompts_leaks)（已核验 2026-06 状态）
- [Aider editblock_prompts.py](https://github.com/Aider-AI/aider/blob/main/aider/coders/editblock_prompts.py)（已 WebFetch 核验）
- [Continue defaultSystemMessages.ts](https://github.com/continuedev/continue/blob/main/core/llm/defaultSystemMessages.ts)（已 WebFetch 核验，**[修正] plan mode 已补回**）
- [Roo Code System Prompt Gist (iamhenry)](https://gist.github.com/iamhenry/ed79403fc81e8a1ffaf867d7897f5f71)
- [RooCodeInc/Roo-Code system.ts](https://github.com/RooCodeInc/Roo-Code/blob/main/src/core/prompts/system.ts)
- [Augment Code 整理：Leaked AI System Prompts](https://www.augmentcode.com/learn/leaked-ai-system-prompts-github)
- **[补充]** [Cursor 2.0 changelog & AGENTS.md docs](https://cursor.com/docs/rules)
- **[补充]** [Cursor Composer 2 Technical Report](https://cursor.com/resources/Composer2.pdf)
- **[补充]** [Medium: Claude Code 不是 prompt 泄漏而是 runtime 泄漏](https://medium.com/online-inference/the-claude-code-leak-wasnt-a-prompt-leak-it-was-an-agent-runtime-leak-264eef5be6cc)
- **[补充]** [Zscaler: Claude Code source leak 分析](https://www.zscaler.com/blogs/security-research/anthropic-claude-code-leak)
- **[补充]** [oddguan.com: Comment and Control prompt injection 研究](https://oddguan.com/blog/comment-and-control-prompt-injection-credential-theft-claude-code-gemini-cli-github-copilot/)
