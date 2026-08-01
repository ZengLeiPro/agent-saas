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
| 阿里云 | `aliyun` | 短期 STS 三件套、`ALIBABA_CLOUD_REGION_ID` |

Notion、Google Workspace、阿里云的长期凭据由 SecretVault 持久化；Google refresh token 永不进入运行时 env，每次运行只注入有效的短期 access token。阿里云源 AK/SK 只用于 Server 端 `AssumeRole`，运行时只注入短期 STS，不创建共享 `~/.aliyun/config.json`。钉钉、飞书按官方 CLI 的多 profile/keychain 机制运行，认证目录位于当前用户独立 workspace。

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
- `aliyun`

生产镜像不在用户运行时执行 `npx ...@latest`。升级版本先修改 Dockerfile pin，再经过镜像构建和官方 CLI `--version`/授权 smoke test。

## Google OAuth 配置

原生 Google Workspace Connector 使用：

```text
GOOGLE_WORKSPACE_CONNECTOR_CLIENT_ID
GOOGLE_WORKSPACE_CONNECTOR_CLIENT_SECRET
CONNECTOR_OAUTH_CALLBACK_URL=https://<公开域名>/api/connectors/oauth/callback
```

原生 Connector 不读取旧 MCP OAuth client 配置，避免 client 与回调 URI 串线。回调 URL 必须在 Google OAuth client 中单独登记。

## 阿里云 RAM Role 基线

能力中心要求用户提供专用 RAM 身份的 AccessKey、目标 Role ARN、默认地域和可选 External ID。连接时 Server 立即调用 STS `AssumeRole` 验证权限；验证成功后，源凭据按 `tenantId + userId + aliyun` 隔离保存在 SecretVault。每个 run 首次解析时重新换取 1 小时 STS，进程内最多缓存到过期前 5 分钟；刷新失败时 fail closed，不注入任何阿里云变量。

`aliyun v3.4.4` 的 `ALIBABA_CLOUD_IGNORE_PROFILE=TRUE` 会把 CLI region 固定为 `cn-hangzhou`，因此运行态不使用该开关。镜像中的 `/usr/local/bin/aliyun` 只是官方二进制前的凭据适配脚本：检测到短期 STS env 时，通过 Linux `memfd` 生成 mode 0600、仅存在于内存文件描述符中的一次性 `StsToken` profile，把目标地域传给原版 `/usr/local/libexec/aliyun`；进程退出或被 `SIGKILL` 后由内核自动销毁，不在 `/tmp`、HOME 或 NAS 落盘。未注入连接器 env 时直接执行原版 CLI。

官方 CLI OAuth 的 localhost 回调不用于 SaaS。未来若配置阿里云 Web OAuth，授权入口只负责把长期授权写入同一 SecretVault，运行态仍统一解析为短期 STS env，CLI 与执行链路不变。

## MCP 边界

通用 MCP Manager 继续支持用户或管理员自行添加的第三方 MCP server；GitHub、Notion、Google Workspace、钉钉、飞书、阿里云不再作为内置 MCP preset 出现。旧 preset 在 v5 迁移时会从用户启用列表移除，运行态 resolver 也显式排除这些 legacy id。
