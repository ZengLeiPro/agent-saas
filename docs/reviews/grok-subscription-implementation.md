# Grok 订阅实施记录

日期：2026-09-12（Asia/Singapore）。主依据：《agent-saas：Grok 订阅鉴权与 Codex 同机制接入实施方案》2026-09-11 v1.0。

## 对焦与实现取舍

原实施基线 `d59eca1e1cef7e83a1e59634569f80497ca37834`，收尾时同步 `main` 的 `eec01d4c1d043a3de0eec54f9fc1ab8d64651c4b`；最终精确 SHA 以 PR head/CI 为准，不把基线当成最新。根目录和本次相关目录的 tracked `AGENTS.md` 查询未发现文件。Node 22.23.1 / pnpm 10.18.3，冻结 lockfile，未升级依赖。

本地容器不可用时使用独立功能分支的 Ubuntu / PostgreSQL GitHub Actions 完成应用、构建与验证。临时应用脚本和开发 workflow 必须在最终 diff 清理；没有修改生产数据、部署或主分支。独立 `workbench/grok-validation` 仅存脱敏检查报告，报告明确记录实际受测 SHA 和是否干净工作树，不把失败/未提交工作树当成已验证 commit。

共用 `subscriptionCredentialFailover`、`subscriptionCredentialLock`、`subscriptionCredentialRuntimeState`、`subscriptionAccountBinding`、`subscriptionTelemetry` 等小模块；Codex 路径、原表名和错误策略保留兼容包装。Grok 协议、身份解析、错误分类、model catalog、请求归一化独立，不复制 Codex originator、账号 claim 或 WebSocket 假设。

刷新结果不确定使用 ref/generation journal 和 Vault 高代读回。生产 publication fence 在 credential lock 外层；在 PG 锁内复用已借出的连接，真实 `max:1` 双池测试覆盖死锁回归。重授权先新 candidate，再原位置替换；发布前失败和提交不确定区分，补偿不远端撤销共享 grant。

## 协议依据与未确认边界

公开文档：[xAI 企业部署](https://docs.x.ai/build/enterprise)、[OpenClaw xAI provider](https://docs.openclaw.ai/providers/xai)。代码参考锁定 `openclaw/openclaw@c94dbef6c914c3433a1c6678996ffa99674c1ea2` 的 `extensions/xai/xai-oauth.ts`、`provider-catalog.ts`、`usage.ts`、`stream.ts`。参考协议行为，不引入 OpenClaw 运行时；本项目代码为独立实现。

| 内容              | 实现和证据边界                                                                                                        |
| ----------------- | --------------------------------------------------------------------------------------------------------------------- |
| OIDC discovery    | 固定 `https://auth.x.ai/.well-known/openid-configuration`，issuer 和 HTTPS host 白名单校验，拒绝重定向和 URL userinfo |
| 设备码            | RFC8628 grant；pending/slow_down/denied/expired；管理员 owner、数量/TTL、单次交换                                     |
| 身份              | 使用 Bearer 认证的受信 userinfo `sub`，不信任前端 accountId 或未验证 JWT；仅已验证邮箱用于脱敏显示                    |
| Public client     | 默认公开参考 client，可配置明确获准 client；bundle 保存签发 client，刷新不会跟随之后配置错用 client                   |
| Responses         | `https://cli-chat-proxy.grok.com/v1/responses`；HTTP/SSE、完整历史、自有工具 loop、无 API Key fallback                |
| 模型目录          | 订阅 `/v1/models`，按账号读取、并集与资格、短缓存，失败保留 stale 而非删除管理员模型                                  |
| 额度              | `/v1/billing?format=credits`；camel/snake、数值/周期/余额均验证，缺失不当作零/无限                                    |
| 状态/能力         | 不启用未验证 WS/服务端接力/cache key；图像/effort 需目录确认；独立图片理解、Chat-only 门禁明确限制                    |
| 商业许可/真实账号 | 资格、scopes/client 适用性、上游实调和集中使用许可没有由 CI 证明，需上线验收                                          |

没有真实账号成功响应样本，不能将模拟 SSE、OAuth 或余额夹具称为真实上游认证。未知 403、普通 429、5xx、HTML challenge 保守报告，不盲目封号或扫池；明确耗尽才进入 quota cooldown。

## 接线地图

| 入口/组件       | 实际接线或限制                                                                                                                                 |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| 主请求          | rawRuntimeRunDispatch → modelAdapterFactory → GrokSubscriptionResponsesTransport，依赖来自 modelSubscriptionRuntime                            |
| 子 Agent        | subagentRunner 使用共享 factoryDependencies；保留 model resolver 和 tenant 权限，不建立第二个池                                                |
| 组织 dispatcher | 订阅连接不强制 API Key；不改变普通/dispatcher 的角色、委派和工具权限边界                                                                       |
| 标题            | createTitleModelAdapterFactory 注入同一管理器/网络服务，独立会话 binding                                                                       |
| wake/审批/压缩  | 逻辑 model ref 重解析；runtimeModelResolution、事件/continuation provider 类型支持 Grok；正常历史/工具输出保留，跨绑定 opaque reasoning 不回放 |
| 图片理解辅助    | 配置与运行前显式限制 Grok 订阅；不是把 token 填进旧 API Key 客户端                                                                             |
| 门禁            | 现有 Chat Completions-only 能力不扩展为假 Responses 支持                                                                                       |
| 记忆整理        | 既有 raw runtime/factory 语言路径复用，独立 embedding 不变                                                                                     |
| 配置发布        | Grok 操作注册精确字段；API/Worker sharedConfigRefresher 消费；configIdentity 受管 ref/version；ProductionModelPublisher 轮换/恢复              |
| Web/移动端      | 使用标准模型列表/事件与逻辑引用，未下发全局订阅 token；移动端不新增管理员页面                                                                  |

详见[测试覆盖对照](grok-subscription-validation.md)、[操作指南](../grok-subscription.md)和[发布回滚](../grok-subscription-rollout.md)。
