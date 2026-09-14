# KY App V2 非对称接入威胁模型

## 范围与安全目标

本模型覆盖平台 enrollment/token/resource server、浏览器授权跳转、业务系统 enrollment router、DeploymentKeyStore、BindingStore、动态 runtime、目录同步和 Agent 工具快照。业务系统自身登录和业务授权不是平台授权的替代品，但属于端到端业务隔离的验证边界。

安全目标：私钥和长期秘密不离开其所有者；授权绑定到精确组织、安装、系统、部署、origin、callback、key 和 scope；短期 token 只能由持有绑定私钥的一方使用；所有 mutation 可判定、可恢复且不重复提交；V2 不能静默降级；未授权用户和其他组织看不到安装、目录、工具或业务数据。

## 资产与信任边界

| 资产                      | 所有者/存储                        | 允许跨越的边界                                    |
| ------------------------- | ---------------------------------- | ------------------------------------------------- |
| 部署私钥                  | 业务系统 KMS/HSM/加密 Secret Store | 仅签名结果离开；私钥不可导出                      |
| 平台签名私钥              | 平台密钥服务                       | 仅签名结果离开                                    |
| public JWK/keyId          | 平台与业务系统                     | 可传输，但必须绑定 iid/deployment/generation      |
| PKCE verifier/state       | 业务系统临时加密存储               | verifier 只到 token endpoint；state 只到 callback |
| authorization code        | 浏览器短暂携带、平台只存 hash      | 只到固定 callback；60 秒、一次性                  |
| workload token/DPoP proof | 业务系统内存和单次请求             | TLS 内传输；禁止持久化与日志                      |
| installation binding      | 双方数据库                         | 只含非敏感 metadata/keyRef                        |
| 用户/目录/业务数据        | 平台与业务系统各自权限域           | 仅在 Entitlement、Assignment 与业务授权交集内     |

主要边界：浏览器与平台、平台出站探测与业务 origin、平台 API 与业务后端、业务进程与 KMS/数据库、平台进程与 PostgreSQL、Agent session snapshot 与当前 installation state。

## 威胁、控制、自动化落点与监控

| ID  | 威胁/攻击路径                                                  | 预防与检测控制                                                                                                    | 自动化测试落点                                           | 监控信号                                                                        |
| --- | -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------- |
| T01 | 攻击者把自己的 code 注入受害者 callback                        | code 绑定 operation、iid、deploymentId、keyId、精确 callback、PKCE challenge、actor；state 恒时比较；原子单次消费 | WP1 负向向量；WP2 PostgreSQL 并发消费；WP3 callback E2E  | `enrollment_operation_total{status,reason=code_binding_mismatch}`               |
| T02 | 降级 PKCE 为 `plain`、缺失 challenge 或替换 verifier           | 只接受 `S256`；challenge 长度/字符集固定；兑换时恒时比较 SHA-256                                                  | WP1 PKCE vectors；WP2 token route tests                  | `workload_token_issue_total{grant_type=authorization_code,result=invalid_pkce}` |
| T03 | 替换 redirect/callback 或利用开放重定向                        | callback 为已验证 HTTPS origin 下固定路径；精确匹配；响应使用 `Referrer-Policy: no-referrer`；清理 URL            | WP1 URI vectors；WP3 Playwright 与 redirect tests        | enrollment reason `callback_mismatch`                                           |
| T04 | 公钥 JWK 携带 `d` 等私钥成员并被平台/日志保存                  | public-only JWK allowlist，只接受 `kty/crv/x/y` 和允许的 metadata；请求与日志脱敏                                 | WP1 `private_jwk_member` vector；WP2 secret scan         | 安全告警 `private_jwk_rejected`，日志 secret scan                               |
| T05 | `alg=none`、HS/ES 密钥混淆                                     | 每种 `typ` 固定 ES256 与独立 key source；不按 token header 自动选择对称密钥                                       | WP1 `alg_none`/`alg_confusion` vectors                   | token reject reason `invalid_alg`                                               |
| T06 | 把 grant 当 workload token、把 DPoP 当 client assertion        | 每种 JWT 互斥 verifier、固定 `typ`/audience/claims/TTL                                                            | WP1 `typ_substitution` vectors；WP2 route tests          | token reject reason `invalid_typ`                                               |
| T07 | 重放 DPoP proof 或 client assertion                            | `(keyId,jti)` PostgreSQL 唯一占用；60 秒窗口；校验 htm/htu/ath/nonce                                              | WP1 replay vector；WP2 并发与跨进程 tests                | `dpop_replay_rejected_total`                                                    |
| T08 | 在其他组织/安装复用相同 key 或 token                           | 查验 tid/iid/sid/deploymentId/keyId/generation 全绑定；资源接口实时 JOIN installation                             | WP1 cross-tenant vectors；WP2 PostgreSQL isolation tests | reject reason `installation_binding_mismatch`                                   |
| T09 | DNS rebinding 将平台探测引向内网                               | 复用 SSRF 策略；解析前后校验；阻止私网/保留地址；连接固定已验证 IP；Host/SNI 保持 origin                          | WP3 DNS rebinding integration tests                      | enrollment reason `unsafe_origin_resolution`                                    |
| T10 | 通过 30x 跳转绕过 origin 限制                                  | 不跟随跨 origin redirect；同 origin redirect 也必须仍为固定 endpoint                                              | WP3 redirect chain tests                                 | enrollment reason `redirect_rejected`                                           |
| T11 | callback/token/activate 响应丢失导致重复绑定或重复 grant       | 稳定 operationId；lock/reload/validate/mutate/atomic publish；相同摘要读回提交结果                                | WP2 unknown-outcome tests；WP3 refresh recovery E2E      | `enrollment_operation_total{status=needs_human}` 与 diagnosticId                |
| T12 | 多副本在新旧 key 间 split-brain，提前撤销旧 key                | prepare/双 proof/实例 heartbeat/CAS commit/previous 窗口；generation 单调；旧 runtime drain                       | WP4/WP7 双进程与故障注入 tests                           | `deployment_key_generation`、instance generation divergence                     |
| T13 | 窃取 workload token 后以 Bearer 使用                           | token 包含 `cnf.jkt`；仅接受 `Authorization: DPoP`；每次请求校验 proof 和 `ath`                                   | WP1 `bearer_downgrade` vector；WP2 resource tests        | reject reason `dpop_required`                                                   |
| T14 | 已停用/撤销安装继续使用未过期 token                            | 每次资源调用实时检查 installation、key generation 与 scope；撤销触发快照失效                                      | WP2 resource tests；WP6 revoke/session tests             | `installation_activation_total`、snapshot invalidation lag                      |
| T15 | 浏览器、URL、storage、下载、剪贴板或 console 泄漏秘密          | 浏览器只接触 code/state/operationId；不返回 token/私钥；no-store/no-referrer；页面不下载凭据                      | WP3 Playwright 全表面扫描                                | CSP/reporting、前端 secret-canary test                                          |
| T16 | 日志、审计 metadata、trace 或错误响应泄漏 code/token/proof/JWK | 结构化日志 allowlist；Authorization/header/body 默认不记录；错误只含 reason/diagnosticId                          | WP2 secret canary 与日志快照 tests                       | 持续 secret scan，命中即阻断发布                                                |
| T17 | 未绑定或平台故障拖垮独立业务                                   | 业务先启动；adapter fail closed 且异步；unbound 不开放 Agent 能力                                                 | WP4 zero-binding/KMS/platform outage process tests       | 独立业务错误率与 `binding_runtime_state`                                        |
| T18 | 目录旧数据在 degraded 状态越权                                 | 保留最后有效快照但按陈旧度门禁读写；不能回退匿名或本地管理员                                                      | WP4 directory staleness tests；WP6 capability tests      | directory age、拒绝原因与同步延迟                                               |
| T19 | 管理员授权被误当成业务数据权限                                 | token scope 仅平台安装 API；Agent 调用仍要求 Assignment、主体映射和业务 ACL                                       | WP6 authorized/unauthorized/cross-org E2E                | capability deny reason、跨租户访问告警                                          |
| T20 | 当前会话在授权/撤销时工具面抖动或继续投影                      | 当前 run 工具快照不变；事件失效后下一 run/new session 重建；资源层实时拒绝                                        | WP6 current-run/next-run tests                           | `agent_tool_snapshot_invalidation_total` 与传播时延                             |
| T21 | 授权请求被重复点击或并发批准                                   | operationId + actor/iid/request digest 幂等；状态/version CAS；approve 重新认证                                   | WP2 CAS tests；WP3 double-click E2E                      | duplicate operation counter、CAS conflicts                                      |
| T22 | 公钥、origin 或 scope 在恢复操作时发生替换                     | resume 前重读并比较请求摘要；任何 identity/origin/key/scope 变化均取消并新建 operation                            | WP2 resume mutation tests；WP3 refresh tests             | reason `operation_context_changed`                                              |
| T23 | access token TTL、时钟或 audience 被放宽                       | 最大 5 分钟；10 秒 skew；固定 issuer/audience；拒绝超长/未来/过期 token                                           | WP1 time/aud vectors；WP2 fake-clock tests               | reject reason `invalid_token_time`/`invalid_audience`                           |
| T24 | 未知 `crit`、重复 claim 或非规范 JWK 绕过解析差异              | 严格 JOSE parser；拒绝未知 `crit`、重复 JSON key、非 P-256 坐标和 thumbprint 不一致                               | WP1 parser corpus；Node/SDK 交叉验证                     | reject reason `malformed_jose`                                                  |

## 滥用与故障场景

### 授权竞争

同一安装只允许一个兼容的非终态 operation。并发发起者只有 request digest 完全一致时能读取同一 operation；否则返回冲突，不覆盖 actor、key、origin 或 scope。approve 必须重新认证，并在事务内重读 Entitlement、安装状态、技术联系人和 published Manifest。

### 未知提交结果

平台必须区分 `not_committed`、`committed`、`committed_unconfirmed`、`rolled_back` 和 `needs_human`。网络超时不是失败证明；客户端只查询原 operation。已经消费的 code 与 assertion jti 不再执行 mutation，但可以在身份和请求摘要一致时读回相同 grant 结果。日志不得为支持排障而记录 code 或 token。

### 撤销与令牌窗口

停用或撤销后不再签发 token，所有资源接口即时拒绝，即使 token 尚未过期；五分钟 TTL 只是签名失效的上限，不是撤销传播机制。事件用于停止同步和失效工具快照，不能替代资源层检查。

## 安全测试与发布门禁

- WP1：以 `packages/ky-app-contract/test-vectors/v2/` 为单一静态语料，平台与 SDK 交叉验证全部正向和负向向量。
- WP2：使用真实 PostgreSQL 验证 code/jti/CAS 的原子性、跨进程竞争和 TTL 清理，并运行 secret canary 扫描。
- WP3：浏览器验证 URL、Referer、localStorage、sessionStorage、IndexedDB、console、network、下载和剪贴板无秘密。
- WP4/WP7：两个进程共享 PostgreSQL/KMS 模拟轮换、崩溃、旧 generation drain 和 split-brain。
- WP6/WP8：授权用户、无授权用户、其他组织用户分别验证页面、目录、工具投影及真实只读能力；证据绑定同一 RC/SHA/digest。

任一高风险负向用例未自动化、日志 secret scan 命中、V2 可回退 V1、并发出现两个提交者，或真实业务仅以 health/CI 代替验收时，禁止启用 V2 allowlist。

## 剩余风险

- KMS、平台签名密钥和业务部署环境被完全攻陷时，协议无法恢复其信任；需要各自的密钥轮换、最小权限和事件响应。
- DPoP 不防止攻击者同时控制 token 与部署私钥所在进程；运行时隔离和 KMS 不可导出策略仍是必要控制。
- 第一版不支持平台/浏览器不可达的私网系统；不得用放宽 SSRF 或任意 callback 作为临时绕过。
- 当前 run 的工具快照按设计保持稳定，因此撤销后的即时安全依赖资源接口实时状态检查。
