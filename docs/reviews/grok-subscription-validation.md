# Grok 订阅测试与证据对照

真实账号验证：**未执行**。CI 使用明确的 fixture 字符串、模拟 xAI HTTP 和隔离 PostgreSQL；没有读取生产凭据、耗尽真实套餐或部署。通过某项机制测试不代表所有渠道已完成真实账号端到端验收。

## 已读回的干净提交证据

`1f645611338a367fa7b8056cb60b8e825b2ea414`：server/web/shared/mobile typecheck 通过；订阅 18 文件 158 测试通过；配置发布/身份 17 文件 187 测试通过；UI 7 文件 91 测试通过；ratchets 通过。
运行：https://github.com/ZengLeiPro/agent-saas/actions/runs/34626946711 。后续新增测试的结果以最终 PR head CI 为准，不能沿用这个旧 SHA 宣称最终通过。

## T01–T36 映射

下列路径在 `server/src/__tests__` 下，另有明确标注的 Web、release 或 quota 测试。共用机制回归与提供方夹具各自保留，不删除旧 Codex 断言。

| 编号 | 自动化依据                                                                                      | 范围及真实验证边界                                                           |
| ---- | ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| T01  | grokTransportContracts.test.ts、Codex 原 transport/failover                                     | A 成功停止，下一请求仍按优先级                                               |
| T02  | grokTransportContracts.test.ts                                                                  | 明确耗尽冷却、释放、跳过；未耗尽真实套餐                                     |
| T03  | grokTransportContracts.test.ts、grokAdminContracts.test.ts                                      | 到期参与、排序新请求生效                                                     |
| T04  | grokCredentialLifecycle.test.ts、grokTransportContracts.test.ts、grokAdminContracts.test.ts     | auth 状态、后继候选、重授权原位替换                                          |
| T05  | grokTransportContracts.test.ts、grokOAuthContracts.test.ts                                      | 普通 429/403/5xx/HTML/网络不扫池                                             |
| T06  | grokTransportContracts.test.ts、公共/Codex failover                                             | 冷却最早时间、混合不可用、无 API fallback                                    |
| T07  | grokTransportContracts.test.ts、codexStreamGuardTransport.test.ts                               | 401 至多一次，recoveryAttempt/取消边界                                       |
| T08  | grokCredentialLifecycle.test.ts                                                                 | 并发调用共用一次 refresh                                                     |
| T09  | grokCredentialPostgres.test.ts                                                                  | 两个独立 PG pools/管理器/Vault 实例、max:1；不冒充两个 OS 进程或真实蓝绿部署 |
| T10  | grokCredentialLifecycle.test.ts、Codex generation fence                                         | 旧代不覆盖新代，同代 auth 优于 quota                                         |
| T11  | grokCredentialPostgres.test.ts、grokCredentialLifecycle.test.ts                                 | detach/refresh 无复活、锁顺序与池借用；真实生产竞态仍需演练                  |
| T12  | grokCredentialLifecycle.test.ts、grokProductionPublication.test.ts                              | 丢失上游/Vault 回执、高代读回、不重复消费旧 refresh                          |
| T13  | grokOAuthContracts.test.ts                                                                      | discovery、设备码、可信 userinfo、有效期、public metadata                    |
| T14  | grokOAuthContracts.test.ts                                                                      | pending/slow_down/denied/expired 停止条件                                    |
| T15  | grokOAuthContracts.test.ts、Web GrokSubscriptionCard.test.tsx                                   | 恶意 endpoint、URI、issuer、重定向策略                                       |
| T16  | grokOAuthContracts.test.ts、grokAdminContracts.test.ts                                          | 重复 poll/complete、TTL/cancel/capacity                                      |
| T17  | grokAdminContracts.test.ts、grokOAuthContracts.test.ts                                          | owner、普通/组织用户、ref/身份限制                                           |
| T18  | grokSchemaAndCapability.test.ts、grokAdminContracts.test.ts                                     | 首次无 root、disabled 可显示、无账号不能启用                                 |
| T19  | grokAdminContracts.test.ts                                                                      | 精确集合、重复/未知/缺项、revision 冲突                                      |
| T20  | grokProductionPublication.test.ts、productionModelPublication*.test.ts                          | 受控登记回滚、恢复失败、已提交不误作未提交；外部服务用 mock                  |
| T21  | grokProductionPublication.test.ts、grokAdminContracts.test.ts                                   | 确认/revision/操作 scope，Grok 不改 Codex                                    |
| T22  | grokProductionPublication.test.ts、sharedConfigRefresher/configIdentity 回归                    | 双角色独立内存消费者和签名回执，刷新仅推进 credential digest                 |
| T23  | grokAdminContracts.test.ts                                                                      | 删除、最后一个停用、断开、远端未确认 warning                                 |
| T24  | grokSchemaAndCapability.test.ts、environmentSafety/render-config/release 契约                   | staging overlay/allowlist、旧配置；无真实部署                                |
| T25  | grokResponsesAdapter.test.ts、grokTransportContracts.test.ts、Web form                          | 统一原生工厂、固定订阅 endpoint、协议不符拒绝                                |
| T26  | grokResponsesAdapter.test.ts、已有 Responses parser 回归                                        | 分片 UTF-8、arguments、canonical output、缺终态不成功                        |
| T27  | grokTransportContracts.test.ts、grokResponsesAdapter.test.ts、既有 kernel/approval/billing 回归 | 取消不换号；transport 不执行工具；真实外部工具副作用未发起                   |
| T28  | grokTransportContracts.test.ts、runtime continuation/replay 回归                                | tenant/session/account binding、移除 opaque、保留工具结果                    |
| T29  | factory/主运行/子 Agent/标题/恢复相关 affected CI + 实施接线表                                  | 共享依赖已接线；真实 Grok 主/子/组织/标题/唤醒/审批多入口端到端留作上线验收  |
| T30  | grokSchemaAndCapability.test.ts、grokTransportContracts.test.ts、既有压缩/记忆辅助回归          | 支持路径用原 runtime；媒体/门禁能力不符显式拒绝                              |
| T31  | Web ModelManager/GrokSubscriptionCard.test.tsx、grokAdminContracts.test.ts                      | 独立卡片与账号 UI/HTTP 生命周期；不含真实浏览器到 xAI 登录                   |
| T32  | Web GrokSubscriptionCard.test.tsx、productionSave/writePolicy.test.tsx                          | 只读/旧后端/弹窗受阻/确认/失败刷新                                           |
| T33  | grokTransportContracts.test.ts、既有 tenant/model 权限回归                                      | 绑定隔离与现有租户门禁；没有真人多租户上游并发验收                           |
| T34  | grokSubscriptionQuota.test.ts、grokModelCatalog.test.ts、quota 服务回归                         | 缺失/畸形/超大数/过期、共享 manager；真实 billing 字段待核验                 |
| T35  | codex* 全部定向测试、正式 affected CI                                                           | 原 OAuth/WebSocket/排序/identity/旧配置保持                                  |
| T36  | 类型/ratchets/config governance/release/static/security checks、脱敏断言、最终 head CI          | 不使用真实 secrets；CI SHA/attempt 不混用，源码扫描不等于第三方安全认证      |

## 复现命令

工具链取根 package.json，先 `pnpm install --frozen-lockfile`。在隔离 PG 设置 `TEST_DATABASE_URL` 和 `MEMORY_CONSOLIDATION_TEST_PG_URL`。

```bash
pnpm -F server exec vitest run codex grok subscription
pnpm -F server exec vitest run productionModelPublication configIdentity sharedConfigRefresher
pnpm -F web exec vitest run src/components/ModelManager src/components/PlatformAdmin/pages/ProviderQuota
pnpm -F server typecheck
pnpm -F web typecheck
pnpm -F @agent/shared typecheck
pnpm -F mobile typecheck
pnpm check:ratchets
pnpm test:config-governance
pnpm test:release-contracts
pnpm -F server build
pnpm -F web build
node scripts/release/grok-migration-evidence.mjs <实际基线> <候选SHA>
# 完整 PR preflight 包含工作区 coverage、PG、发布和生产 Web 构建
pnpm preflight:pr
```

GitHub PR 正式 CI 按当前主分支的 affected/import 图和 source guards 选择相关测试；main 的全量 coverage 门禁不由本功能降低。诊断 action 还单独运行 shared/server/web 全量测试；只报告实际完成的结果，未执行项不能写成通过。
