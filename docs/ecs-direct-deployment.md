# ECS 直部署：agent-saas server

> 当前生产口径：server 直接跑在新深圳 ECS systemd（蓝绿双实例，2026-07-15 起）；不使用 Docker。
> 蓝绿部署机制、探针语义、drain 生命周期见 [零停机部署](zero-downtime-deployment.md)。

## 运行位置

- release 目录：`/opt/agent-saas-app/releases/<sha>`；`current`/`previous` symlink 仅作 bookkeeping
- 每色代码 symlink：`/opt/agent-saas-app/color/blue`、`/opt/agent-saas-app/color/green` → `releases/<sha>`（部署只改 idle 色）
- systemd：模板实例 `agent-saas-server@blue`（127.0.0.1:3200）/ `agent-saas-server@green`（127.0.0.1:3201）；模板见 `daemon-packaging/systemd/agent-saas-server@.service.template`
- 活动色标记：`/etc/agent-saas/active-color`（内容 `blue`|`green`，切流成功后由部署脚本改写）
- pidfile：`/run/agent-saas-server-<色>.pid`（drain 信号 `kill -USR2 $(cat pidfile)` 的投递目标）
- 配置：`/etc/agent-saas/config.json`
- 环境变量：共享 `/etc/agent-saas/server.env` + 每色 `/etc/agent-saas/server-blue.env` / `server-green.env`（`PORT`、`AGENT_SAAS_PIDFILE`，手工创建一次，不随部署改写）
- ky-azeroth PAT 映射：`/etc/agent-saas/azeroth-tokens.json`（由 `AZEROTH_TOKENS_FILE` 指向）
- NAS 总根：`/mnt/agent-saas`
- 持久数据：`/mnt/agent-saas/server-data`
- 用户 workspace：`/mnt/agent-saas/workspaces/<tenantId>/<userId>`
- 运行态/归档：`/mnt/agent-saas/runtime`
- 前端主入口：`agent.kaiyan.net` CNAME → OSS bucket `agent-saas-web`
- 前端冷灾备：`/opt/agent-saas-web-recovery/releases/<sha>`，`current`/`previous` symlink；由 `deploy-web-oss` 使用同一份分域构建独立发布，不进入 Server release
- 灾备不可变资源池：`/opt/agent-saas-web-recovery/shared-root`，跨 release 只增不删，兼容在途旧页面的 hash chunk 与旧 Workbox runtime
- API/WS 公网入口：`api.agent.kaiyan.net` → ECS nginx（`/etc/nginx/conf.d/agent-api-kaiyan.conf`）→ upstream `agent_saas_backend`（`/etc/nginx/conf.d/agent-saas-upstream.conf`，蓝绿切流点，部署脚本重写）→ 127.0.0.1:3200/3201
- 冷灾备 nginx：`/etc/nginx/conf.d/agent-kaiyan.conf` 直接读取 `agent-saas-web-recovery/current`，不反代 Server；模板见 `daemon-packaging/nginx/agent-kaiyan-recovery.conf.example`
- TLS 证书：API 域证书在 `/etc/letsencrypt/live/` 自动续期；`agent.kaiyan.net` 冷灾备使用与 OSS 同一张 CAS 证书，安装到 `/etc/nginx/ssl/agent-kaiyan-recovery`，OSS 续证时必须同步更新 ECS，Web 发布门禁会直连验证证书与 recovery 内容

`server/data` 在部署后软链到 NAS 持久目录，避免每次 release 覆盖用户、租户、MCP、SecretVault 等本地态。

完整 NAS 约定见 [生产 NAS 目录布局](nas-layout.md)。

`workspaceId` 只作为 PG、HandStore、审计、Sandbox 名称和标签中的逻辑 ID。真实用户文件目录由 `resolveUserCwd(agentCwd, user)` 解析为 `<agentCwd>/<tenantId>/<userId>`；ACS hand 通过 `WorkspaceRecipe.mountSubPath=workspaces/<tenantId>/<userId>` 挂载同一套目录。

## GitHub Actions

`.github/workflows/ci.yml`。`push main` 只构建 + 测试 + 打包，**不部署生产**；
发版走 `workflow_dispatch`（Actions 页面手动触发或 `gh workflow run ci.yml`），
`deploy-ecs` 先发布后端，成功后 `deploy-web-oss` 发布 OSS 与 ECS 冷灾备，保证前后端版本一致。

`deploy-ecs` 蓝绿流程概要（远端脚本 13 步详解见[零停机部署](zero-downtime-deployment.md)）：

1. 打包不含 `web/` 的 Server release，scp 上传 ECS。
2. 读 `/etc/agent-saas/active-color` 定位 idle 色；校验 active 实例在服务。
3. 安装前清理未受保护的历史 release，并校验至少 8 GiB 可用空间、25 万可用 inode；随后解包到 `releases/<sha>`，`server/data` 软链 NAS，以 isolated linker 安装 server/shared 依赖。
4. 只改 idle 色 symlink（active 色 symlink 永不动）→ `systemctl start agent-saas-server@<idle>`。
5. 切流前门禁：`/api/healthz/ready` 200（180s 硬门禁）+ warmup done（420s 软门禁）+ 冒烟。任何失败会还原 idle 色 symlink 并回收当次 release/上传包，老色全程在服务。
6. 切流：重写 nginx upstream（新色 primary、旧色 backup）→ `nginx -t` → reload → 验证。
7. 更新 active-color，重新生成 `/opt/agent-saas-app/rollback.sh`。
8. `kill -USR2` 精确 drain 旧色（活跃流清空后自退，`Restart=on-failure` 不复活）。

`deploy-web-oss` 在 OSS 线上门禁通过后，将同一份 `web/dist` 打包上传到
`/opt/agent-saas-web-recovery/releases/<sha>`，校验 `index.html`/`sw.js` 后原子切换
`current`，并保留原 `current` 为 `previous`。随后 CI 用 `--resolve` 绕过公网 DNS，
直连 ECS 的 `agent.kaiyan.net` vhost，验证 TLS、`X-Agent-Saas-Recovery` 和完整
`index.html`。`assets/` 与 `workbox-*` 同步到只增不删的 `shared-root`，上传包保留在
`agent-saas-web-recovery/artifacts`，均不自动清理；任一步失败都会把 recovery
`current` 与 OSS 入口文件恢复到上一版。

灾备回滚只切 symlink，不删除历史 release：

```bash
ln -sfn "$(readlink -f /opt/agent-saas-web-recovery/previous)" \
  /opt/agent-saas-web-recovery/current
```

部署期间 CI runner 每 1s 探测 `https://api.agent.kaiyan.net/api/healthz`，
最大连续非 200 ≥ 2 即判零停机门禁失败。

这条流水线只覆盖主服务和 Web UI，不覆盖 ACS orchestrator，也不构建/推送/切换 ACS Sandbox 镜像。涉及 workspace 工具执行契约的改动，必须同时检查 [ACS Sandbox 镜像发布门禁](acs-sandbox-release.md)，否则会出现主服务已更新、Sandbox 仍运行旧工具实现的版本错配。

GitHub Secrets：

- `ECS_HOST`
- `ECS_USER`
- `ECS_SSH_KEY`
- `OSS_WEB_DEPLOY_AK_ID`
- `OSS_WEB_DEPLOY_AK_SECRET`

## ky-azeroth PAT 注入

`agent-saas-server.service` 通过 `AZEROTH_TOKENS_FILE` 读取 `(tenantId, username) -> PAT` 映射。生产文件放在稳定路径：

```bash
/etc/agent-saas/azeroth-tokens.json
```

格式参考 `server/config/azeroth-tokens.example.json`。多租户上线后使用 v2 结构：平台根组织 `pantheon` 下放 `admin`，开沿日常组织 `kaiyan` 下放普通员工。文件权限建议 `600`，属主为运行 `agent-saas-server` 的用户。

注意：这里没有自动账号绑定。key 是 agent-saas 的 `tenantId/username`；value 是 ky-azeroth 员工 PAT。推荐用对象格式保存审计 metadata：

```json
{
  "token": "pat_xxx",
  "kyUsername": "17759501593",
  "employeeName": "黄思霖",
  "roles": ["SALES"]
}
```

服务启动时会用 PAT 调 ky-azeroth `/users/me` 做只读校验；metadata 错配会打 error，但不阻断主服务。需要临时关闭时设置 `AZEROTH_TOKEN_METADATA_VERIFY=false`。

## 公网切流（历史记录）

2026-06-28 从旧 ECS 迁到新 ECS 的一次性动作，保留备查：

1. 新 ECS 安装 nginx/certbot。
2. 从旧 ECS 迁移 `agent.kaiyan.net` 现有 LE 证书与 renewal 配置。
3. 新 ECS nginx 反代到本机 `127.0.0.1:3200`。
4. 阿里云 DNS A 记录 `agent.kaiyan.net` 从 `120.25.123.177` 改到 `47.106.14.205`，TTL 600。
5. 旧 ECS `/etc/nginx/conf.d/agent-kaiyan.conf` 已改名禁用为 `/etc/nginx/conf.d/agent-kaiyan.conf.disabled.20260628-new-ecs-cutover`，只保留备份。

切流前已停止 Mac Mini `com.agent-saas.server`，避免与 ECS 同时以 `AGENT_SAAS_PROCESS_ROLE=all` 运行导致 cron 重复执行。Mac 本机 3000 端口服务未触碰。

2026-07-15 前后端分域后此段口径已过时：`agent.kaiyan.net` 现 CNAME → OSS，
API/WS 走 `api.agent.kaiyan.net`（见「运行位置」）。

## 首次蓝绿迁移（一次性手工步骤）

> **状态：生产已于 2026-07-15 03:19~03:29 按下述「零停机变体」完成迁移**——
> 先起 green(3201，跑当时 current release)→nginx 切流→确认双实例均 idle 后
> 停旧 unit，全程公网无中断；`active-color=green`，旧 unit 文件遮蔽为
> `agent-saas-server.service.disabled-bluegreen-20260715`（原件备份
> `/root/agent-saas-server.service.bak-bluegreen-20260715`，nginx 两个站点
> conf 各有 `.bak-bluegreen-20260715` 备份）。以下步骤保留作灾备重建参考。

从单实例 `agent-saas-server.service` 迁到蓝绿模板实例。ci.yml 部署脚本的前置
校验要求 `/etc/agent-saas/active-color` 存在且 `agent-saas-server@<active>`
在服务，所以这套步骤必须先手工做一次，之后日常发版全部走 CI。

> 端口冲突提醒：旧单实例与 blue 同用 3200，起 blue 前必须先停旧 unit，
> 中间有秒级窗口（nginx upstream 的 3201 backup 此时也无人监听）。若要完全
> 零停机，可改为先起 green(3201) → 切流到 green → 再停旧 unit，此时
> `active-color` 写 `green`。以下按 blue 为初始 active 记录。

```bash
# 0. 上传/同步仓库中的模板文件到 ECS 后执行（路径按实际 checkout 位置调整）
REPO=/opt/agent-saas-app/current

# 1. 安装模板 unit
cp "$REPO/daemon-packaging/systemd/agent-saas-server@.service.template" \
   /etc/systemd/system/agent-saas-server@.service

# 2. 每色 env（手工创建一次，内容固定，不随部署改写；见 server-color-env.example）
cat > /etc/agent-saas/server-blue.env <<'EOF'
PORT=3200
AGENT_SAAS_PIDFILE=/run/agent-saas-server-blue.pid
EOF
cat > /etc/agent-saas/server-green.env <<'EOF'
PORT=3201
AGENT_SAAS_PIDFILE=/run/agent-saas-server-green.pid
EOF

# 3. color symlink：blue 指向当前 release（解析 current 的真实目标）
mkdir -p /opt/agent-saas-app/color
ln -sfn "$(readlink -f /opt/agent-saas-app/current)" /opt/agent-saas-app/color/blue

# 4. nginx upstream conf（blue primary、green backup；之后由部署脚本重写）
cp "$REPO/daemon-packaging/nginx/agent-saas-upstream.conf.example" \
   /etc/nginx/conf.d/agent-saas-upstream.conf

# 5. 两个站点 conf 的 proxy_pass 从直连改为 upstream：
#    /etc/nginx/conf.d/agent-api-kaiyan.conf 与 /etc/nginx/conf.d/agent-kaiyan.conf
#    中所有 proxy_pass http://127.0.0.1:3200 → proxy_pass http://agent_saas_backend
#    （两个站点都要改，避免零星旧域名流量与 API 域切流不一致）

# API 站点配置此后由发布流程从
# daemon-packaging/nginx/agent-api-kaiyan.conf.example 幂等安装。
# /api/upload 使用 proxy_request_buffering off，nginx fallback 临时目录位于
# NAS /mnt/agent-saas/runtime/nginx-client-body；不要再手工只改线上 conf。

# 6. active 色标记
echo blue > /etc/agent-saas/active-color

# 7. 加载 unit 并启用两色（日常只有 active 色常驻，idle 色由部署脚本按需 start）
systemctl daemon-reload
systemctl enable agent-saas-server@blue agent-saas-server@green

# 8. 停旧 unit → 起 blue（3200 端口交接，秒级窗口）
systemctl stop agent-saas-server.service
systemctl start agent-saas-server@blue

# 9. 验证
curl -sf http://127.0.0.1:3200/api/healthz/ready
nginx -t && systemctl reload nginx
curl -sf https://api.agent.kaiyan.net/api/healthz

# 10. 禁用旧单实例 unit（保留文件备查亦可 rm）
systemctl disable agent-saas-server.service
```

## 验证

```bash
curl -sf https://api.agent.kaiyan.net/api/healthz
curl -sf https://api.agent.kaiyan.net/api/health
ssh -i ~/.ssh/aliyun-ecs-shenzhen-2c4g.pem root@47.106.14.205 \
  'systemctl is-active nginx "agent-saas-server@$(cat /etc/agent-saas/active-color)" certbot-renew.timer'
ssh -i ~/.ssh/aliyun-ecs-shenzhen-2c4g.pem root@47.106.14.205 'cat /etc/agent-saas/active-color'
ssh -i ~/.ssh/aliyun-ecs-shenzhen-2c4g.pem root@47.106.14.205 'certbot renew --dry-run --no-random-sleep-on-renew --agree-tos'
```
