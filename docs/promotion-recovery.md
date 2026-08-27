# Production Promotion 恢复语义

Promotion 的事实记录是组件身份矩阵，不是 Workflow 的红绿状态。失败处理先重新运行
`read-production-state.mjs`，再由 `reconcile-promotion.mjs` 比较冻结的 before、Manifest target
和 observed：

- `failed_before_change`：观察矩阵仍等于 before；清理未接流量的候选即可；
- `partial_failed`：至少一个组件已变更、至少一个未变更；禁止写 completed；
- `rolled_back`：执行过恢复，且四组件重新权威读回为 before；
- `needs_human`：观察不完整，或 ACS/数据库存在未知、不可逆外部副作用；
- `completed`：四组件都等于 Manifest target，之后仍须通过观察窗口。

API、Worker、Web 和 ACS 每一步都写独立 operation key。Web 失败只恢复上一版 entry；immutable
hash assets 可以保留。ACS 镜像或 Orchestrator 回滚不能被表述为撤销已经发生的外部工具副作用。
数据库迁移只允许 expand → confirm → contract；Promotion 只执行 expand，contract 必须在兼容窗口
和独立确认后执行。

部分失败后先在生产主机执行 `read-live-production-components.mjs`，不得先改写
`runtime-identity.json`。恢复完成后再次读回，并以原 Promotion 的 `production-before.json`、
Manifest target 和新 observed 生成 reconcile 输入；只有四组件完全回到 before 且
`rollbackAttempted=true` 才能得到 `rolled_back`。随后使用新的 operation key 追加记录：

```bash
node scripts/release/reconcile-promotion.mjs recovery-input.json recovery-result.json
test "$(jq -r .outcome recovery-result.json)" = rolled_back
pnpm exec tsx server/src/release/releaseAttestationCli.ts \
  --root <attestation-dir> --release-id <rc-id> --digest <manifest-digest> \
  --state rolled_back --operation "recovery:<独立操作号>" --actor <operator> \
  --reason "$(jq -c . recovery-result.json)"
```

若读回不完整、矩阵混合、ACS 已可能产生外部工具副作用，状态保持 `partial_failed` 或
`needs_human`；不得仅因 systemd/镜像已回切就记录 `rolled_back`。
