# Agent SaaS

一个多端 Agent 应用平台：Web / Mobile / 钉钉通道统一接入后端，由 server 负责鉴权、会话、工具调用、权限审批、定时任务、审计与 OpenAI-compatible LLM 调用。

> 完整架构说明见：[`docs/architecture/project-architecture.md`](docs/architecture/project-architecture.md)

## 当前状态

- Monorepo：`server`、`web`、`shared`、`mobile`、`hand-server`。
- 后端：Express + WebSocket + 自研 raw runtime。
- 模型调用：主聊天 runtime 直接调用 OpenAI-compatible Chat Completions API；不再依赖 `@openai/agents`。
- 前端：Vite + React，支持桌面 / 移动 Web 布局与 PWA。
- 移动端：Expo / React Native，复用 `@agent/shared`。
- 通道：Web WebSocket 与钉钉机器人。
- 数据：transcript JSONL、runtime event store、business DB、memory index、Cron store。

## 项目结构

```text
agent-saas/
├── server/           # Express API、WebSocket、raw runtime、数据层、Cron、集成
├── web/              # Vite + React Web 客户端
├── shared/           # Web / Mobile 共享类型、API client、WS client、store
├── mobile/           # Expo / React Native 移动端
├── hand-server/      # 辅助服务
├── workspace-shared/ # 共享配置、skills pool、模板与脚本
└── docs/             # 架构、部署、运维文档
```

## 前置要求

- Node.js 18+
- pnpm（项目锁定 `pnpm@10.18.3`，建议启用 Corepack：`corepack enable`）
- 可用的 OpenAI-compatible API Key / Base URL 配置

## 快速开始

```bash
pnpm install
pnpm dev
```

默认访问：

- Web: <http://localhost:3000>
- Server: <http://localhost:3001>

常用命令：

```bash
pnpm dev:server   # 启动后端
pnpm dev:web      # 启动 Web
pnpm build        # 构建 Web
pnpm start        # 启动 server
pnpm test         # 运行 server/shared/web 测试
```

## 配置

根目录通常通过 `config.json` 配置服务端口、模型组、Agent 工作区、鉴权、Cron、钉钉、memory index 等。`workspace-shared/.claude/settings.json` 可提供共享 env、MCP 和技能池相关配置。

最小示例：

```json
{
  "agent": {
    "cwd": "../workspace"
  },
  "server": {
    "port": 3001
  },
  "models": {
    "default": "default/gpt",
    "groups": [
      {
        "id": "default",
        "name": "Default",
        "apiKey": "your-api-key",
        "baseUrl": "https://api.example.com/v1",
        "models": [{ "id": "gpt", "value": "gpt-5.4-mini" }]
      }
    ]
  }
}
```

## 主要能力

- WebSocket 实时聊天事件流。
- 多用户、JWT 鉴权、用户禁用与审计日志。
- 文件工具、shell 工具、memory search、技能工具与权限审批。
- runtime event store、approval resume、runtime audit。
- 会话列表、分组、fork、自动标题、token usage 统计。
- Cron 定时任务与钉钉通知。
- 文件上传、预览、照片/视频、TTS/STT。
- 钉钉 Stream / webhook 通道。

## 部署与运维

常用部署方式：

```bash
pnpm build
pnpm start
```

生产模式下，server 会托管 `web/dist`，同时提供 REST API 和 WebSocket。更多运维说明见 `docs/` 下的 Mac mini、ECS、Tailscale、WireGuard、Azeroth 等文档。
