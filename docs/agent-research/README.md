# KY Agent 架构调研文档集

本目录是一次大型多 agent 调研工作流（`agent-architecture-deep-research`，24 个 subagent / 191 万 token / 482 次 tool 调用）的产出，回应了一个核心问题：

> 业界主流 agent 框架（Claude Code、Cursor、Windsurf、LangChain/LangGraph、Dify、Cline、OpenHands、smolagents 等）究竟是怎么把 **tools / skills / MCP servers** 注入到 LLM 上下文里的？我们的 KY Agent 现在的做法处在哪个位置？接下来怎么演进？

## 阅读顺序

| 顺序 | 文档 | 一句话定位 |
|---|---|---|
| ① | [04-ky-agent-recommendations.md](./04-ky-agent-recommendations.md) | **先看这份** — 直接对当前架构（含 file_path:line_number）给出短期 / 中期 / 长期改进清单 |
| ② | [01-tool-injection-patterns.md](./01-tool-injection-patterns.md) | 七种工具注入模式（A-G）横向对比 + 真实框架案例 + 选型决策树 |
| ③ | [02-system-prompt-engineering.md](./02-system-prompt-engineering.md) | System prompt 工程实战（分段顺序、prompt cache、XML vs Markdown、真实泄漏样本） |
| ④ | [03-enterprise-agent-framework.md](./03-enterprise-agent-framework.md) | 企业级 agent 框架（多组织隔离、memory 系统、公司知识、持续更新） |

## 原始调研报告（深度考据用）

`raw/` 子目录是 10 个调研维度的完整原始报告（每份 19k-39k 字符）。合成文档已经从中抽取，但如果要查具体代码片段、原文引用、URL 来源，直接看 raw。

| 维度 | 文件 | 涵盖范围 |
|---|---|---|
| Claude Code 内部 | [raw/claude-code-internals.md](./raw/claude-code-internals.md) | Skills 三级 progressive disclosure、harness instructions、CLAUDE.md 加载、hooks、subagents、MCP 集成、memory |
| 主流 IDE 泄漏 | [raw/leaked-system-prompts.md](./raw/leaked-system-prompts.md) | Cursor / Windsurf / Devin / v0 / Cline / Lovable / Bolt / Replit / Trae 等 system prompt 原文 |
| LangChain/LangGraph | [raw/langchain-langgraph.md](./raw/langchain-langgraph.md) | @tool 装饰器、create_react_agent、ChatPromptTemplate、BaseStore long-term memory、MCP adapters |
| Dify / Coze / FastGPT | [raw/dify-coze-fastgpt.md](./raw/dify-coze-fastgpt.md) | Agent App、workflow-as-tool、RAG 嵌入、多组织、企业特性 |
| MCP 协议深度 | [raw/mcp-protocol-deep.md](./raw/mcp-protocol-deep.md) | 协议规范、transports（stdio / streamable HTTP）、OAuth、Elicitation、registries |
| 长期记忆系统 | [raw/memory-systems.md](./raw/memory-systems.md) | mem0 / Letta / Zep / Graphiti / Cognee / LangGraph BaseStore 对比与基准 |
| 企业知识库 | [raw/enterprise-knowledge.md](./raw/enterprise-knowledge.md) | 静态注入 vs 动态 RAG、CDC 持续更新、Glean / Notion AI / Cohere Compass |
| 新兴 agent 框架 | [raw/newer-agent-frameworks.md](./raw/newer-agent-frameworks.md) | OpenHands / smolagents / OpenManus / Aider / Continue / Cline / Roo Code / Hermes / AutoGen / CrewAI |
| Prompt 工程 | [raw/prompt-engineering-best-practices.md](./raw/prompt-engineering-best-practices.md) | Anthropic / OpenAI / Gemini 官方指南、Lost in the Middle、XML 偏好、prompt cache、反模式 |
| 工具注入模式 | [raw/tool-injection-patterns.md](./raw/tool-injection-patterns.md) | A-G 七种模式 + BFCL 数据 + Anthropic Tool Search Tool 阈值证据 |

## 关键结论速览

1. **KY Agent 当前用的"统一 Skill 工具 + system prompt 名单 + SKILL.md 懒加载"是模式 C**，与 Claude Code 同构，2025 年底已成为 Anthropic / OpenAI Codex CLI / Cursor 共同采纳的事实标准。**保留**。
2. **当前最大的隐性成本**：`rawAgentLoop.ts:222` 直接传 `{ role: 'system', content: ... }`，没有 `cache_control` breakpoint，每次请求 input 成本接近全价。改造成本 1-2 小时，收益 60-70% input 成本下降。
3. **当前最大的认知风险**：没有 eval 集，新增 skill 时无法回归检查 tool selection 精度。
4. **skill 数量到 50+ 之前不会爆**，但是要预留 Anthropic Tool Search Tool（2025-11）和 RAG-MCP（论文）的接入路径。
5. **公司知识层（COMPANY.md / SOP / 红线）目前缺失**，是企业客户化部署的必备前置。
6. **Memory 系统**当前是静态 MEMORY.md，调研显示 mem0 (LongMemEval 94.4%) 已经显著领先纯文件方案 (49%)，但作为中期演进项而非现在动手。

## 工作流元信息

- Run ID: `wf_32f9fd2b-889`
- Agent count: 24（10 discover + 10 verify + 4 synth）
- Tokens: 1,911,539
- Duration: 26 分 41 秒
- Effort: high（除 verify 外）
- Phases: Research（pipeline: discover → adversarial verify）→ Synthesis（4 parallel writers）
