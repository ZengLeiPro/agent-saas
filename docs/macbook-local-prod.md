# MacBook 本地一键运行

目标：先不部署 ECS，在 MacBook 上用一个命令启动 agent-saas；Web、API、WebSocket 统一走 `http://127.0.0.1:3200`，PostgreSQL 由本机 Docker 提供。

## 前置条件

- macOS
- Docker Desktop for Mac
- Node.js 22+（推荐自带 corepack）

## 一键启动

```bash
pnpm local:prod
```

如果刚 clone 下来还没有 pnpm，也可以直接运行：

```bash
bash scripts/local-prod.sh
```

脚本会自动完成：

1. 启动本机 Docker PostgreSQL（`agent-saas-local-postgres`）。
2. 首次运行时从 `config.local.example.json` 生成本地 `config.json`。
3. 创建 repo 内的 `workspace/`、`workspace-shared/`、`server/data/`、`logs/`。
4. 执行 `pnpm install --frozen-lockfile --filter server... --filter web...`，只安装本地 Web/API 运行所需依赖，避免拉取 mobile/Expo/RN 原生依赖。
5. 执行 `pnpm build`。
6. 在 `http://127.0.0.1:3200` 启动 Web + API + WebSocket。

## 依赖安装范围

`pnpm local:prod` 只安装 `server`、`web` 及其 workspace 依赖；本地统一端口运行不需要 `mobile` / Expo / React Native 原生依赖。这样可以避免 macOS 上无关 native postinstall 脚本导致一键启动失败。

如果你确实要开发移动端，请单独运行 mobile 相关安装/构建命令。

## 端口

- Web/API/WS：`3200`
- PostgreSQL：`5432`，只绑定 `127.0.0.1`

如果本机已经占用 5432，可以指定：

```bash
LOCAL_PG_PORT=55432 pnpm local:prod
```

首次生成的 `config.json` 会把 PG 连接串写成对应端口。已经生成过 `config.json` 后，如果再改端口，需要手动同步修改 `runtimeEventStore.connectionString`。

## 本地配置

首次运行会生成 `config.json`。这个文件包含本机绝对路径和本地 secret，已被 `.gitignore` 忽略，不要提交。

默认本地配置：

- `server.port = 3200`
- `runtimeEventStore.backend = "pg"`
- PG 连接到 Docker Postgres
- `auth.enabled = false`，方便第一次本机启动
- `agent.cwd = <repo>/workspace`
- `agent.sharedDir = <repo>/workspace-shared`

如果要给局域网或 Tailscale 上的其他设备访问，建议手动把 `config.json` 里的 `auth.enabled` 改为 `true`，并创建用户后再开放端口。

## 常用命令

```bash
# 启动/重启数据库
LOCAL_PG_PORT=5432 docker compose -f docker-compose.local-db.yml up -d

# 查看数据库日志
docker logs -f agent-saas-local-postgres

# 停止数据库（保留数据卷）
docker compose -f docker-compose.local-db.yml down

# 删除数据库数据（危险）
docker compose -f docker-compose.local-db.yml down -v
```
