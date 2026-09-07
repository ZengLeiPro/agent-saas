# P0 外部验收前置盘点

记录时间：2026-09-07。状态：**阻塞，尚未进入 Gate 6，不构成业务验收通过**。

## 冻结主体与在线事实

- PR #548 已合并，原 HEAD `df2820a263708d686a101394a38ab2956a33ceae`，merge SHA `9f6131c6a173b20b7395f95453e44545ae5ee200`。
- Web 与 API 当前均为 `rc-20260906-75` / `03237fdcfbf9495c5fc091b583a0dab6a37b86e2`，尚未包含 P0 合并提交。API readiness 返回健康；这不证明业务功能可用。
- `https://staging-agent-api.kaiyan.net/.well-known/ky-app-jwks.json` 返回 404，不能开展真实 SAT 握手。
- 实际 Shell `https://staging-agent.kaiyan.net` 对 API 的 OPTIONS 预检返回 204，`Access-Control-Allow-Origin` 为该精确 origin。未验证已认证握手。
- 在线回读保存在 `http/`；API 上报的 ACS digest 仅为发布 identity，尚未独立核验 Worker/ACS 进程。

## 资源盘点

- 阿里云账号 `1440036466967480`，身份 `kaiyan-init`，地域 `cn-shenzhen`。
- ECS `i-wz94xd0v5xab8naa4kov` / `stg-agent-saas-app-cn-shenzhen`，管控面显示 Running、2 核、4096 MiB；RequestId `01A07AA0-B8B7-58F8-A254-7220F8EC2955`。
- 根据项目资源清单尝试 SSH `120.76.54.103:22` 超时。未修改安全组；空闲端口、磁盘容量、Unix 用户、systemd、Nginx 均待实机核验，不能据此批准共机部署。
- `kaiyancn.com` NS 为 `dns21.hichina.com` / `dns22.hichina.com`。阿里云 DNS 查询 `kaiyan-test-system` 得到 0 条记录；RequestId `01A07AA0-BA1A-5DB9-9D3A-E818AE933B0F`。证书覆盖范围待确认。
- 当前 GitHub 身份无法解析 `ZengLeiPro/kaiyan-test-system`，本地同名目录不存在。创建前仍应再次核验名称占用与权限。
- RDS database/role 尚未实时核验；不会把项目清单中的旧信息当作已核验事实。
- Staging 是否有并行演示/验收，已向用户询问，尚未得到答案。

## 本地前置修复

分支 `fix/ky-app-staging-acceptance`：统一 SDK 与平台 Staging issuer/JWKS 为实际连字符域名；按环境生成 CSP；部署环境拒绝通配符、其他 Shell 和额外来源；doctor 按环境检查；模板目录 API 默认基址跟随当前环境的 JWKS origin。

验证：contract 143、SDK 186、CLI 65、生成器 15、平台配置/验签 15，共 424 项测试通过。SDK PostgreSQL 用例 13 项跳过，未声称通过。contract/server/CLI 构建及四个包类型检查通过。

本机 Node 为 22.21.1，与规定的 22.23.1 有差异。本机剩余空间曾降至 105 MiB 并导致 fetch 失败，后回升约 663 MiB；Docker API 返回 500。未删除其他任务的缓存、文件或容器。尚未运行完整 CI 等价门禁或 doctor 16 章，无真实浏览器、目录、Agent 能力、升级、轮换、离场证据。

## 下一步执行边界

1. 前置修复须先形成远程 PR、通过完整门禁、合并并部署 Staging；本地修复不能解决线上 kyApp 配置未启用的问题。
2. 获得 Staging 只读实机访问后，核验资源隔离和空闲端口，再形成精确的服务、数据库角色、证书与 DNS 变更清单。若容量或隔离不满足，不共机部署。
3. 按方案建立独立测试仓库和本地数据库，完成 Gate 1 后才进入部署。
4. 远程仓库/push、Workflow、云资源变更与最终离场须按实施方案第 2.3 节取得明确授权。未执行这些动作；未改 Workflow；未部署 Production。
5. 原工作区无关文件 `docs/plans/runtime-hand-legacy-record-repair.md` 保留。

回滚边界：本轮仅本地代码修改，可通过独立 revert 撤销；后续云端变更须记录现状并提供逐项回滚，不能覆盖共享域名或删除外部数据。
