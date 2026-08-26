# Staging 运行手册

Staging 是独立的发布验证环境，不是生产配置的别名。资源权威清单位于
`infra/staging/resource-plan.json`；其中任何 `UNASSIGNED` 都是上线阻断项。

## 建立顺序

1. 按资源清单创建 ECS、OSS、DNS/证书、数据库角色、NAS 隔离根和测试通知 sink。
2. 将 `infra/staging/acs-runtime.yaml` 应用到明确的 Staging ACK/ACS context；创建
   `agent-saas-staging-acr` Secret 时只从密钥系统注入，不提交 Secret YAML。
3. 安装三个 `*-staging.service`，创建独立 `/etc`、`/opt`、`/var/lib`、`/run/lock`
   路径并限制属主；生产的 active-color、release symlink、unit、端口和锁均不得复用。
4. 安装 nginx 配置并增量配置 DNS。`fc.kaiyan.net` 是共享 FC 域名，本方案不使用
   `fc3-domain`，也不覆盖其路由。
5. 在 GitHub 创建 `staging` Environment，按工作流文档配置独立 Secrets/Variables。

## 必做验收

先运行 `scripts/staging/assert-isolation.mjs`。证据文件必须由真实拒绝操作产生，包含资源
身份、时间和结果；不得用配置文本替代。随后部署固定 RC，运行 Playwright Staging 套件。
只有制品回读、真实 Agent → Worker → ACS → Sandbox 链路、反向隔离和清理全部成功，
才能记录 `verified`。健康接口成功只证明进程存活。

## 回收

先停止 Staging units 并删除 Sandbox/Pod/NetworkPolicy/lease，确认无孤儿资源，再删除
DNS、OSS、ECS、NAS 隔离根和数据库。共享 RDS/NAS/ACK 只删除本清单命名的数据库、根目录
和 namespace；不得删除共享实例。保留 Release Manifest、attestation 和 E2E 证据。
