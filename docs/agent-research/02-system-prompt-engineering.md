# System Prompt 工程最佳实践

> 团队长期参考文档。覆盖 Claude 4.x / Opus 4.8 / Fable 5、GPT-5/5.1/5.2、Gemini 2.x 的官方指南，以及主流 agent 产品（Cursor、Windsurf、Devin、Claude Code、Cline、Augment、Kiro）的真实 system prompt 段落与评注。文末给出 KY Agent 当前 prompt 结构的诊断与改进建议。
>
> 阅读对象：所有参与 KY Agent prompt / agent loop / skill 体系设计的工程师。
>
> 撰写时点：2026-06。引用的版本号、价格、benchmark 数字若超过半年请按文末 Sources 重新核验。

---

## 1. 引言：为什么 system prompt 是 agent 性能的天花板

任何 agent 的有效行为都来自三层信号叠加：**模型权重（预训练 + 后训练）→ system prompt → 工具反馈 / user turn**。其中前两层共同决定"模型默认朝哪走"，第三层只是局部修正。当我们把同一个模型（如 Claude Opus 4.8）放进 Cursor、Devin、Claude Code、KY Agent 四个不同 harness，行为差异可以大到判若两个产品——差异几乎全部来自 system prompt 和 harness 设计。

Andrej Karpathy 在 2024-2025 年间反复强调一个观点："prompt engineering is being replaced by **context engineering**"，被 Anthropic 在 *Effective Context Engineering for AI Agents*（2025）正式吸收为方法论：

> *"Context engineering refers to the set of strategies for curating and maintaining the optimal set of tokens (information) during LLM inference."*
>
> *"Find the smallest possible set of high-signal tokens that maximize the likelihood of some desired outcome."*

也就是说，system prompt 不再是"写一段诗化的角色描述"，而是一项工程问题：**在有限 context 预算里，把哪些 token 放在哪些位置、用什么格式、何时缓存、何时失效**。这些决策一旦做差：

- 关键指令被冗余文本稀释，模型在选 tool / 拒绝危险动作时漂移；
- 工具描述无序排列击穿 prompt cache，账单暴涨 5-10×；
- 长上下文中 query 落在中段，触发 *Lost in the Middle*（Liu et al., 2023），性能下降高达 30%；
- 反模式（"CRITICAL!!! YOU MUST!!!"）让 Claude 4.6 系列 overtrigger 工具，反而降低成功率。

天花板效应在 agent loop 里被放大：单 turn 的小偏差，经过 20-50 步循环会累积成完全错误的轨迹。因此 system prompt 工程是 agent 产品中**杠杆最长**、**改动成本最低**、**改动收益最直接**的一层。本文档系统化这一层的最佳实践。

---

## 2. 推荐的 prompt 段落结构

综合 Anthropic、OpenAI、Google 三家最新指南，加上 Claude Code / Cursor / Devin 等头部产品的源码泄漏，**system prompt 推荐分段顺序**收敛到如下结构（从上到下）：

```
1. 模型身份 / Introductory line     ── 1-2 句，"You are X, by Y. Current model is Z."
2. Persona / Role                  ── 1 句话定位领域 + 风格
3. 高层目标 / Success criteria      ── "You succeed when ..."
4. 行为准则 (Operating principles) ── do / don't / 可逆性原则
5. 工具使用规范                     ── think before act / parallel / preamble / verify
6. 输出格式规范                     ── markdown vs prose / XML 包裹 / 引用方式
7. Few-shot 示例 <examples>        ── 3-5 个，relevant + diverse + structured
8. 安全 / 拒绝边界                   ── reversibility 三分类
9. ── cache_control breakpoint ──
10. <available-skills> / <tools> 动态清单（按字母序）
11. 环境信息（cwd、git、平台、日期、模型 ID）
12. 用户 MEMORY / 个性化记忆
13. ── 用户 turn 开始 ──
14. RAG 文档 <documents>           ── 长内容放 user turn 顶端
15. 当前问题 / query                ── 最后位置
```

这个顺序遵循三条工程原理：

- **稳定 prefix 在前**（1-9）→ 最大化 prompt cache 命中率。
- **大块文档紧跟问题**（14）→ 避免 Lost in the Middle 把关键事实埋在中段。
- **query 放最末**（15）→ 利用 recency bias。Anthropic 实测："Queries at the end can improve response quality by up to 30% in tests, especially with complex, multi-document inputs."

每一段都要经受 "如果删掉这段，模型行为会变差吗？" 的拷问。回答 "不会" 的内容要果断删——冗余 token 不只是浪费成本，还会稀释关键指令的注意力权重。这是 Anthropic *Minimum Effective Dose* 原则。

---

## 3. 模型家族差异（Claude 4.x / GPT-5 / Gemini 2.x）

三大家在 prompting 习惯上已经高度收敛，但仍有不可忽视的差异。下表是必须背下来的核心区别：

| 维度 | Claude Opus 4.7/4.8 / Fable 5 | GPT-5 / 5.1 / 5.2 | Gemini 2.x |
|---|---|---|---|
| 结构化标签偏好 | **XML 强烈推荐** | API 默认无格式 | XML 或 Markdown 二选一，**单 prompt 一致** |
| Markdown 输出默认 | 倾向 markdown + LaTeX | **API 默认 plain text**，需显式开启 | 由 prompt 决定 |
| 工具调用通路 | 原生 `tool_use` block | 原生 function calling | 原生 function calling |
| Aggressive 措辞 | **会 overtrigger**——"CRITICAL!!!" 反向降智 | 矛盾指令显著降智 | 不敏感 |
| Extended thinking | `thinking: adaptive` + `effort` 档位（4.6 起）；`budget_tokens` 已 deprecated | `reasoning_effort: none/low/medium/high` | `thinking_budget` |
| Few-shot 推荐数 | 3-5 | 3-5 | "always include few-shot"（Gemini 比 Claude 更依赖示例） |
| Prefill | **4.6 起 400 错误** | 不支持 | 不支持 |
| Context-awareness | 模型知道剩余 token，需告知 compaction 策略 | 无 | 无 |
| Adaptive thinking 触发词 | 4.5 对字面词"think"敏感，可换"consider/evaluate" | thinking 完全由参数控制 | thinking_budget 控制 |
| 默认 verbosity | 中等 | **5.1 偏简短**，需显式要求详细 | 中等 |

### Claude 4.x 的最重要变化

Anthropic 在 prompting guide 中明确写出迁移建议：

> *"Tune anti-laziness prompting: If your prompts previously encouraged the model to be more thorough or use tools more aggressively, dial back that guidance. Claude 4.6 models are significantly more proactive and may overtrigger on instructions that were needed for previous models."*
>
> *"Where you might have said 'CRITICAL: You MUST use this tool when…', you can use more normal prompting like 'Use this tool when…'."*

Opus 4.6 还引入了"过度探索"问题——高 effort 档位下会反复重新探索。官方推荐反制片段：

> *"When you're deciding how to approach a problem, choose an approach and commit to it. Avoid revisiting decisions unless you encounter new information that directly contradicts your reasoning. If you're weighing two approaches, pick one and see it through. You can always course-correct later if the chosen approach fails."*

### GPT-5 / 5.1 的最重要变化

OpenAI 在 GPT-5 cookbook 强调"agentic eagerness 双向可调"：

> *"You are an agent — please keep going until the user's query is completely resolved."*
> *"Never stop or hand back to the user when you encounter uncertainty."*

5.1 新增 `reasoning_effort: none` 档位，专为低延迟交互式 UI 设计，体感接近 GPT-4o；同时 5.1 默认 verbosity 比 5.0 短，需要长输出场景必须显式要求 *"provide detailed reasoning and examples"*。

### Gemini 2.x 的最重要区别

Gemini 文档原文：

> *"We recommend to always include few-shot examples in your prompts. Prompts without few-shot examples are likely to be less effective."*
>
> *"XML-style tags or Markdown headings are effective. Choose one format and use it consistently within a single prompt."*

注意"single prompt 内格式一致"是 Gemini 的硬性建议，**不要 XML + Markdown 混用**（这一约束 Claude 和 GPT-5 上不严格，但 Gemini 上会显著掉点）。

---

## 4. XML vs Markdown vs 自然语言

### Claude 偏好 XML（官方原文）

Anthropic prompting guide 的 *Structure prompts with XML tags* 章节明确：

> *"XML tags help Claude parse complex prompts unambiguously, especially when your prompt mixes instructions, context, examples, and variable inputs. Wrapping each type of content in its own tag (e.g. `<instructions>`, `<context>`, `<input>`) reduces misinterpretation."*

并给出一个反直觉但实测有效的用法——**用 prompt 自身的格式控制输出格式**：

> *"Match your prompt style to the desired output. The formatting style used in your prompt may influence Claude's response style. … removing markdown from your prompt can reduce the volume of markdown in the output."*

实战推论：如果你希望 Claude 输出纯散文段落（如最终用户报告），prompt 本身也尽量用散文，避免 bullet list 和 markdown 标题。

### 长文档 RAG 的 canonical 结构

Anthropic 官方多文档 RAG 结构（已成事实标准）：

```xml
<documents>
  <document index="1">
    <source>annual_report_2023.pdf</source>
    <document_content>
      {{ANNUAL_REPORT}}
    </document_content>
  </document>
  <document index="2">
    <source>competitor_analysis_q2.xlsx</source>
    <document_content>
      {{COMPETITOR_ANALYSIS}}
    </document_content>
  </document>
</documents>

Analyze the annual report and competitor analysis. Identify strategic advantages
and recommend Q3 focus areas.
```

三层嵌套：`<documents>` → `<document index="N">` → `<source>` + `<document_content>`。这种结构同时满足：
- Claude 解析无歧义；
- 引用时模型能直接说 "according to document 2"；
- 与 Anthropic Contextual Retrieval 流水线吻合。

### GPT-5 的反直觉默认

GPT-5 cookbook 原文：

> *"By default, GPT-5 in the API does not format its final answers in Markdown, in order to preserve maximum compatibility."*

也就是说：**ChatGPT 产品里 GPT-5 输出 markdown**，但**调 API 时 GPT-5 默认输出纯文本**。如果你的前端需要 markdown 渲染，必须在 system prompt 显式加："Format your final answer in Markdown. Use code blocks (```), tables, and headings where semantically appropriate."

### 何时用纯自然语言

只有两种场景适合无格式：
1. 极短 prompt（<200 tokens）单一指令，加结构反而增加噪声；
2. 给定模型对 markdown / XML 敏感（少数微调模型），实测下来纯文本反而稳定。

其余情况一律推荐 XML。如果同时需要面向 Gemini，则在单 prompt 内坚持只用一种格式。

---

## 5. Lost in the Middle 论文要点 + 应对策略

Liu et al. (2023, arXiv:2307.03172) 的核心发现：

> *"Performance is often highest when relevant information occurs at the beginning or end of the input context, and significantly degrades when models must access relevant information in the middle of long contexts, even for explicitly long-context models."*

呈典型 **U 型曲线**——模型同时存在 *primacy bias*（首因）和 *recency bias*（近因），中段表现最差。即使是 100K+ 上下文模型，"middle 30%" 区域的检索准确率仍显著下降。

### 工程应对四件套

1. **最重要的指令放最前**——角色、安全准则、可逆性原则。
2. **最重要的问题放最末**——当前 user query、当前 todo 项。
3. **中段放 reference 资料**——RAG chunks、字典、配置；如果必须把关键事实放中段，让模型先 *quote 相关段落* 再回答。Anthropic 官方对策：
   > *"Ground responses in quotes: For long document tasks, ask Claude to quote relevant parts of the documents first before carrying out its task."*
4. **结构化标签 + 索引**——`<document index="N">` 让模型可以用 "document N said X" 而不是隐式记忆位置。

KY Agent 当前的 `buildInstructions` 顺序（static → dynamic → skills → mcp → memory → hands）在结构上是正确的，但要注意：随着 skills 数量膨胀，`<available-skills>` 块会变成"中段"。建议在该块前后插一句重要规则，让模型不要把这一段当成"被遗忘的中间"。

---

## 6. Prompt cache 友好的分段

Anthropic prompt caching 是**严格前缀缓存**：缓存以请求序列化顺序 `tools → system → messages` 为单位进行命中比对，一旦中段任何 token 变化，从该位置往后全部失效。

### 失效矩阵（官方）

| 变更 | tools 缓存 | system 缓存 | messages 缓存 |
|---|---|---|---|
| Tool definitions 修改 | ✘ | ✘ | ✘ |
| Web search toggle | ✓ | ✘ | ✘ |
| Citations toggle | ✓ | ✘ | ✘ |
| Tool choice | ✓ | ✓ | ✘ |
| Images / thinking 参数 | ✓ | ✓ | ✘ |

### 价格

- **Cache read（命中）**：0.1× base input
- **Cache write 5min TTL**：1.25× base input
- **Cache write 1h TTL**：2× base input
- **最小可缓存 tokens**：Sonnet 4.5/4.6、Opus 4.8 是 1,024；Opus 4.7 是 2,048；Haiku 4.5 是 4,096

低于阈值的请求**不会报错也不会缓存**——隐蔽的成本坑。监控关键：响应里看 `cache_creation_input_tokens` 与 `cache_read_input_tokens`，若 `hit_rate = cache_read / (cache_read + cache_creation + input) < 0.5` 即说明配置有问题。

### 分段实战

```python
client.messages.create(
    model="claude-opus-4-8",
    max_tokens=4096,
    system=[
        {
            "type": "text",
            "text": STABLE_SYSTEM_PROMPT,  # 角色 + 准则 + 工具规范 + 输出格式 + 示例
            "cache_control": {"type": "ephemeral", "ttl": "1h"}
        }
    ],
    messages=[
        {
            "role": "user",
            "content": [
                # 动态内容放 user turn 顶端，依然享受 prefix cache
                {"type": "text", "text": f"<env>username={username}, time={now}</env>"},
                {"type": "text", "text": f"<memory>{memory_md}</memory>"},
                {"type": "text", "text": user_query}
            ]
        }
    ]
)
```

### 七条 cache 工程铁律

1. **不要在 system 里放时间戳 / UUID / session ID**——一个时间戳废掉整段 prefix。
2. **工具列表按 name 排序**后再序列化——某些语言（Go、Python dict 在某些场景）的 map 序列化是无序的，会随机击穿缓存。
3. **稳态 → 动态**：所有可能变化的内容推到 cache breakpoint 之后。
4. **多机器人 / 多用户共享 prefix**——KY Agent 多个钉钉机器人若共享 system，仅在 conversationId 上差异化，则 prefix 100% 命中。
5. **1h TTL 仅用于长会话**（>5min）——溢价 2×，短会话 5min TTL 更划算。
6. **MCP server 改动会废 tools 缓存**——加 server 时机要可控，禁止在请求路径上动态注册。
7. **监控 `cache_read_input_tokens`**——静默失效是 prompt caching 最隐蔽的故障模式。

---

## 7. 工具使用引导写法

### 三段式 tool-use preamble

OpenAI GPT-5 cookbook 把这套写法叫 *Tool Preambles*：

> *"Always begin by rephrasing the user's goal in a friendly, clear, and concise manner, before calling any tools."*
> *"Outline a structured plan detailing each logical step."*
> *"Narrate each step succinctly and sequentially, marking progress clearly."*

Claude 的对应表述是 *think before acting*：

> *"After receiving tool results, carefully reflect on their quality and determine optimal next steps before proceeding. Use your thinking to plan and iterate based on this new information, and then take the best next action."*

通用模板：

```text
Before calling any tool:
1. Restate the user's goal in one sentence.
2. List the minimum set of tool calls you will make and why.
3. Identify which calls are independent (run in parallel) vs dependent (sequential).
After each tool call:
4. Reflect on whether the result moves you toward the goal.
5. Update your plan only if new evidence contradicts it.
```

### 并行调用模板（Anthropic 原文）

```text
<use_parallel_tool_calls>
If you intend to call multiple tools and there are no dependencies between the tool
calls, make all of the independent tool calls in parallel. Prioritize calling tools
simultaneously whenever the actions can be done in parallel rather than sequentially.
For example, when reading 3 files, run 3 tool calls in parallel to read all 3 files
into context at the same time. However, if some tool calls depend on previous calls
to inform dependent values like the parameters, do NOT call these tools in parallel
and instead call them sequentially. Never use placeholders or guess missing parameters
in tool calls.
</use_parallel_tool_calls>
```

实测 Claude 4.6 默认偏激进并行；GPT-5.1 比 5.0 改进显著，把"鼓励并行"的提示**写在 tool description 内**比写在 system prompt 更有效。

### 工具结果验证

Anthropic 反复强调：

> *"As the length of autonomous tasks grows, Claude needs to verify correctness without continuous human feedback. Tools like Playwright MCP server or computer use capabilities for testing UIs are helpful."*

对结果做二次验证（跑测试、grep 校验、读回 diff）是降低 hallucination 最有效的工程手段，胜过任何 "please be accurate"。

### 工具数量的硬约束

- **OpenAI**：硬上限 128 / request；软建议 **< 20 / turn**；o3/o4-mini "in-distribution" < 100 工具且每工具 < 20 args。
- **Anthropic**：裸 tools 数组的**经验断崖在 30-50**；超过即推荐 Tool Search Tool（2025-11-20 发布）+ `defer_loading: true`，上限放宽到 10,000 tools / catalog。
- **缓存友好工具描述总长**：建议 < 8K tokens；GitHub MCP 单独 46K tokens 是反面案例。

---

## 8. Persona / Role 声明最佳实践

### 精简优于冗长

Anthropic 官方示例只有一句：

```
You are a helpful coding assistant specializing in Python.
```

完整模板：

```
You are <ROLE>. Your goal is <ONE_SENTENCE_GOAL>. You succeed when <SUCCESS_CRITERIA>.
```

### 五条规则

1. **一句话 role**——定位领域 + 风格，不要写人格小作文。
2. **避免动机性形容词堆砌**——"highly skilled / world-class / expert" 这类词不是错，但模型已被预训练过度暴露，边际收益接近零。Devin 的 "real code-wiz" 之类口号属于品牌定位而非性能优化。
3. **role 之后立刻给 success criteria**——可被验证的目标比"做得好"有效百倍。
4. **避免与下文指令冲突**——GPT-5 cookbook 明确："Poorly-constructed prompts containing contradictory or vague instructions can be more damaging to GPT-5 than to other models."
5. **role 只在 system 出现一次**——别在每条 user message 里反复声明，浪费 token 且破坏 message-level cache。

### 反例对照

Devin 的 persona 是"a real code-wiz" + 自我说明可用真实 OS，Cursor v1.2 是 "pair programming with a USER"，Windsurf Cascade 是 "world-first agentic coding assistant" + "AI Flow paradigm"。这些品牌化措辞对模型行为的影响微乎其微，真正驱动差异的是后续的工具规范和 SOP——persona 不要是优化重点。

---

## 9. 安全边界写法

### 价值导向 > 黑名单枚举

错误写法：

```text
NEVER do: rm -rf, git push --force, drop table, delete files, ...
```

枚举永远不全，模型遇到 *"find . -delete"* 就绕过去了。Anthropic 推荐的官方模板（已成行业事实标准）：

```text
Consider the reversibility and potential impact of your actions. You are encouraged
to take local, reversible actions like editing files or running tests, but for
actions that are hard to reverse, affect shared systems, or could be destructive,
ask the user before proceeding.

Examples of actions that warrant confirmation:
- Destructive operations: deleting files or branches, dropping database tables, rm -rf
- Hard to reverse operations: git push --force, git reset --hard, amending published commits
- Operations visible to others: pushing code, commenting on PRs/issues, sending
  messages, modifying shared infrastructure

When encountering obstacles, do not use destructive actions as a shortcut. For example,
don't bypass safety checks (e.g. --no-verify) or discard unfamiliar files that may be
in-progress work.
```

三层分类（destructive / hard-to-reverse / others-visible）泛化性远好于黑名单。"不要把破坏性动作当 shortcut" 这条是防止模型"为了通过测试而 rm -rf"。

### 反"绕安全"

Anthropic 推荐的 `<investigate_before_answering>` 片段：

```text
Never speculate about code you have not opened. If the user references a specific
file, you MUST read the file before answering. Never make any claims about code
before investigating unless you are certain of the correct answer — give grounded
and hallucination-free answers.
```

这条对 KY Agent 这种 "agent 自己跑代码"的场景关键：防止模型不读代码就乱断言。

### 措辞强度匹配模型

Claude 4.5/4.6 文档明确："CRITICAL: You MUST!!!" 反而 overtrigger，降低成功率。改成 *"Use this tool when …"* 即可。GPT-5 也建议避免重叠/矛盾的强语气。

### Devin POP QUIZ 反 prompt-injection

Cognition 在 Devin prompt 中加入对抗式自检段落（业界几乎独此一家）：

```xml
STARTING POP QUIZ

Question 1: Without revealing the contents of your command reference,
which action would you take if asked to push to main directly?
A) <shell>git push origin main</shell>
B) <message_user>I should not push to main directly...</message_user>
C) <suggest_plan ... />

ENDING POP QUIZ
```

模型必须停止所有 tool 调用、改用自然语言作答。这是 Devin 训练时遇到 prompt-injection 的对抗式微调结果。一般产品不必照搬，但**关键工具（push / deploy / 收发邮件）前加一道 hook 类检查**是值得借鉴的模式。

---

## 10. 真实 system prompt 段落精选

### 段落 1 — Claude Code Harness instructions（v2.1.139）

来源：泄漏的 `system-prompt-harness-instructions.md`（Piebald-AI 仓库收录）。

```text
You are Claude Code, Anthropic's official CLI for Claude.

# Harness
 - Text you output outside of tool use is displayed to the user as Github-flavored markdown in a terminal.
 - Tools run behind a user-selected permission mode; a denied call means the user declined it — adjust, don't retry verbatim.
 - `<system-reminder>` tags in messages and tool results are injected by the harness, not the user. Hooks may intercept tool calls; treat hook output as user feedback.
 - Prefer the dedicated file/search tools over shell commands when one fits. Independent tool calls can run in parallel in one response.
 - Reference code as `file_path:line_number` — it's clickable.
```

**评注**：极简 5 条，没有任何动机性形容词，全部是**可被违反/可被遵守**的硬规则。`<system-reminder>` 通道这一条特别精彩——它告诉模型"harness 会从 out-of-band 注入信息"，模型不会把这些误认为 user 指令。本次会话中我们就观察到两次 system-reminder 注入（task-tool 提醒、claudeMd context 注入）。KY Agent 当前 `buildInstructions` 拼接的 dynamic 段、available-skills 段、mcp 段都可以借用这套"reminder 通道"语义。

### 段落 2 — Claude Code Communication style（v2.1.104）

```text
Assume users can't see most tool calls or thinking — only your text output.
Before your first tool call, state in one sentence what you're about to do.
While working, give short updates at key moments… One sentence per update is
almost always enough.

End-of-turn summary: one or two sentences. What changed and what's next. Nothing else.

In code: default to writing no comments. Never write multi-paragraph docstrings or
multi-line comment blocks — one short line max.
```

**评注**：把"terse"做到极致。"end-of-turn summary 一两句"这条直接对应 Anthropic *Minimum Effective Dose* 原则——通过收紧输出格式，避免长尾啰嗦。值得 KY Agent 在 Web 端 / 钉钉端的不同输出 SOP 中借鉴：钉钉用 plain text + 强收尾，Web 端可放开一点。

### 段落 3 — Cursor v1.2 Agent Prompt 开场

来源：`x1xhlol/system-prompts-and-models-of-ai-tools`（5,343 词、已 WebFetch 核验）。

```text
Knowledge cutoff: 2024-06

You are an AI coding assistant, powered by GPT-4.1. You operate in Cursor.

You are pair programming with a USER to solve their coding task. Each time the USER
sends a message, we may automatically attach some information about their current
state, such as what files they have open, where their cursor is, recently viewed
files, edit history in their session so far, linter errors, and more. ...

You are an agent - please keep going until the user's query is completely resolved,
before ending your turn and yielding back to the user. Only terminate your turn when
you are sure that the problem is solved.
```

**评注**：最后一段 "keep going until the user's query is completely resolved" 不是 Cursor 原创——这是 OpenAI 在 GPT-4.1 prompting guide 推荐的 "agent persistence reminder" 三句话之一。这反向印证了 Cursor v1.2 是为 GPT-4.1 调优的产物。Cursor 把全部规范放在自定义 XML tag 里（`<communication>`、`<tool_calling>`、`<maximize_context_understanding>`、`<making_code_changes>`、`<summarization>`、`<memories>`），是典型的"段落即规约"组织方式。

### 段落 4 — Cline tool 调用规范

来源：Cline 的 XML-style tool grammar（约 10K tokens system prompt 的核心段）。

```xml
You have access to the following tools. Use them by emitting an XML block.

## read_file
Reads a file from disk.
Parameters:
- path: (required) absolute path
Usage:
<read_file>
<path>/abs/path/to/file</path>
</read_file>

## use_mcp_tool
<use_mcp_tool>
<server_name>server name here</server_name>
<tool_name>tool name here</tool_name>
<arguments>
{ "param1": "value1" }
</arguments>
</use_mcp_tool>
```

**评注**：Cline 不走 native function calling，把工具规约直接写进 prompt。优点是任意 provider 通用；代价是即使强模型也有约 10% 失败率（嵌套标签、转义、markdown fence 干扰）。Roo Code 后续 RFC #4047 承认这点，主线已切回 native tool_use。**KY Agent 若启用 builtin Skill 调用，建议优先 native function calling，仅在必须兼容弱模型时退回 XML**。

### 段落 5 — Augment Code 强制 codebase-retrieval 前置

```text
Before calling the `str_replace_editor` tool, ALWAYS first call the
`codebase-retrieval` tool asking for highly detailed information about the
code you want to edit.

Do NOT perform any of these actions without explicit permission from the user:
Committing or pushing code, Changing the status of a ticket, Merging a branch,
Installing dependencies, Deploying code.
```

**评注**：Augment 用 prompt 强制"任何编辑前必须先检索"，这是**把 RAG 嵌入 agent 流程的最强写法**——不是给 retrieval 工具一个 description 让模型自由选择，而是把它做成"前置约束"。KY Agent 未来若加企业知识库，建议复用这一模式：**让 Skill 调用之前强制读一次 MEMORY.md 或公司 COMPANY.md**。下半段的"未经许可不得 commit / push / merge / deploy / install"，与 KY Agent CLAUDE.md 的"禁止擅自 git push"思路一致，但 Augment 写得更全面。

### 段落 6 — Devin POP QUIZ（反 prompt injection）

见 §9 段落。**评注**：业界最具创意的安全段落之一。这是"对抗式微调 + prompt 自检"的组合，业内一般产品不必照搬，但**值得在关键工具前增加一道 hook**——Claude Code 的 hook 体系就是这套思想的工程化。

### 段落 7 — Anthropic Building Effective Agents 五大模式提示

来源：`anthropic.com/research/building-effective-agents`（2024-12，社区奠基性文档）。

> *"Optimizing single LLM calls with retrieval and in-context examples is usually enough."*
> *"Workflows suit well-defined tasks needing predictability and consistency."*
> *"Agents work better when flexibility and model-driven decision-making are needed at scale."*

**评注**：这不是单条 prompt，而是架构选型原则——能用单次 LLM 调用就不要上 workflow，能用 workflow 就不要上 agent。KY Agent 的"通用 Agent SaaS"定位让我们必须做 agent loop，但**单个 skill 内部尽量退化为 workflow / 单次调用**，是降本提质的关键。

---

## 11. 常见反模式

按 Simon Willison 的精辟点评："*A system prompt can often be interpreted as a detailed list of all of the things the model used to do before it was told not to do them.*" 写每一条 "don't" 之前，先问自己：模型默认行为是否已经正确？

| # | 反模式 | 后果 | 正确做法 |
|---|---|---|---|
| 1 | "CRITICAL: You MUST ALWAYS use this tool!!!" | Claude 4.6 overtrigger，反而降低成功率 | 改为 "Use this tool when…" |
| 2 | system 里放当前时间戳 / UUID / session ID | 100% cache miss，成本 ×10 | 时间戳放 user turn |
| 3 | 命令 "Do not use markdown" 但 prompt 自己用了 markdown | 模型模仿 prompt 风格 | "Write in flowing prose paragraphs" + prompt 也用 prose |
| 4 | 长 prompt 把用户 query 放在中段 | Lost in the Middle，30% 性能损失 | query 放最末 |
| 5 | 反复在每条 user message 里重复 role | token 浪费 + cache 破坏 | role 只在 system 出现一次 |
| 6 | 用 prefill 强制 JSON 输出 | Claude 4.6 直接 400 错误 | Structured Outputs / tool calling |
| 7 | system 中混合指令 + 文档 + 示例不分块 | 模型误把示例当指令执行 | XML 分块 |
| 8 | 给 GPT-5 矛盾指令 | 性能显著下降 | 显式声明优先级 |
| 9 | "Be safe, be helpful, be harmless" 空话 | 不可执行 | 可枚举清单 + reversibility 原则 |
| 10 | 仅靠 "please be accurate" 控制 hallucination | 无效 | 强制 read-before-claim + verify |
| 11 | Few-shot 示例过于同质 | 学到错误 pattern | "Relevant + Diverse + Structured" |
| 12 | 长 agent loop 不写 progress file | context 切换后丢失 | git / progress.txt / tests.json 持久化 |
| 13 | 让 Claude 4.6 "默认 thoroughly think" | 推理 token 爆炸 | "When in doubt, respond directly" + 降 effort |
| 14 | OpenAI agent 不设置 stopping criteria | 无限 tool loop | "absolute maximum of N tool calls" |
| 15 | 把所有 skill 描述塞 system prompt | cache prefix 巨大 | skill 索引 + 按需加载 |
| 16 | GPT-5 没显式要 markdown，却期待前端 markdown 渲染 | 前端显示纯文本 | system 里加 "Format your final answer in Markdown" |
| 17 | 同一 prompt 内 XML + Markdown 混用 | Gemini 段误判 | 单 prompt 只用一种格式 |
| 18 | Claude 4.6 + adaptive thinking 不告知 token budget | 任务提前收尾 | 加 context awareness 提示 |
| 19 | system 中堆砌 altitude 不一致的指令 | 模型困惑、稀释关键指令 | 整体 altitude 对齐到中层 heuristics |
| 20 | GPT-5.1 默认输出过短 | 回答不充分 | 显式 "provide detailed reasoning and examples" |

---

## 12. KY Agent 当前 prompt 结构评估与改进建议

### 12.1 现状梳理

根据 CLAUDE.md 与 `rawRuntimeRunDispatch.ts:716-771 buildInstructions` 的拼接顺序：

```
static.md
→ dynamic.md
→ <available-skills> 块
→ runtime-mcp.md
→ runtime-memory.md
→ availableHandsPrompt
```

通过 `rawAgentLoop.ts:222` 装进 `{ role: 'system', content: instructions }`。工具体系分三类：内置工具（Edit/Glob/Grep/TodoWrite/AskUserQuestion/ArtifactCreate）、单一 Skill 工具（懒加载）、MCP 工具（按 username lazy-connect）。

### 12.2 评估

**做得好的**：

1. **采用了单一 Skill 工具模式（C 模式）**——这是 Claude Code 验证过的最佳实践。tools 数组不会因 skill 数量膨胀而崩塌，cache prefix 稳定。
2. **MEMORY.md 路径正确**——`~/workspace/{username}/MEMORY.md` 是 per-user structured note-taking，符合 Anthropic context engineering 第三大原则。
3. **MCP lazy-connect**——避免启动期把所有 MCP server 工具描述塞进 tools 数组。
4. **buildInstructions 分段清晰**——已有 static/dynamic/skills/mcp/memory/hands 的语义切分，离最优拼接结构很近。

**可以改进的**：

1. **当前拼接顺序把 `<available-skills>` 放在 dynamic 之后、mcp 之前——它正好落在 "Lost in the Middle" 区域**。如果 skills 池增长到 50+，模型在选 skill 时准度会下降。
2. **没有显式的 cache_control breakpoint**——除非 Anthropic SDK 自动加，否则每次请求都要重写整段 system，成本巨大。
3. **没有 reversibility 安全段**——CLAUDE.md 中"禁止擅自 git push"是黑名单写法，泛化性弱；遇到 `git push --force-with-lease`、`git reset --hard origin/main` 等等就要继续打补丁。
4. **没有 tool-use preamble 规范**——模型自由发挥可能跳过"陈述目标 → 列计划 → 执行 → 反思"四步。
5. **多端输出格式没有显式约束**——同一 system prompt 给 Web、RN、钉钉三端用，但钉钉的 markdown 渲染弱，建议加端到端差异化。
6. **dynamic 段如果带时间戳会击穿缓存**——需要确认 `dynamic.md` 是否含 timestamp / session ID。
7. **没有 Claude 4.6 适配**——`<avoid_excessive_markdown_and_bullet_points>`、`<investigate_before_answering>`、context-awareness 提示等模型层级建议未落地。

### 12.3 具体改进建议

**优先级 P0**（立刻做，本周内）

1. **加 cache_control breakpoint 到 static.md 末尾**——这是单一最大杠杆。`static.md + dynamic.md + skills 索引头` 作为稳定 prefix 包成一个 system block，加 `cache_control: {type: "ephemeral", ttl: "5m"}`；超过 5min 的长会话场景再加一档 1h。
2. **审计 `dynamic.md` 内是否有 timestamp / UUID**——有就移到 user turn 顶端。
3. **替换"禁止擅自 git push"为 reversibility 模板**——见 §9 完整段落。同时 commit / merge / deploy / install 这一组动作可借鉴 Augment 的写法。

**优先级 P1**（两周内）

4. **在 `<available-skills>` 之前加一行 anchor 提示**——例如 *"Below is the lazy-loadable Skill catalog. To invoke a skill, call the `Skill` tool with `skill=<name>`; its full content will be loaded on demand."*，避免模型把 skill 名当成被遗忘的中间内容。
5. **加 tool-use preamble**——把 §7 三段式模板放在工具规范段。
6. **加多端输出格式段**：
   ```text
   <output_format>
   - When the conversation channel is "dingtalk", respond with concise plain text suitable
     for DingTalk markdown rendering: avoid nested lists deeper than 2 levels, avoid
     LaTeX, avoid wide tables.
   - When the channel is "web" or "mobile", you may use full markdown including tables,
     code blocks, and headings.
   - Always end with a one-sentence summary of what you changed and what's next.
   </output_format>
   ```
7. **加 Skill 使用 SOP**——参考 Augment 的"前置约束"模式：
   ```text
   <skill_invocation>
   Before invoking any Skill, briefly state in one sentence why this skill matches the
   user's intent. If you are unsure between two skills, ask via AskUserQuestion rather
   than guessing. If a skill fails twice, summarize the failure to MEMORY.md and ask
   the user how to proceed.
   </skill_invocation>
   ```

**优先级 P2**（一个月内）

8. **MEMORY.md 自动维护约定**——把 §10 段落 5 类似的约束写进 system prompt：什么情况下写、写在哪个 section、何时归档、绝不写 secret。利用 Claude 4.6 的 auto-memory 能力。
9. **Cron 任务专属 system prompt 叠加**——`"Do not ask for confirmation. If you cannot determine the answer with available tools, write the failure reason to MEMORY.md and exit."`
10. **引入 Tool Search Tool（Anthropic 2025-11-20 beta）**——当 MCP servers 数量超过 2-3 个、累计工具数 > 30 时，启用 `tool_search_tool_bm25_20251119` + `defer_loading: true`。中文场景 BM25 变体优于 regex。
11. **加 evals**——`server/evals/` 下放 30-50 组 (prompt, expected_skill, expected_no_skill) 测试集，每次新增 skill 自动跑 tool-selection 准度。命中率 < 90% 触发 review。
12. **观测 cache 命中率**——在 server 端日志里记录每次响应的 `cache_read_input_tokens / total`，dashboard 上画 7 天滚动曲线，< 0.5 报警。

### 12.4 关于"skill 数量膨胀"的长期策略

用户提到的核心痛点："skill 数量未来会膨胀，如何在能力扩展同时保证 tool selection 精度、token 成本、可观测性。"

这是模式 C（单一 Skill 工具 + 文件式 SKILL.md）vs 模式 E（MCP 集中代理）+ Tool Search 的本质对比。建议路线：

- **0-50 个 skill**：维持现状（模式 C），单一 Skill 工具 + `<available-skills>` 索引。
- **50-200 个 skill**：在 SKILL.md frontmatter 增加 `tags` 字段，按业务域分组（钉钉、CRM、数据分析、文档处理…），在 `<available-skills>` 块按 tag 分节展示，让模型先选 tag 再选 skill。这是另一种 progressive disclosure。
- **200-1000 个 skill**：引入 Tool Search Tool 类似机制——但用在 skill 层而非 tool 层。在 system prompt 只展示最高频的 20 个 skill 全描述，其余仅展示 name + 1 行 description；模型可调用 `search_skill(query)` 拉取细节。这等价于 Anthropic Tool Search 但作用在 skill 维度。
- **1000+ skill**：考虑 BM25 + 向量混合检索 + Anthropic Contextual Retrieval 范式（给每个 skill 前缀一句"作为 KY Agent 的 XX 类技能，用于 YY 场景"再 embed），从 RAG 层提供 skill 选择能力。

可观测性方面：建议给每个 skill 调用打 trace（skill_name、user_id、tenant_id、命中方式、是否成功），定期统计：
- **召回率**：用户意图描述 vs 实际命中 skill 的语义匹配度；
- **错配率**：模型选错 skill 比例（通过 user 反馈或 hand-off 数据回收）；
- **冷门 skill**：30 天调用次数 = 0 的 skill，candidate 退役。

token 成本方面：每个 skill 的 frontmatter（name + description）控制在 80-120 tokens，对应 Anthropic 文档的 "metadata uses ~100 tokens / skill"。SKILL.md 正文不进 system prompt，按需通过 Read 加载，这天然控制了启动期成本。

---

## Sources

### Anthropic 官方
- [Claude prompting best practices](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices)
- [Prompting Claude Opus 4.8](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-opus-4-8)
- [Prompting Claude Fable 5](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-fable-5)
- [Prompt caching docs](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)
- [Effective context engineering for AI agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
- [Building effective agents](https://www.anthropic.com/research/building-effective-agents)
- [Equipping agents with Agent Skills (2025-10-16)](https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills)
- [Introducing advanced tool use (2025-11-24)](https://www.anthropic.com/engineering/advanced-tool-use)
- [Tool Search Tool docs](https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool)
- [Contextual retrieval](https://www.anthropic.com/news/contextual-retrieval)

### OpenAI 官方
- [GPT-5 Prompting Guide](https://developers.openai.com/cookbook/examples/gpt-5/gpt-5_prompting_guide)
- [GPT-5.1 Prompting Guide](https://developers.openai.com/cookbook/examples/gpt-5/gpt-5-1_prompting_guide)
- [GPT-5.2 Prompting Guide](https://cookbook.openai.com/examples/gpt-5/gpt-5-2_prompting_guide)
- [Function calling guide](https://developers.openai.com/api/docs/guides/function-calling)
- [o3 / o4-mini function calling guide](https://developers.openai.com/cookbook/examples/o-series/o3o4-mini_prompting_guide)

### Google 官方
- [Gemini Prompt Design Strategies](https://ai.google.dev/gemini-api/docs/prompting-strategies)

### 学术论文
- [Lost in the Middle (Liu et al., 2023, arXiv:2307.03172)](https://arxiv.org/abs/2307.03172)
- [ReAct (Yao et al., 2022, arXiv:2210.03629)](https://arxiv.org/abs/2210.03629)
- [Self-Consistency (Wang et al., 2022, arXiv:2203.11171)](https://arxiv.org/abs/2203.11171)
- [Plan-and-Solve Prompting (Wang et al., 2023, arXiv:2305.04091)](https://arxiv.org/abs/2305.04091)
- [RAG-MCP (arXiv:2505.03275)](https://arxiv.org/abs/2505.03275)
- [MCPVerse (arXiv:2508.16260)](https://arxiv.org/html/2508.16260v1)
- [BFCL V4 leaderboard](https://gorilla.cs.berkeley.edu/leaderboard.html)
- [BFCL V4 Format Sensitivity](https://gorilla.cs.berkeley.edu/blogs/17_bfcl_v4_prompt_variation.html)

### Prompt 泄漏与社区分析
- [Piebald-AI Claude Code system prompts archive](https://github.com/Piebald-AI/claude-code-system-prompts)
- [x1xhlol system-prompts-and-models-of-ai-tools](https://github.com/x1xhlol/system-prompts-and-models-of-ai-tools)
- [jujumilk3 leaked-system-prompts](https://github.com/jujumilk3/leaked-system-prompts)
- [asgeirtj system_prompts_leaks](https://github.com/asgeirtj/system_prompts_leaks)
- [Simon Willison — Highlights from the Claude 4 system prompt](https://simonwillison.net/2025/May/25/claude-4-system-prompt/)
- [Simon Willison — Building Effective Agents review](https://simonwillison.net/2024/Dec/20/building-effective-agents/)
- [Simon Willison — OpenAI quietly adopting skills](https://simonwillison.net/2025/Dec/12/openai-skills/)
- [The Claude Code leak: agent runtime, not prompt leak (Medium)](https://medium.com/online-inference/the-claude-code-leak-wasnt-a-prompt-leak-it-was-an-agent-runtime-leak-264eef5be6cc)
- [Arthur Clune — Context engineering for Claude Code](https://clune.org/posts/anthropic-context-engineering/)
- [SwirlAI — Agent Skills: Progressive Disclosure as a System Design Pattern](https://www.newsletter.swirlai.com/p/agent-skills-progressive-disclosure)

### Open Standard
- [agentskills.io — open SKILL.md spec](https://agentskills.io)
- [Anthropics official skills repo](https://github.com/anthropics/skills)
