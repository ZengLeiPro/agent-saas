# M60-05 Crash / ANR / 性能监控契约

M60-05 只实现 first-party、provider-neutral 契约和可注入 adapter；仓库没有选择或推断任何第三方供应商、DSN、dashboard URL、SLO 阈值。

## 数据边界

- 共享 schema：`shared/src/telemetry/mobileTelemetry.ts`，版本 `1`，严格 allowlist。
- 时间同时记录 wall timestamp 与 monotonic timestamp/duration。
- correlation/run/session、tenant/user、stack module 均为 `h1:` keyed pseudonym；production key 必须由原生 bridge/服务环境外部注入，并按 release 派生。
- 不接收 prompt/message/tool raw/input/result、附件名/路径、token/email/phone、带 query 的 URL、stack locals。Crash 只允许 normalized frame（module hash、in-app、行列）。
- `assertSafeTelemetrySurface` 是 telemetry、analytics、a11y、log 投影的共同 scanner；debug build 也没有 raw-upload 旁路。

## Mobile

`mobile/src/telemetry/` 提供：

- React ErrorBoundary/global JS fatal；
- provider-neutral native crash bridge `MobileTelemetryNativeBridge`；
- foreground/debugger-aware event-loop ANR watchdog；
- cold startup、screen ready、chat submit/ACK/first token/terminal、WS disconnect/recovery、sync overflow、artifact/voice error；
- owner-scoped AsyncStorage offline buffer，24h TTL、count/bytes 上限，logout/owner switch 清理，background 不 flush，foreground flush 有预算；native bridge 必须把 namespace 标记为不进 backup。

所有 capture/flush 都是 best-effort，失败不抛入聊天控制流。

生产原生 adapter 必须外部提供：

- `pseudonymKey`；
- `intakeSigningKey`；
- native crash handler（若要验证 native crash）；
- debugger detection 与 no-backup implementation。

## Server

认证 endpoint：`POST /api/mobile/telemetry`。它验证 auth tenant/user、release header、HMAC signature、schema、body、clock/replay、idempotency、rate/sample；first-party file store 成功后异步调用 provider adapter，provider 失败不改变 intake 或业务响应。日志仅输出 event kind、hashed correlation、status。

环境配置均 fail closed：

- `MOBILE_TELEMETRY_PSEUDONYM_KEY`
- `MOBILE_TELEMETRY_INTAKE_SIGNING_KEY`
- `MOBILE_TELEMETRY_RETENTION_DAYS`
- `MOBILE_TELEMETRY_SAMPLE_RATE`
- `MOBILE_TELEMETRY_RATE_LIMIT_PER_MINUTE`
- `MOBILE_TELEMETRY_PROVIDER_KIND`
- `MOBILE_TELEMETRY_OWNER`
- `MOBILE_TELEMETRY_DASHBOARD_ID`
- `MOBILE_TELEMETRY_ALERT_POLICY_ID`
- `MOBILE_TELEMETRY_DSN_SECRET_REFERENCE`（仅 secret reference，禁止 DSN 值）
- `MOBILE_RELEASE_COMMIT`

`GET /api/mobile/telemetry/health` 在 provider/owner/dashboard/alert/release facts 缺失时返回 503。

## 发布证据

- 真源模板：`mobile/telemetry/provider-contract.json`。当前阈值与外部 facts 明确为 `pending_external_approval`，因此不能通过 production gate。
- 示例阈值只存在于 `provider-contract.test-fixture.json`，标记 `exampleOnly`，production 明确拒绝。
- `mobile-telemetry-release-gate.mjs` 要求外部完整 provider contract 与 HMAC 签名的真实 `session_start` test-event receipt，receipt 必须绑定 release、contract digest、dashboardId、alertPolicyId、provider receipt ID。
- build/rollout workflow 从 protected variables/secrets 注入上述两份 JSON 与 evidence HMAC key；缺任一事实或 receipt 被篡改即阻断。

## RC 前外部取证（代码不能替代）

1. 真机分别触发 JS crash、native crash、ANR、cold/warm startup、chat ACK/first-token、断网后 WS recovery、sync overflow。
2. 在外部 dashboard 核对 release/profile、聚合指标和无敏感 raw 字段。
3. 由负责人批准 crash-free、ANR、startup、chat、WS、overflow 阈值及 alert policy。
4. 保存真实 provider test-event receipt 和 dashboard/alert IDs，签名后注入 protected workflow facts。
