# Agent SaaS 项目架构

> 更新时间：2026-06-17  
> 范围：当前仓库 `agent-saas` 的服务端、Web、移动端、共享包、运行时、数据与部署边界。

## 1. 项目定位

Agent SaaS 是一个多端 Agent 应用平台，核心能力包括：

- Web / Mobile 多端聊天入口。
- 基于 WebSocket 的实时 Agent 事件流。
- 自研 raw runtime，直接调用 OpenAI-compatible Chat Completions 接口。
- 工具调用、权限审批、approval resume、runtime event store 与审计查询。
- 多用户、Agent profile、技能、会话分组、文件/媒体、TTS/STT、Cron 定时任务。
- 钉钉机器人通道与通知能力。

历史 `@openai/agents` SDK PoC 已移除；当前不再依赖 Agents SDK。保留的 `openai` npm 包只作为普通 LLM API client 使用，主要用于标题生成与少量验证脚本。主聊天 runtime 使用自研 adapter 和 `fetch` 调 OpenAI-compatible API。

## 2. Monorepo 工作区

仓库使用 pnpm workspace：

```text
agent-saas/
├── server/           # Express API、WebSocket、raw runtime、数据层、Cron、外部集成
├── web/              # Vite + React Web 客户端
├── shared/           # Web / Mobile 共享类型、API client、WebSocket client、store、平台抽象
├── mobile/           # Expo / React Native 移动端
├── hand-server/      # 依赖 server 包的辅助服务
├── workspace-shared/ # Agent 工作区共享配置、skills pool、模板与脚本
├── docs/             # 架构、部署、运维、计划文档
└── package.json      # 根脚本编排
```

根脚本主要负责组合启动和生产构建：

- `pnpm dev`：同时启动 server 和 web。
- `pnpm dev:server`：启动后端 watch 模式。
- `pnpm dev:web`：启动 Vite 开发服务。
- `pnpm build`：构建 Web。
- `pnpm start`：启动 server。
- `pnpm test`：运行 server/shared/web 中声明的测试。

## 3. 高层系统图

```text
┌──────────────────┐       HTTP / WS        ┌────────────────────────┐
│ web/ React + PWA │ ─────────────────────▶ │ server/ Express        │
└──────────────────┘                         │ - REST 控制面 API       │
                                             │ - /ws WebSocket        │
┌──────────────────┐                         │ - ChannelManager       │
│ mobile/ Expo     │ ─────────────────────▶ │ - raw runtime          │
└──────────────────┘                         │ - data stores          │
                                             └──────────┬─────────────┘
┌──────────────────┐                                    │
│ Dingtalk Stream  │ ───────────────────────────────────┘
└──────────────────┘
                                                        ▼
                                             ┌────────────────────────┐
                                             │ OpenAI-compatible API  │
                                             │ Chat Completions       │
                                             │ Embeddings / STT / TTS │
                                             └────────────────────────┘
```

关键原则：

1. 客户端不直接访问模型 API；所有模型调用由 server 代理和治理。
2. 通道入口与控制面 API 分离：聊天消息入口由 Channel 注册，管理查询类 API 由 app routes 注册。
3. raw runtime 是当前主执行路径；事件流与 approval 状态可持久化、可恢复、可审计。
4. Web 和 Mobile 共享协议、类型和部分状态逻辑，UI 层各自实现。

## 4. Server 架构

### 4.1 启动入口

`server/src/index.ts` 是服务入口，负责：

1. 调用 `createRuntime()` 创建 `AppRuntime`。
2. 创建 Express app。
3. 配置 CORS 与 JSON body parser。
4. 为 `/api/azeroth/*` 跳过 JSON parser，保留原始 body stream 以便透明代理。
5. 注册 localhost-only 的 `/internal/browser` 浏览器 CDP API。
6. 挂载鉴权 middleware。
7. 调用 `registerRoutes()` 注册控制面 API。
8. 启动所有 Channel。
9. 生产模式下托管 `web/dist`。
10. 启动 Cron。
11. 监听 HTTP 端口并把 WebSocket server attach 到同一个 HTTP server。

### 4.2 AppRuntime 依赖容器

`server/src/app/runtime.ts` 负责装配全局运行时依赖，返回 `AppRuntime`。典型成员包括：

- 配置与路径：`config`、`processCwd`、`agentCwd`、`sharedDir`、`uploadsDir`。
- 通道管理：`channelManager`。
- 调度指标：`dispatchMetricsStore`。
- 数据 store：users、agents、groups、skills、usage。
- Cron runtime。
- 钉钉依赖。
- runtime event store resolver。
- runtime audit query。
- auth middleware。
- title generator 配置。
- memory index shutdown / MCP shutdown / audit shutdown 等生命周期钩子。

这使路由层和通道层通过依赖注入使用服务，而不是散落读取全局状态。

### 4.3 路由层

`server/src/app/routes.ts` 是控制面 API 的 composition root。

路由约定：

- 聊天入口类路由由 Channel 自己注册，例如 Web chat、钉钉 webhook/stream。
- 控制面和查询类 API 由 `registerRoutes()` 统一挂载。

主要 API 模块：

- Health / 状态：健康检查、活跃流、draining 状态。
- App update：移动端版本检查与 APK 下载。
- Upload / File / Preview：上传、文件浏览、HTML/Markdown/PDF/视频等预览。
- Voice / TTS / STT：语音输入输出。
- Sessions：会话列表、详情、删除、重命名、自动标题、流状态查询。
- Groups：会话分组。
- Auth / Users：登录、刷新 token、用户管理、头像、审计日志。
- Agents：Agent profile 管理。
- Skills：技能池、用户技能、配置同步。
- Cron：定时任务 CRUD、运行日志、表达式校验。
- Usage：管理员 token usage dashboard。
- Runtime audit：管理员查看 tool audit 投影。
- Azeroth proxy：server 注入员工 PAT 的透明反向代理。
- Dingtalk sessions：管理员查看/选择钉钉通知目标。

### 4.4 Channel 层

Channel 是“消息入口”的抽象，由 `ChannelManager` 管理。

当前主要 Channel：

- `WebChannel`：处理 Web 前端聊天请求，通过 WebSocket 推送 Agent 事件流，支持权限审批、AskUser、abort、resume、sync、重连补偿。
- `DingtalkChannel`：处理钉钉 Stream / webhook 消息、媒体预处理、互动卡片、会话映射和发送。

`ChannelManager` 负责：

- 注册 channel。
- 启动 / 停止所有 channel。
- 聚合活跃 stream 数量。
- 保存 draining 状态，优雅停机期间拒绝新聊天。

### 4.5 WebSocket 协议

Web 端使用 `/ws` 长连接。相关模块：

- `server/src/channels/web/wsServer.ts`：连接升级、JWT 验证、心跳、用户连接管理、广播。
- `server/src/channels/web/wsTypes.ts`：上下行消息类型。
- `server/src/channels/web/eventBus.ts`：按 user/session 广播事件，支持多端同步。
- `server/src/channels/web/eventBuffer.ts`：事件缓存，服务重连和补偿场景。
- `server/src/channels/web/interactionStore.ts`：权限审批 / AskUser 等交互请求的等待与恢复。

典型下行事件包括：文本增量、thinking 增量、工具开始/输入/结果/结束、权限请求、AskUser、token usage、通知、memory recall、plugin install 状态、done/error。

## 5. Agent 执行与 raw runtime

### 5.1 当前主路径

当前主路径是自研 raw runtime，不再通过 Agents SDK。核心链路：

```text
Channel 收消息
  → engine/dispatch 中间件
  → runtime/rawRuntimeRunDispatch
  → runtime/rawAgentLoop
  → runtime/chatCompletionsAdapter
  → OpenAI-compatible Chat Completions API
  → OutboundEvent 事件流
  → Channel 推送到客户端
```

### 5.2 Dispatch Engine

`server/src/engine/dispatch.ts` 是 Agent 执行前的中间件层，负责：

- 生成 runId 与 trace。
- 限流、指标、审计日志。
- 解析用户 workspace。
- 注入 persona / memory / skills。
- 构建 sandbox 读写策略。
- 合并 user overrides。
- 注入 GitHub CLI、浏览器端口、Azeroth token 等执行上下文。
- 包装 runtime dispatch。

### 5.3 Runtime 层

`server/src/runtime/` 包含 raw runtime 的核心协议与持久化：

- `rawAgentLoop.ts`：模型循环、工具调用、继续对话。
- `rawRuntimeRunDispatch.ts`：把平台消息转换成 runtime run。
- `chatCompletionsAdapter.ts`：OpenAI-compatible Chat Completions streaming adapter。
- `approvalStore.ts`：持久化 approval pending 状态。
- `fileEventStore.ts` / `pgEventStore.ts`：runtime event store 后端。
- `replay.ts`：基于事件重建运行状态。
- `auditProjection.ts` / `auditQuery.ts` / `pgAuditQuery.ts` / `auditDuckDb.ts`：tool audit 投影和查询。
- `sessionCatalog.ts`：runtime session 目录。
- `executionConfig.ts` / `executionTransport.ts` / `httpTransport.ts`：执行目标与传输抽象。
- `toolPolicy.ts`：工具策略。

### 5.4 Tool Runtime

`server/src/agent/toolRuntime.ts` 和 `server/src/agent/builtinTools.ts` 提供模型可调用工具：

- 文件读写。
- 目录列表。
- shell 命令。
- memory search。
- 其他平台内置工具。

工具调用经过权限策略和交互审批：高风险工具会向客户端发起 permission request，用户批准后再执行。approval 状态写入 runtime event store，因此服务重启或 WebSocket 重连后可以恢复。

平台 admin Web 会话可在输入框模型选择器左侧打开 `Shell` 开关。该开关以 run metadata 中的 `approvalPolicy.autoApproveRunShell` 传给 raw runtime；`DefaultToolPolicy` 只在当前身份为平台 admin（`role='admin' && tenantId=DEFAULT_TENANT_ID`）且工具是 `Shell` 时自动放行，其它危险工具仍按原审批流程处理。`Shell` 本身不再是 admin-only：平台 admin 默认走 `server-local`；非平台用户默认走 `server-container`（本机 Docker 隔离 fallback），若 session attach 唯一 ready tenant-remote hand 则工具层优先自动路由到该 hand；非平台用户若落到 `server-local` 仍 fail-closed。

### 5.5 标题生成

`server/src/agent/titleGenerator.ts` 是轻量单轮 LLM 调用，用于会话自动标题。它使用 `openai` API client 调 Chat Completions，不使用 Agent runtime，不挂工具，不写 runtime event store。

## 6. 数据与持久化

### 6.1 业务数据

`server/src/data/` 按领域拆分：

- `users/`：用户、密码、角色、禁用状态。
- `agents/`：Agent profile、头像、persona。
- `groups/`：会话分组。
- `skills/`：技能池扫描、用户技能配置、迁移。
- `transcripts/`：会话 JSONL、meta、fork、project key。
- `sessions/`：钉钉 session store。
- `usage/`：token usage 聚合、定价、从 JSONL 回填。
- `login-logs/`：登录审计。
- `db/` / `migrations/`：business DB 和启动迁移。

### 6.2 Transcript 与 Session Meta

聊天 transcript 以 JSONL 保存，session meta 保存标题、归属用户、participants、runtime 状态、执行目标等信息。

主要用途：

- 会话列表和详情查询。
- 自动标题。
- token usage 回填。
- 会话 fork。
- 历史消息恢复。

### 6.3 Runtime Event Store

runtime events 是 raw runtime 的真实执行事件流，用于：

- approval resume。
- WebSocket reconnect 后重建状态。
- pending API 查询。
- tool audit projection。
- runtime replay。

后端支持文件和 PostgreSQL 两种 event store 后端，读取路径统一通过 `runtimeEventStoreFor()`，避免调用方硬编码存储实现。

### 6.4 Business DB / Token Usage

业务 DB 存储 token usage 聚合结果，并支持管理员 usage dashboard。usage 可从 transcript JSONL 回填，也可在 runtime 结果中实时记录。

### 6.5 Memory Index

`server/src/memory/index/` 提供记忆索引能力：

- chunking。
- embeddings。
- sqlite / sqlite-vec 存储。
- hybrid search。
- temporal decay。
- debounce sync。

embedding 调用使用 OpenAI-compatible `/v1/embeddings` API。

## 7. Web 前端架构

`web/` 是 Vite + React 应用。

主要分层：

- `src/App.tsx`：组合应用状态、生命周期、布局选择、全局提示。
- `src/layouts/`：DesktopLayout / MobileLayout。
- `src/components/`：消息、工具块、权限块、文件浏览、Cron、用户管理、Usage Dashboard、Skill 等 UI。
- `src/hooks/`：chat app state、session、messages、connection、TTS、voice recorder、upload、responsive 等。
- `src/contexts/`：Auth、FilePreview。
- `src/lib/`：authFetch、sessions API、groups API、WebSocket client、缓存、URL sync。
- `src/types/`：Web 专用类型。
- `src/platform/`：Web 平台适配。

Web 客户端通过 REST API 读控制面数据，通过 WebSocket 收发聊天事件。生产构建产物可由 server 直接托管。

## 8. Shared 包

`shared/` 是 Web 和 Mobile 的共享层，导出：

- 跨端类型：message、session、group、cron、user、agent、skill、file、ws 等。
- API client：auth、sessions、groups、skills、agents 等。
- WebSocket client 和事件处理。
- Zustand store slices 与 actions。
- 平台抽象：storage、secure storage、message cache、config。
- 通用工具：格式化、文件类型视觉、persona 解析、session merge、activity reporter。

原则：协议、类型和通用状态逻辑下沉到 shared；平台 UI 留在 web/mobile。

## 9. Mobile 架构

`mobile/` 是 Expo / React Native 应用，使用 Expo Router。

主要能力：

- 登录和改密。
- Chat session 页面。
- Cron 管理。
- 设置、用户、技能、Agent/persona 管理。
- 文件、Markdown、HTML 预览。
- share target。
- 访问记录/业务表单。

Mobile 依赖 `@agent/shared`，复用协议、API client、类型和部分状态逻辑，但使用原生 UI 和 Expo 能力实现移动体验。

## 10. 钉钉通道

钉钉相关代码位于 `server/src/channels/dingtalk/` 和 `server/src/integrations/dingtalk/`。

主要模块：

- `protocol/`：Stream client、webhook router、签名、消息提取、session router。
- `services/`：media、voice、delivery、card、session、commands、message buffer。
- `pipeline/`：preprocessor、postprocessor、event stream consumer、display filter、媒体后处理。
- `integrations/dingtalk/`：钉钉 API client，包括 AI card、media、voice、proactive message。

钉钉通道将外部消息转换成平台统一的 `InboundMessage`，再走相同 dispatch/runtime 路径；输出事件经过钉钉 display filter 和 delivery service 发送回会话。

## 11. Cron 定时任务

`server/src/cron/` 提供轻量任务调度系统：

- `store.ts`：任务定义持久化。
- `scheduler.ts`：计算下一次运行时间。
- `service.ts`：任务 CRUD、启动、停止、运行日志。
- `executor.ts`：执行 agentTurn 或 systemEvent。
- `notifier.ts` / `notifyChannel.ts`：通知抽象。
- `notifyChannels/dingtalkNotifyChannel.ts`：钉钉通知。
- `followup.ts`：构造 follow-up 上下文。
- `run-log.ts`：运行日志。

Cron payload 支持：

- `agentTurn`：定时触发 Agent 执行。
- `systemEvent`：仅发系统通知。

通知支持 Web 调试输出和钉钉定向会话通知。钉钉通知必须显式指定 `conversationId`，避免误发到最近会话。

## 12. Skills / Workspace

### 12.1 workspace-shared

`workspace-shared/` 存放所有用户 workspace 可共享的配置和资源：

- `.ky-agent/settings.json`：共享 env、mcpServers 等配置来源。
- `.ky-agent/skills-pool/`：技能池。
- `MEMORY.template.md`、`PERSONA.template.md`、`questions.template.md`。
- `system-prompt-static.md`、`system-prompt-dynamic.md`。
- 同步脚本。

### 12.2 用户 workspace

`agent.cwd` 是全局 Agent 工作区根目录。多用户场景中，普通用户通常解析到各自子目录，admin 可按权限访问更多目录。`server/src/workspace/resolver.ts` 负责路径解析、用户 workspace 初始化、技能同步。

### 12.3 Skills

技能配置由 `SkillConfigStore` 管理，启动时可从 manifest 迁移，运行时按用户列出可用 skill。raw runtime 通过 SkillsDispatchConfig 把可用 skill 暴露给工具调用链。

## 13. 认证与权限

认证模块位于 `server/src/auth/` 和 `server/src/routes/auth.ts`。

主要机制：

- JWT 登录与刷新。
- `authMiddleware` 保护 `/api` 路由。
- WebSocket 连接时校验 token。
- 用户禁用后断开 WebSocket 并中止活跃流。
- admin-only 路由使用 `requireAdmin`。
- 文件路径访问经过 `security/extraDirs.ts` 校验。
- executionTarget、extra dirs、GitHub CLI、shell 等能力可按用户 overrides 控制。

## 14. 媒体、文件与预览

相关模块：

- `routes/upload.ts`：上传。
- `routes/file.ts`：文件列表、下载、删除等。
- `routes/preview.ts`：预览 token 与静态文件服务。

预览和下载均需要路径授权校验，避免用户越界读取 workspace 外文件。

## 15. 部署与运维

仓库包含多套运维文档：

- Mac mini：`docs/mac-mini-setup.md`、`docs/mac-mini-ops.md`。
- ECS：`docs/ecs-deployment.md`、`docs/ecs-ssh-setup.md`。
- 网络代理：`docs/tailscale-nginx-setup.md`、`docs/wireguard-nginx-setup.md`。
- Azeroth PG：`docs/azeroth-pg-setup.md`。

生产模式通常为：

1. `pnpm build` 构建 Web。
2. `pnpm start` 启动 server。
3. server 托管 `web/dist`，同时提供 REST API 和 WebSocket。
4. 外层通过 nginx / tailscale / wireguard / frp 等方式暴露服务。

## 17. 关键请求链路

### 17.1 Web 聊天

```text
用户输入
  → web ChatInput
  → shared/web wsClient
  → server WebSocket / WebChannel
  → engine dispatch
  → rawRuntimeRunDispatch
  → rawAgentLoop
  → ChatCompletionsModelAdapter
  → OpenAI-compatible /chat/completions
  → ModelEvent
  → OutboundEvent
  → WebChannel display filter
  → WebSocket 下发
  → web message store 更新 UI
```

### 17.2 工具审批

```text
模型产生 tool_call
  → raw runtime 写 runtime event
  → 判断工具风险
  → 若 approvalPolicy.autoApproveRunShell=true 且工具为 Shell 且会话身份为 admin，则 policy_auto 执行
  → WebChannel 发 permission_request
  → 前端 PermissionBlock 展示
  → 用户批准 / 拒绝
  → approvalStore 写入结果
  → ToolRuntime.invoke 执行或返回拒绝
  → 结果回传模型继续生成
```

### 17.3 WebSocket 重连恢复

```text
客户端断线重连
  → ws sync / resume
  → 通过 runtimeEventStoreFor(session) 读取事件
  → buildRuntimeReplayState
  → 恢复 pending approval / stream 状态
  → 补发必要事件
```

### 17.4 Cron agentTurn

```text
Cron scheduler 到点
  → CronService
  → executor
  → 构造 InboundMessage + ChannelContext
  → dispatch / raw runtime
  → run log
  → notify channel 输出结果
```

## 18. 当前边界与待办

当前已完成：

- 主 runtime 收敛到 raw runtime。
- `@openai/agents` SDK PoC 与依赖已移除。
- Web/Mobile 共享协议层存在。
- runtime event store、approval resume、audit query 已形成闭环。

仍需注意：

- README 与旧运维文档中仍可能存在历史 Claude / 旧仓库描述；以本文档和当前代码为准。
- `openai` npm 包仍作为普通 API client 使用，不是 Agent SDK。
- 部署环境若之前安装过旧依赖，需要重新 `pnpm install --frozen-lockfile` 或按部署流程重建依赖。
