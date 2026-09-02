# M70-02 冷装、升级与回滚演练 Runbook

> 本文是执行契约，不是历史回执。仓库没有旧线上 IPA/APK 或真机 provider，因此不声称生产演练已完成。`test-fixture`、simulator、mock 只能证明 schema/negative/compat contract，不能转写为真实证据。

## 1. 权威输入与启动条件

生产演练只允许通过 `Mobile M70-02 Upgrade and Rollback Rehearsal` 的 `workflow_call` / `workflow_dispatch` 启动，且 `configured=true`。PR 只运行 schema、mock、negative、N-1/N compatibility tests。

执行前由发布负责人逐项提供，不得由 workflow 猜测或现场构造：

1. 当前 commit 与 previous commit（两个不同的 40 位 SHA）。
2. M60-04 的 iOS Store、Android Store、Android Enterprise **真实** artifact evidence；每个含 digest、appId、version、buildNumber/versionCode、signer digest、source SHA。
3. iOS/Android 可安装的真实线上包，或来源、签名和分发方式最接近线上且可审计的旧包；当前与旧包必须同 signer 才能做覆盖升级。
4. 可执行真机 provider adapter，明确设备 ID、型号、OS、安装方法；生产不接受 simulator/emulator。
5. `MOBILE_REHEARSAL_PROVIDER_TOKEN`、`MOBILE_REHEARSAL_POLICY_PUBLIC_KEY`；server production signing secret、owner 和 change approval。任一缺失均 fail closed。

机器计划为 `mobile/rehearsal/rehearsal-plan.json`，共 **21 个 case（iOS 10、Android 11）**。Enterprise 紧急 rollback 是 Android APK 专属；其它十类动作 iOS/Android 各一例。

## 2. 每动作的不可变证据

每个 case 必须绑定：case/action、current commit、previous commit、current/previous artifact digest、appId、version、buildNumber、versionCode、signer digest、M60 evidence ref、真机 provider/device/model/OS、install method、startedAt/completedAt、result、observed outcome、receiptId、testRunId、日志及截图的 SHA-256。

生产 gate 校验：

- current artifact source SHA = current commit；previous artifact source SHA = previous commit；
- appId、profile、signer 连续；覆盖/热修复/Enterprise 紧急包的 versionCode 必须严格增加；
- device=`real-device`，artifact=`m60-verified-artifact`，不接受 `fixture:*`；
- action、安装方法、时间、设备、artifact、log、screenshot、hash 任一缺失即失败；receiptId/testRunId 不得重放；
- 日志和截图按文件内容重算 SHA-256；不采集 token、cookie、Authorization 或 manifest signing secret。

## 3. 启动与兼容策略

客户端启动硬顺序：

1. 恢复/完成 M30 auth lifecycle transaction；expired/revoked token 走同一事务围栏；
2. cache v1→v2 幂等迁移；
3. 拉取并验证 server signed compatibility/kill-switch policy；
4. 分类旧 pending；同协议只查 server ACK，协议变化标记 `failed_upgrade`；两者都 `autoReplay=false`；
5. 只有允许时才 connect，最后 enable send。

policy 绑定 tenant、environment、appId、API min/max、cache schema min/max、min supported app version、disabled capabilities、block reason、owner、incident、changeId、effectiveAt、expiresAt、单调 version、nonce、digest、keyId 和 Ed25519 signature。客户端拒绝 tamper、旧版/重放、过期、cross-tenant、cross-environment、wrong app/key/signature。production 缺 signing secret、owner 或 approved changeId 时 server 不签发。

被版本门禁阻断时只显示安全只读页，可执行 `logout` / `update`；不连接、不发送、不自动删除本地数据。capability kill 只拒绝对应能力，例如关闭 voice 不得影响 send/sync。policy 响应和日志禁止包含 token。

## 4. 21 个动作的操作与判据

| 动作 | 操作 | 通过判据 |
|---|---|---|
| fresh install | 卸载并按已记录分发方式安装 current | 无旧身份/队列泄漏，完成 auth/cache/policy 后再连接 |
| same-version reinstall | 用同一 current artifact 重装 | 平台定义的数据保留/清理一致，无签名或 schema 错误 |
| N-1→N overlay | 真实旧包建立状态后，同 signer 覆盖安装 current | 安装成功，cache/token/pending 各按本表判定 |
| cache v1→v2 | 旧包写入 v1 fixture，升级并启动两次 | 首次原子迁移，二次幂等；未知 N 字段安全忽略 |
| expired token | 旧包写入过期 token 后升级 | M30 transaction 围栏、断连、要求登录，不残留可发送状态 |
| revoked token | server 撤销旧 token 后升级 | 与 expired 相同，不以缓存用户绕过 |
| old pending / same protocol | 制造未确认 ACK 的 durable pending 后升级 | 仅按 clientMsgId 查询 ACK，`ack_*_no_replay` |
| old pending / protocol upgrade | 将旧 pending 的 protocol/schema 与 N 不同 | `failed_upgrade_no_replay`，草稿可人工检查 |
| server epoch restart | 建立 seq/epoch 后重启 server epoch | authoritative resync，不从本地 pending 恢复 server queue |
| Store incident | 暂停 rollout→server capability kill→核对 metrics/compat→发布更高版本修复包 | observed outcome 固定为 `rollout_paused_capability_killed_metrics_verified_higher_version_hotfix`；禁止“商店降级” |
| Enterprise emergency rollback | 签发旧/new APK digest、installed/rollback versionCode、signer、incident、approver、TTL、nonce 的 manifest | rollback APK 的 versionCode 更高、同 signer；Ed25519 验签通过，写 audit 与 replay ledger |

## 5. Store 与 Enterprise 回滚契约

### Store

商店不能瞬时降级，任何将 version/build 调低的方案直接拒绝。顺序必须是：

1. pause staged rollout；
2. 用 server capability kill 只关闭事故能力；必要时用 min supported app version 阻断危险版本；
3. 核对 crash/error/业务 metrics 与 N-1/N compatibility；
4. 发布修复后的**更高 version/build**，恢复 rollout 前重跑受影响 case。

server 保持 N-1/N API 与 cache schema 窗口；N-2 fail closed 并给 update 动作。停止 rollout 和 kill switch 都不得触发旧 pending 自动重放。

### Android Enterprise

`enterpriseRollbackManifest.ts` 验证 package、installed/new APK digest、installed/rollback versionCode、APK signer digest、incident、approver、TTL、nonce、keyId、Ed25519 signature。所谓紧急 rollback 是把经批准的旧逻辑重新封装为**更高 versionCode** 的紧急修复 APK，不是 Android 降 versionCode。接受后写入 nonce + manifest digest replay ledger 和 audit event；tamper、cross-SHA、wrong signer、version regression、过期、重放全部拒绝。

## 6. 回滚/停止判据

任一条件命中立即停止 rollout 并执行 capability kill：身份/租户泄漏、重复发送或自动 replay、cache 迁移不可恢复、expired/revoked token 仍可发送、签名/摘要不一致、N-1 contract 失败、crash-free 或关键业务指标超过既定 incident 阈值。阈值必须来自当次 change/incident，不在仓库伪造固定数字。

恢复 rollout 前必须有：incident owner 与 approver、changeId、有效且未过期 policy、更高版本修复包、受影响 iOS/Android case 真实通过、指标观察窗结束。Enterprise 还必须核对 replay ledger 和审计事件。

## 7. 命令

```bash
pnpm -F @agent/shared exec vitest run src/mobileCompatibility/policy.test.ts
pnpm -F server exec vitest run src/mobileCompatibility/policySigner.test.ts
pnpm -F mobile exec vitest run src/startup/mobileCompatibilityVerifier.test.ts \
  src/startup/mobileStartupGate.test.ts src/updates/enterpriseRollbackManifest.test.ts
pnpm -F mobile test:m70-02
pnpm -F @agent/shared typecheck && pnpm -F server typecheck && pnpm -F mobile typecheck
```

生产 bundle 校验：

```bash
node mobile/rehearsal/scripts/validate-rehearsal-evidence.mjs \
  --bundle m70-02-evidence.json --evidenceRoot rehearsal-results \
  --publicKeys "$RUNNER_TEMP/mobile-release-public-keys.json"
```
