# Mac Mini 运维手册

## 1. 系统设置（一次性手动执行）

```bash
# 防休眠
sudo pmset -a sleep 0 disksleep 0 displaysleep 0 powernap 0

# 断电自动重启
sudo pmset -a autorestart 1

# 禁止自动更新
sudo softwareupdate --schedule off

# System Settings → Users & Groups → 自动登录 admin 用户
```

## 2. 服务管理

```bash
pnpm service:install    # 安装 + 启动 launchd 服务
pnpm service:uninstall  # 卸载服务
pnpm service:start      # 启动
pnpm service:stop       # 停止
pnpm service:restart    # 重启（kickstart -k）
pnpm service:status     # 查看状态 + 健康检查
```

## 3. 部署和回滚

### 自动部署（CI/CD）

push 到 main 分支后 GitHub Actions 自动触发：
1. CI 构建前端 + typecheck
2. SCP 前端产物到 Mac Mini
3. SSH 执行 deploy.sh（git pull + 依赖 + drain + 重启 + 健康检查）

### 手动部署

```bash
cd /Users/admin/code/tools/agent
bash scripts/deploy.sh                              # 本地构建前端
bash scripts/deploy.sh /path/to/web-dist.tar.gz     # 使用预构建产物
```

### 回滚

```bash
pnpm rollback              # 回滚到最近快照
pnpm rollback list         # 列出可用快照
pnpm rollback <name>       # 回滚到指定快照
pnpm rollback --force      # 跳过确认直接回滚
```

## 4. 日志

```bash
pnpm service:logs          # 跟踪服务日志
pnpm service:logs:error    # 跟踪错误日志

# 日志文件位置
logs/server.log            # 标准输出
logs/server.error.log      # 标准错误
logs/deploy-*.log          # 部署日志（保留最近 20 个）
logs/rollback-*.log        # 回滚日志
```

### 日志轮转

使用 copytruncate 方案（`scripts/log-rotate.sh`），避免 launchd fd 持有 + rename 导致的"幽灵文件"问题。

- 主日志 10MB、错误日志 5MB 时触发
- `cp` 复制 → `: >` 原地截断（inode 不变）→ `bzip2` 压缩
- 保留 5 份归档，格式：`server.log.YYYYMMDD-HHMMSS.bz2`
- 通过 launchd 定时器每 6 小时自动执行

```bash
# 随 service:install 自动安装，也可手动触发：
bash scripts/log-rotate.sh

# 查看轮转日志
cat logs/log-rotate.log
```

## 5. SSH 远程访问

```bash
ssh -J ecs-user@120.25.123.177 ky004@10.0.0.2
```

生产访问走深圳 ECS 作为 SSH 跳板，再通过 WireGuard 内网访问 Mac Mini。

## 6. 故障排查

### 服务无法启动

```bash
# 1. 查看 launchd 状态
pnpm service:status

# 2. 查看错误日志
tail -50 logs/server.error.log

# 3. 尝试手动启动定位问题
cd server && node ../node_modules/.bin/tsx src/index.ts
```

### 崩溃恢复

launchd 配置了 `KeepAlive.SuccessfulExit=false`：
- exit(非0) → 30s 后自动重启
- exit(0) → 不重启（正常 drain 退出）

### 健康检查

```bash
# 详细信息
curl http://127.0.0.1:3000/api/health | python3 -m json.tool

# 轻量探针
curl http://127.0.0.1:3000/api/healthz
# 200 ok = 正常
# 503 draining = 排空中
```

## 7. GitHub Secrets 配置

| Name | 值 |
|------|-----|
| `DEPLOY_HOST` | `10.0.0.2` |
| `DEPLOY_USER` | `ky004` |
| `DEPLOY_SSH_KEY` | MacBook SSH 私钥（对应公钥需在 Mac Mini `~/.ssh/authorized_keys` 中） |
| `DEPLOY_PROXY_HOST` | `120.25.123.177` |
| `DEPLOY_PROXY_USER` | ECS 登录用户 |
| `DEPLOY_PROXY_KEY` | ECS SSH 私钥 |
| `DEPLOY_PATH` | `/Users/admin/code/agent` |

**Variables**:

| Name | 值 |
|------|-----|
| `SERVICE_PORT` | `3000` |

**Environment**: `production`（可选，用于部署保护规则）
