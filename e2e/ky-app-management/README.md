# 业务系统管理本地验收

使用生产 React 组件、Express 管理路由和真实 PostgreSQL。每次创建独立随机表前缀，正常退出时清理。身份头仅存在于验收装配中；不会启动 Agent worker、读取生产配置或访问线上环境。

```bash
TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/agent_saas_test \
  pnpm exec playwright test -c e2e/ky-app-management.playwright.config.ts
```

本地目视操作：把上面末行换成 `pnpm -F server exec tsx ../e2e/ky-app-management/serve.mts`，访问 `http://127.0.0.1:4196`。测试账号由顶部选择器切换，组织为 `t_demo`，技术联系人为 `u_member`。

覆盖上传、非登记者复核、发布、组织安装、DNS 配置指引、一次性领取和清除明文。生产登录流程未在此夹具中执行；测试身份通过独立头注入。禁止对外开放此测试服务器。

截图和 JSON 结果位于 `test-results/ky-app-management*`；关闭 trace、video 和失败截图，领取明文清除后才截图。不得把票据、服务凭据或安装密钥写入测试报告。

此测试没有运行外部业务系统，不能代替实施文档第 10 节的完整交付验收。DNS 验证、真实 credential-ack、握手后的业务读取、Agent 新会话权限、升级和离场仍须在明确的测试业务系统上验证。
