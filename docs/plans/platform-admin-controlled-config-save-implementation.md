# 平台管理配置受控保存实现说明

本实现把 #593 的生产签名发布事务泛化为服务端绑定的操作协议。浏览器只提交 raw revision、当前版本生产确认和 operationId；操作类别、允许字段、路径、环境、签名权威及 API/Worker 目标由路由和服务端决定。

实际 raw diff 必须通过 operation registry；候选基于锁内 fresh raw；生产写入先验证权限、CAS、确认、签名基线和双端旧版本回执，再创建候选 Secret；落盘后由共享刷新器真实消费者完成双端回执。缺消费者不成功。

生图引擎与定价 scope 分离；系统提示语仅改目标合法 ID；工具描述、egress、ACS 运行控制继续使用自己的协议。Codex GET 不写配置，登记改为显式 complete，重授权使用新 ref。成功的 device complete 结果仅保留 5 分钟且最多 100 项，用于响应丢失后的短期幂等读取；容量满时优先淘汰最旧已完成项，不淘汰进行中的发布。正常 token 刷新由服务器内部既有受管 ref 协调签名身份；事务外 Vault 改写仍触发 drift。

每个生产 operationId 在私有签名权威目录下保存受 HMAC 保护的操作者与请求语义摘要，以及 `preparing`、`publishing`、`applied`、`committed_unconfirmed`、`rolled_back`、`not_committed` 或 `recovery_required` 状态；不保存请求正文或明文 Secret。候选 Secret 元数据绑定 operationId。`GET /api/admin/config-operations/:operationId` 只允许原操作者查询；浏览器遇到网络失败或 5xx 会查询原操作状态并停止自动重发。

工具整包和单工具候选均在发布锁内用 fresh raw 重建；系统只接受显式 `X-Config-Fingerprint` 作为旧 canonical fingerprint 兼容口径，`If-Match` 与 ETag 保持 raw revision 语义，避免两类 SHA 互相冒充。环境池新提交的 Vault ref 必须是未撤销的 global `tenant-hand`，并由 ref 元数据绑定同一 handId；既有同 handId 引用可在脱敏 GET 后继续保留。

本轮不启用全局生产直写，不改变 Workflow，不部署生产，也不操作真实凭据或真实账号。
