# Dify / Coze（扣子）/ FastGPT / Bisheng 等 LLMOps 平台

> 这是工作流 Research 阶段（discover + adversarial verify）的完整原始调研报告。已经被合成进 `../01-04` 系列文档，这里保留全文便于深入考据。

---

I have sufficient verified data. Now I'll produce the expanded report.

# 国内外 LLMOps 平台 Agent 体系深度调研（核验与扩充版）

> 调研范围：Dify、Coze（字节扣子，国内 + coze.com 国际版 + coze-studio 开源版）、FastGPT、Bisheng（毕昇）、QAnything（网易有道）、MaxKB（飞致云）
> 维度：Agent 推理范式、工具体系、Prompt 模板、RAG 嵌入、多模型适配、企业级能力、记忆机制、企业知识持续更新
> **[补充]** 本次核验时点：2026-06，主要对 2025 H2 ~ 2026 H1 的版本演进做了交叉验证。验证方法：抽样 WebFetch 官方博客 / GitHub README / Release Notes，并对照社区横评。

---

## 一、Dify（langgenius）

**总体定位**：Dify 把自己定义为「Production-ready Agentic Workflow 平台」，过去两年从「LLMOps 一站式套件」彻底重构为「以 Workflow 为骨架、以 Agent Node 为大脑、以 Plugin Marketplace 为肌肉」的三层架构。其最大特征是**双形态融合**：一个 App 既可以是纯 Chat/Agent 模式（端到端的 ReAct/FC 循环），也可以作为 Workflow 中的一个「Agent 节点」嵌入到固定的 DAG 流程里，从而在「确定性」与「自主性」之间做权衡。

1. **Agent App 设计**：Dify 同时内置 **Function Calling** 与 **ReAct** 两套推理策略（Agent Strategy）。**[修正]** Agent Node 并非"1.x 之后"才出现的模糊概念——根据官方博客其首发于 **2025 年 3 月（v1.x 早期）**，正式名称为 "Agent Node"，默认 `max_iterations = 5`（不是无限制，也不是经验值；社区常见误抄为 10）。当所选模型支持原生 tool_choice 时优先走 Function Calling 路径——LLM 直接输出结构化的 tool_call JSON、Dify 执行、回填 observation；当模型不支持原生 FC（例如部分本地 Qwen、Llama 微调版），自动降级到 ReAct，用 `Thought / Action / Action Input / Observation` 文本协议解析。**[补充]** Agent Strategy 本身已被插件化：除官方内置的 ReAct / Function Calling 两个 Strategy 插件外，社区已经发布了 `junjiem/mcp_sse_agent`、`hjlarry/mcp_agent`、`3dify-project/dify-mcp-client`（甚至支持 UI-TARS-SDK 做 GUI Agent）等多个第三方 Agent Strategy，让你可以**自定义"思考-行动"协议**而不必改 Dify 源码——这是 1.0 后插件化架构的核心红利。

2. **Tools 配置**：三类来源——(a) 内置 50+ 工具；(b) 自定义 HTTP 工具（粘 OpenAPI/Swagger 即生成）；(c) **Workflow-as-Tool**；(d) **[修正]** MCP 集成不再是"2025 年后通过 Marketplace 接入"这么模糊——准确时间线是：**Dify v1.6.0（2025-07-10）正式内置"双向 MCP"**：既能作为 MCP Client 调用 Linear/Notion/Zapier/Composio 等任意外部 MCP Server，又能将 Dify 内的 Workflow/Agent **一键发布为 MCP Server**（实现协议版本 `2025-03-26`，仅支持 HTTP / SSE 传输，不支持 stdio）。**[补充]** 这意味着 Dify 现在可以做"被调用方"：Claude Desktop、Cursor、Cherry Studio 等任意 MCP 客户端都能调到 Dify 上的私有 Agent。自定义工具配置示例（**[补充] 修正旧示例以匹配 1.x 鉴权 schema**）：

```yaml
# Dify 1.x Custom Tool YAML（OpenAPI 风格）
identity:
  author: acme
  name: crm_tool
  label:
    en_US: ACME CRM
credentials_for_provider:
  api_key:
    type: secret-input
    required: true
    label:
      en_US: CRM API Key
tools:
  - identity:
      name: get_customer
      label:
        en_US: Get Customer
    description:
      human:
        en_US: Fetch a single customer by id
      llm: Retrieve a customer record by customer_id from ACME CRM.
    parameters:
      - name: customer_id
        type: string
        required: true
        form: llm
        llm_description: The CRM customer id, e.g. cus_123
```

**[补充]** Dify 还提供"Workflow 发布为 MCP"的服务端示例：在 App → Publish → "Expose as MCP Server"，自动得到形如 `https://your-dify/mcp/<app_id>/sse` 的端点，可直接粘到 Claude Desktop 的 `claude_desktop_config.json`：

```json
{
  "mcpServers": {
    "dify-finance-agent": {
      "transport": "sse",
      "url": "https://dify.acme.com/mcp/app-xxxx/sse",
      "headers": { "Authorization": "Bearer app-yyyy" }
    }
  }
}
```

3. **Prompt 模板**：用类 Jinja 语法 `{{var}}`。系统区分「System / User / Assistant」三段，所有上游节点输出通过「Variable Reference」拖拽插入。Workflow 还专门设有 `Template` 节点与 `Variable Assigner` 节点，用于变量重塑。**[补充]** v1.14.0（2025-04-29）起新增「**Workflow Collaboration**」多人实时协同编辑（类似 Figma），以及 **Human-in-the-Loop Service API**——可在工作流中插入"暂停-等待人工接管"节点，由外部业务系统通过 API 投递人工答复后再续跑，是 ToB 项目里"审批/复核/兜底"场景的关键能力。

4. **知识库 RAG 嵌入 Agent 上下文**：Dify 的精髓——LLM 节点里有个独立的 `context` 字段（而不是简单字符串拼接），把 **Knowledge Retrieval 节点**输出的 `result` 变量绑定到该字段后，Dify 才会启用「引用与归因」（citation & attribution）能力。v1.1.0 起新增**自定义 metadata 过滤**，是企业行级权限的关键能力。**[补充]** v1.13.3（2025-03）起进一步修复了 streaming 模式下 citation metadata 在长会话中丢失的问题；v1.14.x 在 Knowledge 检索节点中正式开放了 "indexed document chunk preview"——工程师可直接在画布右栏看到当前命中的 chunk 原文与 metadata，调 prompt 时不必再反复跳页。

5. **多模型适配**：通过 Model Provider 插件机制对接 OpenAI、Anthropic、Azure、Bedrock、Gemini、Qwen、智谱、文心、DeepSeek、Ollama、xinference 等数十家。**[补充]** v1.0（2025-02）的最大架构变更就是「**所有模型与工具全部插件化**」——以前内置硬编码 provider，现在均通过 `dify-official-plugins` 仓库的 `.difypkg` 安装，离线环境可用 `dify-cli` 打包后旁路加载。

6. **企业级特性**：Dify Enterprise 上架 Azure & AWS Marketplace，提供 SAML/OIDC/OAuth2 SSO、RBAC 四角色、多工作区、审计日志、MFA、集中式访问控制。**[补充]** v1.14.1（2025-05-12）做了重要的安全硬化：**self-hosted `SECRET_KEY` 自动生成持久化**（解决早期社区版默认 key 被全网扫描的安全事件），internal metrics endpoint 默认收紧到 tenant-scoped，Docker env 变量重组到 `docker/envs/**` 分类目录。

7. **记忆**：Chat App 自带 `conversation_variables`（持久化跨轮变量）+ 滚动窗口 memory；Workflow 中提供 `Conversation Variable` 节点，可显式声明长期记忆字段。**[补充]** v1.14.2（2025-05-19）将默认 GraphEngine worker 数与 Celery 并发提升（worker 4 / PG max_connections 200），改善了大量并发会话下 memory 写入的争用问题。

8. **公司知识持续更新**：知识库支持 Notion / 网页 URL / 飞书 / 本地文件自动同步 + 定时刷新；可挂 webhook 在 CRM/Wiki 更新后调用 `/datasets/{id}/documents` API 增量入库。

引用：[Agent | Dify Docs](https://legacy-docs.dify.ai/guides/workflow/node/agent)、[Dify Agent Node Introduction (2025-03)](https://dify.ai/blog/dify-agent-node-introduction-when-workflows-learn-autonomous-reasoning)、**[补充][Dify v1.6.0 Built-in Two-Way MCP Support (2025-07-10)](https://dify.ai/blog/v1-6-0-built-in-two-way-mcp-support)**、**[补充][Dify Releases (v1.13/1.14/1.x)](https://github.com/langgenius/dify/releases)**、**[补充][dify-official-plugins 仓库](https://github.com/langgenius/dify-official-plugins)**、[Dify Enterprise](https://dify.ai/enterprise)、[v1.1.0 Metadata Filtering](https://dify.ai/blog/dify-v1-1-0-filtering-knowledge-retrieval-with-customized-metadata)、[LLM Node Docs](https://docs.dify.ai/en/guides/workflow/node/llm)。

---

## 二、Coze（字节扣子 / coze.com 国际版 / coze-studio 开源版）

**总体定位**：Coze 是字节跳动主推的「全民可用」AI Bot 平台，分三条线——国内 `coze.cn`、国际 `coze.com`、以及**[修正]** 开源版 `coze-studio`（**实际开源时间是 2025-07-26**，而非原报告所说的"2024 年底"；和它一起开源的还有 `coze-loop`——AgentOps 评测与监控套件）。设计哲学是 **Bot = 人设 + 技能 + 知识 + 记忆**。

1. **Agent App 设计**：Coze Bot 有两种模式——「**单 Agent 模式**」和「**多 Agent 模式（Multi-Agent）**」，后者用节点图连接多个有不同人设和技能的子 Agent，节点间通过 `jump condition`（跳转条件）切换控制权，本质是 **State Machine + LLM Routing**。**[补充]** 2025-07 开源的 coze-studio 0.x 系列首发时**暂未把多 Agent State Machine 完整开源**，主要包含单 Agent + Workflow + Knowledge + Plugin，多 Agent 编排和长期记忆等仍在路线图（详见 GitHub Issues）；如需 Multi-Agent，目前仍只能在 coze.cn / coze.com 商用版上使用，这一点选型时常被忽略。

2. **Tools 配置**：四类一等公民——(a) 官方插件商店；(b) **自定义插件**（在 IDE 内写 Python/Node 代码或粘 HTTP API）；(c) **OAuth 插件**（`authorization_code` / `service_http`）；(d) **Workflow-as-Tool**。插件认证配置示例：

```json
{
  "auth_type": "oauth",
  "sub_type": "authorization_code",
  "oauth_info": {
    "client_id": "xxx",
    "client_secret": "yyy",
    "client_url": "https://oauth.example.com/authorize",
    "scope": "read write",
    "authorization_url": "https://oauth.example.com/token",
    "authorization_content_type": "application/x-www-form-urlencoded"
  }
}
```

**[补充]** Workflow 节点内调用 LLM 时的"输出结构化"是常被忽略的能力——你可以为 LLM 节点声明 JSON Schema 形式的 output，coze-studio 会自动注入对应 system prompt 并对返回做 schema 校验失败重试。Prompt 片段示例：

```text
# 角色
你是 ACME 法务初审助手。

# 技能
1. 调用 {{plugin_contract_parser}} 抽取条款
2. 调用 {{kb_legal_handbook}} 检索内部判例
3. 风险打分（low / mid / high）

# 限制
- 任何条款引用必须给出出处段落编号
- 风险判定必须基于检索到的判例，不允许自由发挥
- 若无法判定，请在 `need_human_review` 字段输出 true

# 输出（严格遵守）
{
  "risks": [{ "clause_id": "...", "level": "low|mid|high", "reason": "..." }],
  "need_human_review": false
}
```

3. **Prompt 模板**：人设 & 回复逻辑用结构化模板：`# 角色` / `# 技能` / `# 限制` 三段式，支持 `{{user_input}}` 等变量。

4. **RAG 嵌入**：Coze 知识库分**文本/表格/图片**三类，对话时自动 hybrid 检索（embedding + BM25）。可调 `召回策略`、`最大召回数`、`最小匹配度`。

5. **多模型**：国内版默认豆包系列（Doubao-pro/lite/character），可切换 GLM、通义、DeepSeek；国际版默认 GPT-4o、Claude 3.5，可切 Gemini。**[修正]** 开源 coze-studio 实际只支持"OpenAI 兼容协议端点 + 火山方舟"——不像 Dify 那样直接内置 Anthropic/Bedrock SDK，要接 Claude 需走中转网关（OneAPI / LiteLLM），上线前需评估。

6. **企业级特性**：「**Team Space**」多组织、角色、资源隔离；企业版（火山引擎）提供专属组织、私有化、审计、SLA。**[补充]** coze-studio 采用 **Apache 2.0**（**[修正]** 比 Dify/FastGPT 的"附带禁止 unauthorized SaaS"条款更宽松，可直接做商业 SaaS 二开），最小本地部署仅需 2C/4G，技术栈 Golang 后端 + React/TS 前端 + DDD 微服务。

7. **记忆**：分**短期记忆 + 长期记忆 + Variable + Database**。Database 是 Coze 区别于其他平台的亮点。

8. **知识持续更新**：知识库支持飞书文档/网页 URL 定时同步；通过 Open API `/v1/datasets/.../documents` 增量上传；Bot Database 支持 SQL-like 操作。

引用：[Coze Open API](https://www.coze.com/open/docs/developer_guides)、[Plugin Tools](https://docs.coze.com/guides/plugin_tools)、[OAuth Plugin](https://www.coze.com/open/docs/guides/oauth_plugin)、[coze-studio GitHub](https://github.com/coze-dev/coze-studio)、**[补充][字节官宣开源 Coze Studio + Coze Loop (2025-07-26)](https://news.aibase.com/news/19989)**、**[补充][36Kr 解读：开源版 48 小时收获 9K stars](https://eu.36kr.com/en/p/3398065816816003)**、[扣子国内版教程](https://www.tixiaolu.com/posts/ai-coze-cn-2026/)。

---

## 三、FastGPT（labring）

**总体定位**：FastGPT 出身于 Sealos 团队，是国内最早把「**可视化 Flow 编排**」和「**RAG 知识库**」打通的开源平台，定位偏「知识库 + 工作流」而非「全自主 Agent」，开发者群体以工程师为主，部署门槛低（docker-compose 即可）。

1. **Agent App 设计**：核心抽象是「**应用（App）= 一张 Flow 图**」，FC/Agent 能力以「工具调用节点」形式呈现。**[修正]** 原报告说"没有独立的 Agent App 类型"——这在 4.8 时代是对的，但 **4.9 起 FastGPT 已经增加"工具调用"应用模式（Tool Call App）**，可不画 Flow 直接挂一组工具让 LLM 自主调度，定位更接近 Dify Agent App；"全部靠 Flow 节点挂工具"已经不是唯一形态。

2. **Tools 配置**：(a) 内置系统节点；(b) HTTP 节点；(c) 插件；(d) 4.8 之后官方插件市场。**[补充]** **FastGPT v4.9.6 起正式支持 MCP Server**——既可作为 MCP Client 引入外部 MCP 工具，也可把整个 FastGPT App 一键发布为 MCP Server（路径：应用 → 发布 → MCP）。最新 v4.14.7（2026 年初）针对 MCP 做了多项工程化收敛：保存时自动过滤 mongo 4.x 不兼容字段、后端自动剔除未配置工具防止误调用、MCP 子工具权限精确到调用方组织。

3. **Prompt 模板**：每个 LLM 节点有 `system / 引用模板 / 引用提示词` 三段；变量语法 `{{var}}`。**[补充]** "引用提示词（quote prompt）"的工程价值常被忽视——它是控制"模型如何看待 chunk"的最后一道防线，强烈推荐覆盖默认值。生产级 FAQ 模式参考：

```text
# 引用模板（quoteTemplate）
{instruction:{{q}}}
answer:{{a}}
source:{{source}}#{{chunkIndex}}

# 引用提示词（quotePrompt）
你将基于下述「知识库片段」回答用户问题。请严格遵守：
1. 仅使用片段内的事实，禁止臆测；信息不足时回答「我不确定」并建议联系人工。
2. 每条结论后用 [^source#chunkIndex] 形式标注引用。
3. 若多个片段冲突，优先以更新时间晚的片段为准。

知识库片段：
"""
{{quote}}
"""

用户问题：{{question}}
```

4. **RAG 嵌入**：FastGPT 的 RAG 工程化做得最细——**多索引机制**（正文/标题/LLM 摘要/图片描述最多 4 向量）、**QA 拆分**、**混合检索**（embedding + PG 全文 + rerank 三段式）。底层 PostgreSQL + pgvector + HNSW，MongoDB 存元数据。**[补充]** 4.9 起将分段策略默认从"固定 token"改为"语义/标题感知"双模式，长文档召回精度有可观提升。

5. **多模型**：通过 `config.json` 中的 `llmModels / vectorModels / reRankModels / audioSpeechModels` 配置，兼容任何 OpenAI 协议端点。

6. **企业级特性**：开源版有团队/成员/角色、资源权限到知识库/应用/集合（Collection）粒度；商业版增加 SSO（OAuth2、企业微信、钉钉）、审计日志、SLA。

7. **记忆**：内置「Chat History」节点；可用「变量存储」配合 Code 节点做用户级长期记忆。**[补充]** v4.14.7 给"chat log 模式"新增了「memory selection」——同一会话可分配到不同 LLM 节点不同的历史窗口策略（如概览节点用窗口 4 轮，详查节点用窗口 20 轮），解决长会话 token 爆炸。

8. **公司知识持续更新**：支持网页 URL/飞书/语雀定时刷新；`POST /api/core/dataset/collection/create` 等 OpenAPI 让外部 ETL 推送增量。

引用：[Workflows & Plugins | FastGPT](https://doc.fastgpt.io/en/guide/build/workflow/intro)、[Knowledge Base Fundamentals](https://doc.fastgpt.io/en/guide/dataset/rag)、**[补充][FastGPT MCP Server Docs](https://doc.fastgpt.io/en/guide/build/publish/mcp_server)**、**[补充][FastGPT v4.14.7 Upgrade](https://doc.fastgpt.io/en/docs/upgrading/4-14/4147)**、**[补充][FastGPT Releases](https://github.com/labring/FastGPT/releases)**、[FastGPT GitHub](https://github.com/labring/FastGPT)。

---

## 四、Bisheng（毕昇 / dataelement）

**总体定位**：Bisheng 由数语科技（DataElement）出品，主打「**企业级 AgentOps**」，是六款里**唯一原生面向 500 强企业**、文档处理能力（OCR/版面/表格）最强的开源平台。**[补充]** 官方 README 正式 slogan 是 "*open LLM devops platform for next generation Enterprise AI applications*"，强调 **GenAI workflow + RAG + Agent + 模型统一管理 + 评测 + SFT + 数据集管理 + 企业级系统管理 + Observability** 九大模块——这是六款里**唯一把 SFT / 评测 / 数据集做进同一控制台**的（其它平台多半要外接 LLaMA-Factory + 自建评测）。

1. **Agent App 设计**：早期叫「助手（Assistant）」FC + ReAct 混合；后续推出「**工作流（Workflow）**」，把循环（loop）、并行（parallel）、批处理（batch）、条件判断、人机交互（HITL）全部塞进同一个画布。**[补充]** 2025 H1 推出的 **Linsight**（毕昇自家 Agent 产品形态）是 Workflow + Agent 的进一步融合：Linsight 在"主动向用户求助"时会弹窗，**支持文件上传 & 拖拽**——这是 ToB"合同会签 / 报告补料"等流程的关键体验点。

2. **Tools 配置**：丰富的内置组件库（数百个），覆盖文档解析、表格抽取、图表绘制、SQL、Python、HTTP、邮件、企微等；支持自定义 HTTP / **MCP** 工具。**[补充]** Bisheng 自 2025 年中正式接入 MCP，与 Dify 的区别是它把"内部组件"也封装成 MCP 端点对外暴露，相当于让既有的"文档解析、表格抽取"作为"基础设施 MCP"被其他 Agent 平台调用。

3. **Prompt 模板**：组件级 prompt 配置 + 全局变量；AGL 文件可作为外部 prompt 资产版本化管理。**[补充]** AGL 片段示意（社区用法）：

```yaml
# agl/contract_review.agl.yaml
role: 资深合同审核律师
sop:
  - 步骤: 提取关键条款
    要点:
      - 付款条款、违约责任、知识产权归属、保密条款、争议解决
    工具: [bisheng.doc.parse_clauses]
  - 步骤: 风险判定
    规则:
      - 若付款条款中"账期 > 60 天"：风险=高
      - 若违约金 < 合同金额 5%：风险=中
    工具: [bisheng.kb.search(handbook="法务红宝书")]
  - 步骤: 汇总输出
    输出格式: 表格(条款, 原文, 风险等级, 依据, 建议)
human_in_loop:
  触发条件: any(风险=="高")
  审核人: legal_lead@acme.com
```

4. **RAG 嵌入**：差异化在**文档解析**——自研高精度 OCR（手写/印刷/罕见字、印章）、表格识别、版面分析模型，5 年沉淀，可私有化交付。这使得它在金融研报、合同、医疗病历等复杂文档场景准确率远高于通用方案。

5. **多模型**：统一模型管理后台，兼容 OpenAI 协议、本地推理（vLLM、TGI、xinference）、智谱、文心、通义、Claude；模型按角色（chat/embedding/rerank/vision）注册。

6. **企业级特性**：是六款中**最厚重**的——细粒度 RBAC、用户组管理、分组流控、SSO/LDAP、漏洞扫描、高可用部署、监控、审计日志、SFT/评估/数据集一站式。Apache 2.0 许可证可商用。

7. **记忆**：会话历史 + 工作流上下文变量；Workflow 节点支持「会话变量」「全局变量」；HITL 节点可让审核员中途介入。

8. **持续知识更新**：内置数据集管理 + SFT 流程支持用业务沉淀语料微调专属小模型；评估模块支持 A/B 跑分回归。

引用：[bisheng GitHub](https://github.com/dataelement/bisheng)、[README_CN](https://github.com/dataelement/bisheng/blob/main/README_CN.md)、[bisheng.ai 官网](https://www.bisheng.ai/)、[MCP 功能体验](https://news.qq.com/rain/a/20250517A07EDB00)、**[补充][bisheng Releases](https://github.com/dataelement/bisheng/releases)**、**[补充][arXiv FLOW-BENCH: Conversational Generation of Enterprise Workflows (含 Bisheng 评测)](https://arxiv.org/pdf/2505.11646)**。

---

## 五、QAnything（网易有道）

**总体定位**：QAnything 是六款中**最纯粹的 RAG 引擎**，并非完整 Agent 平台——其名字「Question & Answer based on Anything」直白点明定位。它没有可视化 workflow，没有插件市场，但**检索质量是国内开源里第一梯队**，因为有自研的 `BCEmbedding`（bilingual & cross-lingual）+ `BCEReranker`。**[修正]** 客观说明维护状态：2025 全年 QAnything 主仓库提交频率明显放缓（年新增约 52 issue / 9 PR，平均 16 天关闭），**接近"维护模式"**——选型时若期望持续大版本演进需谨慎，更稳妥的策略是**只采用其 BCEmbedding/BCEReranker 模型权重**自行集成到 Dify/Bisheng 上。

1. **Agent App 设计**：严格说没有 Agent App 概念，对外只有「知识库 + 问答接口」；如要构建真正 Agent，更多是把 QAnything 作为「RAG 微服务」被 Dify/Bisheng/MaxKB 调用。
2. **Tools**：内置工具较少，主要是「文档检索」「网页检索」「联网搜索」；扩展能力弱。
3. **Prompt 模板**：提供基础 system prompt + 引用模板配置。
4. **RAG 嵌入**：核心王牌——(a) **两阶段检索 + 强 Rerank**：embedding 召回 top-100 → BCEReranker 精排 top-N；(b) **混合检索**：BM25 + embedding 双路融合；(c) 自研 `BCEmbedding` 双语模型，对中英混合场景友好；(d) 1.3.0 后纯 Python 版可在 Mac/CPU 部署。**[补充]** BCEReranker 不仅支持中英，还覆盖**中英日韩四语**——在跨境电商客服场景实战收益明显。最小集成 Python 片段（**[补充]**）：

```python
from BCEmbedding import EmbeddingModel, RerankerModel

embed = EmbeddingModel(model_name_or_path="maidalun1020/bce-embedding-base_v1")
rerank = RerankerModel(model_name_or_path="maidalun1020/bce-reranker-base_v1")

query = "保税仓 7 天无理由退货政策"
docs = vector_store.search(embed.encode([query])[0], top_k=100)
# 两阶段精排
scored = rerank.rerank(query, [d.text for d in docs])
top = [docs[i] for i in scored["rerank_ids"][:8]]
```

5. **多模型**：支持 Qwen-7B-QAnything（自家微调）、OpenAI、本地 vLLM。
6. **企业级**：有道企业版（私有化交付）提供多用户、空间隔离、文档协同编辑（类 Wiki），但 SSO/审计/RBAC 不如 Dify Enterprise/Bisheng 成熟。
7. **记忆**：基础会话历史，无显式长期记忆。
8. **公司知识持续更新**：通过 Web/API 上传新文档触发增量索引；空间内可在线协同编辑文档，编辑保存即重建索引。

适用场景小结：QAnything 应被定位为「**RAG 子系统**」而非「Agent 平台」，最佳用法是为 Dify/Coze/MaxKB 提供高质量检索后端，或**直接复用其开源权重**。

引用：[BCEmbedding GitHub](https://github.com/netease-youdao/BCEmbedding)、[QAnything GitHub](https://github.com/netease-youdao/QAnything)、[bce-embedding-base_v1 on HuggingFace](https://huggingface.co/maidalun1020/bce-embedding-base_v1)、[QAnything 开源公告](https://m.jiemian.com/article/10682542.html)、[QAnything 升级支持 Mac](https://www.199it.com/archives/1684879.html)、[QAnything 1.4 版本更新](https://blog.csdn.net/youdaotech/article/details/139418315)。

---

## 六、MaxKB（飞致云 / 1Panel-dev）

**总体定位**：MaxKB（Max Knowledge Brain）来自飞致云（1Panel 同源团队），定位「**强大易用的开源企业级智能体平台**」。v2 重构为完整智能体平台，渐进式上手 `基础问答 → 工作流 → 智能体`。**[补充]** 当前 GitHub stars 已突破 21.4k / 2.9k forks，是国产开源 KB 平台 stars 前三梯队。

1. **Agent App 设计**：v2 提供三种应用类型——简单应用 / 工作流应用 / 智能体应用，FC 是默认推理范式，复杂场景可降级到 ReAct。
2. **Tools 配置**：(a) **函数库**——Python 函数沙箱直接注册为 tool，签名自动转 JSON Schema；(b) **MCP Tool**——v2 原生支持 MCP，既能调三方 MCP Server 也能把 MaxKB 应用对外发布为 MCP；(c) HTTP/API 工具；(d) Workflow-as-Tool。**[补充]** 函数库代码示例（生产可直接抄）：

```python
# MaxKB v2 函数库 - 工单查询
def query_ticket(ticket_id: str) -> dict:
    """
    根据工单号查询 ITSM 中的工单详情
    :param ticket_id: 工单号，例如 INC0001234
    :return: 工单详情字典
    """
    import requests, os
    resp = requests.get(
        f"{os.environ['ITSM_BASE']}/api/v1/incidents/{ticket_id}",
        headers={"Authorization": f"Bearer {os.environ['ITSM_TOKEN']}"},
        timeout=10,
    )
    resp.raise_for_status()
    data = resp.json()
    return {
        "id": data["number"],
        "title": data["short_description"],
        "state": data["state"],
        "assignee": data.get("assigned_to", {}).get("display_value"),
        "url": f"{os.environ['ITSM_BASE']}/nav_to.do?uri=incident.do?sys_id={data['sys_id']}",
    }
```

3. **Prompt 模板**：支持系统提示词、用户提示词、变量、知识库引用占位符。
4. **RAG 嵌入**：本地知识库支持文件上传与网页爬取，自动分段+向量化；底层用 PostgreSQL + pgvector + LangChain；支持多知识库聚合 + 命中度阈值 + 召回模式（向量/全文/混合）。
5. **多模型**：模型中立性是其设计准则——支持 DeepSeek R1/Qwen 3 等本地模型、阿里通义/腾讯混元/字节豆包/百度千帆/智谱/Kimi/MiniMax 等国内云，以及 OpenAI/Claude/Gemini 等海外模型。
6. **企业级特性**：开源版自带成员/角色/资源权限；企业版提供 SSO（OIDC/CAS/LDAP）、审计、提问者权限隔离；零代码嵌入微信、钉钉、飞书、官网；与 1Panel 集成简化交付。
7. **记忆**：会话历史滚动 + 用户级变量；工作流支持「会话变量」「全局变量」。
8. **公司知识持续更新**：支持网页定时爬取、文档上传 OpenAPI；通过 MCP 发布使知识库可被任何外部 Agent 实时调用。

引用：[MaxKB GitHub](https://github.com/1Panel-dev/MaxKB)、[README_CN v2](https://github.com/1Panel-dev/MaxKB/blob/v2/README_CN.md)、[MaxKB 文档站 v2](https://maxkb.cn/docs/v2/)、[发布为 MCP 服务](https://zhuanlan.zhihu.com/p/1946288517199148996)、[V2 发布博客](https://blog.fit2cloud.com/?p=3fc89470-2ba1-4220-9c89-99d61e012267)、[MaxKB 官网](https://www.maxkb.cn/)。

---

## **[补充]** 七、被原报告遗漏的两个重要参照系

虽然不属于原 6 选型，但 2025 年中之后任何严肃选型都绕不开下面两位，**否则结论会偏**。

### 7.1 RAGFlow（infiniflow）
- 由 InfiniFlow 团队开源，**Apache 2.0 + 无 SaaS 限制**（比 Dify/FastGPT 更宽松），特别适合"做产品再卖给客户"的二开场景。
- 强项：**深度文档理解（DeepDoc）**——版面/表格/扫描 PDF 解析与 RAGFlow 同等级，但**召回-rerank-生成全链路可视化、chunk 级可调**，对"做难文档的工程师"友好。
- 与本报告六者关系：与 Bisheng 文档解析正面竞争、与 FastGPT 工作流定位重叠，常作为 Dify 的"高级 RAG 后端"被反向集成。
- 选型建议（2025 社区共识）：**Product-led 团队选 Dify；ML/regulated 重型团队选 RAGFlow；可"Dify 原型 → RAGFlow 生产"做组合**。

### 7.2 Coze Loop（字节同时开源）
- 与 coze-studio 同时（2025-07-26）开源，是**AgentOps 评测 + 监控套件**：Trace、Eval Set、自动回归、Prompt 版本灰度。
- 国内 Apache 2.0 的 AgentOps 工具非常稀缺，Coze Loop 上线后 Bisheng 的"评测一站式"独占性被削弱；做严肃 LLM 产品的团队应把它和 Bisheng Eval / LangSmith / Phoenix 一同评估。

---

## **[补充]** 八、高质量参考资料（社区被广泛引用）

1. **[Jimmy Song《Open Source AI Agent Platform Comparison (2026): n8n, Dify, LangGraph, Coze, RAGFlow》](https://jimmysong.io/blog/open-source-ai-agent-workflow-comparison/)** —— 2026 年迄今被中英文社区转载最多的横评文，对许可证陷阱（"no unauthorized SaaS"）讨论尤其透彻，本报告"选型建议"区块部分采纳其结论。
2. **[Dify v1.6.0: Built-in Two-Way MCP Support (Dify 官方博客, 2025-07)](https://dify.ai/blog/v1-6-0-built-in-two-way-mcp-support)** —— Dify 双向 MCP 的官方一手资料，对"MCP 是 Agent 平台未来的 USB-C"这一观点的标志性背书。
3. **[DEV.to《FastGPT vs Dify: The Chinese RAG Platform Battle You're Missing》](https://dev.to/victorjia/fastgpt-vs-dify-the-chinese-rag-platform-battle-youre-missing-18eo)** —— 海外工程师视角对比 FastGPT 与 Dify，对"Dify 是瑞士军刀 vs FastGPT 是手术刀"的比喻被广泛引用。
4. **[ByteDance 官宣 Coze Studio + Coze Loop 开源 (AIbase 2025-07-26)](https://news.aibase.com/news/19989)** + **[36Kr《Coze 开源 48 小时收 9K stars》](https://eu.36kr.com/en/p/3398065816816003)** —— 解读字节开源策略与生态影响。
5. **[FLOW-BENCH (arXiv 2505.11646)《Towards Conversational Generation of Enterprise Workflows》](https://arxiv.org/pdf/2505.11646)** —— 学术界对 Bisheng/Dify/RAGFlow 等 workflow 平台进行系统评测的论文，提供量化对比基准。

---

## 横向对比与选型建议（**[修正]** 已根据 2025 H2 演进更新）

| 维度 | Dify | Coze | FastGPT | Bisheng | QAnything | MaxKB |
|---|---|---|---|---|---|---|
| Agent 范式 | FC + ReAct + Agent Node + 可插拔 Strategy | FC + Multi-Agent 状态机（开源版暂缺） | FC（Tool Call App / 工具节点） | FC + ReAct + AGL + HITL | 弱 Agent | FC + Workflow + MCP |
| Workflow-as-Tool | 是 | 是 | 是 | 是 | 否 | 是 |
| **MCP 双向（Client + Server）** | **是（v1.6.0, 2025-07）** | 部分（client 优先） | **是（v4.9.6+）** | 是 | 否 | **是（v2 原生）** |
| RAG 工程深度 | 高（metadata、citation、chunk preview） | 中（隐藏细节） | 极高（多索引/QA 拆分） | 极高（OCR/版面/印章） | 极高（BCE 双阶段） | 中 |
| 企业级（SSO/RBAC/审计） | 强（Enterprise） | 强（火山引擎） | 中（商业版） | 极强（含 SFT/评测） | 弱 | 强（V2） |
| 多模型 | 极广（插件化） | 默认绑定豆包/GPT，可切 | 广 | 广 | 中 | 极广 |
| 长期记忆/结构化数据 | conversation_variables | Database + Variable（独有） | 弱（4.14 memory selection） | 会话变量 + HITL | 弱 | 会话变量 |
| 许可证商业友好度 | "no unauthorized SaaS" | **Apache 2.0（最宽松）** | "no unauthorized SaaS" | Apache 2.0 | Apache 2.0 | "no unauthorized SaaS" |
| 维护活跃度（2026 视角） | 高 | 高（开源版仍在快速迭代） | 高 | 高 | **放缓** | 高 |

**选型建议（更新版）**：
- **企业内部知识库 + 客服/工单 Agent + 严格审计/SSO**：**Bisheng** 或 **Dify Enterprise**；若文档复杂度高（合同/研报/票据）优先 Bisheng / RAGFlow。
- **To C / 出海 Bot、强对话体验和长期记忆**：商用版 **Coze.cn / Coze.com**；私有化 SaaS 二开优先 **coze-studio**（Apache 2.0 + DDD 架构最适合改造）。
- **工程师友好的 RAG + 工作流、低成本自部署**：**FastGPT**（4.9 起 MCP 双向 + Tool Call App 已大幅缩小与 Dify 差距）。
- **仅需高质量 RAG 引擎作为子系统**：**[修正]** 优先 **复用 BCEmbedding/BCEReranker 模型权重**自行集成；只在团队精力有限时部署完整 QAnything。
- **1Panel 用户 / MCP 生态优先 / 需要快速嵌入官网 IM**：**MaxKB**。
- **2026 通用结论**：把"**MCP Server 暴露能力 + 许可证条款**"列入硬性评估项；不暴露 MCP 的平台等同于"不出现在未来 Agent 网络上"。Dify v1.6 / FastGPT v4.9.6 / MaxKB v2 / Bisheng 已合规，**Coze 开源版与 QAnything 在这一点上仍有差距**。

Sources（**[补充]** 已新增 2025-2026 一手资料）:
- [Agent | Dify Docs](https://legacy-docs.dify.ai/guides/workflow/node/agent)
- [Dify Agent Node Introduction (2025-03)](https://dify.ai/blog/dify-agent-node-introduction-when-workflows-learn-autonomous-reasoning)
- [Dify v1.6.0 Built-in Two-Way MCP (2025-07)](https://dify.ai/blog/v1-6-0-built-in-two-way-mcp-support)
- [Dify Releases](https://github.com/langgenius/dify/releases)
- [dify-official-plugins](https://github.com/langgenius/dify-official-plugins)
- [Dify Enterprise](https://dify.ai/enterprise)
- [Dify v1.1.0 Metadata Filtering](https://dify.ai/blog/dify-v1-1-0-filtering-knowledge-retrieval-with-customized-metadata)
- [Dify Knowledge Retrieval Node](https://legacy-docs.dify.ai/guides/workflow/node/knowledge-retrieval)
- [Dify LLM Node Docs](https://docs.dify.ai/en/guides/workflow/node/llm)
- [Coze Open API Docs](https://www.coze.com/open/docs/developer_guides)
- [Coze Plugin Tools](https://docs.coze.com/guides/plugin_tools)
- [Coze OAuth Plugin](https://www.coze.com/open/docs/guides/oauth_plugin)
- [coze-studio GitHub](https://github.com/coze-dev/coze-studio)
- [字节官宣开源 Coze Studio + Coze Loop (AIbase, 2025-07-26)](https://news.aibase.com/news/19989)
- [36Kr: Coze 开源 48 小时收 9K stars](https://eu.36kr.com/en/p/3398065816816003)
- [扣子国内版完整教程 2026](https://www.tixiaolu.com/posts/ai-coze-cn-2026/)
- [FastGPT Workflow Docs](https://doc.fastgpt.io/en/guide/build/workflow/intro)
- [FastGPT Knowledge Base RAG](https://doc.fastgpt.io/en/guide/dataset/rag)
- [FastGPT MCP Server Docs](https://doc.fastgpt.io/en/guide/build/publish/mcp_server)
- [FastGPT v4.14.7 Upgrade Notes](https://doc.fastgpt.io/en/docs/upgrading/4-14/4147)
- [FastGPT Releases](https://github.com/labring/FastGPT/releases)
- [FastGPT GitHub](https://github.com/labring/FastGPT)
- [Bisheng GitHub](https://github.com/dataelement/bisheng)
- [Bisheng README_CN](https://github.com/dataelement/bisheng/blob/main/README_CN.md)
- [Bisheng Releases](https://github.com/dataelement/bisheng/releases)
- [Bisheng 官网](https://www.bisheng.ai/)
- [Bisheng MCP 功能体验](https://news.qq.com/rain/a/20250517A07EDB00)
- [FLOW-BENCH arXiv 2505.11646](https://arxiv.org/pdf/2505.11646)
- [QAnything GitHub](https://github.com/netease-youdao/QAnything)
- [BCEmbedding GitHub](https://github.com/netease-youdao/BCEmbedding)
- [bce-embedding-base_v1 HuggingFace](https://huggingface.co/maidalun1020/bce-embedding-base_v1)
- [QAnything 开源公告](https://m.jiemian.com/article/10682542.html)
- [QAnything 1.4 版本更新](https://blog.csdn.net/youdaotech/article/details/139418315)
- [MaxKB GitHub](https://github.com/1Panel-dev/MaxKB)
- [MaxKB README v2](https://github.com/1Panel-dev/MaxKB/blob/v2/README_CN.md)
- [MaxKB 文档站 v2](https://maxkb.cn/docs/v2/)
- [MaxKB 发布为 MCP 服务](https://zhuanlan.zhihu.com/p/1946288517199148996)
- [MaxKB V2 发布博客](https://blog.fit2cloud.com/?p=3fc89470-2ba1-4220-9c89-99d61e012267)
- [MaxKB 官网](https://www.maxkb.cn/)
- [Jimmy Song: Open Source AI Agent Platform Comparison 2026](https://jimmysong.io/blog/open-source-ai-agent-workflow-comparison/)
- [DEV.to: FastGPT vs Dify](https://dev.to/victorjia/fastgpt-vs-dify-the-chinese-rag-platform-battle-youre-missing-18eo)
- [Sider: Dify vs RAGFlow 2025](https://sider.ai/blog/ai-tools/dify-vs-ragflow-which-rag-platform-should-you-build-on-in-2025)
- [Sider: FastGPT vs RAGFlow 2025](https://sider.ai/blog/ai-tools/fastgpt-vs-ragflow-which-rag-stack-wins-for-2025-deployments)
