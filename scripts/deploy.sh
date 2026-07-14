#!/usr/bin/env bash
# 本脚本已停用：生产部署走 .github/workflows/ci.yml 的 deploy-ecs job
# （蓝绿零停机，workflow_dispatch 手动触发；push main 只构建不发版）。
# 机制说明与运维手册见 docs/zero-downtime-deployment.md；
# 手动回滚在 ECS 上执行 bash /opt/agent-saas-app/rollback.sh（部署时生成）。
set -euo pipefail

echo "deploy.sh is disabled in agent-saas PoC."
echo "Use 'pnpm dev' for local validation or define a dedicated deployment flow for com.agent-saas.server."
exit 1
