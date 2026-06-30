# ECS 直部署：agent-saas server

> 当前生产测试口径：server 直接跑在新深圳 ECS systemd；不使用 Docker。

## 运行位置

- 代码目录：`/opt/agent-saas-app/current`
- systemd：`agent-saas-server.service`
- 配置：`/etc/agent-saas/config.json`
- 环境变量：`/etc/agent-saas/server.env`
- NAS 总根：`/mnt/agent-saas`
- 持久数据：`/mnt/agent-saas/server-data`
- 用户 workspace：`/mnt/agent-saas/workspaces/<tenantId>/<userId>`
- 运行态/归档：`/mnt/agent-saas/runtime`
- 公网入口：新 ECS 本机 nginx，`agent.kaiyan.net -> 47.106.14.205 -> 127.0.0.1:3200`
- nginx 配置：`/etc/nginx/conf.d/agent-kaiyan.conf`
- TLS 证书：`/etc/letsencrypt/live/agent.kaiyan.net/`，`certbot-renew.timer` 自动续期

`server/data` 在部署后软链到 NAS 持久目录，避免每次 release 覆盖用户、租户、MCP、SecretVault 等本地态。

完整 NAS 约定见 [生产 NAS 目录布局](nas-layout.md)。

`workspaceId` 只作为 PG、HandStore、审计、Sandbox 名称和标签中的逻辑 ID。真实用户文件目录由 `resolveUserCwd(agentCwd, user)` 解析为 `<agentCwd>/<tenantId>/<userId>`；ACS hand 通过 `WorkspaceRecipe.mountSubPath=workspaces/<tenantId>/<userId>` 挂载同一套目录。

## GitHub Actions

`push main` 触发 `.github/workflows/ci.yml`：

1. 安装依赖。
2. `pnpm -F server typecheck`。
3. `pnpm test`。
4. `pnpm -F web build`。
5. 打包 release。
6. SSH 上传到 ECS。
7. 解包到 `/opt/agent-saas-app/current`。
8. `pnpm install --filter server... --filter shared...`。
9. `systemctl restart agent-saas-server`。
10. 检查 `http://127.0.0.1:3200/api/healthz`。

这条流水线只覆盖主服务和 Web UI，不覆盖 ACS orchestrator，也不构建/推送/切换 ACS Sandbox 镜像。涉及 workspace 工具执行契约的改动，必须同时检查 [ACS Sandbox 镜像发布门禁](acs-sandbox-release.md)，否则会出现主服务已更新、Sandbox 仍运行旧工具实现的版本错配。

GitHub Secrets：

- `ECS_HOST`
- `ECS_USER`
- `ECS_SSH_KEY`

## 公网切流

`agent.kaiyan.net` 已完全脱离旧 ECS：

1. 新 ECS 安装 nginx/certbot。
2. 从旧 ECS 迁移 `agent.kaiyan.net` 现有 LE 证书与 renewal 配置。
3. 新 ECS nginx 反代到本机 `127.0.0.1:3200`。
4. 阿里云 DNS A 记录 `agent.kaiyan.net` 从 `120.25.123.177` 改到 `47.106.14.205`，TTL 600。
5. 旧 ECS `/etc/nginx/conf.d/agent-kaiyan.conf` 已改名禁用为 `/etc/nginx/conf.d/agent-kaiyan.conf.disabled.20260628-new-ecs-cutover`，只保留备份。

切流前已停止 Mac Mini `com.agent-saas.server`，避免与 ECS 同时以 `AGENT_SAAS_PROCESS_ROLE=all` 运行导致 cron 重复执行。Mac 本机 3000 端口服务未触碰。

## 验证

```bash
curl -sf https://agent.kaiyan.net/api/healthz
curl -sf https://agent.kaiyan.net/api/health
ssh -i ~/.ssh/aliyun-ecs-shenzhen-2c4g.pem root@47.106.14.205 'systemctl is-active nginx agent-saas-server certbot-renew.timer'
ssh -i ~/.ssh/aliyun-ecs-shenzhen-2c4g.pem root@47.106.14.205 'certbot renew --dry-run --cert-name agent.kaiyan.net --no-random-sleep-on-renew --agree-tos'
```
