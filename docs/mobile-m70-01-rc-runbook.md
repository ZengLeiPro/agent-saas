# M70-01 Mobile RC 回归矩阵 Runbook

> 本文只定义可复现门禁，不代表任何 RC 已通过。仓库中的 mock 仅用于 PR contract mode；**不得把 mock、模拟器或仿真器结果写成真机 RC 回执**。

## 1. 准入与不可替代证据

生产 RC 固定读取 `mobile/rc/rc-plan.json`。计划包含 24 个稳定 case ID，覆盖 iOS 最低/最新、Android 旗舰/低端小屏，以及网络、账号、Agent、会话、权限、交互和产物的全部权威值；高风险组合由 `highRiskPairs` fail closed 校验，不执行全笛卡尔积。

开始前必须同时具备同一 40 位 Git SHA 的：

1. **M60-02** 四槽真机回执：`ios-minimum`、`ios-latest`、`android-flagship`、`android-low-end-small`；`evidenceKind=real-device`，物理设备证明完整且 receiptId/testRunId/providerRunId 均不可重放。
2. **M60-04** 三个真实 verified artifact：`ios-store`、`android-store`、`android-enterprise`；提交、版本、签名、制品摘要和 Ed25519 证据链一致。
3. **M60-05** production provider contract 与真实 test-event receipt；release 必须等于 RC SHA。
4. 显式 provider matrix、可执行 provider adapter、fixture server、服务账号、HMAC/公钥 secret。仓库不推测设备型号、OS 版本、provider 或凭据。

缺任一项、跨 SHA、摘要不符、签名失败、回执过期、重复 receipt/testRunId、unsupported device 均立即失败。生产 RC 不接受 simulator、mock、`blocked` 或 `skipped`。

## 2. 预置数据与账号角色

fixture server 必须为本次 RC 创建隔离 namespace，并返回不可复用的 fixture receipt。禁止使用真实客户数据。

| fixture | 权限/状态 | 用途 |
|---|---|---|
| `account-a` | 普通账号 A | 建立旧 WS、会话缓存、离线队列 |
| `account-b` | 普通账号 B，和 A 不同租户/主体 | 验证 A→B 后旧 WS/cache 不泄漏 |
| `admin` | 管理员，但无越权跨租户数据 | 管理入口与普通聊天并行回归 |
| `disabled` | 登录后由 fixture server 禁用 | 禁用态失败关闭 |
| `agent-personal` | 可用个人 Agent | personal 基线 |
| `agent-assigned` | 组织分配 Agent | assigned 基线 |
| `agent-revoked` | 测试过程中撤销 | 撤销后不得继续执行 |
| `agent-personal-disabled` | 租户关闭个人 Agent | 不得回退或误执行 |

会话 fixture 必须明确产生 empty、normal、1000 条索引、500 条消息、50 个 tools 和 running 六种状态。running fixture 需提供可观察的 queued message 与幂等 execution ID。AskUser fixture 至少两题；approval fixture 分别产生 allow/deny；ACK fixture 能控制超时且保留 server execution ID。

产物 fixture 必须包含 Markdown、image、PDF、audio、video、HTML、SVG 和已过期签名 URL。HTML/SVG 使用无害探针验证脚本、外跳、宿主 cookie/token 访问均被阻止；过期 URL 不得依靠本地缓存恢复内容。

## 3. Provider adapter 与网络注入

provider matrix 每项必须显式给出：`caseId`、`slot`、`runnerLabels`、`providerExecutable`、`m60ReceiptId`、provider `buildId`、当前安装包 `artifactDigest`。adapter 接受：

```text
providerExecutable --request <provider-request.json> --output <provider-receipt.json>
```

adapter 自行绑定真实设备和网络工具，仓库不安装或猜测 provider。网络 profile 必须由 provider 回执确认，而不是仅凭测试名称：WiFi、蜂窝、完全离线、300ms RTT、5% 丢包、WiFi↔蜂窝切网。离线/丢包 + ACK 超时必须核对 client message ID、server execution ID 和最终消息 ID，确认 at-most-once。

`provider-receipt.json` 应包含 schema/case、real-device 证明、slot、开始结束时间、flow hash、pass/fail/blocked/skipped、expected invariant 逐项结果、截图路径、有限脱敏日志路径、缺陷和五个 hard-stop 计数。`run-rc-case.mjs` 拒绝超过 64 KiB 或含凭据的 receipt/log，并只规范化上传 receipt、截图与有限日志。

权限在系统设置或 provider 原生能力中注入，不得在 JS mock：麦克风/相机/相册分别执行 allow、deny、once。deny 场景必须覆盖 voice 与 share，确认无静默 fallback。

## 4. 执行

推荐从 GitHub Actions 手工触发或经受保护的 `workflow_call` 调用 `.github/workflows/mobile-rc-regression.yml`。只有 `configured=true` 时真实 matrix 才运行；否则只跑 plan/schema/mock/negative contract，并明确不生成 RC 结论。

真实入口还需指定：

- `build_sha` 与安装 RC SHA；
- `profile`；
- `m60_evidence_run_id`、`m60_evidence_artifact`、`m60_binding_path`；
- 完整 `matrix_json`；
- fixture/provider/HMAC/telemetry/release public-key secrets。

本地单 case 调试命令（仍须真实 provider）：

```bash
node mobile/rc/scripts/run-rc-case.mjs \
  --plan mobile/rc/rc-plan.json --caseId M70-RC-001 --mode production \
  --providerExecutable /configured/provider-adapter --buildSha "$RC_SHA" \
  --buildId "$BUILD_ID" --profile "$RC_PROFILE" --artifactDigest "$ARTIFACT_DIGEST" \
  --m60ReceiptId "$M60_RECEIPT_ID" --testRunId "$UNIQUE_RUN_ID" \
  --attempt "$ATTEMPT" --outputDir .m70-rc/M70-RC-001
```

聚合后必须运行：

```bash
node mobile/rc/scripts/assemble-rc-evidence.mjs \
  --plan mobile/rc/rc-plan.json --results rc-results --m60 m60-evidence/m60-bindings.json \
  --commitSha "$RC_SHA" --profile "$RC_PROFILE" --mode production --expiryHours 24 \
  --output rc-bundle.json
node mobile/rc/scripts/validate-rc-evidence.mjs \
  --plan mobile/rc/rc-plan.json --bundle rc-bundle.json \
  --evidenceRoot m60-evidence --resultsRoot rc-results \
  --publicKeys release-public-keys.json
```

## 5. 判定、缺陷和重跑

case 结果仅允许 `pass/fail/blocked/skipped`。生产 RC 要求 24/24 pass，P0/P1 open count 为 0，且以下任一计数非 0 都硬停，**不能与成功率平均**：

- `identityLeak`（跨账号泄漏）
- `wrongAgentExecution`
- `duplicateExecution`
- `signatureFailure`
- `upgradeFailure`

缺陷必须使用可审计 HTTPS 链接并保留严重级别、状态和对应 case receipt。失败不得通过重跑“清零”：先链接缺陷，提交修复；新结果的 `retryOf` 必须记录旧 `testRunId`、旧失败 receiptId、当前修复 commit SHA，并生成新的 testRunId/device receipt；`attempt>1` 或 provider failure ledger 非空而缺少该链路会被 validator 拒绝。原失败证据保留。环境缺失在探索阶段可记 blocked，但该 bundle 不能进入 production gate；不得改成 skipped 规避。

## 6. 有限证据与 PR 门禁

Actions 只保留规范化 `result.json`、受限 provider receipt、截图、脱敏日志和最终 bundle，默认 14 天；M60 临时转存只保留 1 天。不得上传 provider request、账号 JSON、fixture token、服务 URL、签名 URL、原始全量日志或 secret。

PR CI 只执行：plan lint、JSON schema 可读性、显式 contract mock 正例、tamper/cross-SHA/replay/missing/expired/unsupported/blocked/skipped/P0/P1/hard-stop 等负例，以及 workflow YAML/security scan；PR 不运行或宣称真实 RC matrix。
