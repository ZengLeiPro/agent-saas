# 能力中心原生连接器与官方 CLI

## 统一目标

能力中心内置连接器不再以 MCP server 作为授权、启停或主要调用模型。每位用户独立授权后，平台在该用户每次运行、恢复、durable wake 和后台 Agent 执行时解析当前连接状态，并向运行环境提供官方 CLI 所需的认证环境。

| 连接器 | 官方 CLI | 运行时认证环境 |
|---|---|---|
| GitHub | `gh` / `git` | `GH_TOKEN`、`GITHUB_TOKEN`、隔离 Git credential helper |
| Notion | `ntn` | `NOTION_API_TOKEN` |
| Google Workspace | `gws` | `GOOGLE_WORKSPACE_CLI_TOKEN` |
| 钉钉 | `dws` | `DWS_CONFIG_DIR=/workspace/.dws` |
| 飞书 | `lark-cli` | `LARKSUITE_CLI_CONFIG_DIR=/workspace/.lark-cli` |

Notion、Google Workspace 的长期凭据由 SecretVault 持久化；Google refresh token 永不进入运行时 env，每次运行只注入有效的短期 access token。钉钉、飞书按官方 CLI 的多 profile/keychain 机制运行，认证目录位于当前用户独立 workspace。

## 运行链路

统一入口为 `server/src/runtime/connectorRunEnv.ts` 与 `server/src/app/runtime.ts` 的 native connector resolver。覆盖：

- 普通消息 dispatch；
- Tool approval / 交互恢复；
- durable scheduler wake；
- 前台子 Agent（继承父运行 env）；
- 后台 Agent（执行时按任务 owner 重新解析）。

环境是 run-scoped，不修改宿主进程全局 `process.env`，也不需要重启用户运行环境。授权或断开后，下一个 run/resume 生效；已经启动的进程不会被反向修改。

## 镜像基线

`Dockerfile` 必须固定并在构建期执行版本 smoke test：

- `gh`
- `ntn`
- `gws`
- `dws`
- `lark-cli`

生产镜像不在用户运行时执行 `npx ...@latest`。升级版本先修改 Dockerfile pin，再经过镜像构建和官方 CLI `--version`/授权 smoke test。

## Google OAuth 配置

原生 Google Workspace Connector 使用：

```text
GOOGLE_WORKSPACE_CONNECTOR_CLIENT_ID
GOOGLE_WORKSPACE_CONNECTOR_CLIENT_SECRET
CONNECTOR_OAUTH_CALLBACK_URL=https://<公开域名>/api/connectors/oauth/callback
```

原生 Connector 不读取旧 MCP OAuth client 配置，避免 client 与回调 URI 串线。回调 URL 必须在 Google OAuth client 中单独登记。

## MCP 边界

通用 MCP Manager 继续支持用户或管理员自行添加的第三方 MCP server；GitHub、Notion、Google Workspace、钉钉、飞书不再作为内置 MCP preset 出现。旧 preset 在 v5 迁移时会从用户启用列表移除，运行态 resolver 也显式排除这些 legacy id。
