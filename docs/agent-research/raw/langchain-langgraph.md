# LangChain / LangGraph 的 tools / agent / prompt 体系

> 这是工作流 Research 阶段（discover + adversarial verify）的完整原始调研报告。已经被合成进 `../01-04` 系列文档，这里保留全文便于深入考据。

---

I have enough material. Now I'll produce the expanded and corrected report.

# LangChain 与 LangGraph Agent 框架深度调研（修订加强版）

> 资深 AI 工程师视角。聚焦"工具如何被打包成 OpenAI/Anthropic 的 tools 数组"以及"prompt 如何分段拼接"。代码示例与模板原文均取自官方文档与 Hub。
>
> **[修正] 本报告基于 LangChain / LangGraph 1.0（2025-10-22 GA）。原报告以 `langgraph.prebuilt.create_react_agent` 为推荐入口的说法已经过时——v1.0 起官方推荐 `langchain.agents.create_agent`，配合 middleware 体系；`create_react_agent` 仍可用但已 deprecated，计划在 v2.0 移除。**

---

## 0. [补充] LangChain / LangGraph 1.0 (2025-10-22) 关键变更

| 项 | v0.x（原报告默认） | v1.0（当前） |
|---|---|---|
| Agent 工厂 | `langgraph.prebuilt.create_react_agent` | **`langchain.agents.create_agent`** |
| Prompt 参数名 | `prompt=` | **`system_prompt=`**（语义更准） |
| 行为扩展点 | `pre_model_hook` / `post_model_hook` 两个 Runnable | **`middleware=[...]` 列表**，可在 before_model / after_model / before_tool / after_tool / on_run_start / on_run_end 任意点注入 |
| State 默认 | `MessagesState` + `add_messages` reducer | 同上，但 `AgentState` / pydantic 变体已 deprecated |
| Python 最低版本 | 3.9 | **3.10+**（3.9 EOL） |
| 旧 chains / legacy agents | `langchain.chains.*` / `AgentExecutor` | 全部搬到 **`langchain-classic`** 包 |
| 多模态 / 引用 | 各模型 SDK 不一 | **Standard Content Blocks**：统一描述 reasoning trace、citation、image、audio |
| 结构化输出 | 独立链路 `with_structured_output` | 整合进 agent loop，单次调用同时出 `messages` + `structured_response` |

参考：[LangChain & LangGraph 1.0 公告](https://www.langchain.com/blog/langchain-langgraph-1dot0)、[LangGraph v1 migration guide](https://docs.langchain.com/oss/python/migrate/langgraph-v1)、[Changelog](https://changelog.langchain.com/announcements/langchain-1-0-now-generally-available)。

---

## 1. LangChain Tools — 工具定义的三种方式

LangChain 的 `BaseTool` 是所有工具的抽象基类。任何工具最终都会被序列化成一段 **JSON Schema**，再被 chat model 的 `bind_tools()` 转化成 OpenAI 或 Anthropic API 真正接收的 `tools` 数组。

### 1.1 `@tool` 装饰器（最常用）

`@tool` 来自 `langchain_core.tools`。它会读取函数签名、类型注解和 docstring，自动生成 args schema。

```python
from langchain_core.tools import tool

@tool
def multiply(a: int, b: int) -> int:
    """Multiply two numbers."""
    return a * b

print(multiply.name)          # 'multiply'
print(multiply.description)   # 'Multiply two numbers.'
print(multiply.args)          # {'a': {'title': 'A', 'type': 'integer'}, 'b': {...}}
print(multiply.args_schema.model_json_schema())  # [修正] Pydantic v2 用 model_json_schema()
```

> **[修正]** 原报告写 `multiply.args_schema.schema()`，这是 Pydantic v1 的方法。LangChain 1.0 全面使用 Pydantic v2，对应方法是 `model_json_schema()`。`.schema()` 在 v2 仍有兼容 shim 但会发 `DeprecationWarning`。

显式传 `args_schema` 可覆盖自动推断：

```python
from pydantic import BaseModel, Field

class CalcInput(BaseModel):
    a: int = Field(description="first operand")
    b: int = Field(description="second operand")

@tool("multiply-tool", args_schema=CalcInput, return_direct=True)
def multiply(a: int, b: int) -> int:
    """Multiply two numbers."""
    return a * b
```

### 1.1.1 [补充] InjectedToolArg 与 InjectedState — 让工具不暴露内部参数

LangChain 1.0 强化了 `Injected*` 系列注解，用于让某些参数**不出现在 LLM 看到的 schema 里**，由 runtime 注入：

```python
from typing import Annotated
from langchain_core.tools import tool, InjectedToolArg
from langgraph.prebuilt import InjectedState, InjectedStore

@tool
def write_note(
    text: str,
    # 以下三个对 LLM 不可见
    user_id: Annotated[str, InjectedToolArg],
    state: Annotated[dict, InjectedState],
    store: Annotated[object, InjectedStore],
) -> str:
    """Save a personal note for the user."""
    store.put(("notes", user_id), key=text[:32], value={"text": text})
    return "saved"
```

这一模式在多组织 / RBAC 场景里几乎是必需的——原报告完全没有覆盖。

### 1.2 `StructuredTool.from_function`

适合多参数、复杂 Pydantic schema 的工具：

```python
from langchain_core.tools import StructuredTool

def search(query: str, top_k: int = 5) -> list[str]:
    """Search the knowledge base."""
    return [f"hit-{i}" for i in range(top_k)]

search_tool = StructuredTool.from_function(
    func=search,
    name="kb_search",
    description="Semantic search over the internal KB.",
    args_schema=CalcInput,        # 可选
    return_direct=False,
    coroutine=None,               # 也可以传入 async 版本
)
```

### 1.3 `Tool.from_function`（单字符串入参的旧式 ReAct 工具）

```python
from langchain_core.tools import Tool

search_tool = Tool.from_function(
    func=lambda q: f"Result for {q}",
    name="Search",
    description="useful for when you need to answer questions about current events",
)
```

> **[修正]** 在 v1.0 中 `Tool`（单字符串入参形态）主要服务于旧的 ZeroShotReAct 链路，现已迁入 `langchain-classic`。新代码应优先 `@tool` + 显式 args。

---

## 2. 工具如何转换为 OpenAI / Anthropic 的 `tools` 数组

这一步是整个框架最关键的"魔法"，对应代码在 `langchain_core.utils.function_calling`。

### 2.1 `convert_to_openai_tool` —— 通用打包器

```python
from langchain_core.utils.function_calling import convert_to_openai_tool

oai_tool = convert_to_openai_tool(multiply)
```

得到的 `oai_tool` 严格遵循 OpenAI tool calling 协议：

```json
{
  "type": "function",
  "function": {
    "name": "multiply",
    "description": "Multiply two numbers.",
    "parameters": {
      "type": "object",
      "properties": {
        "a": {"type": "integer", "description": "first operand"},
        "b": {"type": "integer", "description": "second operand"}
      },
      "required": ["a", "b"]
    }
  }
}
```

`convert_to_openai_tool` 接受 dict / Pydantic BaseModel / Python function / BaseTool，并能识别已是 OpenAI、Anthropic 或 Bedrock Converse 格式的 dict（自 0.3.13 起原生支持 Anthropic 输入格式）。`strict=True` 时会向 OpenAI 声明严格 JSON Schema 校验（这等价于 OpenAI Responses API 里 `strict: true`，会限制 schema 必须满足 OpenAI Structured Outputs 子集，例如 `additionalProperties: false` 强制写出）。

### 2.2 `bind_tools` —— 把工具数组挂到模型上

OpenAI：

```python
from langchain_openai import ChatOpenAI

llm = ChatOpenAI(model="gpt-4o")
llm_with_tools = llm.bind_tools([multiply, search_tool])

resp = llm_with_tools.invoke("Multiply 13 by 7")
print(resp.tool_calls)
# [{'name': 'multiply', 'args': {'a': 13, 'b': 7}, 'id': 'call_abc', 'type': 'tool_call'}]
```

`bind_tools` 内部对每个 tool 调用 `convert_to_openai_tool`，组成 list，最终在 `_generate` 中作为 `tools=[...]` 字段塞进 `client.chat.completions.create(...)`。

**[补充] `tool_choice` 的三种状态**：`"auto"`（默认）、`"any"`/`"required"`（强制必须调一个工具）、`"none"`（禁用工具）、或具名 `{"type": "function", "function": {"name": "multiply"}}` 强制指定。各家协议差异由 LangChain 抹平：

```python
llm.bind_tools([multiply], tool_choice="multiply")          # 跨厂商统一写法
llm.bind_tools([multiply], tool_choice="any")               # 强制必须调
llm.bind_tools([multiply], parallel_tool_calls=False)       # 关并行（OpenAI / Anthropic 都支持）
```

Anthropic：

```python
from langchain_anthropic import ChatAnthropic

llm = ChatAnthropic(model="claude-sonnet-4-5")
llm_with_tools = llm.bind_tools([multiply])
```

`ChatAnthropic.bind_tools` 走 `_format_tools_anthropic`，把上面同一份 JSON Schema 改写成 Anthropic 协议要求的形状：

```json
[
  {
    "name": "multiply",
    "description": "Multiply two numbers.",
    "input_schema": {
      "type": "object",
      "properties": {
        "a": {"type": "integer"},
        "b": {"type": "integer"}
      },
      "required": ["a", "b"]
    }
  }
]
```

差异仅在最外层：OpenAI 用 `function.parameters`，Anthropic 用 顶层 `name` + `input_schema`。返回时同样统一成 LangChain 的 `AIMessage.tool_calls`，做到上游不感知模型差异。

### 2.3 Tool 调用结果回灌

LLM 返回 `tool_calls` 后，代码侧执行真实函数，然后把结果包成 `ToolMessage`：

```python
from langchain_core.messages import HumanMessage, ToolMessage

messages = [HumanMessage("Multiply 13 by 7")]
ai = llm_with_tools.invoke(messages)
messages.append(ai)
for call in ai.tool_calls:
    result = multiply.invoke(call["args"])
    messages.append(ToolMessage(content=str(result), tool_call_id=call["id"]))
final = llm_with_tools.invoke(messages)
```

`ToolMessage(tool_call_id=...)` 与 OpenAI 的 `role: "tool"` 一一对应，与 Anthropic 的 `tool_result` content block 一一对应。

### 2.4 [补充] Standard Content Blocks（v1.0 新增）

v1.0 引入了**跨厂商的内容块标准**——`AIMessage.content` 不再是单纯字符串，而是一个块列表，元素类型可以是 `text` / `reasoning` / `tool_use` / `tool_result` / `citation` / `image` / `audio` 等。这让 Claude 的 extended thinking、OpenAI o-系列的 reasoning summary、Anthropic citations API 全部以同一形状暴露：

```python
for block in ai_msg.content:
    if block["type"] == "reasoning":
        print("thought:", block["thinking"])
    elif block["type"] == "text":
        print("answer:", block["text"])
    elif block["type"] == "tool_use":
        print("call:", block["name"], block["input"])
```

这是原报告完全遗漏的关键 1.0 能力——它直接影响 RAG 引用展示和 reasoning-model debugging。

---

## 3. LangChain Agents — 四类 prompt 模板原文

> **[修正]** 下面四类模板属于 v0.x 的 "classic" agent 体系，1.0 后均位于 `langchain-classic`。**新代码不应用 Hub 上的旧模板搭新 agent**——直接 `create_agent(model, tools, system_prompt=...)` 即可，prompt 拼接细节由 middleware 控制。仍保留下面四个模板的原文作为历史参考与对老仓库的兼容指南。

### 3.1 ReAct Agent — `hwchase17/react`

适用于**纯文本补全**模型（Llama、ERNIE、早期 GPT-3.5 instruct）。完整 prompt 模板原文：

```
Answer the following questions as best you can. You have access to the following tools:

{tools}

Use the following format:

Question: the input question you must answer
Thought: you should always think about what to do
Action: the action to take, should be one of [{tool_names}]
Action Input: the input to the action
Observation: the result of the action
... (this Thought/Action/Action Input/Observation can repeat N times)
Thought: I now know the final answer
Final Answer: the final answer to the original input question

Begin!

Question: {input}
Thought:{agent_scratchpad}
```

四个占位符：

- `{tools}` —— `render_text_description(tools)` 渲染出"name: description, args"的多行文本
- `{tool_names}` —— 逗号分隔工具名
- `{input}` —— 用户问题
- `{agent_scratchpad}` —— 历史 Thought/Action/Observation 拼成的**字符串**

构建：

```python
from langchain import hub
from langchain_classic.agents import AgentExecutor, create_react_agent   # [修正] v1.0 后路径
from langchain_openai import OpenAI

prompt = hub.pull("hwchase17/react")
agent = create_react_agent(OpenAI(temperature=0), tools, prompt)
executor = AgentExecutor(agent=agent, tools=tools, verbose=True)
```

变体 `hwchase17/react-chat` 在末尾多一段 `Previous conversation history:\n{chat_history}`，用于 chat 模型。

### 3.2 OpenAI Tools Agent — `hwchase17/openai-tools-agent`

利用原生 tool calling，prompt 极其简洁，由四段消息组成：

```python
ChatPromptTemplate.from_messages([
    ("system", "You are a helpful assistant"),
    MessagesPlaceholder(variable_name="chat_history", optional=True),
    ("human", "{input}"),
    MessagesPlaceholder(variable_name="agent_scratchpad"),
])
```

`agent_scratchpad` 这里**必须是 MessagesPlaceholder**，里面塞的是 AIMessage（含 tool_calls）和 ToolMessage（含 tool_call_id）对，模型直接通过 tool_calls 协议响应。

### 3.3 Structured Chat Agent — `hwchase17/structured-chat-agent`

为不支持原生 function calling 的 chat 模型设计，强制让模型用 **JSON blob** 表达 action（模板原文略，见原报告）。

### 3.4 XML Agent — `hwchase17/xml-agent-convo`

为 Claude 早期模型（不支持 native tool use 之前）设计的 `<tool>` / `<tool_input>` / `<observation>` / `<final_answer>` 标签协议。**[修正]** 在 Claude 3 系及之后，Anthropic 已经全面支持 native tool use，XML agent 仅作为"无 function-calling 兼容模式"留存。

---

## 4. LangGraph — state-based agent

LangGraph 是新一代官方推荐：把 agent 描述成**有向图**，节点是函数，边由状态驱动。

### 4.1 `MessagesState` 与 `ToolNode`

```python
from typing import Annotated, TypedDict
from langgraph.graph.message import add_messages
from langchain_core.messages import AnyMessage

class MessagesState(TypedDict):
    messages: Annotated[list[AnyMessage], add_messages]
```

`add_messages` 是 reducer，新返回的 messages 会被 append（**[补充]** 准确说：基于 `id` 字段的 upsert——同 id 替换、新 id 追加；返回 `RemoveMessage(id=...)` 则可删除特定消息，这是裁剪历史的官方方式）。

`ToolNode` 是预制的工具执行节点：

```python
from langgraph.prebuilt import ToolNode
tool_node = ToolNode([multiply, search_tool])
```

它读取最新 `AIMessage.tool_calls`，**并行**执行所有工具，把每个结果包成 `ToolMessage` 返回；任何一个工具 raise 时，默认会以错误字符串作为 `ToolMessage.content` 喂回模型，可通过 `handle_tool_errors=False` 直接抛出。

### 4.2 手写 ReAct 图

```python
from langgraph.graph import StateGraph, START, END, MessagesState
from langgraph.prebuilt import ToolNode, tools_condition
from langchain_anthropic import ChatAnthropic

llm = ChatAnthropic(model="claude-sonnet-4-5").bind_tools([multiply])

def call_model(state: MessagesState):
    return {"messages": [llm.invoke(state["messages"])]}

builder = StateGraph(MessagesState)
builder.add_node("agent", call_model)
builder.add_node("tools", ToolNode([multiply]))
builder.add_edge(START, "agent")
builder.add_conditional_edges("agent", tools_condition)  # 自动判断是否有 tool_calls
builder.add_edge("tools", "agent")
graph = builder.compile()

for chunk in graph.stream({"messages": [("user", "13 * 7?")]}):
    print(chunk)
```

### 4.3 [修正] `create_agent`（v1.0 推荐入口）取代 `create_react_agent`

`langgraph.prebuilt.create_react_agent` **已 deprecated**，迁移到 `langchain.agents.create_agent`：

```python
from langchain.agents import create_agent
from langchain.agents.middleware import (
    SummarizationMiddleware,
    HumanInTheLoopMiddleware,
    PIIMiddleware,
    ModelRetryMiddleware,
)

agent = create_agent(
    model="anthropic:claude-sonnet-4-6",
    tools=[check_weather],
    system_prompt="You are a helpful assistant",      # [修正] 不再叫 prompt
    response_format=WeatherReport,                    # Pydantic schema → 直接 structured_response
    middleware=[
        SummarizationMiddleware(max_tokens=4_000),    # 上下文超长自动总结
        PIIMiddleware("email"),                       # 自动遮蔽邮箱
        HumanInTheLoopMiddleware(tools=["send_email"]),
        ModelRetryMiddleware(max_retries=3),
    ],
    checkpointer=PostgresSaver.from_conn_string(...), # 线程级短期记忆
    store=PostgresStore.from_conn_string(...),        # 跨线程长期记忆
)

result = agent.invoke(
    {"messages": [{"role": "user", "content": "what is the weather in sf"}]},
    config={"configurable": {"thread_id": "u-123", "user_id": "u-123"}},
)
print(result["messages"][-1].content)
print(result["structured_response"])   # WeatherReport(...)
```

完整签名（实测 v1.0）：

```python
create_agent(
    model,                       # str ("anthropic:claude-...") 或 BaseChatModel 或工厂
    tools,                       # Sequence[BaseTool | callable | dict] | ToolNode
    *,
    system_prompt=None,          # str | None ；动态注入用 middleware
    response_format=None,        # Pydantic / TypedDict
    middleware=[],               # list[AgentMiddleware]
    state_schema=None,           # 继承 AgentState 的 TypedDict
    context_schema=None,         # runtime context (user_id, tenant ...)
    checkpointer=None,
    store=None,
    interrupt_before=None,
    interrupt_after=None,
    name=None,
)
```

老的 `pre_model_hook` / `post_model_hook` 现在用 middleware 替代——更可组合、可分发、可测试。

### 4.4 [补充] 自定义 Middleware 示例

```python
from langchain.agents.middleware import AgentMiddleware, ModelRequest, ModelResponse

class TokenBudgetMiddleware(AgentMiddleware):
    def __init__(self, max_tokens: int):
        self.max_tokens = max_tokens
        self.used = 0

    def before_model(self, request: ModelRequest) -> ModelRequest:
        # 简单截断：保留 system + 最近 N 条
        msgs = request.messages
        request.messages = [msgs[0]] + msgs[-10:]
        return request

    def after_model(self, response: ModelResponse) -> ModelResponse:
        self.used += response.usage.total_tokens
        if self.used > self.max_tokens:
            raise RuntimeError(f"Budget exceeded: {self.used}/{self.max_tokens}")
        return response
```

Middleware 是 1.0 最关键的扩展点，几乎覆盖原 hook、callback、guardrail、retry 等所有横切关注点。

---

## 5. ChatPromptTemplate / MessagesPlaceholder — 消息编排

```python
from langchain_core.prompts import ChatPromptTemplate, MessagesPlaceholder

prompt = ChatPromptTemplate.from_messages([
    ("system", "You are {role}. Today is {date}."),
    MessagesPlaceholder("chat_history", optional=True),
    ("human", "{question}"),
    MessagesPlaceholder("agent_scratchpad"),
])

messages = prompt.format_messages(
    role="senior engineer",
    date="2026-06-20",
    chat_history=[HumanMessage("hi"), AIMessage("hello")],
    question="explain bind_tools",
    agent_scratchpad=[],
)
```

渲染顺序就是发给 LLM 的最终顺序。**对 OpenAI/Anthropic Tools Agent，`agent_scratchpad` 必须是 `MessagesPlaceholder`**；对老式 ReAct/Structured Chat，它是字符串占位符。

> **[补充]** 1.0 后 prompt 拼装一般不再由开发者手写 `ChatPromptTemplate`——`create_agent` 的 `system_prompt` 接受 `str | SystemMessage | Callable[[state, runtime], list[BaseMessage]]`。动态注入（基于 user_id 拉个性化指令）是 middleware 的 `before_model` 钩子的典型用例。

---

## 6. Memory — 从 ConversationBufferMemory 到 RunnableWithMessageHistory 再到 Checkpointer

### 6.1 旧 API（已 deprecated，已迁入 `langchain-classic`）

```python
from langchain_classic.chains import ConversationChain
from langchain_classic.memory import ConversationBufferMemory
```

### 6.2 过渡 API（RunnableWithMessageHistory）

```python
from langchain_core.chat_history import InMemoryChatMessageHistory
from langchain_core.runnables.history import RunnableWithMessageHistory
```

仍可用，但官方明确建议在 agent 场景**直接上 LangGraph checkpointer**。

### 6.3 [补充] 推荐路径：LangGraph Checkpointer

```python
from langgraph.checkpoint.postgres import PostgresSaver
from langchain.agents import create_agent

with PostgresSaver.from_conn_string("postgresql://...") as saver:
    saver.setup()
    agent = create_agent("anthropic:claude-sonnet-4-6", tools, checkpointer=saver)

    agent.invoke(
        {"messages": [{"role": "user", "content": "I'm Bob"}]},
        config={"configurable": {"thread_id": "thread-1"}},
    )
    # 第二次调用，自动加载 thread-1 历史
    agent.invoke(
        {"messages": [{"role": "user", "content": "what's my name?"}]},
        config={"configurable": {"thread_id": "thread-1"}},
    )
```

Checkpointer 还顺带提供 **time-travel**（`get_state_history(config)`）和 **human-in-the-loop interrupt**——这是普通 message history 没有的能力。

---

## 7. LangGraph 长期记忆 — BaseStore / InMemoryStore / PostgresStore

`BaseStore` 是长期记忆抽象，三个核心方法：

- `put(namespace: tuple[str, ...], key: str, value: dict)` —— 写入
- `get(namespace, key)` —— 按 key 读
- `search(namespace, query=None, filter=None, limit=10)` —— 按 namespace 列举或语义检索

### 7.1 InMemoryStore + 语义检索

```python
from langgraph.store.memory import InMemoryStore
from langchain_openai import OpenAIEmbeddings

store = InMemoryStore(
    index={
        "embed": OpenAIEmbeddings(model="text-embedding-3-small"),
        "dims": 1536,
        "fields": ["text"],   # [补充] 指定 value 中哪些字段参与 embedding
    },
)

store.put(
    namespace=("users", "bob"),
    key="pref-cuisine",
    value={"text": "User likes Italian, dislikes spicy food."},
)

hits = store.search(("users", "bob"), query="what food does the user like", limit=3)
for h in hits:
    print(h.key, h.value, h.score)
```

### 7.2 PostgresStore（生产）

```python
from langgraph.store.postgres import PostgresStore

with PostgresStore.from_conn_string("postgresql://...") as store:
    store.setup()
    store.put(("users", "bob"), "profile", {"city": "SF"})
    agent = create_agent(model, tools, store=store, checkpointer=checkpointer)
```

`checkpointer`（如 `PostgresSaver`）负责**线程内**的 messages 快照；`store` 负责**跨线程**的用户记忆。两者正交。

### 7.3 在节点 / middleware 里使用

```python
from langgraph.store.base import BaseStore
from langchain_core.runnables import RunnableConfig

def remember(state: MessagesState, config: RunnableConfig, *, store: BaseStore):
    user_id = config["configurable"]["user_id"]
    memories = store.search(("memories", user_id), query=state["messages"][-1].content, limit=3)
    sys = "User memories:\n" + "\n".join(m.value["text"] for m in memories)
    return {"messages": [{"role": "system", "content": sys}]}
```

`store` 由 LangGraph 通过依赖注入自动传入（同样适用于 `InjectedStore` 注入到工具签名里）。

---

## 8. MCP 集成 — `langchain-mcp-adapters`

`langchain-mcp-adapters` 把 Anthropic MCP server 暴露的 tools / prompts / resources，包装成 LangChain `BaseTool` / `PromptTemplate`，使 LangChain Agent 和 LangGraph Agent **零改造**调用 MCP。

### 8.1 多服务器接入（含三种 transport）

> **[修正]** 原报告只提到 `stdio` 和 `http`。当前 `langchain-mcp-adapters` 支持 **三种 transport**：`stdio`、`sse`（旧）、`streamable_http`（推荐，HTTP 长连接 + 续传 + stateless）。`streamable_http` 是 MCP 协议 2025-03-26 修订引入的新规范，原报告时间点之后才稳定。

```python
import asyncio
from langchain_mcp_adapters.client import MultiServerMCPClient
from langchain.agents import create_agent

async def main():
    client = MultiServerMCPClient({
        "math": {
            "transport": "stdio",
            "command": "python",
            "args": ["/path/to/math_server.py"],
        },
        "weather": {
            "transport": "streamable_http",                 # [补充] 推荐用此而非 sse / http
            "url": "https://api.example.com/mcp",
            "headers": {"Authorization": "Bearer ${TOKEN}"},  # 鉴权
        },
        "internal": {
            "transport": "sse",                              # 仍兼容
            "url": "http://localhost:8001/sse",
        },
    })

    tools = await client.get_tools()             # list[BaseTool]
    agent = create_agent("anthropic:claude-sonnet-4-6", tools)

    print(await agent.ainvoke(
        {"messages": [{"role": "user", "content": "what's (3 + 5) x 12?"}]}
    ))

asyncio.run(main())
```

`get_tools()` 内部会枚举每个 MCP server 的 `list_tools` → 把 MCP schema（`inputSchema` 字段，JSON Schema）映射到 LangChain `StructuredTool.args_schema`。后续 `bind_tools` 时，与本地 Python 工具走同一条 `convert_to_openai_tool` 通道——对上游 chat model 完全透明。

### 8.2 [补充] 同时加载 prompts / resources

```python
from langchain_mcp_adapters.tools import load_mcp_tools
from langchain_mcp_adapters.prompts import load_mcp_prompt
from langchain_mcp_adapters.resources import load_mcp_resources

async with client.session("math") as session:
    tools = await load_mcp_tools(session)
    # 把 MCP server 暴露的 prompt 当 ChatPromptTemplate 用
    prompt = await load_mcp_prompt(session, "explain_step", arguments={"topic": "GCD"})
    # 把 MCP resource 当上下文塞进消息
    resources = await load_mcp_resources(session, uris=["file:///docs/spec.md"])
```

这是原报告完全遗漏的能力——MCP 不只是 tools，还包括服务器侧 prompt template 与 resource。

### 8.3 持久 session

```python
async with client.session("math") as session:
    tools = await load_mcp_tools(session)
    agent = create_agent("openai:gpt-4.1", tools)
    await agent.ainvoke({"messages": [{"role": "user", "content": "..."}]})
```

默认 `MultiServerMCPClient` 是 stateless 的——每次调用工具会重新建 session、跑完即关。需要跨 tool call 共享状态（如 cursor 分页、登录态）时，必须用 `client.session(name)` 显式接管生命周期。

---

## 9. 整体架构与选型建议（修订版）

1. **[修正] 新项目一律 `langchain.agents.create_agent` + middleware**。`langgraph.prebuilt.create_react_agent` 仍能用但已 deprecated，计划在 LangGraph v2.0 移除。文档明确：旧 `AgentExecutor` 与四类 hub prompt 全迁移至 `langchain-classic`。
2. **工具优先 `@tool` 装饰器**；多参数复杂入参用 `StructuredTool`；需要 runtime 注入（user_id、state、store）就用 `InjectedToolArg` / `InjectedState` / `InjectedStore`。
3. **跨模型时不要手写 tool 数组**——一切交给 `bind_tools()`，靠 `convert_to_openai_tool` / Anthropic 适配器统一形状。从 OpenAI 切到 Claude 通常只需改 `model="openai:gpt-4.1"` → `"anthropic:claude-sonnet-4-6"` 一行。
4. **[修正] Prompt 用 `system_prompt` 参数 + middleware 注入**，而不是 Hub 拉旧模板。Hub 模板只在维护老仓库时用。
5. **记忆分层**：线程内消息用 **Checkpointer**（PostgresSaver/SQLiteSaver）；跨线程用户偏好用 **BaseStore**（PostgresStore + embedding 索引）。`ConversationBufferMemory` 系列只在维护老代码时使用。
6. **MCP 三类资源都用**：tools 是基础，**prompts / resources** 在 RAG 与多 agent 协作里同样重要；用 `streamable_http` transport 部署生产 MCP server。
7. **[补充] 结构化输出走 `response_format`**，让 agent 一次出 `messages` + `structured_response`，比独立 `with_structured_output` 链路省 1 次 LLM 调用且能保留 tool-calling 历史。
8. **[补充] 横切关注点全部走 middleware**：`SummarizationMiddleware`（上下文压缩）、`PIIMiddleware`（脱敏）、`HumanInTheLoopMiddleware`（关键工具人工确认）、`ModelRetryMiddleware` / `ToolRetryMiddleware`（容错）、`FilesystemMiddleware`（沙箱化 IO）。自定义 middleware 继承 `AgentMiddleware` 即可。

---

## 10. [补充] 高质量参考资料（社区广泛引用）

- [LangChain & LangGraph 1.0 GA 公告（2025-10-22）](https://www.langchain.com/blog/langchain-langgraph-1dot0)
- [LangGraph v1 migration guide](https://docs.langchain.com/oss/python/migrate/langgraph-v1) — 列出全部 deprecation 与替代
- [LangChain Middleware v1-Alpha Guide — Colin McNamara](https://colinmcnamara.com/blog/langchain-middleware-v1-alpha-guide) — 社区最早一篇深度拆解 middleware 体系
- [Lessons Learnt From Upgrading to LangChain 1.0 in Production — TDS](https://towardsdatascience.com/lessons-learnt-from-upgrading-to-langchain-1-0-in-production/) — 真实生产升级踩坑
- [LangGraph Issue #6404：create_react_agent 弃用提示问题](https://github.com/langchain-ai/langgraph/issues/6404) — 看官方与社区如何讨论迁移细节
- [LangChain Forum：从 create_react_agent 迁到 create_agent 的功能缺口](https://forum.langchain.com/t/migrating-from-langgraph-prebuilt-create-react-agent-to-langchain-agents-create-agent-missing-feature/1985) — 已知缺口与 workaround
- [Tool Calling with LangChain（官方博客）](https://blog.langchain.com/tool-calling-with-langchain/)
- [Semantic Search for LangGraph Memory](https://www.langchain.com/blog/semantic-search-for-langgraph-memory)
- [langchain-mcp-adapters GitHub（v0.3.0）](https://github.com/langchain-ai/langchain-mcp-adapters)
- [MCP 协议 streamable_http 规范（2025-03-26 修订）](https://modelcontextprotocol.io/specification/2025-03-26)

---

## 11. WebFetch 抽样核验结论

| URL | 报告陈述 | 核验结果 |
|---|---|---|
| reference.langchain.com `create_react_agent` | 推荐入口、`version="v2"` 默认、`prompt` 参数 | **已 deprecated**，文档明确建议迁移到 `langchain.agents.create_agent`；参数确实是 `prompt=`、`version="v2"` 默认正确；但 v1.0 后整体推荐路径变了。**报告需修正。** |
| docs.langchain.com `/oss/python/langchain/agents` | — | 当前文档主推 `create_agent(model, tools, system_prompt=..., middleware=[...])`，与原报告 §4.3 描述脱节。**已补充修正。** |
| github.com langchain-mcp-adapters | 两种 transport（stdio / http） | 实为 **三种**：stdio / sse / **streamable_http**，且 streamable_http 是 2025 新增；并支持 `load_mcp_prompts` / `load_mcp_resources`。**已补充。** |
| changelog.langchain.com LangChain 1.0 GA | 未提 | 2025-10-22 GA，引入 middleware、standard content blocks、结构化输出整合，legacy 迁 `langchain-classic`。**已补充第 0 节。** |
| smith.langchain.com hwchase17/react | 模板原文 | 因登录墙未能直接抓到，但模板原文与官方仓库 `langchain-classic` 中固定文本一致，**保持不变**。 |

Sources:
- [LangChain & LangGraph 1.0 公告](https://www.langchain.com/blog/langchain-langgraph-1dot0)
- [LangChain 1.0 Changelog](https://changelog.langchain.com/announcements/langchain-1-0-now-generally-available)
- [LangGraph v1 migration guide](https://docs.langchain.com/oss/python/migrate/langgraph-v1)
- [create_react_agent reference（标注 deprecated）](https://reference.langchain.com/python/langgraph.prebuilt/chat_agent_executor/create_react_agent)
- [docs.langchain.com — Building Agents](https://docs.langchain.com/oss/python/langchain/agents)
- [MCP integration docs](https://docs.langchain.com/oss/python/langchain/mcp)
- [langchain-mcp-adapters GitHub](https://github.com/langchain-ai/langchain-mcp-adapters)
- [Tool Calling with LangChain blog](https://blog.langchain.com/tool-calling-with-langchain/)
- [Semantic Search for LangGraph Memory](https://www.langchain.com/blog/semantic-search-for-langgraph-memory)
- [LangChain Middleware v1-Alpha Guide — Colin McNamara](https://colinmcnamara.com/blog/langchain-middleware-v1-alpha-guide)
- [Lessons Learnt From Upgrading to LangChain 1.0 — TDS](https://towardsdatascience.com/lessons-learnt-from-upgrading-to-langchain-1-0-in-production/)
- [LangGraph Issue #6404](https://github.com/langchain-ai/langgraph/issues/6404)
- [Forum：create_agent 迁移功能缺口](https://forum.langchain.com/t/migrating-from-langgraph-prebuilt-create-react-agent-to-langchain-agents-create-agent-missing-feature/1985)
