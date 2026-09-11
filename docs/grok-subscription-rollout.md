# Grok 订阅发布与回滚

## 上线前条件

代码 PR 不执行部署。生产全局池要求既有共享 PostgreSQL 和受管持久化 Vault；开发用内存 store 不代表多进程生产一致性。API 与 Runtime Worker 均须升级到识别 Grok config/transport/continuation 的版本，Web 升级后再允许管理员登记。

运行状态新增 `<prefix>_grok_credential_runtime_state` 和 `<prefix>_grok_credential_refresh_journal`，不重命名、不复制、不清空 Codex 表。新表通过受信前缀和 provider 名字生成，长前缀有稳定摘要以满足 PostgreSQL 标识符限制。发布必须走现有 expand 迁移计划、后置条件和观察回执，不把 `CREATE TABLE IF NOT EXISTS` 当作跳过迁移门禁的理由。用 `node scripts/release/grok-migration-evidence.mjs <实际生产基线> <候选SHA>` 生成只读计划；该命令不执行数据库操作。

Grok 正常刷新采用发布 fence → 凭据锁的单一顺序。锁内状态查询复用同一 PG client，避免 `poolMax=1` 自锁。刷新 journal 只保存 ref/generation，不保存 token。上游成功但 Vault 写入回执丢失时，重新读取更高 generation 并推进签名身份；不能重发已经消费的旧 token。双端回执不完整时保持 recovery_required，不伪造健康状态。

Staging 必须用独立账号/Vault/namespace，显式提供 `grokSubscription` overlay。禁止从生产配置复制 refresh token 或旧 Vault 快照。必要认证/推理域名纳入既有显式环境 allowlist，不关闭 TLS 校验，不设置任意域名放行。设备 OAuth 只在固定 API owner 上持续；有负载均衡多 API 时先提供可靠 owner 路由，当前实现不声称跨 API owner 无缝共享设备任务。

## 真实账号验证（尚未执行）

由获授权管理员在隔离环境进行：添加现有符合资格的订阅、确认外部授权与平台登记状态、查询订阅目录、显式配置候选模型、短文本和一次无破坏工具调用、子 Agent/标题/审批恢复、受控刷新、额度读取、排序/重授权/删除/断开。双账号上游行为在有第二个获授权账号后验证；不要求为编码购买账号，不通过耗尽套餐测试故障切换。

网络目的地必须为订阅服务，不能用 API Key 成功来替代订阅验收。记录脱敏字段结构、终态、generation、用量和实际源 SHA，不保存 token、用户码、完整提示词或原始上游 body。OAuth public client/scopes 的适用性、订阅资格及集中商业使用许可由账号/平台负责人确认；开源参考实现不构成远端服务许可。

## 功能回滚（保留新代码）

通过受控配置保存关闭 Grok。停止新请求及后续新工具腿；已经发出的一次请求按既有取消/终态处理，不重放工具。检查默认、标题、压缩、组织 Agent 等引用，只有明确获授权的配置调整才选择替代模型；不要悄悄将显式 Grok 请求换为另一个付费提供方。保留账号/事件以便诊断；需要撤销时走卡片断开流程。

## 代码回滚（旧版不识别 Grok）

仅 `enabled:false` 不够。先在新代码下使所有模型配置和辅助引用恢复旧版可解析集合，停用并移除 Grok 引用，等待相关任务结束。用待回退旧版的 parser 和真实配置/会话样本做隔离验证；含 `xai_grok_subscription` continuation 的历史可能使旧 reader 不兼容。

不能证明旧 reader 能读取时选择修复性前向发布，限制回退到支持新枚举的版本。禁止删除生产事件/会话或删表来让旧版启动。新增表可以保留。遵循既有 release rollback 和签名身份恢复步骤，禁止直接编辑 publication/receipt 欺骗一致性校验。

Staging 首次设备码申请、轮询和启用配置也检查 OAuth 开关及认证/订阅双域名白名单；不是等已启用后才检查。读取状态和取消本地授权不要求额外联网。
