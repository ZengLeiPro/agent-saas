# 能力中心连接器运行态凭据注入

## 目标

能力中心中已启用、已绑定的连接器，其用户凭据以 SecretVault 为唯一持久来源。每次 Agent 任务开始时，服务端按连接器声明解析环境变量，并注入该用户本次运行环境，使 CLI、SDK 和脚本按官方标准环境变量直接使用。

这套机制只适用于“能力中心 → 连接器”，不读取或注入平台系统配置、管理员 Secret、部署环境变量或任意 `.env` 文件。

## 数据流

```text
能力中心绑定连接器
  → SecretVault 持久化
  → 连接器声明 runtimeEnv
  → 每次任务开始解析当前用户已启用连接器
  → AgentRunOptions.env
  → SDK / 本地 Shell / 容器 Shell / 远端 hand
```

凭据不会写入用户工作区、项目 `.git/config` 或授权配置文件。

## 连接器声明

### Env Secret

`target: "env"` 的 Secret 默认使用 `name` 作为运行态环境变量，不需要重复声明：

```json
{
  "key": "api_key",
  "target": "env",
  "name": "EXAMPLE_API_KEY",
  "scope": "user"
}
```

### Header Secret 同步给 CLI

原本用于 HTTP Header、同时需要提供给 CLI/SDK 的凭据，通过 `runtimeEnv` 声明：

```json
{
  "key": "token",
  "target": "header",
  "name": "Authorization",
  "scope": "user",
  "runtimeEnv": ["GH_TOKEN", "GITHUB_TOKEN"]
}
```

### OAuth access token

OAuth 连接器可在 `config.oauth.runtimeEnv` 声明 access token 的环境变量名：

```json
{
  "type": "streamable-http",
  "url": "https://example.com/mcp",
  "oauth": {
    "provider": "generic",
    "runtimeEnv": ["EXAMPLE_TOKEN"]
  }
}
```

第一版只注入 OAuth `access_token`，不注入 refresh token、client secret 或 OAuth client 配置。内置映射为：Notion 使用 `NOTION_TOKEN`；Google 官方连接器使用各自独立的 `GOOGLE_<SERVICE>_ACCESS_TOKEN`，避免多个 Google 授权互相覆盖。

## 生效规则

只有同时满足以下条件的连接器才会注入：

- 对当前租户可见；
- 当前用户已启用；
- 对应 Secret 或 OAuth connection 已绑定且可读取；
- 环境变量名符合 `^[A-Z_][A-Z0-9_]*$`。

单个连接器凭据失效时，该连接器跳过并记录不含凭据值的警告，不阻断其他连接器和 Agent 任务。

连接器值覆盖平台通用运行环境中的同名变量，保证当前用户授权优先。

## GitHub

内置 GitHub 连接器将 PAT 注入：

```text
GH_TOKEN
GITHUB_TOKEN
```

`gh` CLI 直接读取上述变量。原生 Git 通过固定的 `credential.helper` 从相同环境变量读取 token，因此 `clone/fetch/pull/push` 不依赖 `gh auth login`、工作区授权文件或用户项目配置。

## 远端 hand

brain 到远端 hand 的 wire env 接受标准大写环境变量名，同时拒绝可能改变进程加载、模块解析或执行路径的保留变量，例如：

```text
PATH
HOME
NODE_OPTIONS
NODE_PATH
LD_PRELOAD
LD_LIBRARY_PATH
PYTHONPATH
```

服务端发送和 hand 接收两侧都会执行相同过滤。

## 安全边界

本方案优先保证连接器的原生工具兼容性和任务成功率。连接器凭据进入当前用户运行态后，Agent 及其启动的代码可以读取该用户主动授权的凭据。

平台仍必须保证：

- 不跨用户、跨租户注入；
- 不把凭据值写入日志、审计、工作区或 Git；
- 连接器断开、更新或撤销后，后续任务重新从 Vault 解析；
- 不将本机制扩展到能力中心连接器之外的系统 Secret。
