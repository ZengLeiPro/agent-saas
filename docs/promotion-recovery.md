# Production Promotion 恢复语义

Promotion 的事实记录是组件身份矩阵，不是 Workflow 的红绿状态。失败处理先重新运行
`read-production-state.mjs`，再由 `reconcile-promotion.mjs` 比较冻结的 before、Manifest target
和 observed：

- `failed_before_change`：没有真实 rollback-attempted marker，且观察矩阵仍等于 before；
- `partial_failed`：至少一个组件已变更、至少一个未变更；禁止写 completed；
- `rolled_back`：真实专用恢复已经开始，且四组件重新权威读回为 before；该 Release 仍保留“曾进入生产写入”的事实；
- `needs_human`：观察不完整，或当前矩阵仍有未知、不可逆外部副作用；
- `completed`：四组件都等于 Manifest target，之后仍须通过观察窗口。

Workflow 不再根据 deploy step 的 `failure` outcome 猜测是否回滚。ACS/App 的 cleanup trap 真正
进入恢复分支时，才在 `/tmp/agent-saas-promotion-<run-id>-<run-attempt>/` 写入 root 创建、0444 的
`rollback-attempted-acs|app` marker；trap 未 arm 或未执行就没有 marker。Web 只有
`restore_web_entry` 真正被调用时才在 Runner 的同一 run-attempt 隔离命名下写 marker。marker
只证明恢复已开始，不证明恢复成功；必须与新的权威 `observed == before` 同时成立，才能记录
`rolled_back`。不需要也不得用单独的 success marker 替代权威读回。

API、Worker、Web 和 ACS 每一步都写独立 operation key。Web 失败只恢复上一版 entry；immutable
hash assets 可以保留。数据库迁移只允许 expand → confirm → contract；Promotion 只执行 expand，
contract 必须在兼容窗口和独立确认后执行。

部分失败后先在生产主机执行 `read-live-production-components.mjs`，不得先改写
`runtime-identity.json`。恢复完成后再次读回，并以原 Promotion 的 `production-before.json`、
Manifest target、新 observed 和真实 attempted marker 生成 reconcile 输入；只有四组件完全回到
before 且 `rollbackAttempted=true` 才能得到 `rolled_back`。随后使用新的 operation key 追加记录：

```bash
node scripts/release/reconcile-promotion.mjs recovery-input.json recovery-result.json
test "$(jq -r .outcome recovery-result.json)" = rolled_back
pnpm exec tsx server/src/release/releaseAttestationCli.ts \
  --root <attestation-dir> --release-id <rc-id> --digest <manifest-digest> \
  --state rolled_back --operation "recovery:<独立操作号>" --actor <operator> \
  --reason "$(jq -c . recovery-result.json)"
```

权威人工恢复允许从本轮 `promoting` 的直接失败结果追加：
`promoting → partial_failed → rolled_back` 或 `promoting → needs_human → rolled_back`；原有受控
`needs_human → approved` 模式仍保留。`partial_failed` 最新状态不得直接重试。任何包含
`completed`、`rejected`、`revoked`、`superseded`，或没有本轮 active `promoting` 的尾部都不得
追加/消费 `rolled_back`。

`rolled_back` 不会把同一 immutable Release 降级为 fresh 或 `retry_before_change`。下一轮必须
重新校验该 Release 绑定的 Staging evidence，经过新的 production environment 人工审批，追加新的
`approved`，并始终以 `retry_after_change` 重新读取生产基线；不得自动跳过人审。合法多轮历史例如：
`verified → approved → promoting → partial_failed → rolled_back → approved → promoting → needs_human → rolled_back`。

若读回不完整或矩阵混合，状态保持 `partial_failed` 或 `needs_human`；不得仅因 trap 已执行、
systemd/镜像已回切或 marker 存在就记录 `rolled_back`。
