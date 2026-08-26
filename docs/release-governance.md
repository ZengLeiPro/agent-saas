# 发布治理

## GitHub main ruleset

目标 Ruleset 位于 `config/github-main-ruleset.json`。它要求 `main` 通过
`Build & Check`、`ACS Impact Gate`、最新基线检查、至少一次批准、CODEOWNER
批准和对话解决，并禁止删除与 non-fast-forward 更新。配置刻意不设置 bypass
actor，因此仓库管理员也受同一规则约束。

执行 `scripts/release/github-ruleset.mjs --apply` 前，脚本会检查 GitHub
Administration 权限并以排他方式写入回滚快照。调用方必须显式传入
`--confirm=ZengLeiPro/agent-saas`，并可用 `--backup=<path>` 指定回滚快照。
读回命令：

```bash
node scripts/release/github-ruleset.mjs --verify
```

截至 2026-08-26，只读盘点显示仓库没有 repository ruleset 或 classic branch
protection；本机 GitHub 身份只有 `write` 而非 `admin`。该身份不能应用目标规则，
验证失败必须继续作为发布阻断项。

## Integration 紧急人工通道

系统不允许隐式管理员 merge bypass。紧急变更仍通过显式绑定操作者的
`manual_batch` Integration authorization 进入，并取得新的 Integration Admission
receipt。receipt 绑定精确 candidate revision、PR subject/tree、source set、policy、
lane、workflow epoch 和 Provider 实时 checks。若 Provider PR 未经过 Taskboard
预先加 fence 的 merge attempt 就被外部合并，本地 reconcile 会按 receipt 冲突拒绝。
因此紧急通道可审计，但不会降低 Admission 标准。
