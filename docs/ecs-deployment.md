# ECS 部署指南：agent-saas 上阿里云 ECS

> 路径：把本机自用的 3200 agent-saas 迁到阿里云 ECS。
> 关联：路线规划 `assets/20260607/Managed-Agents架构-完整路线规划.md` β 阶段。
> β 阶段三个决策（06-14，曾磊授权"自己进 beta 不要等"，AI 自决）：
>
> | 决策点 | 方案 | 理由 |
> |---|---|---|
> | β-Q1 hand-server 部署形态 | **同台 ECS 不同容器**（HttpTransport 走 localhost） | 保留 cattle 形态零开销，未来要拆只是改 `SERVER_REMOTE_BASE_URL` |
> | β-Q2 workspace 持久化 | **阿里云 NAS 挂载** | "workspace 跟 hand 走" 最轻形态；ECS 挂了不丢 |
> | β-Q3 反向代理 | **Tailscale 内网** | 自用阶段不暴露公网；省 HTTPS/防 DDoS/鉴权审计 |

## 实操 Runbook（按顺序照做）

> 整份材料的有序行动清单。① 是一次性 RDS 准备（影响本机 + ECS），②~⑦ 是 ECS 上的部署；每步展开见对应章节。

**① 开启 Azeroth RDS 服务端 SSL（一次性，约 10s）**
当前状态：RDS 服务端 SSL **尚未开启**，所以本机 `config.json` 暂用 `sslmode=disable`（node-postgres 遇 `require`/`prefer` 会强发 SSL 握手并报 `server does not support SSL connections`）。
- 阿里云 RDS 控制台 → 实例 `pgm-wz96n2735914490l4o` → 数据安全性 / SSL → 开启「SSL 加密」（无需下载 CA 证书，node-postgres 用 `sslmode=require` 即可）
- 开完告诉麦迪文：把本机 `config.json` 的 `sslmode=disable` 切回 `require`
- 此后所有连接串（本机 + ECS config.json）统一 `sslmode=require`

**② 购 ECS + NAS** — ecs.g7.large 4C8G、跟 RDS 同 region+VPC；NAS 通用性能型同 VPC。见 §0 / §1.1 / §1.2
**③ 装 docker + nfs-common + Tailscale，挂 NAS，入 tailnet** — 见 §1.1~§1.3
**④ clone 仓库 + 写 config.json / .env.ecs / override** — 仓库已备 `.env.ecs.example`、`docker-compose.override.ecs.yml`，`cp` 后填值即可。⚠️ 核心配置全在 config.json（runtimeEventStore / auth / serverRemote）；compose 里 `RUNTIME_PG_URL`/`JWT_SECRET`/`SERVER_REMOTE_*` 等 env **server 进程不读**。见 §2
**⑤ RDS 白名单加 ECS 内网 IP** — 见 §3
**⑥ 数据迁移：已做完** — 本机 ETL 已把历史 events 灌进 Azeroth RDS（ECS 启动即见数据），跳过。见 §4
**⑦ `docker compose up -d` + Tailscale 内网验收** — 见 §5 / §6

## 0. 前置依赖

- 阿里云账号，已购：
  - 1× ECS 实例（建议 ecs.g7.large 4C8G 起，跟 Azeroth RDS 同 region+VPC）
  - 1× NAS 通用性能型（同 VPC）
  - Azeroth RDS（已有）+ `agent_runtime` database 已建（按 `docs/azeroth-pg-setup.md`）
- Tailscale 账号（开沿统一一个 tailnet）
- 本机 docker + docker compose 跑通（`docker compose up -d` 本地能起）

## 1. ECS 实例准备

### 1.1 操作系统与基础包

推荐 Ubuntu 22.04 LTS。

```bash
# SSH 登 ECS 后
sudo apt update && sudo apt upgrade -y
sudo apt install -y docker.io docker-compose-v2 nfs-common curl wget jq

# docker 服务
sudo systemctl enable --now docker
sudo usermod -aG docker $USER   # 退登重进生效，或用 newgrp docker
```

### 1.2 NAS 挂载（β-Q2）

阿里云 NAS 控制台创建文件系统 → 拿到挂载点 like `xxxxxx.cn-shenzhen.nas.aliyuncs.com:/`。

```bash
sudo mkdir -p /mnt/nas/agent-runtime
sudo mount -t nfs -o vers=3,nolock,proto=tcp,noresvport \
  xxxxxx.cn-shenzhen.nas.aliyuncs.com:/agent-runtime /mnt/nas/agent-runtime

# 加 /etc/fstab 让重启自动挂
echo "xxxxxx.cn-shenzhen.nas.aliyuncs.com:/agent-runtime /mnt/nas/agent-runtime nfs vers=3,nolock,proto=tcp,noresvport,_netdev 0 0" \
  | sudo tee -a /etc/fstab

# 验证读写
touch /mnt/nas/agent-runtime/.write-test && rm /mnt/nas/agent-runtime/.write-test
```

### 1.3 Tailscale 装上 + 加入 tailnet（β-Q3）

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up --hostname=agent-runtime-ecs --accept-routes
```

记下 ECS 在 tailnet 内的 100.x.x.x 地址，后面给 server 访问用。

## 2. 准备配置 + 拉代码

### 2.1 在 ECS 上 clone 仓库

```bash
sudo mkdir -p /srv/agent-saas
sudo chown $USER:$USER /srv/agent-saas
cd /srv/agent-saas
git clone <gitee/github 仓库 URL> .   # 或者 rsync 本机过来
git checkout main
```

### 2.2 生成生产 config.json

`config.json` 在 `.gitignore` 里，**不能 commit**。从本机模板复制或新建：

```bash
# /etc/agent-runtime/config.json （挂载点路径，固定）
sudo mkdir -p /etc/agent-runtime
sudo cp config.example.json /etc/agent-runtime/config.json
sudo chmod 600 /etc/agent-runtime/config.json
sudo nano /etc/agent-runtime/config.json
```

必填字段：
- `auth.jwtSecret`：`openssl rand -base64 48 | tr -d '/+=' | head -c 48`
- `auth.enabled: true`
- `models.default` 或具体模型组的 `apiKey` / `baseUrl`
- `runtimeEventStore`：
  ```json
  "runtimeEventStore": {
    "backend": "pg",
    "connectionString": "postgresql://agent_runtime_app:<PG_PWD>@<Azeroth RDS 内网域名>:5432/agent_runtime?sslmode=require",
    "tablePrefix": "runtime"
  }
  ```
  - `sslmode`：见 Runbook ①——RDS 服务端 SSL **已开**用 `require`，**未开**用 `disable`（本机当前为 `disable`）。建议部署 ECS 前先开 SSL，全程统一 `require`。
- `serverRemote`（双容器 β-Q1 必填）：`{ "baseUrl": "http://hand-server:3300", "authToken": "<与 .env.ecs 的 HAND_SERVER_AUTH_TOKEN 同值>" }`
- `agent.cwd`：`/app/workspace`（容器内路径，对应 NAS 挂载点）
- 不要在 ECS 上配 `HTTP_PROXY/HTTPS_PROXY`，阿里云 ECS 在境内直接出网就行

### 2.3 写 docker-compose `.env.ecs`

仓库已提供 `.env.ecs.example`（含完整注释与「server 进程不读哪些 env」的配置真相警示），推荐 `cp` 后填值：

```bash
cp /srv/agent-saas/.env.ecs.example /srv/agent-saas/.env.ecs
sudo nano /srv/agent-saas/.env.ecs
```

字段速览（详见模板内注释）：

```ini
CONFIG_JSON_PATH=/etc/agent-runtime/config.json

OPENAI_API_KEY=<生产 key 或留空走 baseUrl>
OPENAI_BASE_URL=<可选>

HAND_SERVER_AUTH_TOKEN=<openssl rand -base64 32 | tr -d '/+=' | head -c 32>

# 本地不复用 docker volume，改 NAS bind mount（在 docker-compose.override.ecs.yml 里）
```

### 2.4 加 ECS 专用 override 让 volume 走 NAS

仓库已提供 `docker-compose.override.ecs.yml`（NAS bind mount，已显式重列 config.json 挂载，不依赖 compose 隐式保留行为），通常直接可用，只需确认 NAS 挂载点为 `/mnt/nas/agent-runtime`：

```bash
cat /srv/agent-saas/docker-compose.override.ecs.yml
```

```yaml
services:
  server:
    volumes:
      # 覆盖 docker volume 改 bind mount
      - /mnt/nas/agent-runtime/workspace:/app/workspace
      - /mnt/nas/agent-runtime/transcripts:/root/.claude/projects
      - /mnt/nas/agent-runtime/server-data:/app/server/data
      - /mnt/nas/agent-runtime/server-logs:/app/logs

  hand-server:
    volumes:
      - /mnt/nas/agent-runtime/workspace:/app/sandbox
```

注意：开启 override 后命名 volume 会失效，目录都直接走 NAS。

## 3. β5 ECS ↔ Azeroth RDS 内网连通

Azeroth RDS 必须配安全组允许 ECS 内网访问。

阿里云 RDS 控制台 → 数据安全性 → 白名单 → 添加 ECS 的内网 IP（或加入同一 VPC 安全组）→ 测试：

```bash
# ECS 上验证
PG_PWD='<agent_runtime_app 密码>'
PGPASSWORD="$PG_PWD" psql -h <Azeroth RDS 内网域名> -p 5432 -U agent_runtime_app -d agent_runtime -c "SELECT 1;"
```

返回 `1` 即通。`sslmode` 见 Runbook ①：RDS 服务端 SSL 开了用 `?sslmode=require`，没开用 `?sslmode=disable`，与 config.json 保持一致。

## 4. β6 数据迁移：本机 file → Azeroth PG

如果本机已经跑了一段时间 file backend，迁过来：

```bash
# 1. 本机把现有 ~/.claude/projects/*/*.runtime-events.jsonl rsync 到 ECS
rsync -avz --include='*.runtime-events.jsonl' --include='*/' --exclude='*' \
  ~/.claude/projects/ \
  ecs:/mnt/nas/agent-runtime/transcripts-staging/

# 2. ECS 上跑 ETL，连本机的 Azeroth RDS（已经在内网）
cd /srv/agent-saas
docker compose run --rm server bash -c "
  pnpm -C server run migrate:events-file-to-pg -- \
    --root /root/.claude/projects \
    --connection-string '<内网 connection string>' \
    --execute
"
```

或者更稳：先在**本机**跑 ETL 把数据写到 Azeroth RDS（一次性，几分钟），ECS 启动时数据已在 PG，跳过 transcripts 同步。

## 5. 启动 + 验证

```bash
cd /srv/agent-saas
docker compose --env-file .env.ecs \
  -f docker-compose.yml \
  -f docker-compose.override.ecs.yml \
  up -d

# 看日志
docker compose logs -f server hand-server

# 健康检查
curl http://127.0.0.1:3200/api/health   # ECS 本机
curl http://<tailscale IP>:3200/api/health   # Tailscale 内网另一台机
```

期望启动日志：
```
Runtime EventStore initialized: backend=pg
Runtime audit query: backend=pg (shared pool with PgEventStore)
Channel [web] started
Server running on http://localhost:3200
```

## 6. 客户端访问（Tailscale 内网）

在曾磊 Mac / 其他开沿员工机器上：
- 装 Tailscale，加入同 tailnet
- 浏览器访问 `http://agent-runtime-ecs:3200/`（hostname 解析）或 `http://100.x.x.x:3200/`
- 登录用 `auth.jwtSecret` 签发的 admin token

## 7. 运维

### 7.1 升级

```bash
cd /srv/agent-saas
git pull --ff-only
docker compose build server hand-server
docker compose up -d   # rolling restart
```

### 7.2 看日志

```bash
docker compose logs -f --tail 200 server
docker compose logs -f --tail 200 hand-server
```

### 7.3 备份

- PG：Azeroth RDS 已有快照策略，覆盖 `agent_runtime` db
- NAS：阿里云 NAS 控制台开启自动快照（建议每日一次，保留 30 天）
- config.json：手工备份 1Password 或私人密码本

### 7.4 故障排查

- 启动失败 → `docker compose logs server` 看头几行
- PG 连不上 → ECS 内 `psql` 直连验证，看 RDS 白名单
- workspace 写不进 → 检查 `/mnt/nas/agent-runtime/` 挂载是否还在（`mount | grep nas`）
- Tailscale 断网 → `sudo tailscale status` + `sudo tailscale up --reset`

## 8. 后续路线

- β4 Brain 文件预览 API 改走 transport：自用阶段不阻塞（同台 ECS InProc 等价），等真有 server-remote 跨机时再做
- Stage 3 vault / 客户机器 daemon：等真有 SaaS 客户线索拉动

## 9. Tenant ECS hand appliance 模式（2026-06-19）

除了本指南前面描述的“同台 ECS server + hand-server 双容器”自用部署，现在平台也支持把每个组织 ECS 上的 Docker 作为 **tenant hand appliance** 接入。该 Docker 可以先复用当前 `hand-server` target，也可以在后续演进为兼容 hand protocol 的独立执行面；关键边界是：平台仍是 run/session/event/approval/cancel/audit 的事实源，组织 ECS Docker 只是可替换执行面。

### 9.1 组织 ECS hand-server 启动要求

组织 ECS Docker 至少要提供兼容当前 hand protocol 的 HTTP API：

- `GET /health`
- `GET /tools`
- `POST /provision`
- `POST /execute`
- `POST /execute-stream`
- `DELETE /invocations/:id`

如果直接使用本仓库镜像，可运行 Dockerfile 的 `hand-server` target，并配置：

```ini
HAND_SERVER_HOST=0.0.0.0
HAND_SERVER_PORT=3300
HAND_SERVER_AUTH_TOKEN=<与平台 tenantRemoteHands.hands[].authToken 一致>
HAND_SERVER_BACKEND=local
HAND_SERVER_SANDBOX_ROOT=/app/sandbox
```

`HAND_SERVER_HOST=0.0.0.0` 只表示容器内监听所有接口，方便平台通过 Docker bridge / VPC / Tailscale 访问；不要把 3300 直接映射公网。`/health` 与 `/tools` 当前无鉴权，公网暴露必须由安全组/反代 ACL 限制；跨 ECS 建议走 VPC 内网、安全组 allow-list、Tailscale、或前置反代 TLS。

### 9.2 平台 config.json 配置

平台侧在 `config.json` 中配置 `tenantRemoteHands`：

```jsonc
"tenantRemoteHands": {
  "hands": [
    {
      "id": "tenant-ecs",
      "description": "Docker hand-server running in the tenant ECS/VPC",
      "users": ["alice"],
      "baseUrl": "http://tenant-ecs-hand:3300",
      "authToken": "replace-with-tenant-hand-token",
      "invokeTimeoutMs": 120000
    }
  ]
}
```

字段说明：

- `id`：session 内 hand 后缀，平台内部 handId 形如 `<sessionId>:<id>`；普通 workspace 工具不需要、也不接受模型传入 handId。
- `users`：当前 baseline 的 username allow-list；为空/省略表示所有认证用户可见。正式 SaaS 多组织后应升级为 tenant/org policy。启用 `tenantRemoteHands` 必须同时启用 `runtimeEventStore.backend="pg"`，否则 durable HandStore/RunStore 不可用，服务启动会拒绝该配置。
- `baseUrl`：组织 ECS Docker hand-server 的内网/Tailscale/反代地址。
- `authToken`：hand-server Bearer token，必须与组织 ECS 的 `HAND_SERVER_AUTH_TOKEN` 一致。
- `invokeTimeoutMs`：该 hand 的 HTTP 调用兜底超时。

### 9.3 路由与验收

启动后，每个匹配用户的新 session 会在 durable `HandStore` 中注册一个 `type='server-remote'` hand。Agent prompt 的 `<available-hands>` 中会显示该 hand；runtime 会在唯一 ready tenant hand 存在时把普通 workspace 工具自动路由过去，未 ready 时模型应先调用 `WaitForWorkspaceReady`。平台按 hand record 的 endpoint/token 动态创建 `HttpTransport`，不会走全局 `serverRemote`，也不会把平台本地 `workspace.root` 发到远端。

建议验收：

```bash
# 组织 ECS 本机 / 容器内探活
docker compose exec hand-server wget -qO- http://127.0.0.1:3300/health

# 平台 server 所在网络到组织 hand endpoint 探活
curl -fsS http://tenant-ecs-hand:3300/health
curl -fsS http://tenant-ecs-hand:3300/tools

# 带鉴权验证 provision / workspace 初始化
curl -fsS -H "Authorization: Bearer $HAND_SERVER_AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  http://tenant-ecs-hand:3300/provision \
  -d '{"workspaceId":"smoke"}'

# 发起一次 Web run 后，在 UI/日志里确认 available-hands 包含 tenant hand，
# 再调用 Read/List/Shell；工具层应自动路由到该 ready tenant hand。
```

### 9.4 与 serverRemote 的关系

- `serverRemote`：单个默认远端 hand，适合同台 ECS 双容器或全局默认 hand-server。
- `tenantRemoteHands`：多个静态组织 ECS hand appliance，适合“平台总调度器 + 每组织 ECS Docker”的过渡形态。
- `clientDaemon`：客户机器反向连接平台，适合平台不能主动访问客户内网的场景。

三者可以并存：平台默认 hand 走 `serverRemote`，特定组织/用户的工具调用由 runtime 自动路由到唯一 ready 的 `tenantRemoteHands`，客户侧反连场景则用 `clientDaemon` 注册 `type='client'` hand。
