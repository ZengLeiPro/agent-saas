# M70-03 移动端灰度门禁 Runbook

## 结论与边界

M70-03 只实现 provider-neutral 的灰度策略、证据验证、逐阶段审批、观察和回执合同，**不会发布、提交商店或调用任何真实供应商**。权威顺序固定为：

1. `employee-dogfood`（员工 dogfood）
2. `closed-test`（封闭测试）
3. `small-percentage`（小比例）
4. `expanded`（扩大灰度）
5. `full`（全量）

不可跳级、倒退或复用阶段审批。机器策略是 `mobile/rollout/rollout-policy.json`，机器 schema 在 `mobile/rollout/schema/`。权威材料没有提供 cohort、流量、观察窗、最小样本、dashboard/provider 与阈值，因此 canonical policy 全部保留 `pending_external_approval`，生产必定 fail closed；`mobile/rollout/fixtures/rollout-policy.test-fixture.json` 中的数字只用于显式非生产合同测试，绝不是建议值。

## 上线前一次性外部配置

发布负责人必须在受保护来源中提供并审批：

- 每阶段 cohort 定义、traffic min/max、观察窗、snapshot freshness、最小样本；
- 每项指标的 direction 对应阈值及不可变批准来源；
- 真实 telemetry provider、dashboard ID、query ID/digest、告警策略和负责人；
- support/incident owner 与工单查询来源；
- 五个 GitHub protected environment：`mobile-rollout-gate-<stage>`，启用 required reviewers、禁止 self review；
- 可执行的 provider adapter；仓库不猜 Apple/Google/企业分发 adapter、endpoint 或供应商；
- `MOBILE_ROLLOUT_GATE_HMAC_KEY`、provider robot token。不得向 fork 提供。

production 不接受 mock、simulator、test fixture、`pending_external_approval`、缺 provider/dashboard/threshold、未配置 adapter。

## Dogfood 前必备证据

所有证据必须绑定同一 40 字符 source SHA、同一 release ID 和同一 artifact-set digest，且状态为 pass：

1. M60-04 signed build evidence；
2. M60-04 signed submit receipt，必须引用该 build evidence digest；
3. M60-05 approved provider contract；
4. M60-05 真实 test-event receipt，必须引用 provider contract digest；
5. M70-01 RC 全通过回执；
6. M70-02 升级/回滚演练全通过回执。

每阶段还必须有新的 protected-environment approval、provider adapter receipt、telemetry snapshot、support/incident snapshot。telemetry snapshot 的签名覆盖 provider、dashboard、query/digest、时间窗、cohort/stage、release/SHA/artifact、十项 soft metrics 和六项 hard-stop 独立计数；support snapshot 的签名覆盖 owner、时间窗、cohort/release、incident/ticket 列表。缺失、NaN、partial、样本不足、短窗、cohort/release 不匹配、stale、future 或签名篡改均失败。

## 指标与阶段判定

每阶段完整检查：crash-free users、Android ANR、登录成功、WS 重连/恢复、消息 ACK 成功、消息 duplicate run rate、上传成功、身份/租户/Agent incident、用户可见错误、支持工单。每项按 policy 指定的 direction、threshold、sample 和 window 独立比较，不允许以平均值掩盖失败。

以下 hard stop 独立计数必须严格等于 0：

- cross-account identity leak；
- cross-tenant identity leak；
- wrong-Agent execution；
- signature failure；
- upgrade failure；
- duplicate run/execution。

任一非零立即生成 signed `stopped` receipt；不再计算平均 soft metrics，不允许 override。soft metric 超阈值生成 `paused` receipt；全通过才生成 `passed` receipt。后续阶段入口必须消费紧邻前一阶段的 signed pass receipt；`previousReceiptDigest` 形成从 `GENESIS` 开始的不可篡改 hash chain。approval ID、approval nonce、snapshot ID 和 receipt nonce 必须写 replay ledger，任何复用拒绝。

## 标准执行

仓库内原 `Mobile M70-03 Staged Rollout Gate` 与暂停入口已在 PR #417 删除，当前**没有可执行的生产灰度入口**。在发布负责人提供受保护的外部发布系统，或建立只接受 protected `main` / 签名 RC tag、固定 validator、protected environment 与短期凭据的入口前，本节仅定义目标顺序，生产 Gate 必须保持 blocked；不得恢复允许任意目标 SHA 进入 secret job 的旧 workflow。

受保护入口必须按以下顺序运行：

1. 下载指定 run/name 的不可变证据，验证同 SHA/release/artifact 与 production policy；
2. 等待目标阶段 protected environment 人工审批；
3. 调用显式注入的 provider adapter；未配置立即失败；
4. 等待完整观察窗，由 adapter 输出已签名 telemetry 与 support/incident snapshots；
5. evaluate，生成并上传 90 天保留的 signed stage receipt。

build、submit 与 rollout 始终分离；本流程没有 EAS build/submit。有限日志最大 64 KiB，不能输出 token、URL、用户/租户/消息正文。PR/fork 只运行合同测试，不进入 secret/provider jobs。

## Hard stop、支持工单与 kill switch

收到 `stopped` receipt 后立即：

1. 创建 P0/P1 incident，记录 incident owner、release、stage、cohort、hard-stop 独立计数、telemetry/support snapshot digest；
2. 使用受保护发布系统中的暂停/回滚入口；当前仓库入口已删除，因此未重建前由发布负责人按阻塞流程人工处置。新入口只消费验签成功且 `status=stopped` 的 receipt，只允许 `pause` 或 `rollback`；普通 pass/paused receipt、`resume`、override 均拒绝；
3. 执行 capability kill switch，停止对应身份/消息执行/上传能力。kill-switch 的具体命令由外部 provider adapter 实现，仓库只给出 command contract，不臆造供应商命令；
4. support owner 建立工单视图，标记受影响 cohort、可见错误、重复执行风险，冻结自动重试；
5. 保全 adapter receipt、dashboard query、snapshot、stage receipt、incident 与支持工单引用。

商店版本不能“降级”。Store 事故采用 pause → server capability kill → 验证兼容/指标 → 发布更高 version/build hotfix；Android Enterprise 仅可使用 M70-02 已验证的签名回滚合同并保留审计/replay ledger。

## 事故恢复

恢复必须同时具备：

- signed incident-resolved receipt，引用原 stopped receipt digest；
- 修复后的新 SHA；严禁原 SHA 手工放行；
- 新 artifact-set digest 和新 build/submit/telemetry 证据；
- 在新 SHA/新 artifact 上重跑并通过 M70-01 与 M70-02；
- 从 employee dogfood 重新开始五阶段链，不复用旧审批、nonce、snapshot 或 receipt。

## N-1 / N 与 rollback

服务端必须维持 M70-02 定义的 N-1/N API、token、cache schema 和消息 ACK 查询兼容窗口。停止 rollout 或 kill switch 后，旧 pending 消息不得自动 replay；必须查询 ACK 状态。N-2 fail closed 并向用户提供升级动作。rollback 不能绕过本门禁、签名验证、incident resolution 或新 SHA 要求。

## CI 与本地验证

```bash
pnpm -F mobile test:m70-03
pnpm -F mobile test:m60-04
pnpm -F mobile test:m60-05
pnpm -F mobile test:m70-01
pnpm -F mobile test:m70-02
```

CI 覆盖 policy/schema、显式 mock 正链、hard stop、soft metric、stage 跳级/倒退、cross-SHA/artifact、窗口/样本/cohort/stale/future/tamper/NaN、approval/nonce replay、hash chain、事故恢复新 SHA、YAML/fork/secrets/有限日志和 M60/M70 回归。生产真实 rollout 只有外部事实与 adapter 全部配置后才可由受保护审批人工启动。
