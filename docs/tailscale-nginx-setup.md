# ~~外网访问架构：Tailscale + 国内 ECS nginx 反代~~

> **⚠️ 已弃用（2026-03-21）**：已迁移到原生 WireGuard 方案。新文档：[wireguard-nginx-setup.md](wireguard-nginx-setup.md)
>
> 弃用原因：Tailscale 作为商业服务，控制面/STUN/DERP 依赖海外基础设施，在中国大陆网络环境 + Surge 增强模式下无法稳定共存（UDP 被 Surge TUN 拦截、休眠/网络切换后无法自动恢复）。
>
> 以下内容保留供历史参考。

> 2026-03-13 ~ 2026-03-20 完成，替代原有的 frp 穿透方案

## 背景

Agent 平台后端运行在办公室 Mac Mini（Express :3000），需要让 Mobile App 和 Web 端从外网访问。

### 旧方案（frp 穿透）

```
客户端 → agent.frp.kaiyan.net → 新加坡 ECS(frps) → frp 隧道 → Mac Mini(frpc → :3000)
```

**问题**：`*.frp.kaiyan.net` 被 GFW 通过 SNI + HTTP Host 双重检测封锁。IP 没被封，但只要 TLS Client Hello 或 HTTP 请求中携带该域名就会被 RST。国内访问必须翻墙。

### 诊断过程

通过以下测试确认是**域名级 SNI 封锁**而非 IP 封锁：

| 测试 | 结果 | 结论 |
|------|------|------|
| `curl --noproxy '*' --resolve 'agent.frp.kaiyan.net:443:8.216.134.128' https://agent.frp.kaiyan.net` | Connection reset (RST) | SNI 中携带域名被拦截 |
| `openssl s_client -connect 8.216.134.128:443`（不带 SNI） | TLS 握手成功 | IP 未被封 |
| `curl --noproxy '*' -H 'Host: agent.frp.kaiyan.net' http://8.216.134.128/` | Connection reset | HTTP Host 头也被检测 |
| `curl --noproxy '*' -H 'Host: example.com' http://8.216.134.128/` | Empty reply（正常） | 非目标域名不触发 |
| DNS 解析（223.5.5.5 / 114.114.114.114） | 正确返回 8.216.134.128 | DNS 未被污染 |
| SSH / TCP 直连各端口 | 全部正常 | IP 层完全畅通 |

## 新方案（Tailscale + 国内 ECS nginx）

```
客户端 → https://ai.kaiyan.net → 深圳 ECS(nginx, HTTPS) → Tailscale(100.88.186.16:3000) → Mac Mini
```

### 架构要点

- **域名**：`ai.kaiyan.net`，A 记录指向深圳 ECS `120.25.123.177`，已备案
- **HTTPS**：Let's Encrypt 证书，certbot 自动续期，证书到期 2026-06-16
- **内网互通**：Tailscale 组网（WireGuard），Mac Mini IP `100.88.186.16`，ECS IP `100.90.113.75`
- **GFW 无感**：域名不含敏感关键词，流量全程国内，不过墙

### 各组件详情

#### 深圳 ECS（120.25.123.177）

- 系统：AlmaLinux 9.6，2C4G
- SSH 别名：`aliyun-ecs-shenzhen-2c4g`
- Tailscale IP：`100.90.113.75`
- nginx 配置：`/etc/nginx/conf.d/ai-kaiyan.conf`
- 证书路径：`/etc/letsencrypt/live/ai.kaiyan.net/`

#### Mac Mini（办公室）

- Tailscale IP：`100.88.186.16`
- tailscaled 模式：**TUN**（创建 utun 设备 + 系统路由，通过 sudo 运行）
- utun 设备：`utun5`（编号可能变化），注入 `100.64.0.0/10` 路由
- 固定 WireGuard 端口：`41641`
- 服务管理：launchd `com.kaiyan.tailscaled`（开机自启 + KeepAlive 保活）
- wrapper 脚本：`scripts/tailscaled.sh`（通过 sudo 启动，免密规则 `/etc/sudoers.d/tailscaled`）
- 状态文件：`~/.config/tailscale/tailscaled.state`（持久化）
- socket 路径：`/tmp/tailscale/tailscaled.sock`（临时，每次启动重建，CLI 操作需加 `--socket=` 参数）
- 日志：`~/.config/tailscale/tailscaled.log`
- Tailscale 账号：`zengleipro@gmail.com`（Google 登录）

#### Tailscale 网络

- Tailnet：`zengleipro@gmail.com`
- 节点列表：`tailscale --socket=/tmp/tailscale/tailscaled.sock status`
- 连接方式：已打洞直连（非 DERP 中继），延迟约 28ms
- 注意：MagicDNS 已在 ECS 端关闭（`tailscale set --accept-dns=false`），避免覆盖系统 DNS

### nginx 配置

```nginx
server {
    server_name ai.kaiyan.net;

    location / {
        proxy_pass http://100.88.186.16:3000;
        proxy_http_version 1.1;

        # WebSocket 支持
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";

        # 传递真实客户端信息
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # 超时设置（WebSocket 长连接需要）
        proxy_read_timeout 86400s;
        proxy_send_timeout 86400s;

        # 禁用缓冲（SSE 流式响应需要）
        proxy_buffering off;
        proxy_cache off;
    }

    listen 443 ssl; # managed by Certbot
    ssl_certificate /etc/letsencrypt/live/ai.kaiyan.net/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/ai.kaiyan.net/privkey.pem;
    include /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;
}

server {
    listen 80;
    server_name ai.kaiyan.net;
    return 301 https://$host$request_uri; # HTTP → HTTPS 重定向
}
```

## 代码改动

| 文件 | 改动 |
|------|------|
| `mobile/src/platform/mobileConfig.ts` | `DEFAULT_BASE_URL` → `https://ai.kaiyan.net` |
| `web/vite.config.ts` | `allowedHosts` 新增 `ai.kaiyan.net` |
| `CLAUDE.md` | 外网地址文档更新 |

## 已清理的历史遗留

| 组件 | 说明 |
|------|------|
| autossh 隧道 | 中间过渡方案（Tailscale userspace 模式当时入站不通），已 unload launchd 服务。plist 文件已改名为 `~/Library/LaunchAgents/com.kaiyan.autossh-agent.plist.disabled`（防止重启自动加载） |
| `tailscale serve 3000` | 空跑进程，未实际生效（ECS 直连 Mac Mini :3000 即可），已杀掉 |
| Tailscale GUI App | 安装在 `/Applications/Tailscale.app`，但未使用（System Extension 未授权）。实际用的是 brew CLI 版 |
| ECS 上的 `dx7h-youzan.conf` | 旧的有赞反代配置，域名失效导致 nginx 启动报错，已重命名为 `.disabled` |

## Surge 代理共存（重要）

Mac Mini 运行 Surge for Mac 6.x 作为 GFW 翻墙代理（System Extension 增强模式）。Surge 6.x（≥ 5.9.1）已改用系统 VPN 模式，与 Tailscale 的 Network Extension 不在同一层面冲突。但仍需两项配置：

### 1. Surge 规则：进程绕过

在 Surge 配置文件的 `[Rule]` 段添加：

```
PROCESS-NAME,tailscaled,DIRECT
```

让 tailscaled 的控制面和数据面流量不被 Surge 代理。

### 2. Surge 路由：移除 100.64.0.0/10 排除

`tun-excluded-routes` 中**不要包含** `100.64.0.0/10`（Tailscale IP 段）。如果 Surge 把这个段排除到物理网卡，会覆盖 Tailscale 的 utun 路由，导致 Tailscale 内网流量走错路径。

正确做法是让 Tailscale 自己的 utun 路由（`100.64.0.0/10 → utun5`）生效，它比 Surge 的默认路由（`0.0.0.0/0`）更具体，macOS 路由表自然优先走 Tailscale。

### 背景

tailscaled 以 TUN 模式运行（创建 utun 设备 + 注入系统路由），与 Surge 的 TUN 在路由表层面通过最长前缀匹配自动分流。`netcheck` 可能仍报 `UDP: false`（STUN 检测到 Tailscale 海外 DERP 服务器的 UDP 被 Surge 拦截），但实际的 WireGuard 打洞 UDP 到 ECS 公网 IP 能正常建立直连。

**注意**：更换 Surge 配置文件（Profile）时需确保新配置也包含上述两项配置。

### 调研报告

详细的 Tailscale + Surge 共存可行性分析：[assets/20260321/tailscale-surge-coexistence-research.md](/Users/admin/workspace/admin/assets/20260321/tailscale-surge-coexistence-research.md)

## 已知限制与注意事项

1. **tailscaled 以 TUN 模式运行（sudo）**：创建 utun 设备和系统路由，通过 sudo 获取 root 权限。sudoers 免密规则在 `/etc/sudoers.d/tailscaled`。已配 launchd 保活（`com.kaiyan.tailscaled`），崩溃后 5s 自动重启
2. **状态文件已持久化**：`~/.config/tailscale/tailscaled.state`，Mac 重启后不丢失，tailscaled 启动后自动连接无需重新认证
3. **pre-auth key（待配置）**：作为状态损坏时的自动恢复保险。Tailscale 免费版 auth key 最长 90 天，需定期续期。到 [Tailscale admin console](https://login.tailscale.com/admin/settings/keys) 生成
4. **打洞不是永久的**：公网 IP 变化时会短暂回退到 DERP 中继（延迟升至几百 ms），通常几十秒内重新打洞成功
5. **Tailscale IP 是固定的**：`100.88.186.16` 在删除节点重新注册前不会变，nginx 硬编码 IP 没问题
6. **Let's Encrypt 证书自动续期**：certbot 已配置 systemd timer，无需手动操作
7. **旧 frp 链路仍可用**（需翻墙）：`agent.frp.kaiyan.net` 的 frpc 代理未删除，可作为备用

## tailscaled 服务管理

```bash
# launchd 服务管理
launchctl load ~/Library/LaunchAgents/com.kaiyan.tailscaled.plist     # 安装并启动
launchctl unload ~/Library/LaunchAgents/com.kaiyan.tailscaled.plist   # 停止并卸载
launchctl list | grep tailscaled                                       # 检查服务状态

# 相关文件
# wrapper 脚本:  scripts/tailscaled.sh
# plist 源文件:  scripts/com.kaiyan.tailscaled.plist
# 软链接:        ~/Library/LaunchAgents/com.kaiyan.tailscaled.plist → scripts/com.kaiyan.tailscaled.plist
# 状态文件:      ~/.config/tailscale/tailscaled.state
# socket:        /tmp/tailscale/tailscaled.sock（临时，每次启动重建）
# 日志:          ~/.config/tailscale/tailscaled.log / tailscaled.error.log
```

## 故障排查

```bash
# 1. 检查 Tailscale 连通性
tailscale --socket=/tmp/tailscale/tailscaled.sock status
tailscale --socket=/tmp/tailscale/tailscaled.sock ping 100.90.113.75

# 2. 从 ECS 测试后端可达性
ssh aliyun-ecs-shenzhen-2c4g "curl -s http://100.88.186.16:3000/api/auth/me"

# 3. 检查 nginx 状态
ssh aliyun-ecs-shenzhen-2c4g "nginx -t && systemctl status nginx"

# 4. 检查证书到期时间
ssh aliyun-ecs-shenzhen-2c4g "certbot certificates"

# 5. tailscaled 挂了且 launchd 没拉起（正常情况 launchd 会自动重启）
launchctl unload ~/Library/LaunchAgents/com.kaiyan.tailscaled.plist
launchctl load ~/Library/LaunchAgents/com.kaiyan.tailscaled.plist
# 检查状态
tailscale --socket=/tmp/tailscale/tailscaled.sock status

# 6. 如果状态文件损坏需要重新认证
tailscale --socket=/tmp/tailscale/tailscaled.sock up
# 会输出一个 https://login.tailscale.com/a/xxx 链接，浏览器打开完成认证
```
