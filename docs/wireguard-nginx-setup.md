# 外网访问架构：WireGuard + 国内 ECS nginx 反代

> 2026-03-21 完成，替代 Tailscale 方案

## 架构

```
客户端 → https://ai.kaiyan.net → 深圳 ECS(nginx, HTTPS) → WireGuard(10.0.0.2:3000) → Mac Mini
```

- **域名**：`ai.kaiyan.net`，A 记录指向深圳 ECS `120.25.123.177`，已备案
- **HTTPS**：Let's Encrypt 证书，certbot 自动续期
- **内网互通**：原生 WireGuard 点对点隧道，无第三方依赖
- **延迟**：~25ms 直连

## 为什么从 Tailscale 迁移

Tailscale 作为商业服务，所有节点的发现、认证、STUN、DERP 中继依赖其海外基础设施。在中国大陆网络环境下：
1. 控制面（美国）和 STUN/DERP（新加坡/旧金山）被 Surge 代理干扰，导致 UDP 被拦截
2. 休眠/网络切换后无法自动恢复（需重新连接海外服务）
3. 架构复杂度不匹配——两台设备之间的点对点隧道不需要商业控制面

原生 WireGuard：零第三方依赖，纯 P2P，与 Surge 天然共存。

## 网络规划

| 节点 | WireGuard IP | 公网 IP | 端口 |
|------|-------------|---------|------|
| 深圳 ECS | 10.0.0.1 | 120.25.123.177 | 51820/udp |
| Mac Mini | 10.0.0.2 | NAT 后（动态） | 随机 |

## 各组件详情

### 深圳 ECS（120.25.123.177）

- 系统：AlmaLinux 9.6
- SSH 别名：`aliyun-ecs-shenzhen-2c4g`
- WireGuard 配置：`/etc/wireguard/wg0.conf`
- WireGuard 服务：`systemctl status wg-quick@wg0`（开机自启）
- 密钥：`/etc/wireguard/server.key` / `server.pub` / `client.key` / `client.pub`
- nginx 配置：`/etc/nginx/conf.d/ai-kaiyan.conf`（proxy_pass → `http://10.0.0.2:3000`）
- 证书：`/etc/letsencrypt/live/ai.kaiyan.net/`
- 安全组：已放行 51820/udp 入站

### Mac Mini（办公室）

- WireGuard 配置：`/opt/homebrew/etc/wireguard/wg0.conf`
- 服务管理：launchd `com.kaiyan.wireguard`（开机自启 + KeepAlive 保活）
- wrapper 脚本：`scripts/wireguard.sh`（通过 sudo 运行 wg-quick，60s 健康检查）
- sudoers 免密：`/etc/sudoers.d/wireguard`
- 日志：`~/.config/wireguard/wireguard.log`
- PersistentKeepalive：25s（保持 NAT 映射）

## Surge 代理共存

与 Tailscale 方案相比，WireGuard 与 Surge 的共存**天然无冲突**：

1. **隧道 IP 段**：`10.0.0.0/8` 已在 Surge `tun-excluded-routes` 中 → WireGuard 隧道流量在路由层直接绕过 Surge TUN
2. **ECS 公网 IP**：`120.25.123.177/32` 已加入 `tun-excluded-routes` → WireGuard UDP 包直接走物理网卡
3. **无额外流量**：没有 STUN 检测、没有控制面、没有 DERP 中继 → 消除了 Tailscale 方案中所有与 Surge 冲突的根源

Surge 配置要点（`default.conf`）：
```
[General]
tun-excluded-routes = ..., 10.0.0.0/8, 120.25.123.177/32, ...
```

**更换 Surge Profile 时必须确保新配置包含这两项排除。**

## 服务管理

```bash
# launchd 服务
launchctl load ~/Library/LaunchAgents/com.kaiyan.wireguard.plist     # 启动
launchctl unload ~/Library/LaunchAgents/com.kaiyan.wireguard.plist   # 停止
launchctl list | grep wireguard                                       # 状态

# 手动操作 WireGuard 接口
sudo wg-quick up wg0        # 启动
sudo wg-quick down wg0      # 停止
sudo wg show                # 状态

# 相关文件
# wrapper 脚本:    scripts/wireguard.sh
# plist 源文件:    scripts/com.kaiyan.wireguard.plist
# 软链接:          ~/Library/LaunchAgents/com.kaiyan.wireguard.plist
# WireGuard 配置:  /opt/homebrew/etc/wireguard/wg0.conf
# 日志:            ~/.config/wireguard/wireguard.log
# sudoers:         /etc/sudoers.d/wireguard
```

## 故障排查

```bash
# 1. 检查 WireGuard 接口
sudo wg show

# 2. 检查隧道连通
ping 10.0.0.1

# 3. 从 ECS 测试后端
ssh aliyun-ecs-shenzhen-2c4g "curl -s http://10.0.0.2:3000/api/auth/me"

# 4. 检查 nginx
ssh aliyun-ecs-shenzhen-2c4g "nginx -t && systemctl status nginx"

# 5. 检查证书
ssh aliyun-ecs-shenzhen-2c4g "certbot certificates"

# 6. WireGuard 接口异常时手动重建
sudo wg-quick down wg0
sudo wg-quick up wg0

# 7. 检查 ECS 端 WireGuard
ssh aliyun-ecs-shenzhen-2c4g "wg show wg0"

# 8. 检查路由（确认 ECS IP 走物理网卡而非 Surge TUN）
/sbin/route -n get 120.25.123.177
# 应显示 interface: en0（物理网卡），不是 utun4（Surge）
```

## 已知限制

1. **macOS 休眠后 UDP socket 可能失效**：wrapper 脚本每 60s 检查并自动重建接口
2. **密钥是静态的**：不像 Tailscale 自动轮换，需要手动更换（但对内网隧道不是实际问题）
3. **加第三台设备需手动配置**：每个节点的 `wg0.conf` 都需要更新（目前只有两台，不是问题）
4. **utun 设备编号不固定**：每次启动分配的 utun 编号可能变化，不影响功能
5. **wg-quick 依赖 bash 4+**：必须用 `/opt/homebrew/bin/bash`，macOS 自带 bash 3.x 不兼容

## 已清理的历史遗留

| 组件 | 说明 |
|------|------|
| Tailscale（tailscaled） | 已 unload launchd 服务 `com.kaiyan.tailscaled`，brew uninstall tailscale。残留文件：`~/.config/tailscale/`、`/etc/sudoers.d/tailscaled`、`/Applications/Tailscale.app` |
| autossh 隧道 | SSH 反向隧道过渡方案，plist 已改名为 `.disabled` |
| frpc 代理 | frpc 仍在运行（`agent.frp.kaiyan.net`），但被 GFW SNI 封锁，仅翻墙可用，保留备用 |
| ECS 上的 `dx7h-youzan.conf` | 旧的有赞 nginx 反代配置，域名失效，已重命名为 `.disabled` |
| Surge `PROCESS-NAME,tailscaled,DIRECT` | 不再需要（WireGuard 无进程级流量绕过需求），可保留或删除 |
| Surge `tun-excluded-routes` 中移除的 `100.64.0.0/10` | Tailscale IP 段，已不再需要。当前需要的是 `10.0.0.0/8` 和 `120.25.123.177/32` |

## 历史方案

| 方案 | 时期 | 状态 | 详情 |
|------|------|------|------|
| frp 穿透（新加坡 ECS） | 2026-03 初 | 弃用 | `*.frp.kaiyan.net` 被 GFW 通过 SNI + HTTP Host 双重检测封锁。诊断过程见 [tailscale-nginx-setup.md](tailscale-nginx-setup.md) |
| SSH 反向隧道 | 2026-03-18 | 弃用 | 过渡方案，autossh + launchd 保活 |
| Tailscale | 2026-03-17 ~ 03-21 | 弃用 | 海外依赖（control plane/STUN/DERP）+ Surge 增强模式冲突。调研报告：[Tailscale+Surge 共存分析](/Users/admin/workspace/admin/assets/20260321/tailscale-surge-coexistence-research.md)、[Headscale vs WireGuard 对比](/Users/admin/workspace/admin/assets/20260321/headscale-vs-wireguard-research.md) |
| **原生 WireGuard** | **2026-03-21** | **当前方案** | 零第三方依赖，与 Surge 天然共存 |

> 注：文中引用的 workspace 内文件路径（如 `~/workspace/admin/assets/...`）为用户工作区内容，不在本项目仓库中。
