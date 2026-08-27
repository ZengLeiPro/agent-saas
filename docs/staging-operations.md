# Staging 运行手册

Staging 是独立的发布验证环境，不是生产配置的别名。资源权威清单位于
`infra/staging/resource-plan.json`。资源 `status=provisioned` 只表示云资源已创建；只有
`firstDeploymentReadiness=ready` 且 `blockingConditions` 为空，首次 Workflow 才允许继续。

## 建立顺序

1. 按资源清单创建 ECS、OSS、DNS/证书、数据库角色和 NAS 隔离根；Staging 通知保持禁用。
2. 将 `infra/staging/acs-runtime.yaml` 应用到明确的 Staging ACK/ACS context；创建
   `agent-saas-staging-acr` Secret 时只从密钥系统注入，不提交 Secret YAML。
3. 安装三个 `*-staging.service`，创建独立 `/etc`、`/opt`、`/var/lib`、`/run/lock`
   路径并限制属主；生产的 active-color、release symlink、unit、端口和锁均不得复用。
4. 安装 nginx 配置并增量配置 DNS。`fc.kaiyan.net` 是共享 FC 域名，本方案不使用
   `fc3-domain`，也不覆盖其路由。
5. 在 GitHub 创建 `staging` Environment，按工作流文档配置独立 Secrets/Variables。

## 必做验收

先运行 `scripts/staging/assert-isolation.mjs`。数据库、OSS、通知、API/Worker 和 ACS namespace
边界必须由真实的生产访问拒绝产生证据；不得用配置文本替代。NAS 是复用生产文件系统的逻辑
隔离：必须读回 Staging ECS 只挂载 `/agent-saas-staging` 子目录、客户端来源限制为单一 `/32`、
权限为 `all_squash`，且当前挂载点看不到生产目录名；Sandbox 还必须读回独立 namespace、PVC 和
workspace 路径。具备主机特权的身份仍可能重新挂载共享文件系统根目录，此残余风险必须以
`privileged-host-can-remount-shared-filesystem-root` 明文绑定到证据，不能宣称物理隔离。

随后部署固定 RC，运行 Playwright Staging 套件。只有制品回读、真实 Agent → Worker → ACS →
Sandbox 链路、生产边界拒绝、共享 NAS 逻辑隔离和清理全部成功，才能记录
`verified-with-accepted-residual-risk`。健康接口成功只证明进程存活。

## 回收

先停止 Staging units 并删除 Sandbox/Pod/NetworkPolicy/lease，确认无孤儿资源，再删除
DNS、OSS、ECS、NAS 隔离根和数据库。共享 RDS/NAS/ACK 只删除本清单命名的数据库、根目录
和 namespace；不得删除共享实例。保留 Release Manifest、attestation 和 E2E 证据。
