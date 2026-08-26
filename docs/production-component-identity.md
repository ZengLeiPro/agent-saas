# 生产组件身份

生产发布基线不是 Git 分支名，也不是健康接口的单一 `200`。权威读回由
`scripts/release/read-production-state.mjs` 在生产 ECS 上执行，并交叉验证四类来源：

- API `/api/healthz/ready`：当前 API source SHA、Server bundle digest 与安全证明；
- `/etc/agent-saas/runtime-identity.json`：API/Worker/Web/ACS 组件矩阵，以及 API、Worker
  的 systemd MainPID、cgroup、active color、symlink、pidfile/readyfile；
- Web `release-identity.json`：OSS entry 对应的 source SHA 和 Web bundle digest；
- ACS `/health`：environment、release ID、Orchestrator/Sandbox digest、namespace 和配置指纹。

脚本必须在生产主机本地运行，才能验证 `/proc`、systemd 和 symlink。任一观察缺失、过期、
组件不一致或 ACS namespace 不是 `agent-saas-coding` 都会失败。输出只含 SHA、digest、路径、
PID 和非敏感配置指纹，不输出凭据。Promotion 把该输出与 Manifest 的
`productionBaseline` 做 canonical 比较；有漂移即停止在任何生产写入之前。
