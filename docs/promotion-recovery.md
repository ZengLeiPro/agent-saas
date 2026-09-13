# 生产发布的失败与恢复

生产发布（`.github/workflows/promote-release.yml`）分两层：

- **主干**：解析 RC → 校验测试环境证据 → 读取在线生产 → ACS → API/Worker → Web → 回读全部组件 → 保存
  checkpoint → 写 OSS 发布记录。每一步都是普通步骤：失败即失败，不猜、不补偿、不进状态机。
- **旁证**：GitHub 永久 tag、GitHub Release 与资产、GitHub Deployment 记录。带重试、失败只告警，
  不改变发布结论。

生产的事实只来自主干末尾的回读：在线组件矩阵必须逐项等于 Manifest 目标且 ConfigIdentity 一致，
否则该次运行失败，生产不会被记为已发布。

## 失败了怎么办

**重新运行同一 RC 的「生产环境发布」。** 主干是幂等的：

1. 写入前读取的是真实在线组件（`read-live-production-components.mjs`），不是上次写下的身份文件。
2. `promotionGateCli` 只要求当前生产矩阵是「基线 → ACS → App → Web」的某个前缀；首次发布和中断后重跑走同一条规则。
3. 已经等于目标的组件（`ACS_ALREADY_TARGET` / `APP_ALREADY_TARGET` / `WEB_ALREADY_TARGET`）自动跳过，
   只部署剩下的。
4. 回读收敛后才写 checkpoint、OSS 记录和 GitHub 旁证。

RC 记录尾部状态决定运行模式：

| 尾部状态                                                                       | 模式      | 行为                                                    |
| ------------------------------------------------------------------------------ | --------- | ------------------------------------------------------- |
| `verified` / `approved` / `promoting` / `needs_human` / `failed_before_change` | `promote` | 完整主干；`promoting` 尾部先落 `needs_human` 再重新批准 |
| `awaiting_expand_confirmation`                                                 | `confirm` | 只回读并自动核验 expand 迁移，然后 `completed`          |
| `completed`                                                                    | `verify`  | 只回读校验并补写旁证，不部署                            |

`release_id` 留空时发布 OSS 记录中 ID 最新的 RC。

## 什么情况必须人工介入

- 回读显示某个组件既不等于发布前、也不等于目标（`verify-promotion-observation.mjs` 报「Unknown or split identity」）：
  先在生产主机核对该组件，再决定重跑还是回滚。
- 生产矩阵不是任何前缀（例如有人手工改过某个组件）：先把生产恢复到某个一致状态，或运行「测试环境部署」用当前生产为基线重新生成 RC。
- 数据库只允许 expand → confirm → contract；主干只执行 expand，contract 必须在兼容窗口和独立确认后单独执行。

## 旁证没写上

运行会绿，但带 `发布成功，但 GitHub 记录未完整写入` 告警，`evidence-status.json` 列出未写入项。
再次运行同一 RC 的发布（`verify` 模式）会幂等补写 tag / Release / Deployment，不会重新部署。

## 排查「什么时候切到这个版本」

- 现在跑的是什么：`https://api.agent.kaiyan.net/api/healthz/ready` 的 `release` 块。
- 什么时候切的：OSS `records/<rc>/attestations/` 里最后一个 `completed` 快照（主干写入、带重试），
  以及 GitHub Actions 运行历史；GitHub Release / tag 是旁证。
